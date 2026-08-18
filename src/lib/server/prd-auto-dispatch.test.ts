import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
	_createScopedH70AccessForLoad,
	_resolvedProjectRelay,
	autoDispatchPrdCanvasLoad,
	buildAutoDispatchTaskSkillMap,
	canvasLoadToMissionGraph,
	_providerApiKeysFromEnv,
	inferProjectPathFromPrdLoad,
	shouldAutoDispatchPrdLoad,
	type PrdCanvasLoadForAutoDispatch
} from './prd-auto-dispatch';
import { relayMissionControlEvent } from './mission-control-relay';
import {
	buildServerGovernorDecisionAuthority,
	buildServerTurnIntentVNextAuthority
} from './harness-authority';
import { verifyH70SkillAccessToken } from './h70-skill-access-token';
import { getTierSkills } from './skill-tiers';
import { eventBridge } from '$lib/services/event-bridge';
import { providerRuntime } from './provider-runtime';

const { originalSpawnerStateDir } = vi.hoisted(() => {
	const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
	process.env.SPAWNER_STATE_DIR = `${process.cwd()}/.svelte-kit/test-state/prd-auto-dispatch-${process.pid}`;
	return { originalSpawnerStateDir };
});
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const load: PrdCanvasLoadForAutoDispatch = {
	requestId: 'tg-build-1',
	missionId: 'mission-1',
	pipelineId: 'prd-tg-build-1',
	pipelineName: 'Spark Test',
	autoRun: true,
	executionPrompt: 'Build this at C:\\Users\\USER\\Desktop\\spark-test as a standalone project.',
	nodes: [
		{
			skill: {
				id: 'task-task-1',
				name: 'task-1: Create shell',
				description: 'Create C:\\Users\\USER\\Desktop\\spark-test\\index.html',
				category: 'development',
				tier: 'free',
				tags: ['frontend-engineer'],
				triggers: []
			},
			position: { x: 160, y: 140 }
		},
		{
			skill: {
				id: 'task-task-2',
				name: 'task-2: Verify shell',
				description: 'Run smoke checks.',
				category: 'development',
				tier: 'free',
				tags: ['test-architect'],
				triggers: []
			},
			position: { x: 480, y: 140 }
		}
	],
	connections: [{ sourceIndex: 0, targetIndex: 1 }]
};

let testSpawnerDir: string | null = null;
const originalSparkWorkspaceRoot = process.env.SPARK_WORKSPACE_ROOT;
const originalSpawnerWorkspaceRoot = process.env.SPAWNER_WORKSPACE_ROOT;
const originalAllowExternalProjectPaths = process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
const originalAllowHighAgencyWorkers = process.env.SPARK_ALLOW_HIGH_AGENCY_WORKERS;
const originalCodexSandbox = process.env.SPARK_CODEX_SANDBOX;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function governorAuthority(authorityLoad: PrdCanvasLoadForAutoDispatch = load) {
	return buildServerGovernorDecisionAuthority({
		source: 'prd-auto-dispatch-test',
		reason: 'Focused PRD auto-dispatch authority regression.',
		toolName: 'spawner.dispatch',
		mutationClass: 'launches_mission',
		requestId: authorityLoad.requestId,
		actorKind: 'system',
		actorIdRef: 'spawner-ui.test',
		target: authorityLoad.missionId
	});
}

function bareVNextAuthority() {
	return buildServerTurnIntentVNextAuthority({
		source: 'prd-auto-dispatch-test',
		reason: 'Focused PRD auto-dispatch authority regression.',
		toolName: 'spawner.dispatch',
		mutationClass: 'launches_mission',
		requestId: load.requestId,
		actorKind: 'system',
		actorIdRef: 'spawner-ui.test',
		target: load.missionId
	});
}

describe('PRD auto-dispatch helpers', () => {
	beforeEach(async () => {
		testSpawnerDir = await mkdtemp(path.join(tmpdir(), 'spawner-prd-auto-dispatch-'));
		process.env.SPAWNER_STATE_DIR = testSpawnerDir;
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		restoreEnv('SPAWNER_STATE_DIR', originalSpawnerStateDir);
		restoreEnv('SPARK_WORKSPACE_ROOT', originalSparkWorkspaceRoot);
		restoreEnv('SPAWNER_WORKSPACE_ROOT', originalSpawnerWorkspaceRoot);
		restoreEnv('SPARK_ALLOW_EXTERNAL_PROJECT_PATHS', originalAllowExternalProjectPaths);
		restoreEnv('SPARK_ALLOW_HIGH_AGENCY_WORKERS', originalAllowHighAgencyWorkers);
		restoreEnv('SPARK_CODEX_SANDBOX', originalCodexSandbox);
		vi.restoreAllMocks();
		if (testSpawnerDir && existsSync(testSpawnerDir)) {
			await rm(testSpawnerDir, { recursive: true, force: true });
		}
		testSpawnerDir = null;
	});

	it('converts PRD bridge node indexes into executable canvas node and connection ids', () => {
		const graph = canvasLoadToMissionGraph(load);

		expect(graph.nodes).toHaveLength(2);
		expect(graph.nodes[0]).toMatchObject({
			id: 'node-1-task-task-1',
			skillId: 'task-task-1',
			status: 'queued'
		});
		expect(graph.connections).toEqual([
			{
				id: 'conn-1-node-1-task-task-1-to-node-2-task-task-2',
				sourceNodeId: 'node-1-task-task-1',
				sourcePortId: 'output',
				targetNodeId: 'node-2-task-task-2',
				targetPortId: 'input'
			}
		]);
	});

	it('extracts the standalone target folder from PRD execution text', () => {
		expect(inferProjectPathFromPrdLoad(load)).toBe('C:\\Users\\USER\\Desktop\\spark-test');
	});

	it('uses structured project lineage before command-like verification text', () => {
		const projectPath = inferProjectPathFromPrdLoad({
			...load,
			executionPrompt:
				"Verification commands:\n- Test-Path 'C:/Users/USER/.spark/workspaces/harness-rendered-cua-proof-20260610l/index.html'; Test-Path 'C:/Users/USER/.spark/workspaces/harness-rendered-cua-proof-20260610l/styles.css'",
			relay: {
				projectLineage: {
					projectPath: 'C:/Users/USER/.spark/workspaces/harness-rendered-cua-proof-20260610l'
				}
			}
		});

		expect(projectPath).toBe('C:/Users/USER/.spark/workspaces/harness-rendered-cua-proof-20260610l');
		expect(projectPath).not.toContain('index.html');
		expect(projectPath).not.toContain('Test-Path');
	});

	it('rejects semicolon-joined file verification targets as project paths', () => {
		const projectPath = inferProjectPathFromPrdLoad(
			{
				...load,
				executionPrompt:
					"Verification commands:\n- Test-Path 'C:/Users/USER/.spark/workspaces/harness-rendered-cua-proof-20260610l/index.html'; Test-Path 'C:/Users/USER/.spark/workspaces/harness-rendered-cua-proof-20260610l/styles.css'",
				relay: {}
			},
			{ SPARK_WORKSPACE_ROOT: '/data/workspaces' }
		);

		expect(projectPath).toMatch(/[\\/]data[\\/]workspaces[\\/]mission-1-spark-test$/);
		expect(projectPath).not.toContain('index.html');
		expect(projectPath).not.toContain('Test-Path');
	});

	it('stops Windows target folders before prose after a colon', () => {
		expect(
			inferProjectPathFromPrdLoad({
				...load,
				executionPrompt:
					'Build this at C:\\Users\\USER\\Desktop\\spark-progress-pause-probe: a vanilla-JS static app called Spark Progress Pause Probe.'
			})
		).toBe('C:\\Users\\USER\\Desktop\\spark-progress-pause-probe');
	});

	it('stops Windows target folders before sentence prose after the folder name', () => {
		expect(
			inferProjectPathFromPrdLoad({
				...load,
				executionPrompt:
					'Create a local-only static proof in C:\\Users\\USER\\Desktop\\spark-os-proof-s. You must create exactly two files and no others.'
			})
		).toBe('C:\\Users\\USER\\Desktop\\spark-os-proof-s');
	});

	it('uses a hosted workspace folder when PRD text has no explicit path', () => {
		const projectPath = inferProjectPathFromPrdLoad(
			{
				...load,
				executionPrompt: 'Build a tiny static landing page for a cafe.',
				nodes: [{ skill: { name: 'task-1: Build page', description: 'Create the page.' } }]
			},
			{ SPARK_WORKSPACE_ROOT: '/data/workspaces' }
		);

		expect(projectPath).toMatch(/[\\/]data[\\/]workspaces[\\/]mission-1-spark-test$/);
	});

	it('uses SPARK_WORKSPACE_ROOT as the one generated-project root when both workspace variables differ', () => {
		const projectPath = inferProjectPathFromPrdLoad(
			{
				...load,
				executionPrompt: 'Build a tiny static landing page for a cafe.',
				nodes: [{ skill: { name: 'task-1: Build page', description: 'Create the page.' } }]
			},
			{
				SPARK_WORKSPACE_ROOT: '/data/spark-workspaces',
				SPAWNER_WORKSPACE_ROOT: '/data/legacy-spawner-workspaces'
			}
		);

		expect(projectPath).toMatch(/[\\/]data[\\/]spark-workspaces[\\/]mission-1-spark-test$/);
		expect(projectPath).not.toContain('legacy-spawner-workspaces');
	});

	it('does not treat relative workspace target files as the executor workspace', () => {
		const projectPath = inferProjectPathFromPrdLoad(
			{
				...load,
				executionPrompt: 'Build a tiny local Spawner proof pad.',
				nodes: [
					{
						skill: {
							name: 'task-1: Data contract',
							description:
								'Workspace targets:\n- src/lib/server/relay-readback-proof-pad.ts\n- src/lib/server/relay-readback-proof-pad.test.ts'
						}
					}
				]
			},
			{ SPARK_WORKSPACE_ROOT: '/data/workspaces' }
		);

		expect(projectPath).toMatch(/[\\/]data[\\/]workspaces[\\/]mission-1-spark-test$/);
		expect(projectPath).not.toContain('src');
		expect(projectPath).not.toContain('relay-readback-proof-pad');
	});

	it('does not treat absolute file targets as the executor workspace', () => {
		const projectPath = inferProjectPathFromPrdLoad(
			{
				...load,
				executionPrompt: 'Build a tiny local Spawner proof pad.',
				nodes: [
					{
						skill: {
							name: 'task-1: Data contract',
							description:
								'Workspace targets:\n- C:\\Users\\USER\\.spark\\modules\\spawner-ui\\source\\src\\lib\\server\\relay-readback-proof-pad.test.ts'
						}
					}
				]
			},
			{ SPARK_WORKSPACE_ROOT: '/data/workspaces' }
		);

		expect(projectPath).toMatch(/[\\/]data[\\/]workspaces[\\/]mission-1-spark-test$/);
		expect(projectPath).not.toContain('relay-readback-proof-pad.test.ts');
	});

	it('does not let provider task text choose the installed Spawner source as a new-project workspace', () => {
		const projectPath = inferProjectPathFromPrdLoad(
			{
				...load,
				executionPrompt: '',
				relay: {
					goal:
						'Build a compact local Spawner Authority Handoff Board for tonight installer work with Spawner. Make a real project with a README, one smoke test, and a simple page.'
				},
				nodes: [
					{
						skill: {
							name: 'task-1: README',
							description:
								'Workspace targets:\n- docs/spawner-authority-handoff-board/README.md\n\nAcceptance criteria:\n- README includes workspace path C:\\Users\\USER\\.spark\\modules\\spawner-ui\\source.'
						}
					}
				]
			},
			{ SPARK_WORKSPACE_ROOT: '/data/workspaces' }
		);

		expect(projectPath).toMatch(/[\\/]data[\\/]workspaces[\\/]mission-1-spark-test$/);
		expect(projectPath).not.toContain('spawner-ui');
		expect(projectPath).not.toContain('source');
	});

	it('uses the Spark workspace instead of Spawner state for generated projects', () => {
		const sparkHome = path.join(testSpawnerDir!, 'spark-home');
		const projectPath = inferProjectPathFromPrdLoad(
			{
				...load,
				executionPrompt: 'Build a tiny static landing page for a cafe.',
				nodes: [{ skill: { name: 'task-1: Build page', description: 'Create the page.' } }]
			},
			{ SPARK_HOME: sparkHome, SPAWNER_STATE_DIR: path.join(testSpawnerDir!, 'spawner-state') }
		);

		expect(projectPath).toBe(path.resolve(sparkHome, 'workspaces', 'generated-projects', 'mission-1-spark-test'));
		expect(projectPath).not.toContain('spawner-state');
	});

	it('fails closed before mkdir or provider dispatch for unsafe final lineage and explicit PRD paths', async () => {
		const originalCwd = process.cwd();
		const workspaceRoot = path.join(testSpawnerDir!, 'workspaces');
		const externalRoot = path.join(testSpawnerDir!, 'external');
		await mkdir(workspaceRoot, { recursive: true });
		await mkdir(externalRoot, { recursive: true });
		process.env.SPARK_WORKSPACE_ROOT = workspaceRoot;
		delete process.env.SPAWNER_WORKSPACE_ROOT;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
		const linkedOut = path.join(workspaceRoot, 'linked-out');
		await symlink(externalRoot, linkedOut, process.platform === 'win32' ? 'junction' : 'dir');
		const foreignPath = process.platform === 'win32'
			? '/tmp/spark-foreign-auto-dispatch'
			: 'C:\\Users\\USER\\Desktop\\spark-foreign-auto-dispatch';
		const cases = [
			{
				label: 'lineage traversal escape',
				path: path.resolve(workspaceRoot, '..', 'traversal-escape'),
				source: 'lineage'
			},
			{
				label: 'explicit root-prefix collision',
				path: path.join(`${workspaceRoot}-evil`, 'project'),
				source: 'explicit'
			},
			{
				label: 'lineage symlink escape',
				path: path.join(linkedOut, 'project'),
				source: 'lineage'
			},
			{ label: 'explicit foreign-OS path', path: foreignPath, source: 'explicit' },
			{ label: 'lineage caret metacharacter', path: path.join(workspaceRoot, 'unsafe^project'), source: 'lineage' },
			{ label: 'explicit percent metacharacter', path: path.join(workspaceRoot, 'unsafe%TEMP%project'), source: 'explicit' },
			{ label: 'lineage bang metacharacter', path: path.join(workspaceRoot, 'unsafe!VAR!project'), source: 'lineage' }
		] as const;
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => 'ok',
			json: async () => ({ ok: true })
		}));
		vi.stubGlobal('fetch', fetchMock);

		try {
			process.chdir(testSpawnerDir!);
			const results = [];
			for (const [index, testCase] of cases.entries()) {
				const candidate: PrdCanvasLoadForAutoDispatch = {
					...load,
					requestId: `tg-path-authority-${index}`,
					missionId: `mission-path-authority-${index}`,
					executionPrompt: testCase.source === 'explicit'
						? `Build this at ${testCase.path}`
						: 'Build a compact local API service.',
					relay: testCase.source === 'lineage'
						? { projectLineage: { projectPath: testCase.path } }
						: {}
				};
				candidate.executionAuthority = governorAuthority(candidate);
				results.push({ testCase, result: await autoDispatchPrdCanvasLoad(candidate) });
			}

			for (const { testCase, result } of results) {
				expect(result.started, testCase.label).toBe(false);
				expect(result.error, testCase.label).toMatch(/workspace root|Spark-controlled root|foreign operating-system|unsafe.*metacharacter/i);
				expect(existsSync(testCase.path), testCase.label).toBe(false);
			}
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			process.chdir(originalCwd);
		}
	});

	it('keeps a foreign path as evidence only and dispatches from a generated Spark workspace', async () => {
		const workspaceRoot = path.join(testSpawnerDir!, 'workspaces');
		await mkdir(workspaceRoot, { recursive: true });
		process.env.SPARK_WORKSPACE_ROOT = workspaceRoot;
		delete process.env.SPAWNER_WORKSPACE_ROOT;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
		const foreignPath = process.platform === 'win32'
			? '/tmp/evidence-only-project'
			: 'C:\\Users\\USER\\Desktop\\evidence-only-project';
		vi.stubGlobal('fetch', vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => 'ok',
			json: async () => ({ ok: true })
		})));
		const candidate: PrdCanvasLoadForAutoDispatch = {
			...load,
			requestId: 'tg-path-evidence-only',
			missionId: 'mission-path-evidence-only',
			executionPrompt: `Build a compact local API service with tests at ${foreignPath}.`,
			relay: {
				goal: `Build the compact service at ${foreignPath}.`,
				projectLineage: {
					projectPath: foreignPath,
					projectId: 'project-foreign-path',
					previewUrl: 'http://127.0.0.1:3333/preview/foreign/index.html',
					parentMissionId: 'mission-parent-safe'
				},
				projectPathEvidence: {
					requestedProjectPath: foreignPath,
					usedProjectPath: null,
					evidenceOnly: true,
					rejectedReason: 'foreign_operating_system_path'
				}
			}
		};
		candidate.executionAuthority = governorAuthority(candidate);

		const result = await autoDispatchPrdCanvasLoad(candidate);

		expect(result.started, JSON.stringify(result)).toBe(true);
		expect(result.projectPath).toBe(path.join(realpathSync(workspaceRoot), 'mission-path-evidence-only-spark-test'));
		expect(result.projectPath).not.toContain(foreignPath);
		expect(candidate.relay?.projectPathEvidence).toMatchObject({
			requestedProjectPath: foreignPath,
			evidenceOnly: true
		});
		const resolvedRelay = _resolvedProjectRelay(candidate, result.projectPath!);
		expect(resolvedRelay.projectLineage).toEqual({
			parentMissionId: 'mission-parent-safe',
			projectPath: result.projectPath
		});
		expect(resolvedRelay.goal).toBeUndefined();
		expect(JSON.stringify(resolvedRelay.projectLineage)).not.toContain(foreignPath);
		expect(resolvedRelay.projectPathEvidence).toMatchObject({
			requestedProjectPath: foreignPath,
			evidenceOnly: true
		});
	});

	it('allows auto-dispatch only when the PRD load is runnable', () => {
		expect(shouldAutoDispatchPrdLoad(load).ok).toBe(true);
		expect(shouldAutoDispatchPrdLoad({ ...load, autoRun: false, relay: {} }).reason).toBe('autoRun disabled');
		expect(shouldAutoDispatchPrdLoad({ ...load, nodes: [] }).reason).toBe('no canvas nodes');
	});

	it('does not let autoRun alone become execution authority', async () => {
		const result = await autoDispatchPrdCanvasLoad(load);

		expect(result.started).toBe(false);
		expect(result.error).toContain('missing_harness_authority');
	});

	it('rejects legacy machine-origin policy for PRD auto-dispatch', async () => {
		const result = await autoDispatchPrdCanvasLoad({
			...load,
			executionAuthority: {
				schema: 'spark.machine_origin_policy.v1',
				origin: 'prd-auto-dispatch-test',
				source: 'prd_auto_dispatch_test',
				reason: 'Legacy PRD auto-dispatch authority fixture.',
				allowedTools: ['spawner.dispatch'],
				mutationClassesAllowed: ['launches_mission'],
				networkPolicy: 'local_only'
			}
		});

		expect(result.started).toBe(false);
		expect(result.error).toContain('legacy_machine_origin_demoted');
	});

	it('rejects bare VNext authority for PRD auto-dispatch', async () => {
		const result = await autoDispatchPrdCanvasLoad({
			...load,
			executionAuthority: bareVNextAuthority()
		});

		expect(result.started).toBe(false);
		expect(result.error).toContain('native_governor_required');
	});

	it('accepts native Governor authority for PRD auto-dispatch', async () => {
		const workspaceRoot = path.join(testSpawnerDir!, 'workspaces');
		const projectPath = path.join(workspaceRoot, 'native-governor-project');
		await mkdir(workspaceRoot, { recursive: true });
		process.env.SPARK_WORKSPACE_ROOT = workspaceRoot;
		delete process.env.SPAWNER_WORKSPACE_ROOT;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
		vi.stubGlobal('fetch', vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => 'ok',
			json: async () => ({ ok: true })
		})));
		const candidate: PrdCanvasLoadForAutoDispatch = {
			...load,
			executionPrompt: 'Build a compact local API service.',
			relay: { projectLineage: { projectPath } }
		};
		candidate.executionAuthority = governorAuthority(candidate);
		const result = await autoDispatchPrdCanvasLoad(candidate);

		expect(result.started).toBe(true);
		expect(result.projectPath).toBe(path.join(realpathSync(workspaceRoot), 'native-governor-project'));
		expect(result.authority?.source).toBe('governor_decision');
	});

	it('uses Level 5 Codex sandbox for direct mission auto-dispatch', async () => {
		const workspaceRoot = path.join(testSpawnerDir!, 'workspaces');
		const projectPath = path.join(workspaceRoot, 'level5-codex-project');
		await mkdir(workspaceRoot, { recursive: true });
		process.env.SPARK_WORKSPACE_ROOT = workspaceRoot;
		process.env.SPARK_CODEX_SANDBOX = 'danger-full-access';
		process.env.SPARK_ALLOW_HIGH_AGENCY_WORKERS = '1';
		process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS = '1';
		let observedCommandTemplate = '';
		vi.spyOn(providerRuntime, 'dispatch').mockImplementation(async ({ executionPack }) => {
			observedCommandTemplate =
				executionPack.providers.find((provider) => provider.id === 'codex')?.commandTemplate || '';
			return {} as Awaited<ReturnType<typeof providerRuntime.dispatch>>;
		});
		const candidate: PrdCanvasLoadForAutoDispatch = {
			...load,
			requestId: 'tg-build-level5-codex-sandbox',
			missionId: 'mission-level5-codex-sandbox',
			pipelineId: 'prd-tg-build-level5-codex-sandbox',
			executionPrompt: 'Build a compact local API service.',
			relay: { projectLineage: { projectPath } }
		};
		candidate.executionAuthority = governorAuthority(candidate);

		const result = await autoDispatchPrdCanvasLoad(candidate);

		expect(result.started).toBe(true);
		expect(observedCommandTemplate).toBe(
			'codex exec --model gpt-5.5 --sandbox danger-full-access'
		);
	});

	it('rechecks the project directory and rejects a symlink swap before provider dispatch', async () => {
		const workspaceRoot = path.join(testSpawnerDir!, 'workspaces');
		const projectPath = path.join(workspaceRoot, 'pre-dispatch-project');
		const externalRoot = path.join(testSpawnerDir!, 'external-project');
		await mkdir(workspaceRoot, { recursive: true });
		await mkdir(externalRoot, { recursive: true });
		process.env.SPARK_WORKSPACE_ROOT = workspaceRoot;
		delete process.env.SPAWNER_WORKSPACE_ROOT;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
		const candidate: PrdCanvasLoadForAutoDispatch = {
			...load,
			requestId: 'tg-pre-dispatch-symlink-swap',
			missionId: 'mission-pre-dispatch-symlink-swap',
			executionPrompt: 'Build a compact local API service.',
			relay: { projectLineage: { projectPath } }
		};
		candidate.executionAuthority = governorAuthority(candidate);
		const dispatchSpy = vi.spyOn(providerRuntime, 'dispatch').mockImplementation(async () => {
			throw new Error('provider dispatch must not run after a project-path swap');
		});
		const missionStartedEvents: unknown[] = [];
		const unsubscribe = eventBridge.subscribe((event) => {
			if (event.type === 'mission_started' && event.missionId === candidate.missionId) {
				missionStartedEvents.push(event);
			}
		});

		try {
			const result = await autoDispatchPrdCanvasLoad(candidate, {
				beforeFinalProjectPathCheck: () => {
					rmSync(projectPath, { recursive: true, force: true });
					symlinkSync(externalRoot, projectPath, process.platform === 'win32' ? 'junction' : 'dir');
				}
			});

			expect(result.started).toBe(false);
			expect(result.error).toMatch(/must stay inside Spark workspace root|Spark-controlled root/i);
			expect(dispatchSpy).not.toHaveBeenCalled();
			expect(missionStartedEvents).toHaveLength(0);
		} finally {
			unsubscribe?.();
			dispatchSpy.mockRestore();
		}
	});

	it('passes configured provider API keys into auto-dispatch runtime', () => {
		expect(_providerApiKeysFromEnv(
			[
				{ id: 'zai', label: 'Z.AI GLM', enabled: true, kind: 'openai_compat', eventSource: 'zai', model: 'glm-5.1', apiKeyEnv: 'ZAI_API_KEY', requiresApiKey: true },
				{ id: 'codex', label: 'Codex', enabled: false, kind: 'terminal_cli', eventSource: 'codex', model: 'gpt-5.5', requiresApiKey: false }
			],
			{ ZAI_API_KEY: 'zai-secret' }
		)).toEqual({ zai: 'zai-secret' });
	});

	it('enriches PRD auto-dispatch tasks with tier-allowed H70 skills', async () => {
		const skillMap = await buildAutoDispatchTaskSkillMap({ ...load, tier: 'pro' }, [
			{
				id: 'task-1',
				title: 'Create shell',
				description: 'Create C:\\Users\\USER\\Desktop\\spark-test\\index.html'
			},
			{
				id: 'task-2',
				title: 'Verify shell',
				description: 'Run smoke checks.'
			}
		]);

		expect(skillMap.get('task-1')).toContain('frontend-engineer');
		expect(skillMap.get('task-1')).not.toContain('task-task-1');
		expect(skillMap.get('task-2')).toContain('test-architect');
	});

	it('infers pro skills for sparse Telegram PRD nodes', async () => {
		const skillMap = await buildAutoDispatchTaskSkillMap(
			{
				...load,
				tier: 'pro',
				nodes: [
					{
						skill: {
							id: 'task-task-1',
							name: 'task-1: Build Three.js sprite canvas',
							description: 'Implement a responsive WebGL game-dev editor with particles.',
							tags: []
						}
					}
				],
				connections: []
			},
			[
				{
					id: 'task-1',
					title: 'Build Three.js sprite canvas',
					description: 'Implement a responsive WebGL game-dev editor with particles.'
				}
			]
		);

		expect(skillMap.get('task-1')).toContain('threejs-3d-graphics');
	});

	it('keeps the sparse clarification fixture as a small DAG with allowlisted skills', async () => {
		const requestId = 'tg-build-8319079055-2607-1777608553410-clarified-1777608630635';
		const clarificationLoad: PrdCanvasLoadForAutoDispatch = {
			requestId,
			missionId: 'mission-clarification-fixture-test',
			pipelineId: `prd-${requestId}`,
			pipelineName: 'did you understand what i said',
			tier: 'pro',
			autoRun: true,
			buildMode: 'direct',
			executionPrompt:
				'Original user request: did you understand what i said\n\nAcknowledge understanding and ask for missing audience, core workflow, saved memory, and vibe details.',
			nodes: [
				{
					skill: {
						id: 'task-1-acknowledge-understanding',
						name: 'Acknowledge the understanding check',
						description: 'Confirm Spark understood the user is asking whether the previous message was understood.',
						tags: ['conversation-memory', 'ux-design']
					}
				},
				{
					skill: {
						id: 'task-2-ask-for-actionable-details',
						name: 'Ask for the missing build details',
						description: 'Prompt for audience, core workflow, saved memory, and vibe details.',
						tags: ['product-discovery', 'structured-output']
					}
				}
			],
			connections: []
		};
		const proIds = new Set((await getTierSkills('pro')).map((skill) => skill.id));
		const graph = canvasLoadToMissionGraph(clarificationLoad);
		const skillMap = await buildAutoDispatchTaskSkillMap(clarificationLoad, [
			{
				id: 'task-1',
				title: 'Acknowledge the understanding check',
				description: 'Confirm Spark understood the user is asking whether the previous message was understood.'
			},
			{
				id: 'task-2',
				title: 'Ask for the missing build details',
				description: 'Prompt for audience, core workflow, saved memory, and vibe details.'
			}
		]);

		expect(graph.nodes).toHaveLength(2);
		expect(graph.connections).toEqual([]);
		expect(shouldAutoDispatchPrdLoad(clarificationLoad).ok).toBe(true);
		for (const skills of skillMap.values()) {
			expect(skills.length).toBeGreaterThan(0);
			for (const skillId of skills) {
				expect(proIds.has(skillId)).toBe(true);
			}
		}
	});

	it('limits free-tier PRD auto-dispatch skills to the base allowlist', async () => {
		const baseIds = new Set((await getTierSkills('base')).map((skill) => skill.id));
		const skillMap = await buildAutoDispatchTaskSkillMap(
			{
				...load,
				tier: 'free',
				nodes: [
					{
						skill: {
							id: 'task-task-1',
							name: 'task-1: Build frontend dashboard',
							description: 'Implement responsive UI, analytics charts, and accessibility checks.',
							tags: ['frontend-engineer']
						}
					}
				],
				connections: []
			},
			[
				{
					id: 'task-1',
					title: 'Build frontend dashboard',
					description: 'Implement responsive UI, analytics charts, and accessibility checks.'
				}
			]
		);

		const skills = skillMap.get('task-1') || [];
		expect(skills.length).toBeGreaterThan(0);
		expect(skills.length).toBeLessThanOrEqual(3);
		for (const skillId of skills) {
			expect(baseIds.has(skillId)).toBe(true);
		}
	});

	it('creates scoped H70 access only for pro-exclusive auto-dispatch skills', async () => {
		const baseProof = await _createScopedH70AccessForLoad(
			{ ...load, tier: 'base' },
			new Map([['task-1', ['frontend-engineer', 'threejs-3d-graphics']]])
		);
		expect(baseProof).toBeNull();

		const proProof = await _createScopedH70AccessForLoad(
			{ ...load, tier: 'pro' },
			new Map([['task-1', ['frontend-engineer', 'threejs-3d-graphics']]])
		);
		expect(proProof?.tokenFile).toContain(`${load.missionId}.token`);
		const proToken = (await readFile(proProof!.tokenFile, 'utf-8')).trim();
		expect(proToken).toMatch(/^spark-h70-/);
		const request = new Request('http://127.0.0.1:3333/api/h70-skills/threejs-3d-graphics', {
			headers: { authorization: `Bearer ${proToken}` }
		});
		await expect(verifyH70SkillAccessToken(request, 'threejs-3d-graphics')).resolves.toBe(true);
		await expect(verifyH70SkillAccessToken(request, 'frontend-engineer')).resolves.toBe(false);
	});

	it('can allow creator execution for non-terminal missions that already exist on the board', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
		const missionId = `mission-existing-creator-${Date.now()}`;
		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Creator Mission: Existing board plan',
			source: 'creator-mission',
			data: { executionPolicy: 'read_only' }
		});

		expect(
			shouldAutoDispatchPrdLoad({ ...load, missionId }, { allowExistingNonTerminalMission: true }).ok
		).toBe(true);
	});
});
