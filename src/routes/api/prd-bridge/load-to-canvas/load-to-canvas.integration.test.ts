import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { POST } from './+server';
import { providerRuntime } from '$lib/server/provider-runtime';
import { getMissionControlRelaySnapshot } from '$lib/server/mission-control-relay';
import {
	buildClientGovernorDecisionAuthority,
	buildClientTurnIntentVNextAuthority
} from '$lib/services/harness-authority-client';

vi.mock('$lib/server/provider-runtime', () => ({
	providerRuntime: {
		dispatch: vi.fn(async ({ executionPack }) => ({
			success: true,
			missionId: executionPack.missionId,
			sessions: { codex: { status: 'running' } },
			startedAt: new Date().toISOString()
		})),
		getMissionStatus: vi.fn(() => ({
			allComplete: false,
			anyFailed: false,
			paused: false,
			pausedReason: null,
			lastReason: null,
			snapshotAvailable: false,
			resumeable: false,
			resumeBlocker: null,
			providers: {}
		})),
		getMissionResults: vi.fn(() => [])
	}
}));

let testSpawnerDir: string;
const TEST_API_KEY = 'prd-load-to-canvas-test-secret';
const originalBridgeApiKey = process.env.SPARK_BRIDGE_API_KEY;
const originalEventsApiKey = process.env.EVENTS_API_KEY;
const originalMcpApiKey = process.env.MCP_API_KEY;

function dispatchAuthority(requestId: string, missionId: string) {
	return buildClientGovernorDecisionAuthority({
		source: 'prd-load-authority-test',
		reason: 'Focused PRD load auto-dispatch authority regression.',
		toolName: 'spawner.dispatch',
		mutationClass: 'launches_mission',
		requestId,
		target: missionId
	});
}

function dispatchVNextAuthority(requestId: string, missionId: string) {
	return buildClientTurnIntentVNextAuthority({
		source: 'prd-load-authority-test',
		reason: 'Focused PRD load auto-dispatch authority regression.',
		toolName: 'spawner.dispatch',
		mutationClass: 'launches_mission',
		requestId,
		target: missionId
	});
}

async function resetTestSpawnerDir() {
	delete process.env.SPAWNER_STATE_DIR;
	if (originalBridgeApiKey === undefined) delete process.env.SPARK_BRIDGE_API_KEY;
	else process.env.SPARK_BRIDGE_API_KEY = originalBridgeApiKey;
	if (originalEventsApiKey === undefined) delete process.env.EVENTS_API_KEY;
	else process.env.EVENTS_API_KEY = originalEventsApiKey;
	if (originalMcpApiKey === undefined) delete process.env.MCP_API_KEY;
	else process.env.MCP_API_KEY = originalMcpApiKey;
	if (testSpawnerDir && existsSync(testSpawnerDir)) {
		await rm(testSpawnerDir, { recursive: true, force: true });
	}
}

describe('/api/prd-bridge/load-to-canvas integration', () => {
	beforeEach(async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
		await resetTestSpawnerDir();
		testSpawnerDir = await mkdtemp(path.join(tmpdir(), 'spawner-load-to-canvas-'));
		process.env.SPAWNER_STATE_DIR = testSpawnerDir;
		process.env.SPARK_BRIDGE_API_KEY = TEST_API_KEY;
		delete process.env.EVENTS_API_KEY;
		delete process.env.MCP_API_KEY;
		await mkdir(path.join(testSpawnerDir, 'results'), { recursive: true });
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await resetTestSpawnerDir();
	});

	it('rejects unauthenticated non-local canvas loads before mutating runtime state', async () => {
		const requestId = 'tg-load-unauth-test';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'Unauthorized Load',
				tasks: [{ id: 'TAS-1', title: 'Should not load', skills: [], dependencies: [] }]
			}),
			'utf-8'
		);

		const response = await POST({
			request: new Request('https://spawner.example.com/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ requestId, autoRun: false })
			}),
			url: new URL('https://spawner.example.com/api/prd-bridge/load-to-canvas'),
			getClientAddress: () => '203.0.113.10'
		} as never);

		expect(response.status).toBe(401);
		expect(existsSync(path.join(testSpawnerDir, 'pending-load.json'))).toBe(false);
		expect(existsSync(path.join(testSpawnerDir, 'last-canvas-load.json'))).toBe(false);
	});

	it('rejects unauthenticated local canvas loads before staging pending runtime state', async () => {
		const requestId = 'tg-load-local-unauth-test';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'Local Unauthorized Load',
				tasks: [{ id: 'TAS-1', title: 'Should not stage locally', skills: [], dependencies: [] }]
			}),
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://127.0.0.1:3333/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ requestId, autoRun: true })
			}),
			url: new URL('http://127.0.0.1:3333/api/prd-bridge/load-to-canvas'),
			getClientAddress: () => '127.0.0.1'
		} as never);

		expect(response.status).toBe(401);
		expect(existsSync(path.join(testSpawnerDir, 'pending-load.json'))).toBe(false);
		expect(existsSync(path.join(testSpawnerDir, 'last-canvas-load.json'))).toBe(false);
		expect(vi.mocked(providerRuntime.dispatch)).not.toHaveBeenCalled();
	});

	it('preserves PRD task acceptance criteria and verification commands in canvas nodes', async () => {
		const requestId = 'tg-contract-test';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'Spark Contract Test',
				tasks: [
					{
						id: 'task-1-static-shell',
						title: 'Create static shell',
						summary: 'Build the direct-launch app shell.',
						skills: ['frontend-ui-implementation', 'responsive-css'],
						workspaceTargets: ['C:\\Users\\USER\\Desktop\\spark-contract-test\\index.html'],
						acceptanceCriteria: [
							'Opening index.html directly renders the app.',
							'No package.json or build step is introduced.'
						],
						verificationCommands: [
							'Test-Path C:\\Users\\USER\\Desktop\\spark-contract-test\\index.html',
							'Select-String -Path C:\\Users\\USER\\Desktop\\spark-contract-test\\index.html -Pattern "styles.css","app.js"'
						]
					}
				],
				metadata: {
					taskQuality: {
						passed: true,
						score: 100,
						taskCount: 1,
						weakTaskIds: [],
						findings: [],
						summary: 'Task plan quality 100/100. No rubric findings.'
					}
				},
				executionPrompt: 'Build a vanilla JS app. No build step.'
			}),
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
				body: JSON.stringify({
					requestId,
					autoRun: true,
					executionAuthority: dispatchAuthority(requestId, 'mission-tg-contract-test')
				})
			})
		} as never);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.canvasUrl).toBe('/canvas?pipeline=prd-tg-contract-test&mission=mission-tg-contract-test');
		expect(body.boardUrl).toBe('/kanban?mission=mission-tg-contract-test');
		expect(body.canvasHandoff).toMatchObject({
			status: 'ready',
			reason: 'nodes_and_skill_pairings_materialized',
			boardFirst: true,
			canvasUrl: '/canvas?pipeline=prd-tg-contract-test&mission=mission-tg-contract-test'
		});
		expect(body.workflowHandoff).toMatchObject({
			status: 'ready',
			reason: 'canvas_nodes_skill_pairings_and_workflow_execution_created',
			canvasUrl: '/canvas?pipeline=prd-tg-contract-test&mission=mission-tg-contract-test'
		});
		expect(body.canvasMaterialized).toBe(true);
		expect(body.canvasMaterialization).toMatchObject({
			materialized: true,
			nodeCount: 1,
			pairedNodeCount: 1,
			skillCount: 2,
			pairingStatus: 'complete'
		});
		expect(body.missionControlAccess).toMatchObject({
			mode: 'local-only',
			url: null,
			mobileReachable: false
		});
		const pendingRaw = await readFile(path.join(testSpawnerDir, 'pending-load.json'), 'utf-8');
		const pending = JSON.parse(pendingRaw);
		expect(pending.requestId).toBe(requestId);
		expect(pending.missionId).toBe('mission-tg-contract-test');
		const pipelineArchive = JSON.parse(
			await readFile(path.join(testSpawnerDir, 'canvas-loads', `prd-${requestId}.json`), 'utf-8')
		);
		const missionArchive = JSON.parse(
			await readFile(path.join(testSpawnerDir, 'canvas-loads', 'mission-mission-tg-contract-test.json'), 'utf-8')
		);
		expect(pipelineArchive).toMatchObject({ requestId, missionId: 'mission-tg-contract-test' });
		expect(missionArchive).toMatchObject({ requestId, pipelineId: `prd-${requestId}` });
		expect(pending.executionPrompt).toBeUndefined();
		expect(pending.instructionTextRedacted).toBe(true);
		expect(pending.metadata.taskQuality).toMatchObject({
			passed: true,
			score: 100,
			taskCount: 1
		});
		expect(pending.nodes[0].skill).toMatchObject({
			id: 'task-1-static-shell',
			name: 'Create static shell',
			tags: ['frontend-ui-implementation', 'responsive-css'],
			skillChain: ['frontend-ui-implementation', 'responsive-css']
		});
		const description = pending.nodes[0].skill.description;
		expect(description).toContain('Build the direct-launch app shell.');
		expect(description).toContain('Workspace targets:');
		expect(description).toContain('Opening index.html directly renders the app.');
		expect(description).toContain('No package.json or build step is introduced.');
		expect(description).toContain('Verification commands:');
		expect(description).toContain('Select-String');
	});

	it('loads BOM-prefixed canonical result artifacts into canvas and workflow handoff', async () => {
		const requestId = 'tg-load-bom-result-test';
		const missionId = 'mission-tg-load-bom-result-test';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			`\ufeff${JSON.stringify(
				{
					requestId,
					success: true,
					projectName: 'BOM Canvas Load',
					projectType: 'direct-build',
					tasks: [
						{
							id: 'task-1',
							title: 'Build the BOM-safe board',
							description: 'Render the board after reading a canonical result artifact.',
							skills: ['frontend-engineer'],
							dependencies: []
						}
					],
					skills: ['frontend-engineer'],
					executionPrompt: 'Build the BOM-safe board.'
				},
				null,
				2
			)}`,
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
				body: JSON.stringify({
					requestId,
					missionId,
					autoRun: true,
					executionAuthority: dispatchAuthority(requestId, missionId)
				})
			})
		} as never);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.canvasMaterialization).toMatchObject({
			nodeCount: 1,
			pairedNodeCount: 1,
			skillCount: 1,
			pairingStatus: 'complete'
		});
		expect(body.workflowHandoff).toMatchObject({
			status: 'ready',
			canvasUrl: `/canvas?pipeline=prd-${requestId}&mission=${missionId}`
		});
	});

	it('withholds canvas handoff until task nodes have skill pairings while still returning the board', async () => {
		const requestId = 'tg-board-first-no-skills-test';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'Board First No Skills',
				tasks: [
					{
						id: 'task-1',
						title: 'Create project shell',
						summary: 'This task is intentionally missing skill pairings.',
						skills: [],
						dependencies: []
					}
				],
				executionPrompt: 'Build the board-first fixture.'
			}),
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
				body: JSON.stringify({ requestId, autoRun: false })
			})
		} as never);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.boardUrl).toBe('/kanban?mission=mission-tg-board-first-no-skills-test');
		expect(body.canvasUrl).toBeUndefined();
		expect(body.canvasHandoff).toMatchObject({
			status: 'withheld',
			reason: 'canvas_handoff_requires_materialized_nodes_and_complete_skill_pairings',
			boardFirst: true,
			canvasUrl: null
		});
		expect(body.workflowHandoff).toMatchObject({
			status: 'withheld',
			reason: 'canvas_handoff_requires_materialized_nodes_and_complete_skill_pairings',
			canvasUrl: null
		});
		expect(body.canvasMaterialization).toMatchObject({
			materialized: true,
			nodeCount: 1,
			pairedNodeCount: 0,
			skillCount: 0,
			pairingStatus: 'missing'
		});
		const requestFile = path.join(testSpawnerDir, 'pending-request.json');
		expect(existsSync(requestFile)).toBe(false);
	});

	it('does not auto-dispatch deterministic static proof results over existing artifacts', async () => {
		const requestId = 'tg-static-proof-load-test';
		const targetFolder = path.join(testSpawnerDir, 'spark-static-proof-load-test');
		const marker = 'SPARK_OS_STATIC_LOAD_TEST';
		const sentence = 'Static load proof stays deterministic';
		await mkdir(targetFolder, { recursive: true });
		await writeFile(path.join(targetFolder, 'index.html'), `<p>${marker}</p><p>${sentence}</p>`, 'utf-8');
		await writeFile(path.join(targetFolder, 'README.md'), `${marker}\n\n${sentence}\n`, 'utf-8');
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'Spark Static Proof Load Test',
				projectType: 'static-exact-file-proof',
				instructionTextRedacted: true,
				tasks: [
					{
						id: 'task-1-static-proof',
						title: 'Create deterministic static proof',
						summary: 'Create exactly index.html and README.md.',
						workspaceTargets: [targetFolder],
						acceptanceCriteria: [
							'index.html and README.md exist.',
							'The requested visible marker and sentence are present.'
						]
					}
				]
			}),
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
				body: JSON.stringify({ requestId, autoRun: true })
			})
		} as never);

		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.autoDispatch).toMatchObject({
			started: false,
			skipped: true,
			reason: 'deterministic static artifacts already written'
		});
		const pending = JSON.parse(await readFile(path.join(testSpawnerDir, 'pending-load.json'), 'utf-8'));
		expect(pending.autoRun).toBe(false);
		expect(await readFile(path.join(targetFolder, 'index.html'), 'utf-8')).toContain(marker);
		expect(await readFile(path.join(targetFolder, 'README.md'), 'utf-8')).toContain(sentence);
	});

	it('demotes auto-run to preview-only without inbound dispatch authority', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();
		const requestId = 'tg-load-no-dispatch-authority';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'No Dispatch Authority',
				tasks: [{ id: 'task-1', title: 'Prepare preview', summary: 'Preview only.', skills: ['frontend-engineer'] }],
				executionPrompt: 'Build only when dispatch authority is present.'
			}),
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
				body: JSON.stringify({ requestId, autoRun: true })
			})
		} as never);

		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.autoDispatch).toMatchObject({
			started: false,
			skipped: true,
			missionId: 'mission-tg-load-no-dispatch-authority'
		});
		expect(body.autoDispatch.reason).toContain('missing_harness_authority');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
		expect(body.workflowHandoff).toMatchObject({
			status: 'withheld',
			canvasUrl: null
		});
		expect(body.workflowHandoff.reason).toContain('missing_harness_authority');
		const pending = JSON.parse(await readFile(path.join(testSpawnerDir, 'pending-load.json'), 'utf-8'));
		expect(pending.autoRun).toBe(false);
		expect(pending.executionAuthority).toBeUndefined();
		expect(dispatch).not.toHaveBeenCalled();
		const traceRows = (await readFile(path.join(testSpawnerDir, 'prd-auto-trace.jsonl'), 'utf-8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(traceRows.map((row) => row.event)).toEqual(
			expect.arrayContaining([
				'canvas_auto_run_authority_withheld',
				'canvas_load_materialized',
				'canvas_auto_dispatch_withheld'
			])
		);
		expect(traceRows.find((row) => row.event === 'canvas_auto_run_authority_withheld')).toMatchObject({
			requestId,
			missionId: 'mission-tg-load-no-dispatch-authority',
			reasonCodes: expect.arrayContaining(['missing_harness_authority'])
		});
		const relaySnapshot = getMissionControlRelaySnapshot('mission-tg-load-no-dispatch-authority');
		expect(relaySnapshot.recent).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: 'task_completed',
					taskName: 'PRD analysis',
					requestId
				}),
				expect.objectContaining({
					eventType: 'mission_created',
					taskName: 'Canvas ready',
					requestId
				}),
				expect.objectContaining({
					eventType: 'log',
					taskName: 'Workflow start withheld',
					requestId,
					summary: expect.stringContaining('Workflow start withheld')
				})
			])
		);
	});

	it('demotes bare VNext dispatch authority to preview-only', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();
		const requestId = 'tg-load-vnext-dispatch-authority';
		const missionId = 'mission-tg-load-vnext-dispatch-authority';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'VNext Dispatch Authority',
				tasks: [{ id: 'task-1', title: 'Prepare preview', summary: 'Preview only.', skills: [] }],
				executionPrompt: 'Build only when native Governor dispatch authority is present.'
			}),
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
				body: JSON.stringify({
					requestId,
					autoRun: true,
					executionAuthority: dispatchVNextAuthority(requestId, missionId)
				})
			})
		} as never);

		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.autoDispatch.reason).toContain('native_governor_required');
		expect(body.authority).toMatchObject({
			source: 'turn_intent_vnext',
			reasonCodes: expect.arrayContaining(['native_governor_required'])
		});
		const pending = JSON.parse(await readFile(path.join(testSpawnerDir, 'pending-load.json'), 'utf-8'));
		expect(pending.autoRun).toBe(false);
		expect(pending.executionAuthority).toBeUndefined();
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('keeps auto-run executable with inbound native Governor dispatch authority', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();
		const requestId = 'tg-load-governor-dispatch-authority';
		const missionId = 'mission-tg-load-governor-dispatch-authority';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'Governor Dispatch Authority',
				tasks: [{ id: 'task-1', title: 'Start authorized build', summary: 'Authorized run.', skills: [] }],
				executionPrompt: 'Build when dispatch authority is present.'
			}),
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
				body: JSON.stringify({
					requestId,
					autoRun: true,
					executionAuthority: dispatchAuthority(requestId, missionId)
				})
			})
		} as never);

		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.autoDispatch.missionId).toBe(missionId);
		expect(body.autoDispatch.reason || '').not.toContain('missing_harness_authority');
		expect(body.autoDispatch.reason || '').not.toContain('native_governor_required');
		expect(body.authority).toMatchObject({ source: 'governor_decision', governorOutcome: 'execute' });
		const pending = JSON.parse(await readFile(path.join(testSpawnerDir, 'pending-load.json'), 'utf-8'));
		expect(pending.autoRun).toBe(true);
		expect(pending.executionAuthority).toBeUndefined();
		expect(pending.metadata.executionAuthority).toBeUndefined();
	});

	it('preserves Telegram relay target metadata for canvas auto-run dispatch', async () => {
		const requestId = 'tg-relay-target-test';
		const traceRef = 'trace:spawner-prd:mission-tg-relay-target-test';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'Spark Relay Target Test',
				tasks: [
					{
						id: 'task-1',
						title: 'Build relay target',
						summary: 'Confirm Telegram relay metadata survives PRD bridge loading.',
						skills: ['telegram-relay']
					}
				],
				executionPrompt: 'Build the relay target test.'
			}),
			'utf-8'
		);
		await writeFile(
			path.join(testSpawnerDir, 'pending-request.json'),
			JSON.stringify({
				requestId,
				traceRef,
				buildMode: 'advanced_prd',
				buildModeReason: 'Multi-agent Telegram relay test.',
				relay: {
					chatId: '8319079055',
					userId: '8319079055',
					requestId,
					traceRef,
					goal: 'Build through the primary Telegram relay.',
					telegramRelay: { port: 8789, profile: 'primary' }
				}
			}),
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
				body: JSON.stringify({
					requestId,
					autoRun: true,
					executionAuthority: dispatchAuthority(requestId, 'mission-tg-relay-target-test')
				})
			})
		} as never);

		expect(response.status).toBe(200);
		const pendingRaw = await readFile(path.join(testSpawnerDir, 'pending-load.json'), 'utf-8');
		const pending = JSON.parse(pendingRaw);
		expect(pending.traceRef).toBe(traceRef);
		expect(pending.relay).toMatchObject({
			missionId: 'mission-tg-relay-target-test',
			chatId: '8319079055',
			userId: '8319079055',
			requestId,
			traceRef,
			autoRun: true,
			buildMode: 'advanced_prd',
			buildModeReason: 'Multi-agent Telegram relay test.',
			telegramRelay: { port: 8789, profile: 'primary' }
		});
		expect(pending.executionAuthority).toBeUndefined();
		expect(pending.relay.executionAuthority).toBeUndefined();
		expect(pending.metadata.executionAuthority).toBeUndefined();
		const requestRaw = await readFile(path.join(testSpawnerDir, 'pending-request.json'), 'utf-8');
		const requestMeta = JSON.parse(requestRaw);
		expect(requestMeta).toMatchObject({
			requestId,
			traceRef,
			status: 'canvas_loaded',
			pipelineId: `prd-${requestId}`,
			canvasUrl: `/canvas?pipeline=prd-${requestId}&mission=mission-tg-relay-target-test`,
			missionControlAccess: {
				mode: 'local-only',
				url: null,
				mobileReachable: false
			}
		});
	});

	it('carries capability proposal packets into canvas and mission metadata without changing normal task loading', async () => {
		const requestId = 'tg-capability-packet-test';
		const capabilityProposalPacket = {
			schema_version: 'spark.capability_proposal.v1',
			status: 'proposal_plan_only',
			implementation_route: 'domain_chip',
			owner_system: 'Spark domain chip runtime',
			capability_ledger_key: 'domain_chip:email-summary-chip',
			claim_boundary: 'This packet is a proposal plan, not proof that Spark has gained the capability.'
		};
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'Spark Capability Packet Test',
				tasks: [
					{
						id: 'task-1',
						title: 'Plan capability chip',
						summary: 'Keep capability packet attached while preserving the PRD task.',
						skills: ['domain-chip']
					}
				],
				executionPrompt: 'Build the capability packet test.'
			}),
			'utf-8'
		);
		await writeFile(
			path.join(testSpawnerDir, 'pending-request.json'),
			JSON.stringify({
				requestId,
				buildMode: 'advanced_prd',
				buildModeReason: 'Capability proposal build.',
				capabilityProposalPacket
			}),
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
				body: JSON.stringify({ requestId, autoRun: true })
			})
		} as never);

		expect(response.status).toBe(200);
		const pendingRaw = await readFile(path.join(testSpawnerDir, 'pending-load.json'), 'utf-8');
		const pending = JSON.parse(pendingRaw);
		expect(pending.nodes).toHaveLength(1);
		expect(pending.capabilityProposalPacket).toMatchObject(capabilityProposalPacket);
		expect(pending.metadata.capabilityProposalPacket).toMatchObject(capabilityProposalPacket);
		expect(pending.capabilityProposalSummary).toMatchObject({
			schemaVersion: 'spark.capability_proposal.v1',
			status: 'proposal_plan_only',
			implementationRoute: 'domain_chip',
			ledgerKey: 'domain_chip:email-summary-chip',
			ownerSystem: 'Spark domain chip runtime'
		});
		const requestRaw = await readFile(path.join(testSpawnerDir, 'pending-request.json'), 'utf-8');
		const requestMeta = JSON.parse(requestRaw);
		expect(requestMeta.capabilityProposalSummary.ledgerKey).toBe('domain_chip:email-summary-chip');
	});

	it('returns hosted Mission Control access when a mobile URL is configured', async () => {
		const previous = process.env.SPAWNER_MISSION_CONTROL_PUBLIC_URL;
		process.env.SPAWNER_MISSION_CONTROL_PUBLIC_URL = 'https://mission.sparkswarm.ai/app';
		try {
			const requestId = 'tg-mobile-access-test';
			await writeFile(
				path.join(testSpawnerDir, 'results', `${requestId}.json`),
				JSON.stringify({
					requestId,
					success: true,
					projectName: 'Spark Mobile Access Test',
					tasks: [{ id: 'task-1', title: 'Expose mobile access', summary: 'Return access metadata.', skills: [] }],
					executionPrompt: 'Build the mobile access test.'
				}),
				'utf-8'
			);

			const response = await POST({
				request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
					body: JSON.stringify({ requestId, autoRun: false })
				})
			} as never);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.missionControlAccess).toMatchObject({
				mode: 'hosted',
				url: 'https://mission.sparkswarm.ai/app/missions/mission-tg-mobile-access-test',
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

	it('builds relay metadata from request body when pending request metadata is stale', async () => {
		const requestId = 'tg-build-123-456-1777211869020';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'Spark Body Relay Test',
				tasks: [{ id: 'task-1', title: 'Build body relay', summary: 'Use body fallback.', skills: [] }],
				executionPrompt: 'Build with body relay.'
			}),
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
				body: JSON.stringify({
					requestId,
					autoRun: true,
					chatId: '8319079055',
					userId: '8319079055',
					goal: 'Build through body relay metadata.',
					telegramRelay: { port: 8789, profile: 'spark-agi' },
					executionAuthority: dispatchAuthority(requestId, 'mission-1777211869020')
				})
			})
		} as never);

		expect(response.status).toBe(200);
		const pendingRaw = await readFile(path.join(testSpawnerDir, 'pending-load.json'), 'utf-8');
		const pending = JSON.parse(pendingRaw);
		expect(pending.relay).toMatchObject({
			missionId: 'mission-1777211869020',
			chatId: '8319079055',
			userId: '8319079055',
			requestId,
			autoRun: true,
			telegramRelay: { port: 8789, profile: 'spark-agi' }
		});
	});

	it('queues a full advanced PRD canvas contract with nodes, dependencies, autorun, and Telegram relay', async () => {
		const requestId = 'tg-build-8319079055-777-1777300000000';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'Spark Mission Arcade',
				tasks: [
					{
						id: 'task-1',
						title: 'Create project shell',
						summary: 'Create the static app workspace and base files.',
						skills: ['frontend-engineer'],
						acceptanceCriteria: ['index.html, styles.css, app.js, and README.md exist.'],
						verificationCommands: ['Get-ChildItem']
					},
					{
						id: 'task-2',
						title: 'Implement game-like mission UI',
						summary: 'Build playful mission cards, energy, streak, and launch states.',
						skills: ['ui-design', 'javascript-state'],
						dependencies: ['task-1'],
						acceptanceCriteria: ['The first screen shows active mission status and launch controls.'],
						verificationCommands: ['Select-String -Path app.js -Pattern "localStorage","launch"']
					},
					{
						id: 'task-3',
						title: 'Write smoke-test README',
						summary: 'Document direct launch and refresh persistence checks.',
						skills: ['technical-writer'],
						dependencies: ['task-1'],
						acceptanceCriteria: ['README explains direct index.html launch and manual smoke tests.'],
						verificationCommands: ['Get-Content README.md']
					}
				],
				executionPrompt: 'Advanced PRD: build Spark Mission Arcade with TAS-style verification.'
			}),
			'utf-8'
		);
		await writeFile(
			path.join(testSpawnerDir, 'pending-request.json'),
			JSON.stringify({
				requestId,
				buildMode: 'advanced_prd',
				buildModeReason: 'Request looks like a new project or systematic feature that benefits from PRD-to-task planning.',
				relay: {
					chatId: '8319079055',
					userId: '8319079055',
					requestId,
					goal: '# Spark Mission Arcade\n\nTarget operating-system folder: `/root/spark-mission-arcade`\n\nBuild the project.',
					telegramRelay: { port: 8788, profile: 'spark-agi' }
				}
			}),
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
				body: JSON.stringify({
					requestId,
					autoRun: true,
					telegramRelay: { port: 8788, profile: 'spark-agi' },
					executionAuthority: dispatchAuthority(requestId, 'mission-1777300000000')
				})
			})
		} as never);

		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload).toMatchObject({
			success: true,
			pipelineId: `prd-${requestId}`,
			pipelineName: 'Spark Mission Arcade',
			taskCount: 3,
			connectionCount: 2,
			canvasUrl: `/canvas?pipeline=prd-${requestId}&mission=mission-1777300000000`
		});

		const pendingRaw = await readFile(path.join(testSpawnerDir, 'pending-load.json'), 'utf-8');
		const pending = JSON.parse(pendingRaw);
		expect(pending).toMatchObject({
			pipelineId: `prd-${requestId}`,
			pipelineName: 'Spark Mission Arcade',
			source: 'prd-bridge',
			autoRun: true,
			buildMode: 'advanced_prd',
			buildModeReason: 'Request looks like a new project or systematic feature that benefits from PRD-to-task planning.',
			instructionTextRedacted: true
		});
		expect(pending.executionPrompt).toBeUndefined();
		expect(pendingRaw).not.toContain('Advanced PRD: build Spark Mission Arcade');
		expect(pending.nodes).toHaveLength(3);
		expect(pending.nodes.map((node: any) => node.skill.name)).toEqual([
			'Create project shell',
			'Implement game-like mission UI',
			'Write smoke-test README'
		]);
		expect(pending.nodes.map((node: any) => node.skill.id)).toEqual(['task-1', 'task-2', 'task-3']);
		expect(pending.nodes[1].skill.skillChain).toEqual(['ui-design', 'javascript-state']);
		expect(pending.connections).toEqual([
			{ sourceIndex: 0, targetIndex: 1 },
			{ sourceIndex: 0, targetIndex: 2 }
		]);
		expect(pending.relay).toMatchObject({
			missionId: 'mission-1777300000000',
			chatId: '8319079055',
			userId: '8319079055',
			requestId,
			autoRun: true,
			buildMode: 'advanced_prd',
			telegramRelay: { port: 8788, profile: 'spark-agi' }
		});
		expect(pending.relay.goal).toContain('/root/spark-mission-arcade');
	});

	it('loads sparse clarification tasks without artificial serial dependencies or duplication', async () => {
		const requestId = 'tg-build-8319079055-2607-1777608553410-clarified-1777608630635';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'did you understand what i said',
				projectType: 'clarification-understanding',
				complexity: 'simple',
				infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
				techStack: { framework: 'Existing Spawner UI', language: 'TypeScript' },
				tasks: [
					{
						id: 'task-1-acknowledge-understanding',
						title: 'Acknowledge the understanding check',
						summary: 'Confirm Spark understood the user is asking whether the previous message was understood.',
						skills: ['conversation-memory', 'ux-design'],
						dependencies: [],
						acceptanceCriteria: ['Original request text is preserved exactly.'],
						verificationCommands: ['npm run check']
					},
					{
						id: 'task-2-ask-for-actionable-details',
						title: 'Ask for the missing build details',
						summary: 'Prompt for audience, core workflow, saved memory, and vibe details.',
						skills: ['product-discovery', 'structured-output'],
						dependencies: [],
						acceptanceCriteria: ['The user can continue with concrete details.'],
						verificationCommands: ['npm run smoke:routes']
					}
				],
				skills: ['conversation-memory', 'ux-design', 'product-discovery', 'structured-output'],
				executionPrompt: 'Original user request: did you understand what i said'
			}),
			'utf-8'
		);

		for (let attempt = 0; attempt < 2; attempt++) {
			const response = await POST({
				request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
					body: JSON.stringify({ requestId, autoRun: false })
				})
			} as never);
			expect(response.status).toBe(200);
		}

		const pendingRaw = await readFile(path.join(testSpawnerDir, 'pending-load.json'), 'utf-8');
		const pending = JSON.parse(pendingRaw);
		expect(pending.pipelineName).toBe('did you understand what i said');
		expect(pending.nodes).toHaveLength(2);
		expect(pending.connections).toEqual([]);
		expect(pending.nodes.map((node: any) => node.skill.id)).toEqual([
			'task-1-acknowledge-understanding',
			'task-2-ask-for-actionable-details'
		]);
		expect(pending.nodes[0].skill.description).toContain('Acceptance criteria:');
		expect(pending.nodes[1].skill.description).toContain('Verification commands:');
	});

	it('carries pending request tier into canvas load and relay metadata', async () => {
		const requestId = 'tg-pro-tier-canvas-test';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({
				requestId,
				success: true,
				projectName: 'Pro Tier Canvas',
				projectType: 'direct-build',
				complexity: 'simple',
				infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
				techStack: { framework: 'Existing Spawner UI', language: 'TypeScript' },
				tasks: [
					{
						id: 'task-1',
						title: 'Build pro canvas',
						summary: 'Use the stored tier for dispatch.',
						skills: ['frontend-engineer', 'threejs-3d-graphics'],
						dependencies: []
					}
				],
				skills: ['frontend-engineer', 'threejs-3d-graphics']
			}),
			'utf-8'
		);
		await writeFile(
			path.join(testSpawnerDir, 'pending-request.json'),
			JSON.stringify({
				requestId,
				tier: 'pro',
				relay: {
					chatId: '8319079055',
					userId: '8319079055',
					requestId
				}
			}),
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
				body: JSON.stringify({ requestId, autoRun: false })
			})
		} as never);

		expect(response.status).toBe(200);
		const pending = JSON.parse(await readFile(path.join(testSpawnerDir, 'pending-load.json'), 'utf-8'));
		expect(pending.tier).toBe('pro');
		expect(pending.relay.tier).toBe('pro');
		expect(pending.nodes[0].skill.skillChain).toEqual(['frontend-engineer', 'threejs-3d-graphics']);
	});

	it('does not echo key-shaped request ids when analysis results are missing', async () => {
		const requestId = 'OPENAI_API_KEY=sk-placeholder-load-canvas-token-123456';

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ requestId, autoRun: false })
			})
		} as never);

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error).toBe('No analysis result found for that request.');
		expect(JSON.stringify(body)).not.toContain('sk-placeholder-load-canvas-token-123456');
	});

	it('does not echo malformed result contents in load-to-canvas failures', async () => {
		const requestId = 'tg-malformed-result-redaction-test';
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			'OPENAI_API_KEY=sk-placeholder-load-canvas-token-123456',
			'utf-8'
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/load-to-canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ requestId, autoRun: false })
			})
		} as never);

		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body.error).toBe('Failed to load PRD result into canvas.');
		expect(JSON.stringify(body)).not.toContain('OPENAI_API_KEY');
		expect(JSON.stringify(body)).not.toContain('sk-placeholder-load-canvas-token-123456');
	});
});
