import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const repoRoot = join(import.meta.dirname, '..');
const scriptPath = join(repoRoot, 'scripts', 'sync-runtime.cjs');
const tempRoots = [];

function git(root, args) {
	return execFileSync('git', ['-C', root, ...args], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	}).trim();
}

function makeRepo() {
	const root = mkdtempSync(join(tmpdir(), 'spawner-sync-source-'));
	tempRoots.push(root);
	git(root, ['init']);
	git(root, ['config', 'user.email', 'spawner-sync-test@example.invalid']);
	git(root, ['config', 'user.name', 'Spawner Sync Test']);
	mkdirSync(join(root, 'docs'), { recursive: true });
	mkdirSync(join(root, 'vendor', 'harness-core'), { recursive: true });
	writeFileSync(join(root, 'README.md'), '# sync fixture\n');
	writeFileSync(join(root, 'package.json'), '{"name":"sync-fixture"}\n');
	writeFileSync(join(root, 'docs', 'SPARK_HARNESS_CONTRACT_ADOPTION.md'), 'harness source\n');
	writeFileSync(join(root, 'vendor', 'harness-core', 'SOURCE_MANIFEST.md'), 'source manifest\n');
	git(root, ['add', '.']);
	git(root, ['commit', '-m', 'initial sync fixture']);
	return root;
}

function cloneRepo(source) {
	const runtime = mkdtempSync(join(tmpdir(), 'spawner-sync-runtime-'));
	rmSync(runtime, { recursive: true, force: true });
	execFileSync('git', ['clone', source, runtime], { stdio: ['ignore', 'pipe', 'pipe'] });
	tempRoots.push(runtime);
	return runtime;
}

function runCheck(source, runtime) {
	return spawnSync(process.execPath, [scriptPath, '--check'], {
		encoding: 'utf8',
		env: {
			...process.env,
			SPAWNER_SYNC_SOURCE_ROOT: source,
			SPAWNER_RUNTIME_ROOT: runtime
		}
	});
}

function runInstalledStateCheck(source, runtime) {
	const sparkHome = mkdtempSync(join(tmpdir(), 'spawner-sync-home-'));
	tempRoots.push(sparkHome);
	mkdirSync(join(sparkHome, 'state'), { recursive: true });
	writeFileSync(
		join(sparkHome, 'state', 'installed.json'),
		`${JSON.stringify({ 'spawner-ui': { path: runtime, source: runtime } }, null, 2)}\n`
	);
	return spawnSync(process.execPath, [scriptPath, '--check'], {
		encoding: 'utf8',
		env: {
			...process.env,
			SPARK_HOME: sparkHome,
			SPAWNER_SYNC_SOURCE_ROOT: source,
			SPAWNER_RUNTIME_ROOT: ''
		}
	});
}

afterEach(() => {
	while (tempRoots.length > 0) {
		rmSync(tempRoots.pop(), { recursive: true, force: true });
	}
});

describe('sync-runtime drift check', () => {
	it('passes when source and runtime point at the same clean commit', () => {
		const source = makeRepo();
		const runtime = cloneRepo(source);

		const result = runCheck(source, runtime);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('runtime git mirror matches source checkout');
	});

	it('uses the installed module record before the legacy source fallback', () => {
		const source = makeRepo();
		const runtime = cloneRepo(source);

		const result = runInstalledStateCheck(source, runtime);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('runtime git mirror matches source checkout');
	});

	it('fails when source has a commit that runtime has not fast-forwarded to', () => {
		const source = makeRepo();
		const runtime = cloneRepo(source);
		writeFileSync(join(source, 'README.md'), '# sync fixture\n\nchanged on source only\n');
		git(source, ['add', 'README.md']);
		git(source, ['commit', '-m', 'source only change']);

		const result = runCheck(source, runtime);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('commit drift');
	});

	it('fails when runtime has unexpected local edits', () => {
		const source = makeRepo();
		const runtime = cloneRepo(source);
		writeFileSync(join(runtime, 'README.md'), '# sync fixture\n\nruntime only change\n');

		const result = runCheck(source, runtime);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('runtime has unexpected local edits');
		expect(result.stderr).toContain('README.md');
	});

	it('allows the intentional local harness distribution overlay', () => {
		const source = makeRepo();
		const runtime = cloneRepo(source);
		writeFileSync(join(runtime, 'package.json'), '{"name":"sync-fixture","dependencies":{"@spark/harness-core":"file:C:/Users/USER/.spark/modules/spark-harness-core/source"}}\n');
		writeFileSync(join(runtime, 'package-lock.json'), '{"name":"sync-fixture","lockfileVersion":3}\n');
		writeFileSync(join(runtime, 'docs', 'SPARK_HARNESS_CONTRACT_ADOPTION.md'), 'installed harness source\n');
		writeFileSync(join(runtime, 'vendor', 'harness-core', 'SOURCE_MANIFEST.md'), 'installed source manifest\n');

		const result = runCheck(source, runtime);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('allowed runtime overlay');
		expect(result.stdout).toContain('runtime git mirror matches source checkout');
	});
});
