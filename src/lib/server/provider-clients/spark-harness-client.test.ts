import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSparkHarnessRequest } from './spark-harness-client';
import type { BridgeEvent } from '$lib/services/event-bridge';
import type { MultiLLMProviderConfig } from '$lib/services/multi-llm-orchestrator';

const provider: MultiLLMProviderConfig = {
	id: 'zai',
	label: 'Z.AI',
	model: 'glm-5.1',
	enabled: true,
	kind: 'openai_compat',
	eventSource: 'zai',
	capabilities: ['reasoning', 'planning', 'code_analysis'],
	executesFilesystem: true,
	sparkExecutionBridge: 'codex',
	requiresApiKey: true,
	apiKeyEnv: 'ZAI_API_KEY'
};

const originalCodexSandbox = process.env.SPARK_CODEX_SANDBOX;
const originalAllowHighAgencyWorkers = process.env.SPARK_ALLOW_HIGH_AGENCY_WORKERS;
const originalSparkWorkspaceRoot = process.env.SPARK_WORKSPACE_ROOT;
const originalAllowExternalProjectPaths = process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
const originalSparkHarnessTimeoutMs = process.env.SPAWNER_SPARK_HARNESS_TIMEOUT_MS;
const cleanupPaths: string[] = [];

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

beforeEach(() => {
	delete process.env.SPARK_CODEX_SANDBOX;
	delete process.env.SPARK_ALLOW_HIGH_AGENCY_WORKERS;
	delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
});

afterEach(() => {
	vi.restoreAllMocks();
	restoreEnv('SPARK_CODEX_SANDBOX', originalCodexSandbox);
	restoreEnv('SPARK_ALLOW_HIGH_AGENCY_WORKERS', originalAllowHighAgencyWorkers);
	restoreEnv('SPARK_WORKSPACE_ROOT', originalSparkWorkspaceRoot);
	restoreEnv('SPARK_ALLOW_EXTERNAL_PROJECT_PATHS', originalAllowExternalProjectPaths);
	restoreEnv('SPAWNER_SPARK_HARNESS_TIMEOUT_MS', originalSparkHarnessTimeoutMs);
	vi.useRealTimers();
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe('spark-harness-client', () => {
	it('emits a structured task failure when a Spark task exceeds the local poll budget', async () => {
		process.env.SPAWNER_SPARK_HARNESS_TIMEOUT_MS = '1';
		vi.resetModules();
		vi.useFakeTimers();
		const { executeSparkHarnessRequest: executeWithShortTimeout } = await import('./spark-harness-client');
		const events: BridgeEvent[] = [];
		const fetchMock = vi.fn(async (url: string | URL) => {
			const value = String(url);
			if (value.endsWith('/v1/tasks')) {
				return new Response(JSON.stringify({ task_id: 'spark-task-timeout' }), { status: 200 });
			}
			if (value.endsWith('/v1/tasks/spark-task-timeout')) {
				return new Response(JSON.stringify({ status: 'running' }), { status: 200 });
			}
			return new Response('not found', { status: 404 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const pending = executeWithShortTimeout({
			provider,
			missionId: 'mission-spark-timeout',
			prompt: 'Wait for a deliberately slow Spark task.',
			onEvent: (event) => events.push(event)
		});
		await vi.advanceTimersByTimeAsync(1500);
		const result = await pending;

		expect(result.success).toBe(false);
		expect(result.error).toContain('timed out');
		expect(events.at(-1)).toMatchObject({
			type: 'task_failed',
			data: {
				success: false,
				provider: 'zai',
				sparkTaskId: 'spark-task-timeout',
				sparkStatus: 'timed_out'
			}
		});
	});

	it('emits canvas task ids when Spark completes a provider-level task', async () => {
		const events: BridgeEvent[] = [];
		const fetchMock = vi.fn(async (url: string | URL) => {
			const value = String(url);
			if (value.endsWith('/v1/tasks')) {
				return new Response(JSON.stringify({ task_id: 'spark-task-1' }), { status: 200 });
			}
			if (value.endsWith('/v1/tasks/spark-task-1')) {
				return new Response(
					JSON.stringify({
						status: 'completed',
						result: {
							output: JSON.stringify({
								status: 'completed',
								changed_files: ['index.html']
							}),
							metadata: {
								changed_files: ['index.html']
							}
						}
					}),
					{ status: 200 }
				);
			}
			return new Response('not found', { status: 404 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await executeSparkHarnessRequest(
			{
				provider,
				missionId: 'mission-spark-visual',
				prompt: [
					'Mission ID: mission-spark-visual',
					'Assigned tasks:',
					'1. task-1: Create scaffold (id: node-1)',
					'2. task-2: Build UI (id: node-2 after: node-1)',
					'H70 skill loading'
				].join('\n'),
				onEvent: (event) => events.push(event)
			}
		);

		expect(result.success).toBe(true);
		expect(events.some((event) => event.type === 'task_started' && event.taskId === 'node-1')).toBe(true);
		expect(events.some((event) => event.type === 'task_completed' && event.taskId === 'node-1')).toBe(true);
		expect(events.some((event) => event.type === 'task_started' && event.taskId === 'node-2')).toBe(true);
		expect(events.some((event) => event.type === 'task_completed' && event.taskId === 'node-2')).toBe(true);
	});

	it('sends no-build verification instructions to the Spark harness for vanilla projects', async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), 'spark-harness-workspace-'));
		const workspace = join(workspaceRoot, 'spark-contract-test');
		cleanupPaths.push(workspaceRoot);
		process.env.SPARK_WORKSPACE_ROOT = workspaceRoot;
		let submittedInstruction = '';
		let submittedSandbox = '';
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const value = String(url);
			if (value.endsWith('/v1/tasks')) {
				const submittedBody = JSON.parse(String(init?.body || '{}')) as {
					instruction?: string;
					context?: { _codex_sandbox?: string };
				};
				submittedInstruction = submittedBody.instruction || '';
				submittedSandbox = submittedBody.context?._codex_sandbox || '';
				return new Response(JSON.stringify({ task_id: 'spark-task-vanilla' }), { status: 200 });
			}
			if (value.endsWith('/v1/tasks/spark-task-vanilla')) {
				return new Response(
					JSON.stringify({
						status: 'completed',
						result: {
							output: JSON.stringify({
								status: 'completed',
								changed_files: ['index.html', 'styles.css', 'app.js', 'README.md']
							}),
							metadata: {
								changed_files: ['index.html', 'styles.css', 'app.js', 'README.md']
							}
						}
					}),
					{ status: 200 }
				);
			}
			return new Response('not found', { status: 404 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await executeSparkHarnessRequest({
			provider,
			missionId: 'mission-spark-vanilla',
			workingDirectory: workspace,
			prompt: [
				'Mission ID: mission-spark-vanilla',
				'Project contract:',
				'- Source request:',
				'  Build a vanilla-JS app. Files: index.html, styles.css, app.js, README.md. No build step. No dependencies.',
				'Assigned tasks:',
				'1. task-1: Create static app (id: node-1)',
				'H70 skill loading',
				'Verify Before Reporting Complete (REQUIRED per task):',
				'1. Run the project build command (npm run build or equivalent)',
				'Mission Completion Gate'
			].join('\n'),
			onEvent: () => {}
		});

		expect(result.success).toBe(true);
		const instruction = submittedInstruction;
		expect(instruction).toContain('No-build static project verification');
		expect(instruction).toContain('Do not run npm install, npm run build, npx tsc');
		expect(instruction).not.toContain('Run the project build command (npm run build or equivalent)');
		expect(submittedSandbox).toBe('workspace-write');
	});

	it('keeps fast-lane single-file verification bounded in the Spark harness instruction', async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), 'spark-harness-fast-root-'));
		const workspace = join(workspaceRoot, 'fast-static-smoke');
		cleanupPaths.push(workspaceRoot);
		process.env.SPARK_WORKSPACE_ROOT = workspaceRoot;
		let submittedInstruction = '';
		let submittedIsolatedBuilderHome: boolean | undefined;
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const value = String(url);
			if (value.endsWith('/v1/tasks')) {
				const submittedBody = JSON.parse(String(init?.body || '{}')) as {
					instruction?: string;
					context?: { _codex_isolate_builder_home?: boolean };
				};
				submittedInstruction = submittedBody.instruction || '';
				submittedIsolatedBuilderHome = submittedBody.context?._codex_isolate_builder_home;
				return new Response(JSON.stringify({ task_id: 'spark-task-fast-static' }), { status: 200 });
			}
			if (value.endsWith('/v1/tasks/spark-task-fast-static')) {
				return new Response(
					JSON.stringify({
						status: 'completed',
						result: {
							output: JSON.stringify({
								status: 'completed',
								changed_files: ['index.html'],
								verification: {
									file_exists: true,
									marker_present: true,
									browser_smoke: 'not_applicable'
								}
							}),
							metadata: { changed_files: ['index.html'] }
						}
					}),
					{ status: 200 }
				);
			}
			return new Response('not found', { status: 404 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await executeSparkHarnessRequest({
			provider,
			missionId: 'mission-fast-static',
			workingDirectory: workspace,
			prompt: [
				'Mission ID: mission-fast-static',
				'Project contract:',
				'- Project type: single-file-static-web-app',
				'- Source request:',
				'  Build lane: fast_direct',
				'  Build a tiny one-file static page. No build step. Keep it fast and simple.',
				'Assigned tasks:',
				'1. Build the single-file static page (id: node-1)',
				'2. Check the quick smoke path (id: node-2 after: node-1)',
				'H70 skill loading',
				'Verify Before Reporting Complete (REQUIRED per task):',
				'1. Run the project build command (npm run build or equivalent)',
				'Mission Completion Gate'
			].join('\n'),
			onEvent: () => {}
		});

		expect(result.success).toBe(true);
		expect(submittedInstruction).toContain('Fast-lane budget: do not spend more than 15 seconds discovering browser tooling.');
		expect(submittedInstruction).toContain('Prefer exact file/content checks');
		expect(submittedInstruction).toContain('Browser smoke is optional when no standard harness is immediately available');
		expect(submittedInstruction).toContain('Treat build and typecheck as not applicable');
		expect(submittedInstruction).toContain('Fast direct lane: do not load Codex skills');
		expect(submittedInstruction).not.toContain('Run the project build command (npm run build or equivalent)');
		expect(submittedIsolatedBuilderHome).toBe(true);
	});

	it('passes danger-full-access to the Spark harness only when Level 5 guardrails are active', async () => {
		process.env.SPARK_ALLOW_HIGH_AGENCY_WORKERS = '1';
		process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS = '1';
		process.env.SPARK_CODEX_SANDBOX = 'danger-full-access';
		let submittedSandbox = '';
		const events: BridgeEvent[] = [];
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const value = String(url);
			if (value.endsWith('/v1/tasks')) {
				const submittedBody = JSON.parse(String(init?.body || '{}')) as {
					context?: { _codex_sandbox?: string };
				};
				submittedSandbox = submittedBody.context?._codex_sandbox || '';
				return new Response(JSON.stringify({ task_id: 'spark-task-level5' }), { status: 200 });
			}
			if (value.endsWith('/v1/tasks/spark-task-level5')) {
				return new Response(
					JSON.stringify({
						status: 'completed',
						result: {
							output: JSON.stringify({ status: 'completed', changed_files: ['operator-check.txt'] }),
							metadata: { changed_files: ['operator-check.txt'] }
						}
					}),
					{ status: 200 }
				);
			}
			return new Response('not found', { status: 404 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await executeSparkHarnessRequest({
			provider,
			missionId: 'mission-spark-level5',
			prompt: 'Build a tiny local operator check.',
			onEvent: (event) => events.push(event)
		});

		expect(result.success).toBe(true);
		expect(submittedSandbox).toBe('danger-full-access');
		expect(events.some((event) => event.type === 'worker_high_agency_approved')).toBe(true);
	});

	it('rejects prompt-extracted workspaces outside the Spark workspace root by default', async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), 'spark-harness-root-'));
		const external = mkdtempSync(join(tmpdir(), 'spark-harness-external-'));
		cleanupPaths.push(workspaceRoot, external);
		process.env.SPARK_WORKSPACE_ROOT = workspaceRoot;
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const result = await executeSparkHarnessRequest({
			provider,
			missionId: 'mission-external-workspace',
			prompt: `Target workspace: ${join(external, 'project')}\nBuild a tiny app.`,
			onEvent: () => {}
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain('Project path must stay inside Spark workspace root');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
