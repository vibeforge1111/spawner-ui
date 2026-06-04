import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	_buildAuthorityVerdict,
	_buildFallbackAnalysisResult,
	_demoteProvisionalPrdDraftResult,
	_extractPrdBridgeProjectLineage,
	_provisionalPrdDraftDelayMs,
	_shouldUseDeterministicPrdFallback
} from './+server';

let testSpawnerDir = '';

describe('PRD bridge fallback analysis', () => {
	beforeEach(async () => {
		testSpawnerDir = await mkdtemp(path.join(tmpdir(), 'spawner-prd-write-'));
		await mkdir(path.join(testSpawnerDir, 'results'), { recursive: true });
	});

	afterEach(async () => {
		if (testSpawnerDir && existsSync(testSpawnerDir)) {
			await rm(testSpawnerDir, { recursive: true, force: true });
		}
	});

	it('builds mission execution authority verdict metadata without storing prompt content', () => {
		const verdict = _buildAuthorityVerdict({
			traceRef: 'trace:spawner-prd:mission-test',
			autoStarted: false,
			autoProvider: 'deterministic-static'
		});

		expect(verdict).toMatchObject({
			schema_version: 'spark.authority_verdict.v1',
			traceRef: 'trace:spawner-prd:mission-test',
			actionFamily: 'mission_execution',
			sourcePolicy: 'spawner_prd_bridge_control_auth_rate_limit_auto_provider',
			verdict: 'blocked',
			confirmationRequired: false,
			scope: 'local_spawner_prd_auto_analysis',
			sourceRepo: 'spawner-ui',
			reasonCode: 'auto_provider_deterministic-static_not_started'
		});
		expect(verdict).not.toHaveProperty('prompt');
		expect(verdict).not.toHaveProperty('content');
	});

	it('creates a canvas-ready fallback plan for direct static builds', async () => {
		const pendingPrdFile = path.join(testSpawnerDir, 'pending-prd.md');
		await writeFile(
			pendingPrdFile,
			[
				'Build this at C:\\Users\\USER\\Desktop\\spark-telegram-unit-smoke: a vanilla-JS static app.',
				'Files: index.html, styles.css, app.js, README.md. No build step.',
				'Add checklist state, localStorage persistence, launch/reset controls, and a README smoke test.'
			].join('\n'),
			'utf-8'
		);

		const result = await _buildFallbackAnalysisResult(
			'tg-build-fallback-test',
			'Spark Telegram Unit Smoke',
			'direct',
			'pro',
			{
				spawnerDir: testSpawnerDir,
				resultsDir: path.join(testSpawnerDir, 'results'),
				provisionalResultsDir: path.join(testSpawnerDir, 'provisional-results'),
				pendingPrdFile,
				pendingRequestFile: path.join(testSpawnerDir, 'pending-request.json'),
				prdAutoTraceFile: path.join(testSpawnerDir, 'prd-auto-trace.jsonl')
			}
		);

		expect(result.success).toBe(true);
		expect(result.requestId).toBe('tg-build-fallback-test');
		expect(result.projectName).toBe('Spark Telegram Unit Smoke');
		expect(result.projectType).toBe('static-web-app');
		expect(result.techStack).toMatchObject({ framework: 'Vanilla JavaScript' });

		const tasks = result.tasks as Array<{
			id: string;
			title: string;
			summary: string;
			dependencies: string[];
			workspaceTargets: string[];
			verificationCommands: string[];
		}>;
		expect(tasks).toHaveLength(4);
		expect(new Set(tasks.map((task) => task.id)).size).toBe(4);
		expect(tasks[0].summary).toContain('index.html');
		expect(tasks[1].dependencies).toContain(tasks[0].id);
		expect(tasks[3].dependencies).toEqual(expect.arrayContaining([tasks[1].id, tasks[2].id]));
		expect(tasks.every((task) => task.workspaceTargets.includes('C:\\Users\\USER\\Desktop\\spark-telegram-unit-smoke'))).toBe(true);
		expect(tasks.flatMap((task) => task.verificationCommands).join('\n')).toContain('node --check');
	});

	it('does not use deterministic fallback for fast direct app builds', () => {
		expect(
			_shouldUseDeterministicPrdFallback({
				buildLane: 'fast_direct',
				constrainedStaticSingleFile: false
			})
		).toBe(false);
		expect(
			_shouldUseDeterministicPrdFallback({
				buildLane: 'direct',
				constrainedStaticSingleFile: false
			})
		).toBe(false);
		expect(
			_shouldUseDeterministicPrdFallback({
				buildLane: 'fast_direct',
				constrainedStaticSingleFile: true
			})
		).toBe(true);
	});

	it('demotes provisional canvas drafts so they do not look like provider success', () => {
		const result = _demoteProvisionalPrdDraftResult(
			{
				requestId: 'tg-build-provisional',
				success: true,
				projectName: 'Provisional Build',
				projectType: 'web-app',
				complexity: 'simple',
				infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
				techStack: { framework: 'Web app', language: 'TypeScript or JavaScript' },
				tasks: [
					{
						id: 'create-app-shell',
						title: 'Create app shell',
						skills: [],
						dependencies: [],
						workspaceTargets: [],
						acceptanceCriteria: [],
						verificationCommands: []
					}
				],
				skills: [],
				instructionTextRedacted: true,
				metadata: {
					taskQuality: {
						passed: false,
						score: 44
					}
				}
			},
			'provisional canvas draft after 10000ms while full PRD analysis continues'
		);

		expect(result.success).toBe(false);
		expect(result.metadata).toMatchObject({
			provisional: true,
			canonical: false,
			resultAuthority: 'provisional_canvas_draft',
			replacedByProviderResult: false,
			taskQuality: {
				passed: false,
				score: 44
			}
		});
	});

	it('keeps tiny one-file fast-lane pages to a small task pack', async () => {
		const pendingPrdFile = path.join(testSpawnerDir, 'pending-prd.md');
		await writeFile(
			pendingPrdFile,
			[
				'Build lane: fast_direct',
				'Build a tiny one-file static page called Milestone Copy Smoke.',
				'It should show MILESTONE_COPY_OK and have one button that changes the label.',
				'Keep it fast and simple.'
			].join('\n'),
			'utf-8'
		);

		const result = await _buildFallbackAnalysisResult(
			'tg-build-milestone-copy-smoke',
			'Milestone Copy Smoke',
			'direct',
			'pro',
			{
				spawnerDir: testSpawnerDir,
				resultsDir: path.join(testSpawnerDir, 'results'),
				provisionalResultsDir: path.join(testSpawnerDir, 'provisional-results'),
				pendingPrdFile,
				pendingRequestFile: path.join(testSpawnerDir, 'pending-request.json'),
				prdAutoTraceFile: path.join(testSpawnerDir, 'prd-auto-trace.jsonl')
			},
			'fast_direct'
		);

		expect(result.projectType).toBe('single-file-static-web-app');
		expect(result.techStack).toMatchObject({ framework: 'Single-file static HTML' });
		expect(result.executionPrompt).toContain('Hard file constraint: create only index.html');

		const tasks = result.tasks as Array<{
			title: string;
			skills: string[];
			acceptanceCriteria: string[];
			verificationCommands: string[];
		}>;
		const titles = tasks.map((task) => task.title).join('\n');
		const skills = [...new Set(tasks.flatMap((task) => task.skills))];
		const criteria = tasks.flatMap((task) => task.acceptanceCriteria).join('\n');

		expect(tasks).toHaveLength(1);
		expect(titles).toContain('Build and check the single-file static page');
		expect(titles).not.toContain('Check the quick smoke path');
		expect(titles).not.toMatch(/core interaction|visual system|documentation/i);
		expect(skills.length).toBeLessThanOrEqual(4);
		expect(criteria).toContain('The first screen visibly includes the exact marker "MILESTONE_COPY_OK".');
		expect(criteria).toContain('Only index.html is required');
		expect(criteria).toContain('No package.json, styles.css, app.js, or build step is required.');
		expect(tasks.flatMap((task) => task.verificationCommands).join('\n')).toContain(
			'grep -F "MILESTONE_COPY_OK" index.html'
		);
	});

	it('preserves one-file static HTML app and game constraints in fallback plans', async () => {
		const pendingPrdFile = path.join(testSpawnerDir, 'pending-prd.md');
		await writeFile(
			pendingPrdFile,
			[
				'Build a small browser game called Recursive Sage: Signal Maze.',
				'Make it playable in one static HTML file.',
				'The player moves through a shifting grid, collects signal orbs, avoids corrupted tiles, and wins by reaching the bright exit.',
				'Include keyboard controls, mobile buttons, score, timer, restart, and a polished visual style.'
			].join('\n'),
			'utf-8'
		);

		const result = await _buildFallbackAnalysisResult(
			'tg-build-signal-maze',
			'Recursive Sage: Signal Maze',
			'direct',
			'pro',
			{
				spawnerDir: testSpawnerDir,
				resultsDir: path.join(testSpawnerDir, 'results'),
				provisionalResultsDir: path.join(testSpawnerDir, 'provisional-results'),
				pendingPrdFile,
				pendingRequestFile: path.join(testSpawnerDir, 'pending-request.json'),
				prdAutoTraceFile: path.join(testSpawnerDir, 'prd-auto-trace.jsonl')
			}
		);

		expect(result.projectName).toBe('Recursive Sage: Signal Maze');
		expect(result.projectType).toBe('single-file-static-web-app');
		expect(result.techStack).toMatchObject({
			framework: 'Single-file static HTML',
			styling: 'Embedded CSS in index.html'
		});
		expect(result.executionPrompt).toContain('Original brief:');
		expect(result.executionPrompt).toContain('shifting grid');
		expect(result.executionPrompt).toContain('Hard file constraint: create only index.html');

		const tasks = result.tasks as Array<{
			title: string;
			summary: string;
			acceptanceCriteria: string[];
			verificationCommands: string[];
		}>;
		expect(tasks[0].title).toBe('Create the playable game file');
		expect(tasks[0].summary).toContain('Create only index.html');
		expect(tasks.flatMap((task) => task.acceptanceCriteria).join('\n')).toContain(
			'CSS and JavaScript are embedded in index.html'
		);
		expect(tasks.flatMap((task) => task.verificationCommands).join('\n')).toContain('test ! -f app.js');
	});

	it('uses game-specific fallback tasks instead of the generic app skeleton', async () => {
		const pendingPrdFile = path.join(testSpawnerDir, 'pending-prd.md');
		await writeFile(
			pendingPrdFile,
			[
				'Build a browser game Recursive Sage would want to play.',
				'Make it test reasoning skills with a shifting logic grid, hidden rules, keyboard controls, score, timer, restart, and mobile buttons.',
				'Use one static HTML file so it can run quickly from a browser.'
			].join('\n'),
			'utf-8'
		);

		const result = await _buildFallbackAnalysisResult(
			'tg-build-reasoning-game',
			'Recursive Reasoning Grid',
			'direct',
			'pro',
			{
				spawnerDir: testSpawnerDir,
				resultsDir: path.join(testSpawnerDir, 'results'),
				provisionalResultsDir: path.join(testSpawnerDir, 'provisional-results'),
				pendingPrdFile,
				pendingRequestFile: path.join(testSpawnerDir, 'pending-request.json'),
				prdAutoTraceFile: path.join(testSpawnerDir, 'prd-auto-trace.jsonl')
			}
		);

		const tasks = result.tasks as Array<{ title: string; skills: string[]; acceptanceCriteria: string[] }>;
		const titles = tasks.map((task) => task.title).join('\n');
		const criteria = tasks.flatMap((task) => task.acceptanceCriteria).join('\n');
		const skills = tasks.flatMap((task) => task.skills);

		expect(tasks).toHaveLength(4);
		expect(titles).toContain('Design the core play and reasoning loop');
		expect(titles).toContain('Verify the playable loop');
		expect(titles).not.toContain('Implement the core interaction and state');
		expect(titles).not.toContain('Polish the visual system and documentation');
		expect(criteria).toContain('clear decision loop');
		expect(skills).toEqual(expect.arrayContaining(['game-design', 'puzzle-design']));
	});

	it('pairs pro 3D game briefs with the Three.js specialist while keeping base briefs on starter skills', async () => {
		const pendingPrdFile = path.join(testSpawnerDir, 'pending-prd.md');
		await writeFile(
			pendingPrdFile,
			[
				'Build a tiny interactive 3D game smoke page with WebGL style particles.',
				'Keep it fast, playable, and simple.'
			].join('\n'),
			'utf-8'
		);

		const paths = {
			spawnerDir: testSpawnerDir,
			resultsDir: path.join(testSpawnerDir, 'results'),
			provisionalResultsDir: path.join(testSpawnerDir, 'provisional-results'),
			pendingPrdFile,
			pendingRequestFile: path.join(testSpawnerDir, 'pending-request.json'),
			prdAutoTraceFile: path.join(testSpawnerDir, 'prd-auto-trace.jsonl')
		};
		const proResult = await _buildFallbackAnalysisResult(
			'tg-build-pro-3d-game',
			'Pro 3D Game',
			'direct',
			'pro',
			paths,
			'fast_direct'
		);
		const baseResult = await _buildFallbackAnalysisResult(
			'tg-build-base-3d-game',
			'Base 3D Game',
			'direct',
			'base',
			paths,
			'fast_direct'
		);

		expect((proResult.techStack as { framework?: string }).framework).toContain('Three.js');
		expect((proResult.skills as string[])).toContain('threejs-3d-graphics');
		expect((baseResult.skills as string[])).not.toContain('threejs-3d-graphics');
		expect((baseResult.skills as string[])).toContain('frontend-engineer');
	});

	it('uses token/NFT launch dashboard tasks with decision and risk proof', async () => {
		const pendingPrdFile = path.join(testSpawnerDir, 'pending-prd.md');
		await writeFile(
			pendingPrdFile,
			[
				'Build a token launch dashboard for NFT sale strategy.',
				'It should compare token-only mint ideas, treasury split notes, utility perks, holders, liquidity, and post-launch timing.',
				'Use mock data and make risky price-impact claims clearly marked as not guaranteed.'
			].join('\n'),
			'utf-8'
		);

		const result = await _buildFallbackAnalysisResult(
			'tg-build-token-dashboard',
			'Token Launch Dashboard',
			'direct',
			'pro',
			{
				spawnerDir: testSpawnerDir,
				resultsDir: path.join(testSpawnerDir, 'results'),
				provisionalResultsDir: path.join(testSpawnerDir, 'provisional-results'),
				pendingPrdFile,
				pendingRequestFile: path.join(testSpawnerDir, 'pending-request.json'),
				prdAutoTraceFile: path.join(testSpawnerDir, 'prd-auto-trace.jsonl')
			}
		);

		const tasks = result.tasks as Array<{ title: string; skills: string[]; acceptanceCriteria: string[] }>;
		const titles = tasks.map((task) => task.title).join('\n');
		const criteria = tasks.flatMap((task) => task.acceptanceCriteria).join('\n');
		const skills = tasks.flatMap((task) => task.skills);

		expect(tasks).toHaveLength(4);
		expect(titles).toContain('Model the token and NFT launch signals');
		expect(titles).toContain('Add scenario controls and warning states');
		expect(titles).not.toContain('Create the app shell and project structure');
		expect(criteria).toContain('sample data as live financial proof');
		expect(skills).toEqual(expect.arrayContaining(['tokenomics-design', 'nft-systems', 'data-dashboard-design']));
	});

	it('keeps a sparse understanding clarification small and exact', async () => {
		const pendingPrdFile = path.join(testSpawnerDir, 'pending-prd.md');
		await writeFile(pendingPrdFile, 'did you understand what i said', 'utf-8');

		const result = await _buildFallbackAnalysisResult(
			'tg-build-8319079055-2607-1777608553410-clarified-1777608630635',
			'did you understand what i said',
			'direct',
			'pro',
			{
				spawnerDir: testSpawnerDir,
				resultsDir: path.join(testSpawnerDir, 'results'),
				provisionalResultsDir: path.join(testSpawnerDir, 'provisional-results'),
				pendingPrdFile,
				pendingRequestFile: path.join(testSpawnerDir, 'pending-request.json'),
				prdAutoTraceFile: path.join(testSpawnerDir, 'prd-auto-trace.jsonl')
			}
		);

		expect(result.success).toBe(true);
		expect(result.requestId).toBe('tg-build-8319079055-2607-1777608553410-clarified-1777608630635');
		expect(result.projectName).toBe('did you understand what i said');
		expect(result.projectType).toBe('clarification-understanding');
		expect(result.executionPrompt).toContain('Original user request: did you understand what i said');
		expect(result.infrastructure).toMatchObject({ needsAuth: false, needsDatabase: false, needsAPI: false });

		const tasks = result.tasks as Array<{ title: string; dependencies: string[]; skills: string[] }>;
		expect(tasks).toHaveLength(2);
		expect(tasks.every((task) => task.dependencies.length === 0)).toBe(true);
		expect(tasks.map((task) => task.title).join('\n')).toContain('Acknowledge the understanding check');
		expect(tasks.map((task) => task.title).join('\n')).not.toMatch(/auth|payment|database|mvp/i);
		expect((result.skills as string[]).length).toBeGreaterThan(0);
	});

	it('extracts complete improvement lineage before mission-created relay', () => {
		const lineage = _extractPrdBridgeProjectLineage(
			[
				'# Loop Lantern polish 2',
				'',
				'Target operating-system folder: `C:/Users/USER/Desktop/loop-lantern`',
				'',
				'Improve the existing shipped project "Loop Lantern" at C:/Users/USER/Desktop/loop-lantern.',
				'',
				'User feedback:',
				'make the Loop Lantern preview feel more Spark colored',
				'',
				'Rules:',
				'- Preserve the current app.',
				'',
				'Project context:',
				'- Parent mission: mission-1777644961054',
				'- Current preview: http://127.0.0.1:5555/preview/example/index.html'
			].join('\n'),
			'Loop Lantern polish 2'
		);

		expect(lineage).toMatchObject({
			projectPath: 'C:/Users/USER/Desktop/loop-lantern',
			parentMissionId: 'mission-1777644961054',
			iterationNumber: 2,
			previewUrl: 'http://127.0.0.1:5555/preview/example/index.html',
			improvementFeedback: 'make the Loop Lantern preview feel more Spark colored'
		});
		expect(lineage?.projectId).toMatch(/^project-loop-lantern-[a-f0-9]{10}$/);

		const inlineRulesLineage = _extractPrdBridgeProjectLineage(
			'Improve the existing shipped project "Loop Lantern" at C:/Users/USER/Desktop/loop-lantern.\nUser feedback:\nmake the Loop Lantern preview feel more Spark colored, but do not rebuild from scratch Rules:\n- Read the existing project files before editing.\nProject context:\n- Parent mission: mission-1777644961054',
			'Loop Lantern polish 2'
		);
		expect(inlineRulesLineage?.improvementFeedback).toBe(
			'make the Loop Lantern preview feel more Spark colored, but do not rebuild from scratch'
		);
	});

	it('keeps one-file static HTML smoke prompts constrained', async () => {
		const pendingPrdFile = path.join(testSpawnerDir, 'pending-prd.md');
		await writeFile(
			pendingPrdFile,
			[
				'Build mode: direct',
				'Build a tiny static HTML page called Spark Production Smoke. It should have one file, index.html, with a dark Mission Control panel, a green "Spark Live OK" status, and the text "Telegram to Spawner relay worked on May 8, 2026".',
				'Do not add package files, do not install dependencies, and keep it simple enough to finish fast.'
			].join('\n'),
			'utf-8'
		);

		const result = await _buildFallbackAnalysisResult(
			'tg-static-one-file-test',
			'Spark Relay Static Smoke',
			'direct',
			'pro',
			{
				spawnerDir: testSpawnerDir,
				resultsDir: path.join(testSpawnerDir, 'results'),
				provisionalResultsDir: path.join(testSpawnerDir, 'provisional-results'),
				pendingPrdFile,
				pendingRequestFile: path.join(testSpawnerDir, 'pending-request.json'),
				prdAutoTraceFile: path.join(testSpawnerDir, 'prd-auto-trace.jsonl')
			}
		);

		expect(result.projectType).toBe('static-single-file-html');
		expect(result.complexity).toBe('simple');
		expect(String(result.executionPrompt)).toContain('Create exactly these files in the workspace root: index.html');
		expect(String(result.executionPrompt)).toContain('Do not create any other files');

		const tasks = result.tasks as Array<{ title: string; acceptanceCriteria: string[] }>;
		expect(tasks).toHaveLength(2);
		expect(tasks.map((task) => task.title).join('\n')).not.toMatch(/app shell|core interaction|localStorage|checklist/i);
		expect(tasks.flatMap((task) => task.acceptanceCriteria).join('\n')).toMatch(/No package\.json|Only index\.html/i);
	});

	it('keeps direct provisional PRD drafts opt-in while preserving advanced draft timing', () => {
		expect(_provisionalPrdDraftDelayMs({ buildMode: 'direct', buildLane: 'direct' }, {} as NodeJS.ProcessEnv)).toBeNull();
		expect(_provisionalPrdDraftDelayMs({ buildMode: 'advanced_prd', buildLane: 'advanced_prd' }, {} as NodeJS.ProcessEnv)).toBe(45_000);
		expect(_provisionalPrdDraftDelayMs({ buildMode: 'direct', buildLane: 'fast_direct' }, {} as NodeJS.ProcessEnv)).toBeNull();
		expect(
			_provisionalPrdDraftDelayMs(
				{ buildMode: 'direct', buildLane: 'direct' },
				{
					SPAWNER_PRD_DIRECT_PROVISIONAL_DRAFTS: '1',
					SPAWNER_PRD_PROVISIONAL_DIRECT_MS: '2500'
				} as NodeJS.ProcessEnv
			)
		).toBe(2500);
		expect(
			_provisionalPrdDraftDelayMs(
				{ buildMode: 'direct', buildLane: 'direct' },
				{ SPAWNER_PRD_PROVISIONAL_DRAFTS: '0' } as NodeJS.ProcessEnv
			)
		).toBeNull();
	});

	it('rejects suffixed SPAWNER_PRD_PROVISIONAL_*_MS forms and falls back to the documented default (suffix-trap)', () => {
		// The prior Number.parseInt + Number.isFinite + >= 0 gate silently
		// accepted '5s' as 5 and '30m' as 30 because parseInt strips the
		// suffix. The regex-gated helper now falls back to the documented
		// 10_000 / 45_000 defaults on any non-clean-integer form.
		const direct = { buildMode: 'direct' as const, buildLane: 'direct' as const };
		expect(_provisionalPrdDraftDelayMs(direct, { SPAWNER_PRD_PROVISIONAL_DIRECT_MS: '5s' } as NodeJS.ProcessEnv)).toBe(10_000);
		expect(_provisionalPrdDraftDelayMs(direct, { SPAWNER_PRD_PROVISIONAL_DIRECT_MS: '30m' } as NodeJS.ProcessEnv)).toBe(10_000);
		expect(_provisionalPrdDraftDelayMs(direct, { SPAWNER_PRD_PROVISIONAL_DIRECT_MS: '1.5' } as NodeJS.ProcessEnv)).toBe(10_000);
		expect(_provisionalPrdDraftDelayMs(direct, { SPAWNER_PRD_PROVISIONAL_DIRECT_MS: '1e3' } as NodeJS.ProcessEnv)).toBe(10_000);
		expect(_provisionalPrdDraftDelayMs(direct, { SPAWNER_PRD_PROVISIONAL_DIRECT_MS: '-100' } as NodeJS.ProcessEnv)).toBe(10_000);
		expect(_provisionalPrdDraftDelayMs(direct, { SPAWNER_PRD_PROVISIONAL_DIRECT_MS: '  2500  ' } as NodeJS.ProcessEnv)).toBe(2500);
		expect(_provisionalPrdDraftDelayMs(direct, { SPAWNER_PRD_PROVISIONAL_DIRECT_MS: '0' } as NodeJS.ProcessEnv)).toBe(0);
	});
});
