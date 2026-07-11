import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { GET } from './+server';
import { relayMissionControlEvent } from '$lib/server/mission-control-relay';
import { providerRuntime, type ProviderMissionResultSnapshot } from '$lib/server/provider-runtime';

const TEST_API_KEY = 'mission-control-trace-test-secret';
const originalMcpApiKey = process.env.MCP_API_KEY;

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function event(url: string, options: { auth?: boolean } = {}) {
	const headers = new Headers();
	if (options.auth !== false) headers.set('x-api-key', TEST_API_KEY);
	return {
		request: new Request(url, { headers }),
		url: new URL(url),
		getClientAddress: () => '127.0.0.1'
	};
}

function providerResult(overrides: Partial<ProviderMissionResultSnapshot> = {}): ProviderMissionResultSnapshot {
	return {
		providerId: 'codex',
		status: 'running',
		response: null,
		error: null,
		durationMs: null,
		tokenUsage: null,
		startedAt: '2026-04-28T10:00:00.000Z',
		completedAt: null,
		...overrides
	};
}

describe('/api/mission-control/trace integration', () => {
	beforeEach(() => {
		process.env.MCP_API_KEY = TEST_API_KEY;
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		delete process.env.SPAWNER_STATE_DIR;
		restoreEnv('MCP_API_KEY', originalMcpApiKey);
	});

	it('stitches request, canvas, dispatch, kanban, provider, and timeline state for a Telegram mission', async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), 'spawner-trace-'));
		process.env.SPAWNER_STATE_DIR = stateDir;
		const requestId = `tg-build-trace-1777369000000`;
		const missionId = 'mission-1777369000000';

		await mkdir(path.join(stateDir, 'results'), { recursive: true });
		await writeFile(
			path.join(stateDir, 'pending-request.json'),
			JSON.stringify({
				requestId,
				projectName: 'Trace Mission',
				status: 'pending',
				relay: {
					missionId,
					requestId,
					chatId: 'telegram-chat',
					userId: 'telegram-user',
					telegramRelay: { port: 8789, profile: 'spark-agi' }
				}
			}),
			'utf-8'
		);
		await writeFile(
			path.join(stateDir, 'results', `${requestId}.json`),
			JSON.stringify({
				success: true,
				projectName: 'Trace Mission',
				tasks: [{ id: 'task-1', title: 'Create the traceable app' }]
			}),
			'utf-8'
		);
		await writeFile(
			path.join(stateDir, 'last-canvas-load.json'),
			JSON.stringify({
				pipelineId: `prd-${requestId}`,
				pipelineName: 'Trace Mission',
				autoRun: true,
				nodes: [{ id: 'task-1' }],
				relay: { missionId, requestId }
			}),
			'utf-8'
		);
		await writeFile(
			path.join(stateDir, 'prd-auto-trace.jsonl'),
			[
				JSON.stringify({ ts: '2026-04-28T09:59:00.000Z', requestId, event: 'request_written' }),
				JSON.stringify({ ts: '2026-04-28T09:59:30.000Z', requestId, event: 'canonical_result_stored' }),
				JSON.stringify({ ts: '2026-04-28T09:59:45.000Z', requestId: 'tg-build-other-request', event: 'request_written' })
			].join('\n') + '\n',
			'utf-8'
		);

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			source: 'canvas-dispatch',
			data: {
				missionName: 'Trace Mission',
				plannedTasks: [{ title: 'Create the traceable app', skills: ['frontend-engineer'] }],
				telegramRelay: { port: 8789, profile: 'spark-agi' }
			}
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskName: 'Create the traceable app',
			source: 'codex',
			data: { telegramRelay: { port: 8789, profile: 'spark-agi' } }
		});

		vi.spyOn(providerRuntime, 'getMissionResults').mockImplementation((id) =>
			id === missionId ? [providerResult()] : []
		);
		vi.spyOn(providerRuntime, 'getMissionStatus').mockImplementation((id) => ({
			allComplete: false,
			anyFailed: false,
			paused: false,
			pausedReason: null,
			lastReason: id === missionId ? 'Dispatch started' : null,
			snapshotAvailable: id === missionId,
			resumeable: false,
			resumeBlocker: null,
			providers: id === missionId ? { codex: 'running' } : ({} as Record<string, 'running'>)
		}));

		const response = await GET(
			event(`http://127.0.0.1/api/mission-control/trace?requestId=${requestId}`) as never
		);
		expect(response.status).toBe(200);
		const payload = await response.json();

		expect(payload).toMatchObject({
			ok: true,
			missionId,
			requestId,
			phase: 'executing',
			progress: {
				percent: 0,
				taskCounts: { queued: 0, running: 1, completed: 0, failed: 0, cancelled: 0, total: 1 },
				currentTask: 'Create the traceable app'
			},
			missionControlAccess: {
				mode: 'local-only',
				url: null,
				mobileReachable: false
			},
			surfaces: {
				telegram: {
					relay: { port: 8789, profile: 'spark-agi', url: null },
					chatId: 'telegram-chat',
					userId: 'telegram-user'
				},
				canvas: {
					pipelineId: `prd-${requestId}`,
					pipelineName: 'Trace Mission',
					autoRun: true,
					nodeCount: 1
				},
				kanban: {
					bucket: 'running'
				},
				dispatch: {
					allComplete: false,
					anyFailed: false,
					providers: { codex: 'running' },
					lastReason: 'Dispatch started'
				}
			},
			providerSummary: 'Codex: running'
		});
		expect(payload.timeline[0]).toMatchObject({
			missionId,
			eventType: 'task_started',
			taskName: 'Create the traceable app'
		});

		// /trace ingests the PRD JSONL trail (prd-auto-trace.jsonl) scoped to
		// this request; rows for other requests stay out of the payload.
		expect(payload.prdTrace).toMatchObject({
			file: 'prd-auto-trace.jsonl',
			entryCount: 2
		});
		expect(payload.prdTrace.entries.map((entry: { event: string }) => entry.event)).toEqual([
			'request_written',
			'canonical_result_stored'
		]);
		expect(JSON.stringify(payload.prdTrace)).not.toContain('tg-build-other-request');
	}, 15_000);

	it('returns progress-only trace for local no-key reads', async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), 'spawner-trace-redacted-'));
		process.env.SPAWNER_STATE_DIR = stateDir;
		const requestId = `tg-build-trace-redacted-1777369000001`;
		const missionId = 'mission-1777369000001';

		await mkdir(path.join(stateDir, 'results'), { recursive: true });
		await writeFile(
			path.join(stateDir, 'pending-request.json'),
			JSON.stringify({
				requestId,
				projectName: 'Private Trace Mission',
				status: 'pending',
				relay: {
					missionId,
					requestId,
					chatId: 'telegram-chat-private',
					userId: 'telegram-user-private',
					telegramRelay: { port: 8789, profile: 'spark-agi' }
				}
			}),
			'utf-8'
		);
		await writeFile(
			path.join(stateDir, 'results', `${requestId}.json`),
			JSON.stringify({
				success: true,
				projectName: 'Private Trace Mission',
				tasks: [{ id: 'task-1', title: 'Private execution task', skills: ['private-skill'] }]
			}),
			'utf-8'
		);
		await writeFile(
			path.join(stateDir, 'last-canvas-load.json'),
			JSON.stringify({
				pipelineId: `prd-${requestId}`,
				pipelineName: 'Private Trace Mission',
				autoRun: true,
				nodes: [{ id: 'task-1', skill: { id: 'private-skill', tags: ['private-skill'] } }],
				relay: { missionId, requestId, chatId: 'telegram-chat-private' }
			}),
			'utf-8'
		);

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			source: 'canvas-dispatch',
			data: {
				missionName: 'Private Trace Mission',
				plannedTasks: [{ title: 'Private execution task', skills: ['private-skill'] }],
				telegramRelay: { port: 8789, profile: 'spark-agi' }
			}
		});

		vi.spyOn(providerRuntime, 'getMissionResults').mockImplementation((id) =>
			id === missionId
				? [
						providerResult({
							status: 'completed',
							response: 'private provider output',
							completedAt: '2026-04-28T10:01:00.000Z'
						})
					]
				: []
		);
		vi.spyOn(providerRuntime, 'getMissionStatus').mockImplementation((id) => ({
			allComplete: true,
			anyFailed: false,
			paused: false,
			pausedReason: null,
			lastReason: id === missionId ? 'private dispatch reason' : null,
			snapshotAvailable: id === missionId,
			resumeable: false,
			resumeBlocker: null,
			providers: id === missionId ? { codex: 'completed' } : ({} as Record<string, 'completed'>)
		}));

		const response = await GET(
			event(`http://127.0.0.1/api/mission-control/trace?requestId=${requestId}`, {
				auth: false
			}) as never
		);
		expect(response.status).toBe(200);
		const payload = await response.json();

		expect(payload.authorityBoundary).toMatchObject({
			payload: 'progress_only',
			rawArtifacts: 'requires_control_auth',
			providerResults: 'requires_control_auth',
			telegramIdentity: 'requires_control_auth'
		});
		expect(payload.progress.taskCounts.total).toBe(1);
		expect(payload.surfaces.telegram).toEqual({ relay: null, chatId: null, userId: null });
		expect(payload.surfaces.canvas).toMatchObject({
			pipelineId: `prd-${requestId}`,
			pipelineName: 'Private Trace Mission',
			autoRun: true,
			nodeCount: 1
		});
		expect(payload.surfaces.dispatch).toMatchObject({
			allComplete: true,
			anyFailed: false,
			paused: false,
			providers: { codex: 'completed' },
			lastReason: null
		});
		expect(payload.artifacts).toEqual({
			pendingRequest: null,
			analysisResult: null,
			lastCanvasLoad: null
		});
		expect(payload.prdTrace.entries).toEqual([]);
		expect(payload.providerResults).toEqual([]);
		expect(payload.agentBlackBox.entries).toEqual([]);
		expect(JSON.stringify(payload)).not.toContain('telegram-chat-private');
		expect(JSON.stringify(payload)).not.toContain('telegram-user-private');
		expect(JSON.stringify(payload)).not.toContain('private provider output');
		expect(JSON.stringify(payload)).not.toContain('private dispatch reason');
		expect(JSON.stringify(payload)).not.toContain('private-skill');
	});

	it('returns hosted Mission Control access at the top level for mobile clients', async () => {
		const previous = process.env.SPAWNER_MISSION_CONTROL_PUBLIC_URL;
		process.env.SPAWNER_MISSION_CONTROL_PUBLIC_URL = 'https://mission.sparkswarm.ai';
		try {
			const response = await GET(
				event('http://127.0.0.1/api/mission-control/trace?missionId=mission-mobile-trace') as never
			);
			expect(response.status).toBe(200);
			const payload = await response.json();
			expect(payload.missionControlAccess).toMatchObject({
				mode: 'hosted',
				url: 'https://mission.sparkswarm.ai/missions/mission-mobile-trace',
				mobileReachable: true
			});
		} finally {
			if (previous === undefined) {
				delete process.env.SPAWNER_MISSION_CONTROL_PUBLIC_URL;
			} else {
				process.env.SPAWNER_MISSION_CONTROL_PUBLIC_URL = previous;
			}
		}
	});
});
