import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { buildMissionControlTrace, missionIdFromRequestId } from './mission-control-trace';
import { relayMissionControlEvent } from './mission-control-relay';

async function writeJson(filePath: string, value: unknown) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function makeStateDir() {
	const stateDir = await mkdtemp(path.join(tmpdir(), 'spawner-trace-unit-'));
	process.env.SPAWNER_STATE_DIR = stateDir;
	return stateDir;
}

beforeEach(() => {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
	delete process.env.SPAWNER_STATE_DIR;
	vi.restoreAllMocks();
});

describe('mission-control-trace', () => {
	it('derives stable mission ids from Telegram request ids', () => {
		expect(missionIdFromRequestId('tg-build-8319079055-1638-1777362992971')).toBe(
			'mission-1777362992971'
		);
		expect(missionIdFromRequestId('natural language request')).toBe(
			'mission-natural_language_request'
		);
	});

	it('reports planning from a matching pending Telegram request', async () => {
		const stateDir = await makeStateDir();
		const requestId = 'tg-unit-planning-1777371000000';
		const missionId = 'mission-1777371000000';
		const traceRef = 'trace:spawner-prd:mission-1777371000000';

		await writeJson(path.join(stateDir, 'pending-request.json'), {
			requestId,
			traceRef,
			status: 'processed',
			relay: {
				missionId,
				requestId,
				traceRef,
				chatId: 'chat-1',
				userId: 'user-1',
				telegramRelay: { port: 8789, profile: 'spark-agi' }
			}
		});

		const trace = await buildMissionControlTrace({
			requestId,
			getProviderResults: () => []
		});

		expect(trace).toMatchObject({
			requestId,
			missionId,
			traceRef,
			phase: 'planning',
			summary: 'Spark is shaping the PRD and preparing the canvas.',
			surfaces: {
				telegram: {
					chatId: 'chat-1',
					userId: 'user-1'
				},
				canvas: {
					pipelineId: null,
					nodeCount: null
				},
				kanban: {
					bucket: null
				}
			}
		});
	});

	it('reports canvas_ready when analysis and canvas artifacts match the request', async () => {
		const stateDir = await makeStateDir();
		const requestId = 'tg-unit-canvas-1777371000001';
		const missionId = 'mission-1777371000001';
		const traceRef = 'trace:spawner-prd:mission-1777371000001';

		await writeJson(path.join(stateDir, 'results', `${requestId}.json`), {
			requestId,
			success: true,
			projectName: 'Trace Unit Canvas'
		});
		await writeJson(path.join(stateDir, 'last-canvas-load.json'), {
			traceRef,
			pipelineId: `prd-${requestId}`,
			pipelineName: 'Trace Unit Canvas',
			autoRun: true,
			nodes: [{ id: 'task-1' }, { id: 'task-2' }],
			relay: { missionId, requestId, traceRef }
		});

		const trace = await buildMissionControlTrace({
			requestId,
			getProviderResults: () => []
		});

		expect(trace).toMatchObject({
			requestId,
			missionId,
			traceRef,
			phase: 'canvas_ready',
			surfaces: {
				canvas: {
					pipelineId: `prd-${requestId}`,
					pipelineName: 'Trace Unit Canvas',
					autoRun: true,
					nodeCount: 2
				}
			}
		});
	});

	it('keeps mission progress tied to completed task count while a task is running', async () => {
		await makeStateDir();
		const missionId = `mission-running-trace-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Running Trace',
			source: 'prd-bridge',
			data: {
				plannedTasks: [
					{ title: 'Plan the project', skills: ['planning'] },
					{ title: 'Build the project', skills: ['frontend-engineer'] },
					{ title: 'Verify the project', skills: ['testing'] }
				]
			}
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskName: 'Plan the project',
			source: 'codex'
		});

		const trace = await buildMissionControlTrace({
			missionId,
			getProviderResults: () => []
		});

		expect(trace.phase).toBe('executing');
		expect(trace.progress.taskCounts).toMatchObject({ running: 1, queued: 2, total: 3 });
		expect(trace.progress.percent).toBe(0);
		expect(trace.skillPairing).toMatchObject({
			source: 'kanban',
			taskCount: 3,
			pairedTaskCount: 3,
			pairingRatio: 100,
			status: 'complete'
		});
	});

	it('keeps planned task counts when other missions produce noisy relay events', async () => {
		await makeStateDir();
		const missionId = `mission-long-trace-${Date.now()}`;
		const plannedTasks = Array.from({ length: 10 }, (_, index) => ({
			title: `Task ${index + 1}`,
			skills: [`skill-${index + 1}`]
		}));

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Long Trace',
			source: 'prd-bridge',
			data: { plannedTasks }
		});
		await relayMissionControlEvent({
			type: 'task_started',
			missionId,
			taskName: 'Task 1',
			source: 'codex'
		});

		for (let index = 0; index < 90; index += 1) {
			await relayMissionControlEvent({
				type: 'mission_created',
				missionId: `mission-noisy-${Date.now()}-${index}`,
				missionName: `Noise ${index}`,
				source: 'prd-bridge'
			});
		}

		const trace = await buildMissionControlTrace({
			missionId,
			getProviderResults: () => []
		});

		expect(trace.phase).toBe('executing');
		expect(trace.progress.taskCounts).toMatchObject({ running: 1, queued: 9, total: 10 });
		expect(trace.skillPairing).toMatchObject({
			source: 'kanban',
			taskCount: 10,
			pairedTaskCount: 10,
			status: 'complete'
		});
	}, 15_000);

	it('exposes project lineage for improvement missions', async () => {
		await makeStateDir();
		const missionId = `mission-lineage-trace-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Founder Signal Room polish 2',
			source: 'spark-run',
			data: {
				projectPath: 'C:\\Users\\USER\\Desktop\\founder-signal-room',
				parentMissionId: 'mission-original-build',
				iterationNumber: 2,
				improvementFeedback: 'make this more Spark colored'
			}
		});

		const trace = await buildMissionControlTrace({
			missionId,
			getProviderResults: () => []
		});

		expect(trace.projectLineage).toMatchObject({
			projectPath: 'C:\\Users\\USER\\Desktop\\founder-signal-room',
			parentMissionId: 'mission-original-build',
			iterationNumber: 2,
			improvementFeedback: 'make this more Spark colored'
		});
		expect(trace.projectLineage?.previewUrl).toContain('/preview/');
		expect(trace.surfaces.kanban.entry?.projectLineage).toEqual(trace.projectLineage);
	});

	it('keeps analysis-only missions in planning until the matching canvas loads', async () => {
		const stateDir = await makeStateDir();
		const requestId = 'tg-unit-analysis-1777371000009';
		const missionId = 'mission-1777371000009';

		await writeJson(path.join(stateDir, 'pending-request.json'), {
			requestId,
			relay: { missionId, requestId }
		});
		await writeJson(path.join(stateDir, 'results', `${requestId}.json`), {
			requestId,
			success: true,
			projectName: 'Analysis Only'
		});
		await writeJson(path.join(stateDir, 'last-canvas-load.json'), {
			requestId: 'tg-unit-stale-1777379999999',
			missionId: 'mission-1777379999999',
			pipelineId: 'prd-tg-unit-stale-1777379999999',
			nodes: [{ id: 'stale-node' }]
		});

		const trace = await buildMissionControlTrace({
			missionId,
			getProviderResults: () => []
		});

		expect(trace).toMatchObject({
			requestId,
			missionId,
			phase: 'planning',
			artifacts: {
				analysisResult: {
					projectName: 'Analysis Only'
				},
				lastCanvasLoad: null
			},
			surfaces: {
				canvas: { pipelineId: null, nodeCount: null }
			}
		});
		expect(trace.skillPairing).toMatchObject({
			source: 'none',
			taskCount: 0,
			pairedTaskCount: 0,
			status: 'missing'
		});
	});

	it('recovers mission canvas from archived load when latest canvas belongs to another mission', async () => {
		const stateDir = await makeStateDir();
		const requestId = 'tg-unit-archived-canvas-1777371000011';
		const missionId = 'mission-1777371000011';
		const traceRef = 'trace:spawner-prd:mission-1777371000011';

		await writeJson(path.join(stateDir, 'results', `${requestId}.json`), {
			requestId,
			success: true,
			projectName: 'Archived Canvas'
		});
		await writeJson(path.join(stateDir, 'last-canvas-load.json'), {
			requestId: 'tg-unit-other-1777379999999',
			missionId: 'mission-1777379999999',
			pipelineId: 'prd-tg-unit-other-1777379999999',
			nodes: [{ id: 'wrong-node' }]
		});
		await writeJson(path.join(stateDir, 'canvas-loads', `prd-${requestId}.json`), {
			requestId,
			missionId,
			traceRef,
			pipelineId: `prd-${requestId}`,
			pipelineName: 'Archived Canvas',
			autoRun: false,
			nodes: [{ id: 'task-1' }, { id: 'task-2' }],
			relay: { missionId, requestId, traceRef }
		});

		const trace = await buildMissionControlTrace({
			requestId,
			getProviderResults: () => []
		});

		expect(trace).toMatchObject({
			requestId,
			missionId,
			traceRef,
			phase: 'canvas_ready',
			surfaces: {
				canvas: {
					pipelineId: `prd-${requestId}`,
					pipelineName: 'Archived Canvas',
					nodeCount: 2
				}
			}
		});
	});

	it('uses analysis tasks to report partial skill pairing before Kanban exists', async () => {
		const stateDir = await makeStateDir();
		const requestId = 'tg-unit-skill-pairing-1777371000010';
		const missionId = 'mission-1777371000010';

		await writeJson(path.join(stateDir, 'pending-request.json'), {
			requestId,
			relay: { missionId, requestId }
		});
		await writeJson(path.join(stateDir, 'results', `${requestId}.json`), {
			requestId,
			success: true,
			projectName: 'Skill Pairing Trace',
			tasks: [
				{ id: 'task-1', title: 'Create shell', skills: ['frontend-engineer'] },
				{ id: 'task-2', title: 'Write docs', skills: [] }
			]
		});

		const trace = await buildMissionControlTrace({
			requestId,
			getProviderResults: () => []
		});

		expect(trace.skillPairing).toMatchObject({
			source: 'analysis',
			taskCount: 2,
			pairedTaskCount: 1,
			skillCount: 1,
			pairingRatio: 50,
			status: 'partial',
			unpairedTasks: ['Write docs']
		});
	});

	it('does not attach unrelated pending or canvas artifacts to a requested trace', async () => {
		const stateDir = await makeStateDir();
		const requestId = 'tg-unit-target-1777371000002';

		await writeJson(path.join(stateDir, 'pending-request.json'), {
			requestId: 'tg-unit-other-1777379999999',
			relay: {
				missionId: 'mission-1777379999999',
				requestId: 'tg-unit-other-1777379999999',
				chatId: 'wrong-chat'
			}
		});
		await writeJson(path.join(stateDir, 'last-canvas-load.json'), {
			pipelineId: 'prd-tg-unit-other-1777379999999',
			nodes: [{ id: 'wrong-node' }],
			relay: {
				missionId: 'mission-1777379999999',
				requestId: 'tg-unit-other-1777379999999'
			}
		});

		const trace = await buildMissionControlTrace({
			requestId,
			getProviderResults: () => []
		});

		expect(trace).toMatchObject({
			requestId,
			missionId: 'mission-1777371000002',
			phase: 'unknown',
			artifacts: {
				pendingRequest: null,
				lastCanvasLoad: null
			},
			surfaces: {
				telegram: { chatId: null, userId: null },
				canvas: { pipelineId: null, nodeCount: null }
			}
		});
	});

	it('treats provider failure as failed even when every provider process is finished', async () => {
		const stateDir = await makeStateDir();
		const requestId = 'tg-unit-failed-1777371000003';
		const missionId = 'mission-1777371000003';

		await writeJson(path.join(stateDir, 'pending-request.json'), {
			requestId,
			relay: { missionId, requestId }
		});

		const trace = await buildMissionControlTrace({
			requestId,
			getProviderResults: () => [],
			getDispatchStatus: () => ({
				allComplete: true,
				anyFailed: true,
				paused: false,
				pausedReason: null,
				lastReason: 'Mission completed with provider failures',
				snapshotAvailable: true,
				resumeable: false,
				resumeBlocker: null,
				providers: { codex: 'failed' }
			})
		});

		expect(trace.phase).toBe('failed');
		expect(trace.summary).toBe('Mission failed.');
		expect(trace.surfaces.dispatch).toMatchObject({
			allComplete: true,
			anyFailed: true,
			providers: { codex: 'failed' }
		});
	});

	it('reports cancelled when Mission Control has cancelled the mission', async () => {
		await makeStateDir();
		const missionId = `mission-cancelled-trace-${Date.now()}`;

		await relayMissionControlEvent({
			type: 'mission_cancelled',
			missionId,
			source: 'spawner-ui',
			message: 'Mission cancelled by user'
		});

		const trace = await buildMissionControlTrace({
			missionId,
			getProviderResults: () => []
		});

		expect(trace.phase).toBe('cancelled');
		expect(trace.summary).toContain('Mission cancelled');
		expect(trace.surfaces.kanban.bucket).toBe('cancelled');
	});
});
