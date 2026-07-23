import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissionExecutor, type ExecutionProgress, type ExecutionStatus } from './mission-executor';
import { syncClient, type SyncEvent } from './sync-client';

const executors: MissionExecutor[] = [];

function createExecutor(status: ExecutionStatus): { executor: MissionExecutor; statusChanges: ExecutionStatus[] } {
	const executor = new MissionExecutor();
	executors.push(executor);
	const progress = executor.getProgress();
	(executor as unknown as { progress: ExecutionProgress }).progress = {
		...progress,
		status,
		missionId: 'mission-1'
	};
	const statusChanges: ExecutionStatus[] = [];
	executor.setCallbacks({
		onStatusChange: (nextStatus) => statusChanges.push(nextStatus)
	});
	return { executor, statusChanges };
}

function emitServerMissionStarted(): void {
	const event: SyncEvent = {
		type: 'mission_started',
		missionId: 'mission-1',
		data: {},
		timestamp: new Date().toISOString(),
		source: 'server'
	};
	(syncClient as unknown as { handleMessage: (data: Record<string, unknown>) => void }).handleMessage({
		type: 'event',
		event
	});
}

afterEach(() => {
	for (const executor of executors.splice(0)) {
		executor.destroy();
	}
	vi.unstubAllGlobals();
});

describe('MissionExecutor sync state transitions', () => {
	it('creates production transition IDs without Math.random', () => {
		const { executor } = createExecutor('running');
		const randomSpy = vi.spyOn(Math, 'random');

		(executor as unknown as {
			appendTaskTransition: (event: {
				type: 'task_started';
				taskId: string;
				taskName: string;
				message: string;
			}) => void;
		}).appendTaskTransition({
			type: 'task_started',
			taskId: 'task-crypto',
			taskName: 'Crypto transition',
			message: 'started'
		});

		expect(executor.getProgress().taskTransitions.at(-1)?.id).toMatch(
			/^transition-\d+-[0-9a-f]{8}$/
		);
		expect(randomSpy).not.toHaveBeenCalled();
	});

	it.each<ExecutionStatus>(['completed', 'failed', 'cancelled'])(
		'keeps %s missions terminal when a stale mission_started event arrives',
		(status) => {
			const { executor, statusChanges } = createExecutor(status);

			emitServerMissionStarted();

			expect(executor.getProgress().status).toBe(status);
			expect(statusChanges).toEqual([]);
		}
	);

	it.each<ExecutionStatus>(['idle', 'creating', 'paused', 'partial'])(
		'allows non-terminal %s missions to become running when mission_started arrives',
		(status) => {
			const { executor, statusChanges } = createExecutor(status);

			emitServerMissionStarted();

			expect(executor.getProgress().status).toBe('running');
			expect(statusChanges).toEqual(['running']);
		}
	);
});

describe('MissionExecutor dispatch authority boundaries', () => {
	it.each([
		['an empty body', '', 'dispatch returned empty body'],
		['a non-JSON body', 'not-json', 'dispatch returned HTTP 200 but body was not JSON']
	])('returns bounded failure evidence for %s', async (_label, body, expectedError) => {
		const executor = new MissionExecutor();
		executors.push(executor);
		vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

		const result = await (executor as unknown as {
			dispatchToProviders: (
				executionPack: Record<string, unknown>,
				options: Record<string, unknown>
			) => Promise<{ success: boolean; error?: string }>;
		}).dispatchToProviders(
			{ missionId: 'mission-invalid-dispatch-body', tasks: [] },
			{ apiKeys: {}, providers: ['codex'] }
		);

		expect(result).toMatchObject({ success: false });
		expect(result.error).toContain(expectedError);
	});

	it('does not replay relay authority into provider dispatch', async () => {
		const executor = new MissionExecutor();
		executors.push(executor);
		const progress = executor.getProgress();
		(executor as unknown as { progress: ExecutionProgress }).progress = {
			...progress,
			missionId: 'mission-relay-authority',
			mission: {
				id: 'mission-relay-authority',
				context: { projectPath: 'C:\\tmp\\relay-authority-test' }
			} as ExecutionProgress['mission']
		};
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify({ success: true, sessions: {} }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await (executor as unknown as {
			dispatchToProviders: (
				executionPack: Record<string, unknown>,
				options: Record<string, unknown>,
				relay?: Record<string, unknown>,
				executionAuthority?: unknown
			) => Promise<{ success: boolean }>;
		}).dispatchToProviders(
			{ missionId: 'mission-relay-authority', tasks: [] },
			{ apiKeys: {}, providers: ['codex'] },
			{
				missionId: 'mission-relay-authority',
				requestId: 'request-relay-authority',
				executionAuthority: { schema_version: 'governor-decision-v1' },
				execution_authority: { schema_version: 'governor-decision-v1' }
			}
		);

		expect(result.success).toBe(true);
		const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.executionAuthority).toBeUndefined();
		expect(body.relay).toMatchObject({
			missionId: 'mission-relay-authority',
			requestId: 'request-relay-authority'
		});
		expect(body.relay.executionAuthority).toBeUndefined();
		expect(body.relay.execution_authority).toBeUndefined();
	});

	it('sends explicit dispatch authority separately from relay metadata', async () => {
		const executor = new MissionExecutor();
		executors.push(executor);
		const progress = executor.getProgress();
		(executor as unknown as { progress: ExecutionProgress }).progress = {
			...progress,
			missionId: 'mission-explicit-authority',
			mission: {
				id: 'mission-explicit-authority',
				context: { projectPath: 'C:\\tmp\\explicit-authority-test' }
			} as ExecutionProgress['mission']
		};
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify({ success: true, sessions: {} }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const executionAuthority = { schema_version: 'governor-decision-v1', tool_name: 'spawner.dispatch' };

		const result = await (executor as unknown as {
			dispatchToProviders: (
				executionPack: Record<string, unknown>,
				options: Record<string, unknown>,
				relay?: Record<string, unknown>,
				executionAuthority?: unknown
			) => Promise<{ success: boolean }>;
		}).dispatchToProviders(
			{ missionId: 'mission-explicit-authority', tasks: [] },
			{ apiKeys: {}, providers: ['codex'] },
			{
				missionId: 'mission-explicit-authority',
				requestId: 'request-explicit-authority',
				executionAuthority: { schema_version: 'relay-residue' }
			},
			executionAuthority
		);

		expect(result.success).toBe(true);
		const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.executionAuthority).toEqual(executionAuthority);
		expect(body.relay).toMatchObject({
			missionId: 'mission-explicit-authority',
			requestId: 'request-explicit-authority'
		});
		expect(body.relay.executionAuthority).toBeUndefined();
	});
});

describe('MissionExecutor local lifecycle authority boundaries', () => {
	it('does not locally pause a running mission without governed mission-control authority', async () => {
		const { executor, statusChanges } = createExecutor('running');

		const paused = await executor.pause();

		expect(paused).toBe(false);
		expect(executor.getProgress().status).toBe('running');
		expect(statusChanges).toEqual([]);
	});

	it('does not locally resume a paused mission without governed mission-control authority', async () => {
		const { executor, statusChanges } = createExecutor('paused');

		const resumed = await executor.resume();

		expect(resumed).toBe(false);
		expect(executor.getProgress().status).toBe('paused');
		expect(statusChanges).toEqual([]);
	});

	it('does not locally cancel a mission without governed mission-control authority', async () => {
		const { executor, statusChanges } = createExecutor('running');
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const cancelled = await executor.cancel();

		expect(cancelled).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(executor.getProgress().status).toBe('running');
		expect(statusChanges).toEqual([]);
	});

	it.each<ExecutionStatus>(['completed', 'failed', 'cancelled'])(
		'does not send another kill request for a %s mission',
		async (status) => {
			const { executor, statusChanges } = createExecutor(status);
			const fetchMock = vi.fn();
			vi.stubGlobal('fetch', fetchMock);

			await expect(executor.cancel()).resolves.toBe(false);

			expect(fetchMock).not.toHaveBeenCalled();
			expect(executor.getProgress().status).toBe(status);
			expect(statusChanges).toEqual([]);
		}
	);
});
