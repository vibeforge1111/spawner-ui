import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const testState = vi.hoisted(() => {
	const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
	const tempRoot = process.env.TMPDIR || process.env.TEMP || process.env.TMP || process.cwd();
	const spawnerStateDir = `${tempRoot}/spawner-ui-mission-control-relay-test-${process.pid}-${Date.now()}`;
	process.env.SPAWNER_STATE_DIR = spawnerStateDir;
	return { originalSpawnerStateDir, spawnerStateDir };
});

import {
	buildSparkMissionControlEvent,
	compareMissionControlEntriesByLastUpdatedDesc,
	getMissionControlPersistPath,
	getMissionControlBoard,
	getMissionControlRelaySnapshot,
	relayMissionControlEvent,
	selectWebhookUrlsForMissionEvent,
	shouldRelayMissionControlEvent,
	summarizeMissionControlEvent
} from './mission-control-relay';
import {
	AGENT_EVENT_SCHEMA_VERSION,
	readRecentAgentEvents
} from './agent-event-ledger';

function freshIso(offsetMs = 0): string {
	return new Date(Date.now() + offsetMs).toISOString();
}

describe('mission-control-relay', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
	});

	afterAll(() => {
		if (testState.originalSpawnerStateDir === undefined) {
			delete process.env.SPAWNER_STATE_DIR;
		} else {
			process.env.SPAWNER_STATE_DIR = testState.originalSpawnerStateDir;
		}
		rmSync(testState.spawnerStateDir, { recursive: true, force: true });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('filters unsupported event types', () => {
		expect(shouldRelayMissionControlEvent({ type: 'debug_noise' })).toBe(false);
		expect(shouldRelayMissionControlEvent({ type: 'task_completed' })).toBe(true);
	});

	it('does not relay self-originated spawner-ui events', () => {
		expect(shouldRelayMissionControlEvent({ type: 'mission_started', source: 'spawner-ui' })).toBe(false);
	});

	it('records self-originated canvas events for Kanban without relaying them externally', async () => {
		const missionId = `mission-canvas-local-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			source: 'spawner-ui',
			data: {
				mission: {
					name: 'Canvas-created Galaxy Garden'
				}
			}
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			source: 'spawner-ui',
			data: {
				taskId: 'TAS-1',
				taskName: 'Create static app shell',
				skills: ['frontend']
			}
		});

		expect(shouldRelayMissionControlEvent({ type: 'mission_created', missionId, source: 'spawner-ui' })).toBe(false);

		const board = getMissionControlBoard();
		const entry = board.running.find((candidate) => candidate.missionId === missionId);
		expect(entry?.missionName).toBe('Canvas-created Galaxy Garden');
		expect(entry?.taskNames).toContain('Create static app shell');
		expect(entry?.tasks[0]).toEqual({
			title: 'Create static app shell',
			skills: ['frontend'],
			status: 'running'
		});
		expect(entry?.taskStatusCounts).toMatchObject({ running: 1, completed: 0, failed: 0, total: 1 });
	});

	it('carries creator execution policy into board entries', async () => {
		const missionId = `mission-creator-read-only-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Creator Mission: Startup YC',
			source: 'creator-mission',
			data: {
				requestId: 'req-read-only',
				executionPolicy: 'read_only',
				plannedTasks: [{ title: 'Create creator intent packet', skills: ['creator'] }]
			}
		});

		const board = getMissionControlBoard();
		const entry = Object.values(board).flat().find((candidate) => candidate.missionId === missionId);
		expect(entry?.executionPolicy).toBe('read_only');
	});

	it('keeps relay state when creator trace synchronization fails', async () => {
		const missionId = `mission-creator-trace-sync-failure-${Date.now()}`;
		const creatorDir = path.join(testState.spawnerStateDir, 'creator-missions');
		const tracePath = path.join(creatorDir, `${missionId}.json`);
		mkdirSync(creatorDir, { recursive: true });
		writeFileSync(
			tracePath,
			JSON.stringify({
				schema_version: 'spark-creator-mission-trace.v1',
				mission_id: missionId,
				current_stage: 'dispatch_ready',
				stage_status: 'ready',
				created_at: freshIso(-1000),
				updated_at: freshIso(-1000),
				repo_changes: [],
				benchmarks: [],
				artifact_manifests: [],
				validation_runs: []
			})
		);
		mkdirSync(`${tracePath}.tmp`);
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await expect(
			relayMissionControlEvent({
				type: 'mission_started',
				missionId,
				source: 'creator-mission'
			})
		).resolves.toBeUndefined();

		expect(getMissionControlRelaySnapshot(missionId).recent).toHaveLength(1);
		expect(warning).toHaveBeenCalledWith(
			'[MissionControlRelay] creator trace sync failed (best-effort):',
			expect.any(Error)
		);
	});

	it('deduplicates repeated lifecycle status events while preserving actual transitions', async () => {
		const missionId = `mission-lifecycle-dedupe-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'task-ui',
			taskName: 'Build the UI',
			source: 'codex',
			timestamp: freshIso(),
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'task-ui',
			taskName: 'Build the UI',
			source: 'codex',
			timestamp: freshIso(1_000),
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_completed',
			missionId,
			taskId: 'task-ui',
			taskName: 'Build the UI',
			source: 'codex',
			timestamp: freshIso(10_000),
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_completed',
			missionId,
			taskId: 'task-ui',
			taskName: 'Build the UI',
			source: 'codex',
			timestamp: freshIso(11_000),
			data: { telegramRelay: { port: 1 } }
		});

		const snapshot = getMissionControlRelaySnapshot(missionId);
		expect(snapshot.recent.map((entry) => entry.eventType)).toEqual(['task_completed', 'task_started']);

		const board = getMissionControlBoard();
		const entry = board.running.find((candidate) => candidate.missionId === missionId);
		expect(entry?.taskStatusCounts).toMatchObject({
			completed: 1,
			running: 0,
			failed: 0,
			total: 1
		});
	});

	it('preserves the queued timestamp after a mission moves into progress', async () => {
		const missionId = `mission-queued-lifecycle-${Date.now()}`;
		const queuedAt = freshIso();
		const startedAt = freshIso(5_000);

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Spark Queue Visibility',
			source: 'telegram',
			timestamp: queuedAt,
			data: {
				plannedTasks: [{ title: 'Plan the canvas', skills: ['mission-control'] }],
				telegramRelay: { port: 1 }
			}
		});

		let board = getMissionControlBoard();
		const created = board.created.find((candidate) => candidate.missionId === missionId);
		expect(created?.queuedAt).toBe(queuedAt);
		expect(created?.executionStarted).toBe(false);
		expect(created?.lastSummary).toContain('Spark Queue Visibility entered To do');

		await relayMissionControlEvent({
			type: 'mission_started',
			missionId,
			missionName: 'Spark Queue Visibility',
			source: 'canvas-dispatch',
			timestamp: startedAt,
			data: { telegramRelay: { port: 1 } }
		});

		board = getMissionControlBoard();
		const running = board.running.find((candidate) => candidate.missionId === missionId);
		expect(running?.queuedAt).toBe(queuedAt);
		expect(running?.startedAt).toBe(startedAt);
		expect(running?.executionStarted).toBe(true);
		expect(running?.taskStatusCounts).toMatchObject({ queued: 1, running: 0, completed: 0, total: 1 });
	});

	it('does not add provider-level completion events as anonymous board tasks', async () => {
		const missionId = `mission-provider-completion-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'task_completed',
			missionId,
			source: 'codex',
			message: 'Codex completed with final response',
			data: {
				provider: 'codex',
				response: 'done',
				telegramRelay: { port: 8789, profile: 'spark-agi' }
			}
		});
		await relayMissionControlEvent({
			type: 'mission_completed',
			missionId,
			source: 'codex',
			data: { telegramRelay: { port: 8789, profile: 'spark-agi' } }
		});

		const board = getMissionControlBoard();
		const entry = board.completed.find((candidate) => candidate.missionId === missionId);
		expect(entry?.tasks).toEqual([]);
		expect(entry?.taskStatusCounts).toMatchObject({ completed: 0, total: 0 });
	});

	it('projects provider/model proof into the agent ledger without response bodies', async () => {
		const missionId = `mission-provider-proof-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'task_completed',
			missionId,
			source: 'codex',
			message: 'Codex completed with final response',
			data: {
				providerId: 'codex',
				model: 'gpt-5.5',
				requestId: 'request-provider-proof',
				traceRef: `trace:spawner-prd:${missionId}`,
				response: 'raw provider output must not enter agent facts'
			}
		});

		const events = readRecentAgentEvents({ sessionId: `mission-control:${missionId}`, limit: 5 });
		expect(events[0]).toMatchObject({
			schema_version: AGENT_EVENT_SCHEMA_VERSION,
			event_type: 'mission_changed_state',
			request_id: 'request-provider-proof',
			trace_ref: `trace:spawner-prd:${missionId}`,
			facts: {
				provider: 'codex',
				providerId: 'codex',
				model: 'gpt-5.5'
			}
		});
		expect(JSON.stringify(events[0].facts)).not.toContain('raw provider output');
	});

	it('deduplicates task labels that differ only by generated T-prefixes', async () => {
		const missionId = `mission-task-prefix-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'task_completed',
			missionId,
			source: 'codex',
			taskId: 'node-1',
			taskName: 'T1: Scaffold static Mission Control app'
		});
		await relayMissionControlEvent({
			type: 'task_completed',
			missionId,
			source: 'codex',
			taskId: 'node-1',
			taskName: 'Scaffold static Mission Control app'
		});

		const board = getMissionControlBoard();
		const entry = board.running.find((candidate) => candidate.missionId === missionId);
		expect(entry?.taskCount).toBe(1);
		expect(entry?.taskStatusCounts).toMatchObject({ completed: 1, total: 1 });
	});

	it('seeds planned canvas tasks as queued before task execution starts', async () => {
		const missionId = `mission-planned-tasks-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			source: 'canvas-dispatch',
			data: {
				missionName: 'Planned Task Mission',
				plannedTasks: [
					{ title: 'Create app shell', skills: ['frontend-engineer'] },
					{ title: 'Wire interactions', skills: ['state-management'] }
				]
			}
		});

		let board = getMissionControlBoard();
		let entry = board.created.find((candidate) => candidate.missionId === missionId);
		expect(entry?.taskStatusCounts).toMatchObject({ queued: 2, running: 0, completed: 0, total: 2 });
		expect(entry?.tasks).toEqual([
			{ title: 'Create app shell', skills: ['frontend-engineer'], status: 'queued' },
			{ title: 'Wire interactions', skills: ['state-management'], status: 'queued' }
		]);

		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			source: 'codex',
			taskName: 'Create app shell'
		});

		board = getMissionControlBoard();
		entry = board.running.find((candidate) => candidate.missionId === missionId);
		expect(entry?.taskStatusCounts).toMatchObject({ queued: 1, running: 1, completed: 0, total: 2 });

		await relayMissionControlEvent({
			type: 'task_completed',
			missionId,
			source: 'codex',
			taskName: 'Create app shell'
		});

		board = getMissionControlBoard();
		entry = board.running.find((candidate) => candidate.missionId === missionId);
		expect(entry?.taskStatusCounts).toMatchObject({ queued: 1, running: 0, completed: 1, total: 2 });
	});

	it('keeps creator planning task events separate from provider execution start', async () => {
		const missionId = `mission-creator-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Creator Mission: Startup YC',
			source: 'creator-mission',
			timestamp: freshIso(),
			data: {
				plannedTasks: [
					{ title: 'Lock Startup YC creator intent and task graph', skills: ['creator-system'] },
					{ title: 'Build Startup YC benchmark pack', skills: ['benchmark-designer'] }
				]
			}
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskName: 'Lock Startup YC creator intent and task graph',
			source: 'creator-mission',
			timestamp: freshIso(1_000)
		});
		await relayMissionControlEvent({
			type: 'task_completed',
			missionId,
			taskName: 'Lock Startup YC creator intent and task graph',
			source: 'creator-mission',
			timestamp: freshIso(2_000)
		});

		const board = getMissionControlBoard();
		const entry = board.running.find((candidate) => candidate.missionId === missionId);
		expect(entry?.executionStarted).toBe(false);
		expect(entry?.taskStatusCounts).toMatchObject({ queued: 1, completed: 1, total: 2 });
	});

	it('keeps read-only creator planning events out of the running bucket', async () => {
		const missionId = `mission-creator-read-only-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			missionName: 'Creator Mission: Startup YC',
			taskName: 'Lock Startup YC creator intent and task graph',
			source: 'creator-mission',
			timestamp: freshIso(),
			data: {
				executionPolicy: 'read_only',
				plannedTasks: [
					{ title: 'Lock Startup YC creator intent and task graph', skills: ['creator-system'] },
					{ title: 'Build Startup YC benchmark pack', skills: ['benchmark-designer'] }
				]
			}
		});
		await relayMissionControlEvent({
			type: 'task_completed',
			missionId,
			taskName: 'Lock Startup YC creator intent and task graph',
			source: 'creator-mission',
			timestamp: freshIso(1_000),
			data: { executionPolicy: 'read_only' }
		});

		const board = getMissionControlBoard();
		expect(board.running.find((candidate) => candidate.missionId === missionId)).toBeUndefined();
		const entry = board.created.find((candidate) => candidate.missionId === missionId);
		expect(entry?.executionPolicy).toBe('read_only');
		expect(entry?.executionStarted).toBe(false);
		expect(entry?.taskStatusCounts).toMatchObject({ queued: 1, completed: 1, total: 2 });
	});

	it('merges slug task events with planned task titles instead of duplicating board rows', async () => {
		const missionId = `mission-slug-task-merge-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			source: 'canvas-dispatch',
			data: {
				missionName: 'Memory Quality Dashboard',
				plannedTasks: [
					{
						title: 'memory-quality-prd-architecture: Lock the compact PRD and route architecture',
						skills: ['docs-engineer']
					},
					{
						title: 'memory-quality-data-model-loader: Implement file-backed memory quality data service',
						skills: ['state-management']
					}
				]
			}
		});

		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			source: 'codex',
			taskName: 'memory-quality-prd-architecture'
		});

		const board = getMissionControlBoard();
		const entry = board.running.find((candidate) => candidate.missionId === missionId);
		expect(entry?.taskStatusCounts).toMatchObject({ queued: 1, running: 1, total: 2 });
		expect(entry?.taskNames).toEqual([
			'memory-quality-prd-architecture: Lock the compact PRD and route architecture',
			'memory-quality-data-model-loader: Implement file-backed memory quality data service'
		]);
	});

	it('does not relay diagnostic-only Spark run events', () => {
		expect(
			shouldRelayMissionControlEvent({
				type: 'mission_started',
				source: 'spark-run',
				data: { suppressRelay: true }
			})
		).toBe(false);
	});

	it('keeps suppressRelay events on the local board while skipping external relay', async () => {
		const missionId = `mission-local-progress-${Date.now()}`;
		const event = {
			type: 'task_progress',
			missionId,
			taskName: 'Provider execution',
			source: 'codex',
			progress: 42,
			data: { suppressRelay: true }
		};

		expect(shouldRelayMissionControlEvent(event)).toBe(false);

		await relayMissionControlEvent(event);
		const snapshot = getMissionControlRelaySnapshot(missionId);
		const entry = snapshot.recent.find((candidate) => candidate.missionId === missionId);

		expect(entry?.eventType).toBe('task_progress');
		expect(entry?.taskName).toBe('Provider execution');
		expect(entry?.progress).toBe(42);
	});

	it('can keep local board events while skipping external relays', async () => {
		const missionId = `mission-local-only-relay-${Date.now()}`;
		const event = {
			type: 'task_completed',
			missionId,
			taskName: 'Run creator validation gates',
			source: 'creator-mission',
			data: { suppressExternalRelay: true }
		};

		expect(shouldRelayMissionControlEvent(event)).toBe(false);

		await relayMissionControlEvent(event);
		const board = getMissionControlBoard();
		const entry = board.running.find((candidate) => candidate.missionId === missionId);

		expect(entry?.taskNames).toContain('Run creator validation gates');
		expect(entry?.taskStatusCounts).toMatchObject({ completed: 1, total: 1 });
	});

	it('persists Mission Control state under configured Spawner state directory', () => {
		const previous = process.env.SPAWNER_STATE_DIR;
		process.env.SPAWNER_STATE_DIR = 'C:\\spark-state\\spawner-ui';
		try {
			expect(getMissionControlPersistPath()).toBe('C:\\spark-state\\spawner-ui\\mission-control.json');
		} finally {
			if (previous === undefined) {
				delete process.env.SPAWNER_STATE_DIR;
			} else {
				process.env.SPAWNER_STATE_DIR = previous;
			}
		}
	});

	it('routes Telegram mission events only to the originating relay port', () => {
		const urls = [
			'http://127.0.0.1:8788/spawner-events',
			'http://127.0.0.1:8789/spawner-events'
		];

		expect(
			selectWebhookUrlsForMissionEvent({
				type: 'mission_started',
				missionId: 'spark-1',
				data: { telegramRelay: { port: 8789, profile: 'primary' } }
			}, urls)
		).toEqual(['http://127.0.0.1:8789/spawner-events']);
	});

	it('prefers an explicit Telegram relay URL over a matching port', () => {
		const urls = [
			'http://127.0.0.1:8788/spawner-events',
			'http://127.0.0.1:8789/spawner-events'
		];

		expect(
			selectWebhookUrlsForMissionEvent({
				type: 'mission_started',
				missionId: 'spark-url-target',
				data: {
					telegramRelay: {
						url: 'http://127.0.0.1:8788/spawner-events',
						port: 8789,
						profile: 'primary'
					}
				}
			}, urls)
		).toEqual(['http://127.0.0.1:8788/spawner-events']);
	});

	it('keeps legacy broadcast behavior when no Telegram relay target is present', () => {
		const urls = [
			'http://127.0.0.1:8788/spawner-events',
			'http://127.0.0.1:8789/spawner-events'
		];

		expect(
			selectWebhookUrlsForMissionEvent({
				type: 'mission_started',
				missionId: 'spark-1'
			}, urls)
		).toEqual(urls);
	});

	it('builds a valid SparkEventV1 payload', () => {
		const payload = buildSparkMissionControlEvent({
			id: 'evt-123',
			type: 'task_completed',
			missionId: 'mission-1',
			taskId: 'task-8',
			taskName: 'Build connector',
			source: 'claude-code',
			message: 'done',
			data: { traceRef: 'trace:spawner-prd:mission-1' }
		});

		expect(payload.v).toBe(1);
		expect(payload.source).toBe('spawner-ui');
		expect(payload.kind).toBe('system');
		expect(payload.session_id).toBe('mission-control:mission-1');
		expect(payload.trace_id).toBe('evt-123');
		expect((payload.payload as Record<string, unknown>).mission_event_type).toBe('task_completed');
		expect((payload.payload as Record<string, unknown>).trace_ref).toBe('trace:spawner-prd:mission-1');
		expect(((payload.payload as Record<string, unknown>).meta as Record<string, unknown>).trace_ref).toBe('trace:spawner-prd:mission-1');
		expect((payload.payload as Record<string, unknown>).summary).toContain('Build connector is done.');
	});

	it('preserves Telegram relay target metadata in Spark ingest payloads', () => {
		const payload = buildSparkMissionControlEvent({
			id: 'evt-relay-target',
			type: 'mission_started',
			missionId: 'spark-relay-target',
			source: 'spark-run',
			data: {
				goal: 'Build through Telegram and show the Kanban board.',
				telegramRelay: { port: 8788, profile: 'primary' }
			}
		});
		const body = payload.payload as Record<string, unknown>;
		const data = body.data as Record<string, unknown>;
		const event = body.event as Record<string, unknown>;

		expect(data.telegramRelay).toEqual({ port: 8788, profile: 'primary', url: null });
		expect((event.data as Record<string, unknown>).telegramRelay).toEqual({
			port: 8788,
			profile: 'primary',
			url: null
		});
		expect(body.raw).toBeUndefined();
	});

	it('preserves canonical PRD completion metadata in external relay payloads', () => {
		const payload = buildSparkMissionControlEvent({
			id: 'evt-canonical-prd-complete',
			type: 'mission_completed',
			missionId: 'mission-canonical-prd-complete',
			source: 'prd-bridge',
			data: {
				requestId: 'tg-build-canonical-prd-complete',
				traceRef: 'trace:spawner-prd:mission-canonical-prd-complete',
				buildMode: 'direct',
				buildLane: 'fast_direct',
				provider: 'deterministic-fast-lane',
				providerProcessSuccess: true,
				canonicalResultAvailable: true,
				autoAnalysisStatus: 'complete',
				durationMs: 12,
				resultFileName: 'tg-build-canonical-prd-complete.json',
				telegramRelay: { port: 8791, profile: 'spark-recursive' }
			}
		});
		const body = payload.payload as Record<string, unknown>;
		const data = body.data as Record<string, unknown>;
		const event = body.event as Record<string, unknown>;
		const eventData = event.data as Record<string, unknown>;

		expect(data).toMatchObject({
			requestId: 'tg-build-canonical-prd-complete',
			traceRef: 'trace:spawner-prd:mission-canonical-prd-complete',
			provider: 'deterministic-fast-lane',
			providerProcessSuccess: true,
			canonicalResultAvailable: true,
			autoAnalysisStatus: 'complete',
			durationMs: 12
		});
		expect(eventData).toMatchObject({
			requestId: 'tg-build-canonical-prd-complete',
			traceRef: 'trace:spawner-prd:mission-canonical-prd-complete',
			provider: 'deterministic-fast-lane',
			providerProcessSuccess: true,
			canonicalResultAvailable: true,
			autoAnalysisStatus: 'complete',
			durationMs: 12,
			telegramRelay: { port: 8791, profile: 'spark-recursive', url: null }
		});
		expect(data.resultFileName).toBeUndefined();
		expect(eventData.resultFileName).toBeUndefined();
	});

	it('redacts private local data from external Spark ingest payloads', () => {
		const payload = buildSparkMissionControlEvent({
			id: 'evt-redacted',
			type: 'provider_feedback',
			missionId: 'mission-redacted',
			taskId: 'task-private',
			taskName: 'Wire mobile view',
			source: 'spark-run',
			message:
				'Using C:\\Users\\USER\\Desktop\\private-app with token 123456:abcdefghijklmnopqrstuvwxyz123456 and preview http://127.0.0.1:5555/preview/private.',
			data: {
				projectId: 'project-safe-id',
				projectPath: 'C:\\Users\\USER\\Desktop\\private-app',
				previewUrl: 'http://127.0.0.1:5555/preview/private',
				prompt: 'Full Telegram prompt should stay local.',
				output: 'Full model output should stay local.',
				env: { BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz123456' },
				plannedTasks: [{ title: 'Build C:\\Users\\USER\\Desktop\\private-app shell', skills: ['frontend'] }],
				telegramRelay: {
					port: 8788,
					profile: 'primary',
					url: 'http://127.0.0.1:8788/spawner-events'
				}
			}
		});
		const body = payload.payload as Record<string, unknown>;
		const serialized = JSON.stringify(body);
		const data = body.data as Record<string, unknown>;
		const event = body.event as Record<string, unknown>;

		expect(data.projectId).toBe('project-safe-id');
		expect(data.projectPath).toBeUndefined();
		expect(data.previewUrl).toBeUndefined();
		expect(data.prompt).toBeUndefined();
		expect(data.output).toBeUndefined();
		expect(data.env).toBeUndefined();
		expect(data.telegramRelay).toEqual({ port: 8788, profile: 'primary', url: null });
		expect(event.data).toEqual(data);
		expect(serialized).not.toContain('C:\\Users\\USER\\Desktop\\private-app');
		expect(serialized).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
		expect(serialized).not.toContain('http://127.0.0.1:5555');
		expect(serialized).not.toContain('Full Telegram prompt');
	});

	it('adds mobile-safe Mission Control access metadata to external payloads', () => {
		const previous = process.env.SPAWNER_MISSION_CONTROL_PUBLIC_URL;
		process.env.SPAWNER_MISSION_CONTROL_PUBLIC_URL = 'https://mission.sparkswarm.ai';
		try {
			const payload = buildSparkMissionControlEvent({
				id: 'evt-mobile-access',
				type: 'mission_started',
				missionId: 'mission-mobile-access',
				source: 'spark-run'
			});
			const body = payload.payload as Record<string, unknown>;
			const data = body.data as Record<string, unknown>;
			const meta = body.meta as Record<string, unknown>;
			const access = data.missionControlAccess as Record<string, unknown>;

			expect(access).toMatchObject({
				mode: 'hosted',
				url: 'https://mission.sparkswarm.ai/missions/mission-mobile-access',
				mobileReachable: true
			});
			expect(meta.mission_control_access).toEqual(access);
		} finally {
			if (previous === undefined) {
				delete process.env.SPAWNER_MISSION_CONTROL_PUBLIC_URL;
			} else {
				process.env.SPAWNER_MISSION_CONTROL_PUBLIC_URL = previous;
			}
		}
	});

	it('keeps Telegram relay target metadata in relay snapshots and board entries', async () => {
		const missionId = `mission-relay-target-board-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_started',
			missionId,
			source: 'spark-run',
			data: {
				telegramRelay: { port: 8789, profile: 'primary', url: 'http://127.0.0.1:8789/spawner-events' }
			}
		});

		const snapshot = getMissionControlRelaySnapshot(missionId);
		expect(snapshot.recent[0].telegramRelay).toEqual({
			port: 8789,
			profile: 'primary',
			url: 'http://127.0.0.1:8789/spawner-events'
		});
		expect(snapshot.recent[0].missionControlAccess).toMatchObject({
			mode: 'local-only',
			url: null,
			mobileReachable: false
		});

		const board = getMissionControlBoard();
		const entry = board.running.find((candidate) => candidate.missionId === missionId);
		expect(entry?.telegramRelay).toEqual({
			port: 8789,
			profile: 'primary',
			url: 'http://127.0.0.1:8789/spawner-events'
		});
		expect(entry?.missionControlAccess).toMatchObject({
			mode: 'local-only',
			url: null,
			mobileReachable: false
		});
	});

	it('preserves shipped-project lineage metadata on snapshots and Kanban board entries', async () => {
		const missionId = `mission-lineage-${Date.now()}`;
		const projectPath = 'C:\\Users\\USER\\Desktop\\founder-signal-room';

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Founder Signal Room polish 2',
			source: 'spark-run',
			message: 'Queued a polish pass',
			data: {
				projectId: 'project-founder-signal-room',
				projectPath,
				previewUrl: 'http://127.0.0.1:5555/preview/token/index.html',
				parentMissionId: 'mission-parent-1',
				iterationNumber: 2,
				improvementFeedback: 'Make this more Spark colored.',
				telegramRelay: { port: 1 }
			}
		});

		const snapshot = getMissionControlRelaySnapshot(missionId);
		expect(snapshot.recent[0].projectLineage).toEqual({
			projectId: 'project-founder-signal-room',
			projectPath,
			previewUrl: 'http://127.0.0.1:5555/preview/token/index.html',
			parentMissionId: 'mission-parent-1',
			iterationNumber: 2,
			improvementFeedback: 'Make this more Spark colored.'
		});

		const board = getMissionControlBoard();
		const entry = board.created.find((candidate) => candidate.missionId === missionId);
		expect(entry?.projectLineage).toEqual(snapshot.recent[0].projectLineage);
	});

	it('recovers improvement lineage from Telegram goal text when explicit fields are absent', async () => {
		const missionId = `mission-lineage-text-${Date.now()}`;
		const projectPath = 'C:\\Users\\USER\\Desktop\\founder-signal-room';

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Founder Signal Room polish 3',
			source: 'spark-run',
			data: {
				goal: [
					`Improve the existing shipped project "Founder Signal Room" at ${projectPath}.`,
					'',
					'This is an iteration on an already shipped app, not a new scaffold.',
					'',
					'User feedback:',
					'make this more Spark colored and make the strategy document feel more alive',
					'',
					'Rules:',
					'- Read the existing project files before editing.',
					'',
					'Project context:',
					'- Parent mission: mission-parent-2',
					'- Current preview: http://127.0.0.1:5556/preview/example/index.html'
				].join('\n')
			}
		});

		const board = getMissionControlBoard();
		const entry = board.created.find((candidate) => candidate.missionId === missionId);

		expect(entry?.projectLineage).toMatchObject({
			projectPath,
			parentMissionId: 'mission-parent-2',
			iterationNumber: 3,
			previewUrl: 'http://127.0.0.1:5556/preview/example/index.html',
			improvementFeedback: 'make this more Spark colored and make the strategy document feel more alive'
		});
		expect(entry?.projectLineage?.projectId).toMatch(/^project-founder-signal-room-[a-f0-9]{10}$/);
	});

	it('keeps richer lineage when newer progress events carry partial feedback', async () => {
		const missionId = `mission-lineage-merge-${Date.now()}`;
		const fullFeedback = 'make the Loop Lantern preview feel more Spark colored and keep the same app';

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Loop Lantern polish 2',
			source: 'prd-bridge',
			data: {
				projectPath: 'C:/Users/USER/Desktop/loop-lantern',
				parentMissionId: 'mission-original-loop',
				iterationNumber: 2,
				improvementFeedback: fullFeedback
			}
		});

		await relayMissionControlEvent({
			type: 'progress',
			missionId,
			source: 'codex',
			message: 'make the',
			data: {
				projectPath: 'C:/Users/USER/Desktop/loop-lantern',
				iterationNumber: 2,
				improvementFeedback: 'make the'
			}
		});

		const board = getMissionControlBoard();
		const entry = [...board.running, ...board.created].find((candidate) => candidate.missionId === missionId);
		expect(entry?.projectLineage).toMatchObject({
			parentMissionId: 'mission-original-loop',
			iterationNumber: 2,
			improvementFeedback: fullFeedback
		});
	});

	it('does not replace user feedback with longer status-derived progress text', async () => {
		const missionId = `mission-lineage-status-noise-${Date.now()}`;
		const fullFeedback =
			'make the Loop Lantern preview feel more Spark colored and make the next polish pass section more alive, but keep the same app and do not rebuild from scratch';
		const statusFeedback =
			'make the Loop Lantern preview feel more Spark colored and make the Preview URL returned 200; JS syntax passed; previous workflow and focused polish card checks passed in static DOM/localStorage harness.';

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Loop Lantern polish 2',
			source: 'prd-bridge',
			data: {
				projectPath: 'C:/Users/USER/Desktop/loop-lantern',
				parentMissionId: 'mission-original-loop',
				iterationNumber: 2,
				improvementFeedback: fullFeedback
			}
		});

		await relayMissionControlEvent({
			type: 'mission_completed',
			missionId,
			source: 'codex',
			data: {
				projectPath: 'C:/Users/USER/Desktop/loop-lantern',
				parentMissionId: 'mission-original-loop',
				iterationNumber: 2,
				improvementFeedback: statusFeedback
			}
		});

		const board = getMissionControlBoard();
		const entry = board.completed.find((candidate) => candidate.missionId === missionId);
		expect(entry?.projectLineage).toMatchObject({
			parentMissionId: 'mission-original-loop',
			iterationNumber: 2,
			improvementFeedback: fullFeedback
		});
	});

	it('creates readable summaries', () => {
		const text = summarizeMissionControlEvent({ type: 'mission_failed', missionId: 'm-22' });
		expect(text).toBe('Mission failed.');
	});

	it('tracks relay snapshot stats and recent entries', async () => {
		await relayMissionControlEvent({
			type: 'mission_started',
			missionId: 'spark-relay-xyz',
			source: 'claude-code',
			data: { telegramRelay: { port: 1 } }
		});

		const filtered = getMissionControlRelaySnapshot('spark-relay-xyz');
		expect(filtered.stats.perMission['spark-relay-xyz']).toBeGreaterThanOrEqual(1);
		expect(filtered.recent.length).toBeGreaterThanOrEqual(1);
		expect(filtered.recent[0].summary).toContain('Mission started');
	});

	it('records mission lifecycle events in the Agent Event Model ledger', async () => {
		const missionId = `mission-agent-ledger-${Date.now()}`;
		const requestId = `request-agent-ledger-${Date.now()}`;
		const traceRef = `trace:spawner-prd:${missionId}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Agent Ledger Mission',
			source: 'spark-run',
			timestamp: freshIso(),
			data: { requestId, traceRef, telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'mission_completed',
			missionId,
			missionName: 'Agent Ledger Mission',
			source: 'codex',
			timestamp: freshIso(10_000),
			data: { requestId, traceRef, telegramRelay: { port: 1 } }
		});

		const snapshot = getMissionControlRelaySnapshot(missionId);
		expect(snapshot.recent[0].traceRef).toBe(traceRef);
		const board = getMissionControlBoard();
		expect(board.completed.find((entry) => entry.missionId === missionId)?.traceRef).toBe(traceRef);

		const events = readRecentAgentEvents({ requestId, limit: 5 });

		expect(events.map((event) => event.facts.mission_event_type)).toEqual([
			'mission_completed',
			'mission_created'
		]);
		expect(events[0]).toMatchObject({
			schema_version: AGENT_EVENT_SCHEMA_VERSION,
			component: 'agent_event_model',
			event_type: 'mission_changed_state',
			request_id: requestId,
			session_id: `mission-control:${missionId}`,
			selected_route: 'mission_control',
			route_confidence: 'high'
		});
		expect(events[0].facts.trace_ref).toBe(traceRef);
		expect(events[0].sources[0]).toMatchObject({
			source: 'mission_trace',
			role: 'work_state_evidence',
			freshness: 'fresh',
			source_ref: missionId
		});
		expect(events[0].changed).toContain(`${missionId}:state=completed`);
	});

	it('does not keep malformed mission ids on the board', async () => {
		await relayMissionControlEvent({
			type: 'mission_paused',
			missionId: 'not-spark-id',
			source: 'telegram',
			data: { telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		expect(board.paused.find((entry) => entry.missionId === 'not-spark-id')).toBeUndefined();
		expect(getMissionControlRelaySnapshot('not-spark-id').recent).toEqual([]);
	});

	it('moves paused missions back to running after a resume event', async () => {
		const missionId = `mission-pause-resume-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_started',
			missionId,
			source: 'codex',
			timestamp: freshIso()
		});
		await relayMissionControlEvent({
			type: 'mission_paused',
			missionId,
			source: 'mission-control',
			timestamp: freshIso(10_000)
		});
		await relayMissionControlEvent({
			type: 'mission_resumed',
			missionId,
			source: 'mission-control',
			timestamp: freshIso(20_000)
		});

		const board = getMissionControlBoard();
		expect(board.paused.find((entry) => entry.missionId === missionId)).toBeUndefined();
		expect(board.running.find((entry) => entry.missionId === missionId)).toMatchObject({
			status: 'running',
			lastEventType: 'mission_resumed',
			executionStarted: true
		});
	});

	it('does not keep stale non-terminal missions on the board', async () => {
		const missionId = `spark-stale-running-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_started',
			missionId,
			source: 'spark-run',
			timestamp: '2000-01-01T00:00:00.000Z',
			data: { telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		expect(board.running.find((entry) => entry.missionId === missionId)).toBeUndefined();
	});

	it('builds a Kanban board view from natural mission progress events', async () => {
		const missionId = `spark-natural-language-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Build a Telegram-led mission canvas',
			source: 'spark-run',
			timestamp: '2026-04-26T10:00:00.000Z',
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'task-plan',
			taskName: 'Turn chat request into mission plan',
			source: 'codex',
			timestamp: '2026-04-26T10:00:05.000Z',
			data: { skills: ['telegram-relay', 'mission-control'], telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'task-build',
			taskName: 'Build Kanban and canvas updates',
			source: 'codex',
			timestamp: '2026-04-26T10:00:15.000Z',
			data: { skills: ['kanban', 'canvas'], telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_progress',
			missionId,
			taskId: 'task-build',
			taskName: 'Build Kanban and canvas updates',
			source: 'codex',
			message: 'Generated cards from the Telegram request.',
			timestamp: '2026-04-26T10:00:25.000Z',
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'mission_completed',
			missionId,
			missionName: 'Build a Telegram-led mission canvas',
			source: 'codex',
			timestamp: '2026-04-26T10:01:00.000Z',
			data: { telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		const entry = board.completed.find((candidate) => candidate.missionId === missionId);

		expect(entry).toBeDefined();
		expect(entry?.lastEventType).toBe('mission_completed');
		expect(entry?.lastSummary).toContain('Mission completed');
		expect(entry?.taskCount).toBe(2);
		expect(entry?.taskStatusCounts).toMatchObject({
			completed: 2,
			running: 0,
			failed: 0,
			cancelled: 0,
			total: 2
		});
		expect(entry?.taskNames).toEqual([
			'Build Kanban and canvas updates',
			'Turn chat request into mission plan'
		]);
		expect(entry?.tasks[0]).toEqual({
			title: 'Build Kanban and canvas updates',
			skills: ['kanban', 'canvas'],
			status: 'completed'
		});
	});

	it('keeps same-provider task start bursts from marking every planned task running', async () => {
		const missionId = `mission-single-provider-burst-${Date.now()}`;
		const plannedTasks = [
			{ title: 'Define booking contracts', skills: ['schema'] },
			{ title: 'Build service menu', skills: ['visual-design'] },
			{ title: 'Wire booking flow', skills: ['forms'] }
		];

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Beauty Centre Website',
			source: 'prd-bridge',
			timestamp: freshIso(),
			data: { plannedTasks, telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'task-1-booking-contracts',
			taskName: 'Define booking contracts',
			source: 'codex',
			timestamp: freshIso(1_000),
			data: { telegramRelay: { port: 1 } }
		});

		expect(
			shouldRelayMissionControlEvent({
				type: 'task_started',
				missionId,
				taskId: 'task-2-service-menu',
				taskName: 'Build service menu',
				source: 'codex',
				data: { telegramRelay: { port: 1 } }
			})
		).toBe(false);

		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'task-2-service-menu',
			taskName: 'Build service menu',
			source: 'codex',
			timestamp: freshIso(1_100),
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'task-3-booking-flow',
			taskName: 'Wire booking flow',
			source: 'codex',
			timestamp: freshIso(1_200),
			data: { telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		const running = board.running.find((candidate) => candidate.missionId === missionId);

		expect(running?.taskStatusCounts).toMatchObject({
			queued: 2,
			running: 1,
			completed: 0,
			total: 3
		});
		expect(running?.tasks).toEqual([
			{ title: 'Define booking contracts', skills: ['schema'], status: 'running' },
			{ title: 'Build service menu', skills: ['visual-design'], status: 'queued' },
			{ title: 'Wire booking flow', skills: ['forms'], status: 'queued' }
		]);
	});

	it('updates the board current task pointer when sequential work moves past the first task', async () => {
		const missionId = `mission-current-task-pointer-${Date.now()}`;
		const plannedTasks = [
			{ title: 'Create the playable game shell', skills: ['frontend'] },
			{ title: 'Design the core play and reasoning loop', skills: ['game-design'] },
			{ title: 'Add scoring and restart', skills: ['state-management'] }
		];

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Recursive Sage Maze Game',
			source: 'prd-bridge',
			timestamp: freshIso(),
			data: { plannedTasks, telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'node-1-task-create-the-playable-game-shell',
			taskName: 'Create the playable game shell',
			source: 'codex',
			timestamp: freshIso(1_000),
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_completed',
			missionId,
			taskId: 'node-1-task-create-the-playable-game-shell',
			taskName: 'Create the playable game shell',
			source: 'codex',
			timestamp: freshIso(2_000),
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'node-2-task-design-the-core-play-and-reasoning-loop',
			taskName: 'Design the core play and reasoning loop',
			source: 'codex',
			timestamp: freshIso(3_000),
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_progress',
			missionId,
			taskId: 'node-1-task-create-the-playable-game-shell',
			taskName: 'Create the playable game shell',
			source: 'codex',
			timestamp: freshIso(4_000),
			message: 'OpenAI Codex is still working through 3 task pack.',
			progress: 70,
			data: { telegramRelay: { port: 1 }, kind: 'provider_heartbeat' }
		});

		const board = getMissionControlBoard();
		const running = board.running.find((candidate) => candidate.missionId === missionId);

		expect(running?.taskName).toBe('Design the core play and reasoning loop');
		expect(running?.taskStatusCounts).toMatchObject({
			completed: 1,
			running: 1,
			queued: 1,
			total: 3
		});
		expect(running?.tasks).toEqual([
			{ title: 'Create the playable game shell', skills: ['frontend'], status: 'completed' },
			{ title: 'Design the core play and reasoning loop', skills: ['game-design'], status: 'running' },
			{ title: 'Add scoring and restart', skills: ['state-management'], status: 'queued' }
		]);
	});

	it('keeps the latest sequential running task when an earlier task never emitted completion', async () => {
		const missionId = `mission-current-task-latest-start-${Date.now()}`;
		const plannedTasks = [
			{ title: 'Create the playable game shell', skills: ['frontend'] },
			{ title: 'Design the core play and reasoning loop', skills: ['game-design'] },
			{ title: 'Add scoring and restart', skills: ['state-management'] }
		];

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			source: 'prd-bridge',
			timestamp: freshIso(),
			data: { plannedTasks, telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'node-1-task-create-the-playable-game-shell',
			taskName: 'Create the playable game shell',
			source: 'codex',
			timestamp: freshIso(1_000),
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'node-2-task-design-the-core-play-and-reasoning-loop',
			taskName: 'Design the core play and reasoning loop',
			source: 'codex',
			timestamp: freshIso(2_000),
			data: { telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		const running = board.running.find((candidate) => candidate.missionId === missionId);

		expect(running?.taskName).toBe('Design the core play and reasoning loop');
		expect(running?.taskStatusCounts).toMatchObject({ queued: 2, running: 1, total: 3 });
		expect(running?.tasks).toEqual([
			{ title: 'Create the playable game shell', skills: ['frontend'], status: 'queued' },
			{ title: 'Design the core play and reasoning loop', skills: ['game-design'], status: 'running' },
			{ title: 'Add scoring and restart', skills: ['state-management'], status: 'queued' }
		]);
	});

	it('allows multiple running tasks when different providers start different steps', async () => {
		const missionId = `mission-parallel-provider-starts-${Date.now()}`;
		const plannedTasks = [
			{ title: 'Build frontend', skills: ['frontend'] },
			{ title: 'Build backend', skills: ['backend'] }
		];

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			source: 'prd-bridge',
			timestamp: freshIso(),
			data: { plannedTasks, telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskName: 'Build frontend',
			source: 'codex',
			timestamp: freshIso(1_000),
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskName: 'Build backend',
			source: 'claude',
			timestamp: freshIso(1_100),
			data: { telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		const running = board.running.find((candidate) => candidate.missionId === missionId);

		expect(running?.taskStatusCounts).toMatchObject({
			queued: 0,
			running: 2,
			total: 2
		});
	});

	it('tracks explicit task completion and failure states on Kanban board entries', async () => {
		const missionId = `mission-task-states-${Date.now()}`;
		const startedAt = freshIso();

		await relayMissionControlEvent({
			type: 'mission_started',
			missionId,
			missionName: 'Build a stateful canvas mission',
			source: 'spark-run',
			timestamp: startedAt,
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'task-shell',
			taskName: 'Create static app shell',
			source: 'codex',
			timestamp: freshIso(5_000),
			data: { skills: ['frontend'], telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_completed',
			missionId,
			taskId: 'task-shell',
			taskName: 'Create static app shell',
			source: 'codex',
			timestamp: freshIso(30_000),
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'task-ui',
			taskName: 'Implement animated UI',
			source: 'codex',
			timestamp: freshIso(40_000),
			data: { skills: ['ui'], telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_failed',
			missionId,
			taskId: 'task-readme',
			taskName: 'Write README smoke test',
			source: 'codex',
			timestamp: freshIso(50_000),
			data: { skills: ['docs'], telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		const entry = board.running.find((candidate) => candidate.missionId === missionId);

		expect(entry?.taskStatusCounts).toMatchObject({
			completed: 1,
			running: 1,
			failed: 1,
			cancelled: 0,
			total: 3
		});
		expect(entry?.tasks).toEqual([
			{ title: 'Write README smoke test', skills: ['docs'], status: 'failed' },
			{ title: 'Implement animated UI', skills: ['ui'], status: 'running' },
			{ title: 'Create static app shell', skills: ['frontend'], status: 'completed' }
		]);
	});

	it('sorts malformed board timestamps as oldest instead of falling through', () => {
		const entries = [
			{ missionId: 'mission-bad-time', lastUpdated: 'not-a-date' },
			{ missionId: 'mission-newer', lastUpdated: '2026-04-28T11:00:00.000Z' },
			{ missionId: 'mission-older', lastUpdated: '2026-04-28T10:00:00.000Z' }
		];

		entries.sort(compareMissionControlEntriesByLastUpdatedDesc);

		expect(entries.map((entry) => entry.missionId)).toEqual([
			'mission-newer',
			'mission-older',
			'mission-bad-time'
		]);
	});

	it('deduplicates PRD task titles across canvas and provider label formats', async () => {
		const missionId = `mission-prd-dedupe-${Date.now()}`;

		const plannedTasks = [
			{ title: 'Create static app file structure', skills: [] },
			{ title: 'Implement playful first-screen trace dashboard', skills: [] },
			{ title: 'Implement progress, persistence, and trace lock behavior', skills: [] },
			{ title: 'Document launch steps and manual smoke test', skills: [] }
		];

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			source: 'canvas-dispatch',
			timestamp: '2026-04-28T10:00:00.000Z',
			data: { plannedTasks, telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'dispatch_started',
			missionId,
			source: 'canvas-dispatch',
			timestamp: '2026-04-28T10:00:01.000Z',
			data: {
				plannedTasks: [
					{ title: 'task-1-scaffold-static-app: Create static app file structure', skills: [] },
					{
						title: 'task-2-build-trace-dashboard-ui: Implement playful first-screen trace dashboard',
						skills: []
					},
					{
						title: 'task-3-implement-state-and-launch-logic: Implement progress, persistence, and trace lock behavior',
						skills: []
					},
					{ title: 'task-4-write-readme-and-smoke-test: Document launch steps and manual smoke test', skills: [] }
				],
				telegramRelay: { port: 1 }
			}
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskName: 'task-1-scaffold-static-app',
			source: 'codex',
			timestamp: '2026-04-28T10:00:02.000Z',
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'mission_completed',
			missionId,
			source: 'canvas-dispatch',
			timestamp: '2026-04-28T10:01:00.000Z',
			data: { plannedTasks, telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		const completed = board.completed.find((candidate) => candidate.missionId === missionId);

		expect(completed?.taskCount).toBe(4);
		expect(completed?.taskStatusCounts).toMatchObject({ completed: 4, total: 4 });
		expect(completed?.taskNames).toEqual([
			'Create static app file structure',
			'Implement playful first-screen trace dashboard',
			'Implement progress, persistence, and trace lock behavior',
			'Document launch steps and manual smoke test'
		]);
	});

	it('matches a running task id back to its planned PRD task when newer events are processed first', async () => {
		const missionId = `mission-prd-running-dedupe-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			source: 'canvas-dispatch',
			timestamp: freshIso(),
			data: {
				plannedTasks: [
					{ title: 'task-1-static-app-scaffold: Create the no-build static app files', skills: ['frontend'] },
					{ title: 'task-2-route-check-state-and-actions: Implement route checks', skills: ['state'] }
				],
				telegramRelay: { port: 1 }
			}
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskName: 'task-1-static-app-scaffold',
			source: 'codex',
			timestamp: freshIso(5_000),
			data: { telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		const running = board.running.find((candidate) => candidate.missionId === missionId);

		expect(running?.taskCount).toBe(2);
		expect(running?.taskStatusCounts).toMatchObject({ queued: 1, running: 1, total: 2 });
		expect(running?.tasks).toEqual([
			{
				title: 'task-1-static-app-scaffold: Create the no-build static app files',
				skills: ['frontend'],
				status: 'running'
			},
			{
				title: 'task-2-route-check-state-and-actions: Implement route checks',
				skills: ['state'],
				status: 'queued'
			}
		]);
	});

	it('keeps bundled provider progress from inventing task percentages', async () => {
		const missionId = `mission-task-pack-progress-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			source: 'prd-bridge',
			timestamp: freshIso(),
			data: {
				plannedTasks: [
					{ title: 'task-1-shell: Create shell', skills: ['frontend'] },
					{ title: 'task-2-scene: Build scene', skills: ['threejs'] },
					{ title: 'task-3-controls: Add controls', skills: ['state'] },
					{ title: 'task-4-docs: Write docs', skills: ['docs'] }
				],
				telegramRelay: { port: 1 }
			}
		});
		await relayMissionControlEvent({
			type: 'task_progress',
			missionId,
			taskId: 'task-1-shell',
			taskName: 'task-1-shell: Create shell',
			message: 'Codex is working through the task pack',
			source: 'codex',
			progress: 50,
			timestamp: freshIso(5_000),
			data: {
				assignedTaskIds: ['task-1-shell', 'task-2-scene', 'task-3-controls', 'task-4-docs'],
				telegramRelay: { port: 1 }
			}
		});

		const board = getMissionControlBoard();
		const running = board.running.find((candidate) => candidate.missionId === missionId);

		expect(running?.tasks.map((task) => [task.title, task.status, task.progress ?? 0])).toEqual([
			['task-1-shell: Create shell', 'running', 0],
			['task-2-scene: Build scene', 'queued', 0],
			['task-3-controls: Add controls', 'queued', 0],
			['task-4-docs: Write docs', 'queued', 0]
		]);
		expect(running?.taskStatusCounts).toMatchObject({ queued: 3, running: 1, total: 4 });
	});

	it('keeps node-id task pack progress on the active planned task', async () => {
		const missionId = `mission-task-pack-node-dedupe-${Date.now()}`;
		const plannedTasks = [
			{ title: 'Create the static app shell', skills: ['frontend'] },
			{ title: 'Implement checklist state and progress', skills: ['state'] },
			{ title: 'Polish the dark Mission Control UI', skills: ['design'] },
			{ title: 'Write README and run smoke checks', skills: ['docs'] }
		];

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			source: 'prd-bridge',
			timestamp: freshIso(),
			data: {
				plannedTasks,
				telegramRelay: { port: 1 }
			}
		});
		await relayMissionControlEvent({
			type: 'task_progress',
			missionId,
			taskId: 'node-1-task-task-1-static-shell',
			taskName: 'task-1-static-shell: Create the static app shell',
			message: 'Codex is working through the task pack',
			source: 'codex',
			progress: 50,
			timestamp: freshIso(5_000),
			data: {
				assignedTaskIds: [
					'node-1-task-task-1-static-shell',
					'node-2-task-task-2-checklist-state',
					'node-3-task-task-3-dark-ui',
					'node-4-task-task-4-smoke-docs'
				],
				telegramRelay: { port: 1 }
			}
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'node-2-task-task-2-checklist-state',
			taskName: 'task-2-checklist-state',
			source: 'codex',
			timestamp: freshIso(10_000),
			data: { telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		const running = board.running.find((candidate) => candidate.missionId === missionId);

		expect(running?.taskCount).toBe(4);
		expect(running?.taskNames).toEqual(plannedTasks.map((task) => task.title));
		expect(running?.tasks.map((task) => [task.title, task.status, task.progress ?? 0])).toEqual([
			['Create the static app shell', 'running', 0],
			['Implement checklist state and progress', 'queued', 0],
			['Polish the dark Mission Control UI', 'queued', 0],
			['Write README and run smoke checks', 'queued', 0]
		]);
	});

	it('uses the human task name for single assigned task provider activity', async () => {
		const missionId = `mission-single-assigned-task-name-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			source: 'spark-run',
			timestamp: freshIso(),
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'task-1',
			taskName: 'Execute goal',
			source: 'spark-run',
			progress: 8,
			timestamp: freshIso(1_000),
			data: {
				assignedTaskIds: ['task-1'],
				assignedTaskCount: 1,
				telegramRelay: { port: 1 }
			}
		});

		const board = getMissionControlBoard();
		const running = board.running.find((candidate) => candidate.missionId === missionId);

		expect(running?.taskNames).toEqual(['Execute goal']);
		expect(running?.tasks).toEqual([
			{ title: 'Execute goal', skills: [], status: 'running' }
		]);
	});

	it('keeps completed missions completed when stale canvas task events replay later', async () => {
		const missionId = `mission-terminal-wins-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'task-original',
			taskName: 'Original task before completion',
			source: 'spawner-ui',
			timestamp: '2026-04-28T09:59:00.000Z',
			data: { skills: ['canvas'], telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'mission_completed',
			missionId,
			missionName: 'Completed mission should stay done',
			source: 'codex',
			timestamp: '2026-04-28T10:00:00.000Z',
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskId: 'task-replayed',
			taskName: 'Replayed task after completion',
			source: 'spawner-ui',
			timestamp: '2026-04-28T10:01:00.000Z',
			data: { skills: ['canvas'], telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Replayed mission after completion',
			source: 'spawner-ui',
			timestamp: '2026-04-28T10:02:00.000Z',
			data: { telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		const completed = board.completed.find((candidate) => candidate.missionId === missionId);

		expect(board.running.find((candidate) => candidate.missionId === missionId)).toBeUndefined();
		expect(board.created.find((candidate) => candidate.missionId === missionId)).toBeUndefined();
		expect(completed?.status).toBe('completed');
		expect(completed?.taskName).toBeNull();
		expect(completed?.taskStatusCounts).toMatchObject({ completed: 1, running: 0, total: 1 });
		expect(completed?.tasks[0]).toEqual({
			title: 'Original task before completion',
			skills: ['canvas'],
			status: 'completed'
		});
		expect(completed?.taskNames).not.toContain('Replayed task after completion');
	});

	it('closes open task states when a mission fails', async () => {
		const missionId = `mission-failed-closes-open-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			source: 'canvas-dispatch',
			timestamp: '2026-04-28T10:00:00.000Z',
			data: {
				plannedTasks: [
					{ title: 'Create static shell', skills: [] },
					{ title: 'Run final verification', skills: [] }
				],
				telegramRelay: { port: 1 }
			}
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskName: 'Create static shell',
			source: 'codex',
			timestamp: '2026-04-28T10:00:05.000Z',
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'task_failed',
			missionId,
			taskName: 'Run final verification',
			source: 'codex',
			timestamp: '2026-04-28T10:00:10.000Z',
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'mission_failed',
			missionId,
			source: 'canvas-dispatch',
			timestamp: '2026-04-28T10:00:20.000Z',
			data: { telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		const failed = board.failed.find((candidate) => candidate.missionId === missionId);

		expect(failed?.taskStatusCounts).toMatchObject({
			queued: 0,
			running: 0,
			completed: 0,
			failed: 2,
			total: 2
		});
	});

	it('closes open task states as cancelled when a mission is cancelled', async () => {
		const missionId = `mission-cancelled-closes-open-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Cancelled Mission',
			source: 'spawner-ui',
			timestamp: '2026-04-28T10:00:00.000Z',
			data: {
				plannedTasks: [
					{ title: 'Create static shell', skills: [] },
					{ title: 'Run final verification', skills: [] }
				],
				telegramRelay: { port: 1 }
			}
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskName: 'Create static shell',
			source: 'codex',
			timestamp: '2026-04-28T10:00:05.000Z',
			data: { telegramRelay: { port: 1 } }
		});
		await relayMissionControlEvent({
			type: 'mission_cancelled',
			missionId,
			source: 'telegram',
			timestamp: '2026-04-28T10:00:20.000Z',
			data: { telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		const cancelled = board.cancelled.find((candidate) => candidate.missionId === missionId);

		expect(cancelled?.status).toBe('cancelled');
		expect(cancelled?.lastSummary).toContain('Mission cancelled by user');
		expect(cancelled?.taskStatusCounts).toMatchObject({
			queued: 0,
			running: 0,
			completed: 0,
			failed: 0,
			cancelled: 2,
			total: 2
		});
	});

	it('redacts local paths from board display fields', async () => {
		const missionId = `spark-local-path-display-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'task_progress',
			missionId,
			missionName: 'Inspect C:/Users/USER/.spark/modules/spawner-ui/source',
			taskName: '/Users/leventcem/.spark/logs/spawner-ui.log',
			source: 'codex',
			message: 'Read C:\\Users\\USER\\.spark\\logs\\spark-telegram-bot.log',
			timestamp: new Date().toISOString(),
			data: { telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		const entry = board.running.find((candidate) => candidate.missionId === missionId);

		expect(entry?.missionName).toBe('Inspect [local path]');
		expect(entry?.taskName).toBe('[local path]');
		expect(entry?.lastSummary).toContain('[local path]');
		expect(entry?.lastSummary).not.toContain('C:\\Users\\USER');
		expect(entry?.lastSummary).not.toContain('/Users/leventcem');
	});

	it('compacts long progress messages before relaying them to board summaries', async () => {
		const missionId = `spark-progress-compact-${Date.now()}`;
		const longGoal = `Goal: ${'Build a long project description with too much detail. '.repeat(20)}`;

		await relayMissionControlEvent({
			type: 'progress',
			missionId,
			taskName: 'Create static shell',
			source: 'codex',
			message: longGoal,
			timestamp: new Date().toISOString(),
			data: { telegramRelay: { port: 1 } }
		});

		const board = getMissionControlBoard();
		const entry = board.running.find((candidate) => candidate.missionId === missionId);

		expect(entry?.lastSummary.length).toBeLessThanOrEqual(340);
		expect(entry?.lastSummary).toContain('Goal: Build a long project');
		expect(entry?.lastSummary).not.toContain('too much detail. Build a long project description with too much detail. Build a long project description with too much detail. Build a long project description with too much detail.');
	});
});
