import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	assertHighAgencyWorkerAllowed,
	highAgencyWorkersAllowed,
	level5RuntimeGuardrailsActive,
	resolveCodexSandbox
} from './high-agency-workers';

const originalSparkWorkspaceRoot = process.env.SPARK_WORKSPACE_ROOT;
const originalSpawnerWorkspaceRoot = process.env.SPAWNER_WORKSPACE_ROOT;
const originalSparkHome = process.env.SPARK_HOME;
const originalAllowExternalProjectPaths = process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
const originalAllowHighAgencyWorkers = process.env.SPARK_ALLOW_HIGH_AGENCY_WORKERS;
const originalCodexSandbox = process.env.SPARK_CODEX_SANDBOX;
const cleanupPaths: string[] = [];

function tempDir(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	cleanupPaths.push(path);
	return path;
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

beforeEach(() => {
	process.env.SPARK_HOME = tempDir('spark-high-agency-test-home-');
	delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
	delete process.env.SPARK_ALLOW_HIGH_AGENCY_WORKERS;
	delete process.env.SPARK_CODEX_SANDBOX;
});

afterEach(() => {
	restoreEnv('SPARK_WORKSPACE_ROOT', originalSparkWorkspaceRoot);
	restoreEnv('SPAWNER_WORKSPACE_ROOT', originalSpawnerWorkspaceRoot);
	restoreEnv('SPARK_HOME', originalSparkHome);
	restoreEnv('SPARK_ALLOW_EXTERNAL_PROJECT_PATHS', originalAllowExternalProjectPaths);
	restoreEnv('SPARK_ALLOW_HIGH_AGENCY_WORKERS', originalAllowHighAgencyWorkers);
	restoreEnv('SPARK_CODEX_SANDBOX', originalCodexSandbox);
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe('high-agency worker policy', () => {
	it('requires explicit opt-in', () => {
		process.env.SPARK_HOME = tempDir('spark-no-level5-home-');
		delete process.env.SPARK_ALLOW_HIGH_AGENCY_WORKERS;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
		delete process.env.SPARK_CODEX_SANDBOX;

		expect(highAgencyWorkersAllowed({})).toBe(false);
		expect(highAgencyWorkersAllowed({ SPARK_ALLOW_HIGH_AGENCY_WORKERS: '1' })).toBe(true);
		expect(() => assertHighAgencyWorkerAllowed()).toThrow('High-agency worker mode is disabled');
	});

	it('allows opted-in workers inside the Spark workspace root', () => {
		const root = tempDir('spark-high-agency-root-');
		const project = join(root, 'project');
		mkdirSync(project, { recursive: true });
		process.env.SPARK_WORKSPACE_ROOT = root;
		process.env.SPARK_ALLOW_HIGH_AGENCY_WORKERS = '1';
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;

		expect(assertHighAgencyWorkerAllowed(project)).toMatchObject({
			workingDirectory: join(realpathSync(root), 'project'),
			workspaceRoot: realpathSync(root),
			externalProjectPathsAllowed: false
		});
	});

	it('rejects opted-in workers outside the Spark workspace root unless external paths are enabled', () => {
		const root = tempDir('spark-high-agency-root-');
		const external = tempDir('spark-high-agency-external-');
		process.env.SPARK_WORKSPACE_ROOT = root;
		process.env.SPARK_ALLOW_HIGH_AGENCY_WORKERS = '1';
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;

		expect(() => assertHighAgencyWorkerAllowed(external)).toThrow(
			'High-agency workers must run inside Spark workspace root'
		);

		process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS = '1';
		expect(assertHighAgencyWorkerAllowed(external).workingDirectory).toBe(external);
	});

	it('rejects opted-in workers that escape through a workspace symlink', () => {
		const root = tempDir('spark-high-agency-root-');
		const external = tempDir('spark-high-agency-external-');
		const link = join(root, 'linked-out');
		process.env.SPARK_WORKSPACE_ROOT = root;
		process.env.SPARK_ALLOW_HIGH_AGENCY_WORKERS = '1';
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
		try {
			symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
		} catch {
			return;
		}

		expect(() => assertHighAgencyWorkerAllowed(join(link, 'project'))).toThrow(
			'High-agency workers must run inside Spark workspace root'
		);
	});

	it('defaults Codex sandboxing away from full access and gates explicit full access', () => {
		expect(resolveCodexSandbox({})).toBe('workspace-write');
		expect(() => resolveCodexSandbox({ SPARK_CODEX_SANDBOX: 'root' })).toThrow(
			'Unsupported SPARK_CODEX_SANDBOX value'
		);
		expect(() => resolveCodexSandbox({ SPARK_CODEX_SANDBOX: 'danger-full-access' })).toThrow(
			'SPARK_CODEX_SANDBOX=danger-full-access requires SPARK_ALLOW_HIGH_AGENCY_WORKERS=1'
		);
		expect(
			resolveCodexSandbox({
				SPARK_CODEX_SANDBOX: 'danger-full-access',
				SPARK_ALLOW_HIGH_AGENCY_WORKERS: '1'
			})
		).toBe('danger-full-access');
	});

	it('uses persisted Spawner Level 5 env when the service process env is stale', () => {
		const sparkHome = tempDir('spark-level5-env-');
		const moduleEnv = join(sparkHome, 'config', 'modules');
		mkdirSync(moduleEnv, { recursive: true });
		writeFileSync(
			join(moduleEnv, 'spawner-ui.env'),
			[
				'SPARK_ALLOW_HIGH_AGENCY_WORKERS=1',
				'SPARK_ALLOW_EXTERNAL_PROJECT_PATHS=1',
				'SPARK_CODEX_SANDBOX=danger-full-access',
				''
			].join('\n'),
			'utf8'
		);

		expect(
			level5RuntimeGuardrailsActive({
				SPARK_HOME: sparkHome,
				SPARK_CODEX_SANDBOX: 'workspace-write'
			})
		).toBe(true);
		expect(
			resolveCodexSandbox({
				SPARK_HOME: sparkHome,
				SPARK_CODEX_SANDBOX: 'workspace-write'
			})
		).toBe('danger-full-access');
	});

	it('does not use a partial persisted Spawner Level 5 env for full access', () => {
		const sparkHome = tempDir('spark-partial-level5-env-');
		const moduleEnv = join(sparkHome, 'config', 'modules');
		mkdirSync(moduleEnv, { recursive: true });
		writeFileSync(
			join(moduleEnv, 'spawner-ui.env'),
			[
				'SPARK_ALLOW_HIGH_AGENCY_WORKERS=1',
				'SPARK_ALLOW_EXTERNAL_PROJECT_PATHS=1',
				'SPARK_CODEX_SANDBOX=workspace-write',
				''
			].join('\n'),
			'utf8'
		);

		expect(level5RuntimeGuardrailsActive({ SPARK_HOME: sparkHome })).toBe(false);
		expect(resolveCodexSandbox({ SPARK_HOME: sparkHome })).toBe('workspace-write');
	});

	it('requires the full Level 5 guardrail bundle for whole-computer operator mode', () => {
		expect(level5RuntimeGuardrailsActive({})).toBe(false);
		expect(level5RuntimeGuardrailsActive({ SPARK_ALLOW_HIGH_AGENCY_WORKERS: '1' })).toBe(false);
		expect(
			level5RuntimeGuardrailsActive({
				SPARK_ALLOW_HIGH_AGENCY_WORKERS: '1',
				SPARK_ALLOW_EXTERNAL_PROJECT_PATHS: '1',
				SPARK_CODEX_SANDBOX: 'workspace-write'
			})
		).toBe(false);
		expect(
			level5RuntimeGuardrailsActive({
				SPARK_ALLOW_HIGH_AGENCY_WORKERS: '1',
				SPARK_ALLOW_EXTERNAL_PROJECT_PATHS: '1',
				SPARK_CODEX_SANDBOX: 'danger-full-access'
			})
		).toBe(true);
	});
});
