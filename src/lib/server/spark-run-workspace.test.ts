import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	ensureContainedDirectoryInRoots,
	recheckContainedDirectoryInRoots,
	resolveSparkRunProjectPath,
	SparkRunWorkspaceError
} from './spark-run-workspace';

const originalSparkWorkspaceRoot = process.env.SPARK_WORKSPACE_ROOT;
const originalSpawnerWorkspaceRoot = process.env.SPAWNER_WORKSPACE_ROOT;
const originalSparkHome = process.env.SPARK_HOME;
const originalAllowExternalProjectPaths = process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
const cleanupPaths: string[] = [];

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function expectedContainedPath(root: string, ...segments: string[]): string {
	return join(realpathSync(root), ...segments);
}

afterEach(() => {
	restoreEnv('SPARK_WORKSPACE_ROOT', originalSparkWorkspaceRoot);
	restoreEnv('SPAWNER_WORKSPACE_ROOT', originalSpawnerWorkspaceRoot);
	restoreEnv('SPARK_HOME', originalSparkHome);
	restoreEnv('SPARK_ALLOW_EXTERNAL_PROJECT_PATHS', originalAllowExternalProjectPaths);
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe('resolveSparkRunProjectPath', () => {
	it('uses a platform-local Spark workspace when no project path is provided', () => {
		const root = mkdtempSync(join(tmpdir(), 'spark-workspace-'));
		cleanupPaths.push(root);
		process.env.SPARK_WORKSPACE_ROOT = root;
		delete process.env.SPAWNER_WORKSPACE_ROOT;

		const resolved = resolveSparkRunProjectPath();

		expect(resolved).toBe(expectedContainedPath(root, 'default'));
		expect(existsSync(resolved)).toBe(true);
		expect(resolved).not.toContain('C:/Users/USER/Desktop');
	});

	it('uses SPARK_HOME workspaces for sandboxed installs when no explicit root is set', () => {
		const sparkHome = mkdtempSync(join(tmpdir(), 'spark-home-'));
		cleanupPaths.push(sparkHome);
		delete process.env.SPARK_WORKSPACE_ROOT;
		delete process.env.SPAWNER_WORKSPACE_ROOT;
		process.env.SPARK_HOME = sparkHome;

		const resolved = resolveSparkRunProjectPath();

		expect(resolved).toBe(expectedContainedPath(sparkHome, 'workspaces', 'default'));
		expect(existsSync(resolved)).toBe(true);
	});

	it('creates and returns explicit project paths inside the Spark workspace root', () => {
		const root = mkdtempSync(join(tmpdir(), 'spark-explicit-'));
		const target = join(root, 'project');
		cleanupPaths.push(root);
		process.env.SPARK_WORKSPACE_ROOT = root;

		const resolved = resolveSparkRunProjectPath(target);

		expect(resolved).toBe(expectedContainedPath(root, 'project'));
		expect(isAbsolute(resolved)).toBe(true);
		expect(existsSync(resolved)).toBe(true);
	});

	it('resolves relative project names under the Spark workspace root', () => {
		const root = mkdtempSync(join(tmpdir(), 'spark-relative-'));
		cleanupPaths.push(root);
		process.env.SPARK_WORKSPACE_ROOT = root;

		const resolved = resolveSparkRunProjectPath('telegram-project');

		expect(resolved).toBe(expectedContainedPath(root, 'telegram-project'));
		expect(existsSync(resolved)).toBe(true);
	});

	it('rejects external project paths by default', () => {
		const root = mkdtempSync(join(tmpdir(), 'spark-root-'));
		const external = mkdtempSync(join(tmpdir(), 'spark-external-'));
		cleanupPaths.push(root, external);
		process.env.SPARK_WORKSPACE_ROOT = root;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;

		expect(() => resolveSparkRunProjectPath(join(external, 'project'))).toThrow(SparkRunWorkspaceError);
	});

	it('rejects project paths that escape through a workspace symlink', () => {
		const root = mkdtempSync(join(tmpdir(), 'spark-root-'));
		const external = mkdtempSync(join(tmpdir(), 'spark-external-'));
		const link = join(root, 'linked-out');
		cleanupPaths.push(root, external);
		process.env.SPARK_WORKSPACE_ROOT = root;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
		try {
			symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
		} catch {
			return;
		}

		expect(() => resolveSparkRunProjectPath(join(link, 'project'))).toThrow(SparkRunWorkspaceError);
	});

	it('rejects a contained directory replaced by an external symlink after the initial ensure', () => {
		const root = mkdtempSync(join(tmpdir(), 'spark-recheck-root-'));
		const external = mkdtempSync(join(tmpdir(), 'spark-recheck-external-'));
		const target = join(root, 'mission-project');
		cleanupPaths.push(root, external);

		const initiallyContained = ensureContainedDirectoryInRoots([root], target, 'Mission project');
		expect(initiallyContained).toBe(expectedContainedPath(root, 'mission-project'));

		rmSync(target, { recursive: true, force: true });
		try {
			symlinkSync(external, target, process.platform === 'win32' ? 'junction' : 'dir');
		} catch {
			return;
		}

		expect(() => recheckContainedDirectoryInRoots([root], target, 'Mission project')).toThrow(
			SparkRunWorkspaceError
		);
		expect(() => recheckContainedDirectoryInRoots([root], target, 'Mission project')).toThrow(
			/must stay inside a Spark-controlled root/i
		);
	});

	it('rejects traversal escapes and workspace-root prefix collisions before creating a directory', () => {
		const root = mkdtempSync(join(tmpdir(), 'spark-root-'));
		cleanupPaths.push(root);
		process.env.SPARK_WORKSPACE_ROOT = root;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
		const traversalEscape = resolve(root, '..', `${root.split(/[\\/]/).pop()}-traversal-escape`, 'project');
		const prefixCollision = join(`${root}-evil`, 'project');

		expect(() => resolveSparkRunProjectPath(traversalEscape)).toThrow(SparkRunWorkspaceError);
		expect(() => resolveSparkRunProjectPath(prefixCollision)).toThrow(SparkRunWorkspaceError);
		expect(existsSync(traversalEscape)).toBe(false);
		expect(existsSync(prefixCollision)).toBe(false);
	});

	it.each(['unsafe^project', 'unsafe%TEMP%project', 'unsafe!VAR!project'])(
		'rejects unsafe shell metacharacters in project path %s before creating a directory',
		(segment) => {
			const root = mkdtempSync(join(tmpdir(), 'spark-root-'));
			cleanupPaths.push(root);
			process.env.SPARK_WORKSPACE_ROOT = root;
			delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
			const target = join(root, segment);

			expect(() => resolveSparkRunProjectPath(target)).toThrow(SparkRunWorkspaceError);
			expect(existsSync(target)).toBe(false);
		}
	);

	it('allows a safe generated suffix when the trusted configured workspace root contains shell-like characters', () => {
		const parent = mkdtempSync(join(tmpdir(), 'spark-trusted-root-'));
		const root = join(parent, "O'Brien-100%-!", 'workspaces');
		mkdirSync(root, { recursive: true });
		cleanupPaths.push(parent);
		process.env.SPARK_WORKSPACE_ROOT = root;
		delete process.env.SPAWNER_WORKSPACE_ROOT;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
		const generated = join(root, 'generated-projects', 'mission-safe');

		const resolved = resolveSparkRunProjectPath(generated);

		expect(resolved).toBe(expectedContainedPath(root, 'generated-projects', 'mission-safe'));
		expect(existsSync(resolved)).toBe(true);
	});

	it('rejects a foreign operating-system absolute path before creating a directory', () => {
		const root = mkdtempSync(join(tmpdir(), 'spark-root-'));
		cleanupPaths.push(root);
		process.env.SPARK_WORKSPACE_ROOT = root;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
		const foreignPath = process.platform === 'win32'
			? '/tmp/spark-foreign-project'
			: 'C:\\Users\\USER\\Desktop\\spark-foreign-project';

		expect(() => resolveSparkRunProjectPath(foreignPath)).toThrow(SparkRunWorkspaceError);
		expect(existsSync(foreignPath)).toBe(false);
	});

	it('allows external project paths only when explicitly enabled', () => {
		const root = mkdtempSync(join(tmpdir(), 'spark-root-'));
		const external = mkdtempSync(join(tmpdir(), 'spark-external-'));
		const target = join(external, 'project');
		cleanupPaths.push(root, external);
		process.env.SPARK_WORKSPACE_ROOT = root;
		process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS = '1';

		const resolved = resolveSparkRunProjectPath(target);

		expect(resolved).toBe(realpathSync(target));
		expect(existsSync(resolved)).toBe(true);
	});
});
