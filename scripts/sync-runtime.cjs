#!/usr/bin/env node
/**
 * Runtime drift check for the installed Spawner UI mirror.
 *
 * Runtime updates are git operations now:
 *   git -C "$HOME/.spark/modules/spawner-ui/source" fetch origin
 *   git -C "$HOME/.spark/modules/spawner-ui/source" merge --ff-only origin/main
 *   spark restart spawner-ui --allow-dirty-runtime
 *
 * This script intentionally does not copy files. It verifies that the current
 * checkout and the installed runtime mirror point at the same commit, and that
 * the runtime has no unexpected local edits.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SOURCE_ROOT = path.resolve(process.env.SPAWNER_SYNC_SOURCE_ROOT || path.join(__dirname, '..'));

function installedRuntimeRoot() {
	if (process.env.SPAWNER_RUNTIME_ROOT?.trim()) {
		return path.resolve(process.env.SPAWNER_RUNTIME_ROOT.trim());
	}
	const sparkHome = path.resolve(process.env.SPARK_HOME?.trim() || path.join(os.homedir(), '.spark'));
	const fallback = path.join(sparkHome, 'modules', 'spawner-ui', 'source');
	const installedJson = path.join(sparkHome, 'state', 'installed.json');
	try {
		const installed = JSON.parse(fs.readFileSync(installedJson, 'utf8'));
		const configured = installed?.['spawner-ui']?.path || installed?.['spawner-ui']?.source;
		return configured ? path.resolve(configured) : fallback;
	} catch {
		return fallback;
	}
}

const RUNTIME_ROOT = installedRuntimeRoot();

const ALLOWED_RUNTIME_OVERLAY_PATHS = new Set([
	'docs/SPARK_HARNESS_CONTRACT_ADOPTION.md',
	'package-lock.json',
	'package.json',
	'vendor/harness-core/SOURCE_MANIFEST.md'
]);

function git(root, args, { allowFailure = false } = {}) {
	try {
		return execFileSync('git', ['-C', root, ...args], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		}).trim();
	} catch (error) {
		if (allowFailure) return null;
		const stderr = error?.stderr ? String(error.stderr).trim() : '';
		const detail = stderr ? `: ${stderr}` : '';
		throw new Error(`git -C ${root} ${args.join(' ')} failed${detail}`);
	}
}

function ensureGitRepo(label, root) {
	if (!fs.existsSync(root)) {
		return `${label} does not exist: ${root}`;
	}
	const inside = git(root, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
	if (inside !== 'true') {
		return `${label} is not a git checkout: ${root}`;
	}
	return null;
}

function normalizePorcelainPath(value) {
	const renamed = value.includes(' -> ') ? value.split(' -> ').pop() : value;
	return renamed.replace(/^"|"$/g, '').replace(/\\/g, '/');
}

function runtimeStatusPaths() {
	const output = git(RUNTIME_ROOT, ['status', '--porcelain=v1', '--untracked-files=all']);
	if (!output) return [];
	return output
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => normalizePorcelainPath(line.slice(2).trimStart()));
}

function checkDrift() {
	const errors = [
		ensureGitRepo('source checkout', SOURCE_ROOT),
		ensureGitRepo('runtime mirror', RUNTIME_ROOT)
	].filter(Boolean);

	if (errors.length === 0) {
		const sourceHead = git(SOURCE_ROOT, ['rev-parse', 'HEAD']);
		const runtimeHead = git(RUNTIME_ROOT, ['rev-parse', 'HEAD']);
		if (sourceHead !== runtimeHead) {
			errors.push(`commit drift: source HEAD ${sourceHead} != runtime HEAD ${runtimeHead}`);
		}

		const dirtyPaths = runtimeStatusPaths();
		const unexpectedDirty = dirtyPaths.filter((relPath) => !ALLOWED_RUNTIME_OVERLAY_PATHS.has(relPath));
		const allowedDirty = dirtyPaths.filter((relPath) => ALLOWED_RUNTIME_OVERLAY_PATHS.has(relPath));

		if (unexpectedDirty.length > 0) {
			errors.push(`runtime has unexpected local edits:\n${unexpectedDirty.map((p) => `  - ${p}`).join('\n')}`);
		}

		if (allowedDirty.length > 0) {
			console.log(`[check] allowed runtime overlay: ${allowedDirty.join(', ')}`);
		}
	}

	if (errors.length > 0) {
		console.error('[check] runtime drift detected.');
		for (const error of errors) console.error(`- ${error}`);
		console.error('[check] update runtime with: git fetch origin && git merge --ff-only origin/main');
		process.exit(1);
	}

	console.log('[check] runtime git mirror matches source checkout.');
}

function printRetiredUsage() {
	console.error('[sync] file-copy runtime sync is retired.');
	console.error('[sync] update runtime with git fetch origin && git merge --ff-only origin/main, then restart spawner-ui.');
	console.error('[sync] run node scripts/sync-runtime.cjs --check to verify drift.');
	process.exit(1);
}

const arg = process.argv[2];
if (arg === '--check') checkDrift();
else printRetiredUsage();
