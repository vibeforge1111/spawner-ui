import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { externalProjectPathsAllowed, resolveWorkspaceContainedPath, sparkWorkspaceRoot } from './spark-run-workspace';

export const HIGH_AGENCY_WORKERS_ENV = 'SPARK_ALLOW_HIGH_AGENCY_WORKERS';
const EXTERNAL_PROJECT_PATHS_ENV = 'SPARK_ALLOW_EXTERNAL_PROJECT_PATHS';
const CODEX_SANDBOX_ENV = 'SPARK_CODEX_SANDBOX';
const LEVEL5_ENV = {
	[HIGH_AGENCY_WORKERS_ENV]: '1',
	[EXTERNAL_PROJECT_PATHS_ENV]: '1',
	[CODEX_SANDBOX_ENV]: 'danger-full-access'
};

export interface HighAgencyWorkerApproval {
	workingDirectory: string;
	workspaceRoot: string;
	externalProjectPathsAllowed: boolean;
}

function resolveExistingPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export function highAgencyWorkersAllowed(envRecord: Record<string, string | undefined> = process.env): boolean {
	const value = effectiveLevel5Env(envRecord)[HIGH_AGENCY_WORKERS_ENV]?.trim().toLowerCase();
	return value === '1' || value === 'true' || value === 'yes';
}

function flagEnabled(value: string | undefined): boolean {
	const normalized = String(value || '').trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function level5RuntimeGuardrailsActive(envRecord: Record<string, string | undefined> = process.env): boolean {
	const effectiveEnv = effectiveLevel5Env(envRecord);
	return (
		flagEnabled(effectiveEnv[HIGH_AGENCY_WORKERS_ENV]) &&
		flagEnabled(effectiveEnv[EXTERNAL_PROJECT_PATHS_ENV]) &&
		String(effectiveEnv[CODEX_SANDBOX_ENV] || '').trim() === 'danger-full-access'
	);
}

function readEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	const values: Record<string, string> = {};
	for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
		const [rawKey, ...rawValue] = trimmed.split('=');
		const key = rawKey.trim().replace(/^\uFEFF/, '');
		const value = rawValue.join('=').trim().replace(/^['"]|['"]$/g, '');
		values[key] = value;
	}
	return values;
}

function spawnerEnvFilePath(envRecord: Record<string, string | undefined>): string {
	const sparkHome = envRecord.SPARK_HOME?.trim() || join(homedir(), '.spark');
	return join(sparkHome, 'config', 'modules', 'spawner-ui.env');
}

function persistedSpawnerLevel5Env(envRecord: Record<string, string | undefined>): Record<string, string> {
	if (!envRecord.SPARK_HOME && envRecord !== process.env) return {};
	const values = readEnvFile(spawnerEnvFilePath(envRecord));
	const hasFullBundle = Object.entries(LEVEL5_ENV).every(([key, expected]) => values[key] === expected);
	return hasFullBundle ? values : {};
}

export function effectiveLevel5Env(envRecord: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
	if (
		flagEnabled(envRecord[HIGH_AGENCY_WORKERS_ENV]) &&
		flagEnabled(envRecord[EXTERNAL_PROJECT_PATHS_ENV]) &&
		String(envRecord[CODEX_SANDBOX_ENV] || '').trim() === 'danger-full-access'
	) {
		return envRecord;
	}

	const persisted = persistedSpawnerLevel5Env(envRecord);
	if (!persisted[CODEX_SANDBOX_ENV]) return envRecord;
	return {
		...envRecord,
		[HIGH_AGENCY_WORKERS_ENV]: persisted[HIGH_AGENCY_WORKERS_ENV],
		[EXTERNAL_PROJECT_PATHS_ENV]: persisted[EXTERNAL_PROJECT_PATHS_ENV],
		[CODEX_SANDBOX_ENV]: persisted[CODEX_SANDBOX_ENV]
	};
}

export function assertHighAgencyWorkerAllowed(workingDirectory?: string): HighAgencyWorkerApproval {
	if (!highAgencyWorkersAllowed()) {
		throw new Error(
			`High-agency worker mode is disabled. Set ${HIGH_AGENCY_WORKERS_ENV}=1 only on trusted local installs.`
		);
	}

	const workspaceRoot = resolveExistingPath(sparkWorkspaceRoot());
	const cwd = resolve(workingDirectory?.trim() || process.cwd());
	const externalAllowed = externalProjectPathsAllowed();
	let workingDirectoryResolved = cwd;
	if (!externalAllowed) {
		try {
			workingDirectoryResolved = resolveWorkspaceContainedPath(cwd, 'High-agency worker path');
		} catch {
			throw new Error(
				`High-agency workers must run inside Spark workspace root (${workspaceRoot}). ` +
					`Use a workspace path like "${basename(cwd) || 'project'}", ` +
					'or set SPARK_ALLOW_EXTERNAL_PROJECT_PATHS=1 for trusted local development.'
			);
		}
	}

	return {
		workingDirectory: workingDirectoryResolved,
		workspaceRoot,
		externalProjectPathsAllowed: externalAllowed
	};
}

export function resolveCodexSandbox(envRecord: Record<string, string | undefined> = process.env): string {
	const effectiveEnv = effectiveLevel5Env(envRecord);
	const sandbox = effectiveEnv[CODEX_SANDBOX_ENV]?.trim() || 'workspace-write';
	if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) {
		throw new Error(`Unsupported SPARK_CODEX_SANDBOX value: ${sandbox}`);
	}
	if (sandbox === 'danger-full-access' && !highAgencyWorkersAllowed(effectiveEnv)) {
		throw new Error(`SPARK_CODEX_SANDBOX=danger-full-access requires ${HIGH_AGENCY_WORKERS_ENV}=1`);
	}
	return sandbox;
}
