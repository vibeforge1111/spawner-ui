import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	isPathWithinProject,
	opaqueCommandPayloadReason,
	runCommand,
	truncateOutput,
	validateProjectPath
} from './command-runner';

const originalSparkWorkspaceRoot = process.env.SPARK_WORKSPACE_ROOT;
const originalSpawnerWorkspaceRoot = process.env.SPAWNER_WORKSPACE_ROOT;
const originalSparkHome = process.env.SPARK_HOME;
const originalAllowExternalProjectPaths = process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
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

afterEach(() => {
	restoreEnv('SPARK_WORKSPACE_ROOT', originalSparkWorkspaceRoot);
	restoreEnv('SPAWNER_WORKSPACE_ROOT', originalSpawnerWorkspaceRoot);
	restoreEnv('SPARK_HOME', originalSparkHome);
	restoreEnv('SPARK_ALLOW_EXTERNAL_PROJECT_PATHS', originalAllowExternalProjectPaths);
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe('command-runner path validation', () => {
	it('accepts existing project paths inside the Spark workspace root', () => {
		const root = tempDir('spark-runner-root-');
		const project = join(root, 'project & spaces ; $(literal)');
		mkdirSync(project, { recursive: true });
		process.env.SPARK_WORKSPACE_ROOT = root;
		delete process.env.SPAWNER_WORKSPACE_ROOT;
		delete process.env.SPARK_HOME;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;

		expect(validateProjectPath(project)).toEqual({ valid: true });
		expect(isPathWithinProject(join(project, 'src', 'button & test.ts'), project)).toBe(true);
	});

	it('rejects external project paths by default', () => {
		const root = tempDir('spark-runner-root-');
		const external = tempDir('spark-runner-external-');
		process.env.SPARK_WORKSPACE_ROOT = root;
		delete process.env.SPAWNER_WORKSPACE_ROOT;
		delete process.env.SPARK_HOME;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;

		const result = validateProjectPath(external);

		expect(result.valid).toBe(false);
		expect(result.error).toContain('Project path must stay inside Spark workspace root');
	});

	it('does not confuse sibling directories that share a workspace prefix', () => {
		const root = tempDir('spark-runner-prefix-');
		const sibling = `${root}-external`;
		mkdirSync(sibling, { recursive: true });
		cleanupPaths.push(sibling);
		process.env.SPARK_WORKSPACE_ROOT = root;
		delete process.env.SPAWNER_WORKSPACE_ROOT;
		delete process.env.SPARK_HOME;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;

		expect(validateProjectPath(sibling).valid).toBe(false);
		expect(isPathWithinProject(join(sibling, 'package.json'), root)).toBe(false);
	});

	it('allows external project paths only when explicitly enabled', () => {
		const root = tempDir('spark-runner-root-');
		const external = tempDir('spark-runner-external-');
		process.env.SPARK_WORKSPACE_ROOT = root;
		process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS = '1';

		expect(validateProjectPath(external)).toEqual({ valid: true });
	});
});

describe('runCommand', () => {
	it('does not pass command strings through a shell', async () => {
		const shellLine = `"${process.execPath}" -e "console.log('shell-ran')"`;

		const result = await runCommand(shellLine, [], process.cwd(), 5000);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).not.toContain('shell-ran');
	});

	it('blocks opaque interpreter payload flags before spawning', async () => {
		const result = await runCommand(process.execPath, ['-e', "console.log('payload-ran')"], process.cwd(), 5000);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).not.toContain('payload-ran');
		expect(result.stderr).toContain('Opaque command payload flag "-e" is blocked');
	});

	it('detects shell payload flags consistently', () => {
		expect(opaqueCommandPayloadReason('cmd.exe', ['/c', 'echo unsafe'])).toContain('Opaque command payload flag "/c"');
		expect(opaqueCommandPayloadReason('powershell.exe', ['-Command', 'Write-Output unsafe'])).toContain('Opaque command payload flag "-Command"');
		expect(opaqueCommandPayloadReason('bash', ['-lc', 'echo unsafe'])).toContain('Opaque command payload flag "-lc"');
	});

	it('bounds stdout and stderr while the child is still running', async () => {
		const dir = tempDir('spark-runner-output-');
		const script = join(dir, 'large-output.cjs');
		writeFileSync(
			script,
			"process.stdout.write('o'.repeat(10 * 1024 * 1024 + 1)); process.stderr.write('e'.repeat(10 * 1024 * 1024 + 1));"
		);

		const result = await runCommand(process.execPath, [script], dir, 10_000);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('[OUTPUT TRUNCATED: exceeded 10485760 byte buffer limit]');
		expect(result.stderr).toContain('[STDERR TRUNCATED: exceeded 10485760 byte buffer limit]');
		expect(result.stdout.length).toBeLessThanOrEqual(5100);
		expect(result.stderr.length).toBeLessThanOrEqual(5100);
	});
});

describe('truncateOutput', () => {
	it('redacts local user-home paths from command output', () => {
		const macPath = ['', 'Users', 'alice', 'private', 'auth.json'].join('/');
		const linuxPath = ['', 'home', 'alice', 'private', 'poll.json'].join('/');
		const windowsPath = ['C:', 'Users', 'Alice', 'private', 'cache.json'].join('\\');

		const output = truncateOutput([macPath, linuxPath, windowsPath].join('\n'));

		expect(output.match(/\[local path\]/g)).toHaveLength(3);
		for (const leaked of [macPath, linuxPath, windowsPath, 'auth.json', 'poll.json', 'cache.json']) {
			expect(output).not.toContain(leaked);
		}
	});
});
