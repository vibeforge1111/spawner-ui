import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted(() => ({
	MCP_API_KEY: 'dispatch-authority-route-test-secret',
	EVENTS_API_KEY: ''
}));

vi.mock('$env/dynamic/private', () => ({
	env: privateEnv
}));

vi.mock('$lib/server/provider-runtime', () => ({
	providerRuntime: {
		getMissionStatus: vi.fn(() => ({
			providers: {},
			snapshotAvailable: false,
			allComplete: false
		})),
		cancelMission: vi.fn(async () => undefined),
		dispatch: vi.fn(async ({ executionPack }) => ({
			success: true,
			missionId: executionPack.missionId,
			sessions: { codex: { status: 'running' } },
			startedAt: '2026-05-31T00:00:00.000Z'
		}))
	}
}));

import { DELETE, GET, POST } from './+server';
import { providerRuntime } from '$lib/server/provider-runtime';
import {
	buildServerGovernorDecisionAuthority,
	buildServerTurnIntentVNextAuthority
} from '$lib/server/harness-authority';

const TEST_API_KEY = 'dispatch-authority-route-test-secret';
const originalMcpApiKey = process.env.MCP_API_KEY;

const executionPack = {
	enabled: true,
	strategy: 'single',
	primaryProviderId: 'codex',
	providers: [
		{
			id: 'codex',
			label: 'Codex',
			model: 'gpt-5.5',
			enabled: true,
			kind: 'terminal_cli',
			eventSource: 'codex',
			requiresApiKey: false
		}
	],
	assignments: {},
	mcpTaskPlans: {},
	blockedTaskIds: [],
	masterPrompt: '# Mission: Authority Probe',
	providerPrompts: {},
	launchCommands: {},
	createdAt: '2026-05-31T00:00:00.000Z',
	missionId: 'mission-authority-probe'
};

function event(body: unknown, method = 'POST', url = 'http://127.0.0.1:3333/api/dispatch') {
	return {
		request: new Request(url, {
			method,
			headers: { 'content-type': 'application/json', 'x-api-key': TEST_API_KEY },
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		url: new URL(url),
		getClientAddress: () => '127.0.0.1'
	};
}

function machineAuthority() {
	return {
		schema: 'spark.machine_origin_policy.v1',
		origin: 'spawner-ui.test',
		source: 'dispatch_authority_test',
		reason: 'Focused dispatch authority regression.',
		allowedTools: ['spawner.dispatch'],
		mutationClassesAllowed: ['launches_mission'],
		networkPolicy: 'local_only'
	};
}

describe('/api/dispatch authority contract', () => {
	beforeEach(() => {
		process.env.MCP_API_KEY = TEST_API_KEY;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		if (originalMcpApiKey === undefined) {
			delete process.env.MCP_API_KEY;
		} else {
			process.env.MCP_API_KEY = originalMcpApiKey;
		}
	});

	it('blocks provider dispatch when no TurnIntent or machine-origin policy is present', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(event({ executionPack }) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('blocks legacy machine-origin policy for provider dispatch', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(event({
			executionPack,
			executionAuthority: machineAuthority()
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('legacy_machine_origin_demoted');
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('blocks bare TurnIntentEnvelopeVNext authority for provider dispatch', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(event({
			executionPack,
			executionAuthority: buildServerTurnIntentVNextAuthority({
				source: 'dispatch-authority-test',
				reason: 'User started provider dispatch from Spawner.',
				toolName: 'spawner.dispatch',
				mutationClass: 'launches_mission',
				target: executionPack.missionId
			})
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority).toMatchObject({
			source: 'turn_intent_vnext',
			reasonCodes: expect.arrayContaining(['native_governor_required'])
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('allows provider dispatch with native GovernorDecisionV1 authority', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();
		const requestId = 'request-authority-probe';

		const response = await POST(event({
			executionPack,
			relay: { requestId },
			executionAuthority: buildServerGovernorDecisionAuthority({
				source: 'dispatch-authority-test',
				reason: 'User started provider dispatch from Spawner.',
				toolName: 'spawner.dispatch',
				mutationClass: 'launches_mission',
				requestId,
				target: executionPack.missionId
			})
		}) as never);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.success).toBe(true);
		expect(body.authority).toMatchObject({
			allowed: true,
			source: 'governor_decision',
			governorOutcome: 'execute'
		});
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
			authorityRequestId: requestId
		}));
	});

	it('does not disclose provider failures through a 500 response', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockRejectedValueOnce(new Error('redis://10.0.0.8:6379 /private/runtime.ts'));
		const internalError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const requestId = 'request-dispatch-error-proof';

		const response = await POST(event({
			executionPack,
			relay: { requestId },
			executionAuthority: buildClientGovernorDecisionAuthority({
				source: 'dispatch-authority-test',
				reason: 'Exercise the dispatch error boundary.',
				toolName: 'spawner.dispatch',
				mutationClass: 'launches_mission',
				requestId,
				target: executionPack.missionId
			})
		}) as never);
		const body = await response.json();

		expect(response.status).toBe(500);
		expect(body).toEqual({ success: false, error: 'Internal dispatch error' });
		expect(JSON.stringify(body)).not.toContain('redis');
		expect(JSON.stringify(body)).not.toContain('runtime.ts');
		expect(internalError).toHaveBeenCalledWith(
			'[Dispatch API] POST error:',
			'redis://10.0.0.8:6379 /private/runtime.ts'
		);
	});

	it('blocks browser relay dispatch when requestId is missing from the binding', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(event({
			executionPack,
			relay: { autoRun: true },
			executionAuthority: buildServerGovernorDecisionAuthority({
				source: 'dispatch-authority-test',
				reason: 'User started provider dispatch from Spawner.',
				toolName: 'spawner.dispatch',
				mutationClass: 'launches_mission',
				target: executionPack.missionId
			})
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('dispatch_authority_unbound');
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('blocks replayed Governor authority when relay requestId does not match', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(event({
			executionPack,
			relay: { requestId: 'request-b' },
			executionAuthority: buildServerGovernorDecisionAuthority({
				source: 'dispatch-authority-test',
				reason: 'User started provider dispatch from Spawner.',
				toolName: 'spawner.dispatch',
				mutationClass: 'launches_mission',
				requestId: 'request-a',
				target: executionPack.missionId
			})
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('request_id_mismatch');
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('blocks provider cancellation without native mission-control authority', async () => {
		const cancelMission = vi.mocked(providerRuntime.cancelMission);
		cancelMission.mockClear();

		const response = await DELETE(event(
			undefined,
			'DELETE',
			'http://127.0.0.1:3333/api/dispatch?missionId=mission-authority-probe'
		) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
		expect(cancelMission).not.toHaveBeenCalled();
	});

	it('allows provider cancellation with native mission-control authority', async () => {
		const cancelMission = vi.mocked(providerRuntime.cancelMission);
		cancelMission.mockClear();
		const executionAuthority = buildServerGovernorDecisionAuthority({
			source: 'dispatch-cancel-authority-test',
			reason: 'User cancelled provider dispatch from Spawner.',
			toolName: 'spawner.mission_control.command',
			mutationClass: 'controls_mission',
			target: executionPack.missionId
		});

		const response = await DELETE(event(
			{ executionAuthority },
			'DELETE',
			'http://127.0.0.1:3333/api/dispatch?missionId=mission-authority-probe'
		) as never);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.success).toBe(true);
		expect(body.authority).toMatchObject({
			allowed: true,
			source: 'governor_decision',
			governorOutcome: 'execute'
		});
		expect(cancelMission).toHaveBeenCalledWith('mission-authority-probe', 'Mission cancelled', executionAuthority);
	});

	it('bounds unexpected provider status failures', async () => {
		vi.mocked(providerRuntime.getMissionStatus).mockImplementationOnce(() => {
			throw new Error('redis://10.0.0.8:6379 /private/provider-status.ts');
		});
		const internalError = vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await GET(event(
			undefined,
			'GET',
			'http://127.0.0.1:3333/api/dispatch?missionId=mission-authority-probe'
		) as never);

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({ error: 'Internal dispatch error' });
		expect(internalError).toHaveBeenCalledWith(
			'[Dispatch API] GET error:',
			'redis://10.0.0.8:6379 /private/provider-status.ts'
		);
	});

	it('bounds unexpected provider cancellation failures', async () => {
		vi.mocked(providerRuntime.cancelMission).mockRejectedValueOnce(
			new Error('redis://10.0.0.8:6379 /private/provider-cancel.ts')
		);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const executionAuthority = buildClientGovernorDecisionAuthority({
			source: 'dispatch-cancel-authority-test',
			reason: 'Exercise the cancellation error boundary.',
			toolName: 'spawner.mission_control.command',
			mutationClass: 'controls_mission',
			target: executionPack.missionId
		});

		const response = await DELETE(event(
			{ executionAuthority },
			'DELETE',
			'http://127.0.0.1:3333/api/dispatch?missionId=mission-authority-probe'
		) as never);

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			success: false,
			error: 'Internal dispatch error'
		});
	});
});
