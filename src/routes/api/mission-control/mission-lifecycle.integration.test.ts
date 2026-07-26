import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { POST as loadToCanvas } from '../prd-bridge/load-to-canvas/+server';
import { GET as getBoard } from './board/+server';
import { GET as getTrace } from './trace/+server';
import { relayMissionControlEvent } from '$lib/server/mission-control-relay';
import { providerRuntime, type ProviderMissionResultSnapshot } from '$lib/server/provider-runtime';
import type { ProviderSessionStatus } from '$lib/server/provider-clients/types';
import { buildServerGovernorDecisionAuthority } from '$lib/server/harness-authority';

const TEST_API_KEY = 'mission-control-lifecycle-test-secret';
const originalMcpApiKey = process.env.MCP_API_KEY;
const originalBridgeApiKey = process.env.SPARK_BRIDGE_API_KEY;

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function routeEvent(url: string) {
	return {
		request: new Request(url, {
			headers: { 'x-api-key': TEST_API_KEY }
		}),
		url: new URL(url),
		getClientAddress: () => '127.0.0.1'
	};
}

function postEvent(url: string, body: unknown) {
	return {
		request: new Request(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
			body: JSON.stringify(body)
		}),
		url: new URL(url),
		getClientAddress: () => '127.0.0.1'
	};
}

function providerResult(overrides: Partial<ProviderMissionResultSnapshot>): ProviderMissionResultSnapshot {
	return {
		providerId: 'codex',
		status: 'completed',
		response: 'Mission complete.',
		error: null,
		durationMs: 1200,
		tokenUsage: null,
		startedAt: '2026-04-28T10:00:00.000Z',
		completedAt: '2026-04-28T10:00:01.200Z',
		...overrides
	};
}

async function seedTelegramRequest(input: {
	stateDir: string;
	requestId: string;
	missionId: string;
	projectName: string;
	buildMode: 'direct' | 'advanced_prd';
	tasks: Array<{ id: string; title: string; dependencies?: string[] }>;
}) {
	await mkdir(path.join(input.stateDir, 'results'), { recursive: true });
	await writeFile(
		path.join(input.stateDir, 'pending-request.json'),
		JSON.stringify(
			{
				requestId: input.requestId,
				missionId: input.missionId,
				projectName: input.projectName,
				buildMode: input.buildMode,
				buildModeReason:
					input.buildMode === 'advanced_prd'
						? 'Advanced PRD planning requested from Telegram.'
						: 'Direct Telegram build requested.',
				status: 'processed',
				relay: {
					missionId: input.missionId,
					requestId: input.requestId,
					chatId: 'telegram-chat',
					userId: 'telegram-user',
					goal: `Build ${input.projectName} from Telegram.`,
					telegramRelay: { port: 8789, profile: 'spark-agi' }
				}
			},
			null,
			2
		),
		'utf-8'
	);
	await writeFile(
		path.join(input.stateDir, 'results', `${input.requestId}.json`),
		JSON.stringify(
			{
				requestId: input.requestId,
				success: true,
				projectName: input.projectName,
				tasks: input.tasks.map((task) => ({
					id: task.id,
					title: task.title,
					summary: `Complete ${task.title}.`,
					dependencies: task.dependencies || [],
					skills: ['frontend-engineer'],
					acceptanceCriteria: [`${task.title} is complete.`],
					verificationCommands: ['Get-ChildItem']
				})),
				executionPrompt: `Build ${input.projectName} exactly as requested.`
			},
			null,
			2
		),
		'utf-8'
	);
}

async function loadRequestToCanvas(requestId: string) {
	const missionId = `mission-${requestId.match(/(\d{10,})$/)?.[1] || requestId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
	const response = await loadToCanvas(
		postEvent('http://127.0.0.1/api/prd-bridge/load-to-canvas', {
			requestId,
			autoRun: true,
			telegramRelay: { port: 8789, profile: 'spark-agi' },
			executionAuthority: buildServerGovernorDecisionAuthority({
				source: 'mission-lifecycle-test',
				reason: 'Focused Mission Control lifecycle dispatch authority regression.',
				toolName: 'spawner.dispatch',
				mutationClass: 'launches_mission',
				requestId,
				target: missionId
			})
		}) as never
	);
	expect(response.status).toBe(200);
	return response.json();
}

async function getBoardEntry(bucket: 'running' | 'completed' | 'failed', missionId: string) {
	const response = await getBoard(routeEvent('http://127.0.0.1/api/mission-control/board') as never);
	expect(response.status).toBe(200);
	const body = await response.json();
	return body.board[bucket].find((entry: { missionId: string }) => entry.missionId === missionId);
}

async function getTracePayload(requestId: string) {
	const response = await getTrace(
		routeEvent(`http://127.0.0.1/api/mission-control/trace?requestId=${requestId}`) as never
	);
	expect(response.status).toBe(200);
	return response.json();
}

describe('Mission Control lifecycle integration', () => {
	beforeEach(() => {
		process.env.MCP_API_KEY = TEST_API_KEY;
		process.env.SPARK_BRIDGE_API_KEY = TEST_API_KEY;
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		restoreEnv('MCP_API_KEY', originalMcpApiKey);
		restoreEnv('SPARK_BRIDGE_API_KEY', originalBridgeApiKey);
		delete process.env.SPAWNER_STATE_DIR;
	});

	it('keeps Telegram, Canvas, Kanban, Trace, dispatch, and provider state aligned for an advanced PRD build', async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), 'spawner-lifecycle-'));
		process.env.SPAWNER_STATE_DIR = stateDir;
		const requestId = 'tg-system-advanced-1777370000000';
		const missionId = 'mission-1777370000000';
		const tasks = [
			{ id: 'task-1-shell', title: 'Create static shell' },
			{ id: 'task-2-ui', title: 'Implement playful mission UI', dependencies: ['task-1-shell'] },
			{ id: 'task-3-readme', title: 'Write launch README', dependencies: ['task-1-shell'] }
		];

		await seedTelegramRequest({
			stateDir,
			requestId,
			missionId,
			projectName: 'Spark System Lifecycle',
			buildMode: 'advanced_prd',
			tasks
		});

		const canvas = await loadRequestToCanvas(requestId);
		expect(canvas).toMatchObject({
			success: true,
			pipelineId: `prd-${requestId}`,
			pipelineName: 'Spark System Lifecycle',
			taskCount: 3,
			connectionCount: 2,
			canvasUrl: `/canvas?pipeline=prd-${requestId}&mission=mission-1777370000000`
		});
		const pendingLoad = JSON.parse(await readFile(path.join(stateDir, 'pending-load.json'), 'utf-8'));
		expect(pendingLoad).toMatchObject({
			autoRun: true,
			buildMode: 'advanced_prd',
			relay: {
				missionId,
				requestId,
				chatId: 'telegram-chat',
				userId: 'telegram-user',
				telegramRelay: { port: 8789, profile: 'spark-agi' }
			}
		});

		vi.spyOn(providerRuntime, 'getMissionResults').mockImplementation((id) =>
			id === missionId
				? [
						providerResult({
							status: 'completed',
							response: 'Built Spark System Lifecycle and verified files.'
						})
					]
				: []
		);
		vi.spyOn(providerRuntime, 'getMissionStatus').mockImplementation((id) => ({
			allComplete: id === missionId,
			anyFailed: false,
			paused: false,
			pausedReason: null,
			lastReason: id === missionId ? 'Mission completed successfully' : null,
			snapshotAvailable: id === missionId,
			resumeable: false,
			resumeBlocker: null,
			providers:
				id === missionId
					? ({ codex: 'completed' } as Record<string, ProviderSessionStatus>)
					: ({} as Record<string, ProviderSessionStatus>)
		}));

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Spark System Lifecycle',
			source: 'canvas-dispatch',
			timestamp: '2026-04-28T10:00:00.000Z',
			data: {
				requestId,
				plannedTasks: tasks.map((task) => ({ title: task.title, skills: [] })),
				telegramRelay: { port: 8789, profile: 'spark-agi' }
			}
		});
		await relayMissionControlEvent({
			type: 'dispatch_started',
			missionId,
			missionName: 'Spark System Lifecycle',
			source: 'canvas-dispatch',
			timestamp: '2026-04-28T10:00:01.000Z',
			data: {
				requestId,
				providers: ['codex'],
				plannedTasks: tasks.map((task) => ({ title: `${task.id}: ${task.title}`, skills: [] })),
				telegramRelay: { port: 8789, profile: 'spark-agi' }
			}
		});
		for (const [index, task] of tasks.entries()) {
			await relayMissionControlEvent({
				type: 'task_started',
				missionId,
				taskName: task.id,
				source: 'codex',
				timestamp: `2026-04-28T10:00:0${index + 2}.000Z`,
				data: { requestId, telegramRelay: { port: 8789, profile: 'spark-agi' } }
			});
			await relayMissionControlEvent({
				type: 'task_completed',
				missionId,
				taskName: task.id,
				source: 'codex',
				timestamp: `2026-04-28T10:00:1${index + 2}.000Z`,
				data: { requestId, telegramRelay: { port: 8789, profile: 'spark-agi' } }
			});
		}
		await relayMissionControlEvent({
			type: 'mission_completed',
			missionId,
			missionName: 'Spark System Lifecycle',
			source: 'canvas-dispatch',
			timestamp: '2026-04-28T10:01:00.000Z',
			data: {
				requestId,
				plannedTasks: tasks.map((task) => ({ title: task.title, skills: [] })),
				telegramRelay: { port: 8789, profile: 'spark-agi' }
			}
		});

		// load-to-canvas emits a completed "PRD analysis" handoff task on the
		// Mission Control board, so the board shows the 3 planned tasks plus
		// that canvas-handoff verification task.
		const entry = await getBoardEntry('completed', missionId);
		expect(entry).toMatchObject({
			missionId,
			status: 'completed',
			taskCount: 4,
			taskStatusCounts: { queued: 0, running: 0, completed: 4, failed: 0, total: 4 },
			telegramRelay: { port: 8789, profile: 'spark-agi', url: null },
			providerSummary: 'Codex: Built Spark System Lifecycle and verified files.'
		});
		expect(entry.taskNames).toEqual([
			'Create static shell',
			'Implement playful mission UI',
			'Write launch README',
			'PRD analysis'
		]);

		const trace = await getTracePayload(requestId);
		expect(trace).toMatchObject({
			ok: true,
			missionId,
			requestId,
			phase: 'completed',
			progress: {
				percent: 100,
				taskCounts: { queued: 0, running: 0, completed: 4, failed: 0, total: 4 }
			},
			surfaces: {
				telegram: {
					chatId: 'telegram-chat',
					userId: 'telegram-user',
					relay: { port: 8789, profile: 'spark-agi', url: null }
				},
				canvas: {
					pipelineId: `prd-${requestId}`,
					pipelineName: 'Spark System Lifecycle',
					autoRun: true,
					nodeCount: 3
				},
				kanban: { bucket: 'completed' },
				dispatch: {
					allComplete: true,
					anyFailed: false,
					providers: { codex: 'completed' }
				}
			},
			providerSummary: 'Codex: Built Spark System Lifecycle and verified files.'
		});
		expect(trace.agentBlackBox).toMatchObject({
			schema_version: 'spark.agent_event.v1',
			request_id: requestId,
			session_id: `mission-control:${missionId}`,
			counts: { entries: expect.any(Number) }
		});
		expect(trace.agentBlackBox.entries[0]).toMatchObject({
			event_type: 'mission_changed_state',
			route_chosen: 'mission_control',
			sources_used: [{ source: 'mission_trace', freshness: 'fresh' }]
		});
	}, 10000);

	it('routes failed provider missions to failed Kanban and Trace states without losing Telegram or Canvas context', async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), 'spawner-lifecycle-fail-'));
		process.env.SPAWNER_STATE_DIR = stateDir;
		const requestId = 'tg-system-failed-1777370000001';
		const missionId = 'mission-1777370000001';
		const tasks = [
			{ id: 'task-1-shell', title: 'Create static shell' },
			{ id: 'task-2-verify', title: 'Run final smoke verification', dependencies: ['task-1-shell'] }
		];

		await seedTelegramRequest({
			stateDir,
			requestId,
			missionId,
			projectName: 'Spark Failed Lifecycle',
			buildMode: 'direct',
			tasks
		});
		await loadRequestToCanvas(requestId);

		vi.spyOn(providerRuntime, 'getMissionResults').mockImplementation((id) =>
			id === missionId
				? [
						providerResult({
							status: 'failed',
							response: null,
							error: 'Codex exited 1'
						})
					]
				: []
		);
		vi.spyOn(providerRuntime, 'getMissionStatus').mockImplementation((id) => ({
			allComplete: id === missionId,
			anyFailed: id === missionId,
			paused: false,
			pausedReason: null,
			lastReason: id === missionId ? 'Mission completed with provider failures' : null,
			snapshotAvailable: id === missionId,
			resumeable: false,
			resumeBlocker: null,
			providers:
				id === missionId
					? ({ codex: 'failed' } as Record<string, ProviderSessionStatus>)
					: ({} as Record<string, ProviderSessionStatus>)
		}));

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Spark Failed Lifecycle',
			source: 'canvas-dispatch',
			timestamp: '2026-04-28T10:10:00.000Z',
			data: {
				requestId,
				plannedTasks: tasks.map((task) => ({ title: task.title, skills: [] })),
				telegramRelay: { port: 8789, profile: 'spark-agi' }
			}
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskName: 'task-1-shell',
			source: 'codex',
			timestamp: '2026-04-28T10:10:05.000Z',
			data: { requestId, telegramRelay: { port: 8789, profile: 'spark-agi' } }
		});
		await relayMissionControlEvent({
			type: 'task_failed',
			missionId,
			taskName: 'task-2-verify',
			source: 'codex',
			timestamp: '2026-04-28T10:10:10.000Z',
			data: { requestId, telegramRelay: { port: 8789, profile: 'spark-agi' } }
		});
		await relayMissionControlEvent({
			type: 'mission_failed',
			missionId,
			missionName: 'Spark Failed Lifecycle',
			source: 'canvas-dispatch',
			timestamp: '2026-04-28T10:10:20.000Z',
			data: {
				requestId,
				plannedTasks: tasks.map((task) => ({ title: task.title, skills: [] })),
				telegramRelay: { port: 8789, profile: 'spark-agi' }
			}
		});

		// The completed "PRD analysis" canvas-handoff task from load-to-canvas
		// joins the 2 planned tasks, which both end failed.
		const entry = await getBoardEntry('failed', missionId);
		expect(entry).toMatchObject({
			missionId,
			status: 'failed',
			taskCount: 3,
			taskStatusCounts: { completed: 1, failed: 2, total: 3 },
			providerSummary: 'Codex: Codex exited 1'
		});

		const trace = await getTracePayload(requestId);
		expect(trace).toMatchObject({
			ok: true,
			missionId,
			requestId,
			phase: 'failed',
			progress: {
				percent: 33,
				taskCounts: { completed: 1, failed: 2, total: 3 }
			},
			surfaces: {
				canvas: { pipelineId: `prd-${requestId}`, autoRun: true, nodeCount: 2 },
				kanban: { bucket: 'failed' },
				dispatch: { anyFailed: true, providers: { codex: 'failed' } }
			},
			providerSummary: 'Codex: Codex exited 1'
		});
	}, 10000);
});
