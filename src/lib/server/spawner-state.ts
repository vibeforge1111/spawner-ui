import { env } from '$env/dynamic/private';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { hostedUiLooksHosted, type HostedUiAuthEnv } from './hosted-ui-auth';

export function isWindowsAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

export function joinMaybeWindowsPath(base: string, ...segments: string[]): string {
	if (isWindowsAbsolutePath(base)) {
		return path.win32.join(base, ...segments);
	}
	return path.join(base, ...segments);
}

export function workspaceStateSegment(workspaceId: string): string {
	const normalized = workspaceId
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
	return normalized || 'workspace';
}

export interface SpawnerStateRootAudit {
	schema_version: 'spark.spawner_state_root_audit.v1';
	checked_at: string;
	base_state_dir: string;
	state_dir: string;
	configured_state_dir_present: boolean;
	spark_home_state_dir_present: boolean;
	fallback_state_dir: string;
	fallback_used: boolean;
	spark_home_state_fallback_used: boolean;
	cwd_fallback_used: boolean;
	hosted_workspace_scoped: boolean;
	legacy_local_state_exists: boolean;
	classification:
		| 'canonical_configured'
		| 'canonical_spark_home'
		| 'canonical_fallback'
		| 'active_legacy_present';
	warnings: string[];
	redaction: string;
	source_reference_audit: SpawnerStateSourceReferenceAudit;
	archive_readiness: SpawnerStateArchiveReadiness;
}

export interface SpawnerStateSourceReferenceAudit {
	schema_version: 'spark.spawner_state_source_reference_audit.v1';
	source_root: string;
	scanned_roots: string[];
	reference_file_count: number;
	reference_family_counts: Record<string, number>;
	runtime_reference_file_count: number;
	non_runtime_reference_file_count: number;
	reference_owner_counts: Record<string, number>;
	cwd_spawner_fallback_helper_present: boolean;
	spark_home_state_fallback_helper_present: boolean;
	redaction: string;
}

export interface SpawnerStateArchiveReadiness {
	schema_version: 'spark.spawner_state_archive_readiness.v1';
	classification: 'blocked' | 'candidate';
	archive_candidate: boolean;
	blockers: string[];
	required_proofs: string[];
	next_safe_action: string;
	redaction: string;
}

function configuredSpawnerStateDir(runtimeEnv: HostedUiAuthEnv = env): string {
	return process.env.SPAWNER_STATE_DIR || runtimeEnv.SPAWNER_STATE_DIR || '';
}

function sparkHomeStateDir(runtimeEnv: HostedUiAuthEnv = env): string {
	const sparkHome = process.env.SPARK_HOME || runtimeEnv.SPARK_HOME || '';
	return sparkHome.trim() ? joinMaybeWindowsPath(sparkHome.trim(), 'state', 'spawner-ui') : '';
}

export function spawnerBaseStateDir(runtimeEnv: HostedUiAuthEnv = env, fallbackCwd = process.cwd()): string {
	return configuredSpawnerStateDir(runtimeEnv) || sparkHomeStateDir(runtimeEnv) || path.resolve(fallbackCwd, '.spawner');
}

export function spawnerStateDir(runtimeEnv: HostedUiAuthEnv = env, fallbackCwd = process.cwd()): string {
	const baseDir = spawnerBaseStateDir(runtimeEnv, fallbackCwd);
	const workspaceId = runtimeEnv.SPARK_WORKSPACE_ID?.trim();
	if (!workspaceId || !hostedUiLooksHosted(runtimeEnv)) {
		return baseDir;
	}
	return joinMaybeWindowsPath(baseDir, 'workspaces', workspaceStateSegment(workspaceId));
}

// Hoisted so the directory-walker below doesn't allocate a 5-element
// array literal per visited directory entry.
const SCAN_SKIP_DIRECTORIES = new Set<string>([
	'node_modules',
	'.git',
	'dist',
	'build',
	'.svelte-kit'
]);

export function spawnerStateSourceReferenceAudit(sourceRoot = process.cwd()): SpawnerStateSourceReferenceAudit {
	const referenceNeedles = ['.spawner', 'SPAWNER_STATE_DIR', 'spawnerStateDir', 'spawner-state'];
	const scannedRoots = ['src', 'scripts', 'tests'];
	const scannedExtensions = new Set(['.cjs', '.js', '.json', '.md', '.mjs', '.svelte', '.ts']);
	const referenceFamilyCounts: Record<string, number> = {};
	const referenceOwnerCounts: Record<string, number> = {};
	let referenceFileCount = 0;
	let runtimeReferenceFileCount = 0;
	let nonRuntimeReferenceFileCount = 0;

	const scanDirectory = (family: string, dir: string) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SCAN_SKIP_DIRECTORIES.has(entry.name)) continue;
				scanDirectory(family, fullPath);
				continue;
			}
			if (!entry.isFile()) continue;

			try {
				if (!scannedExtensions.has(path.extname(entry.name).toLowerCase())) continue;
				const stats = statSync(fullPath);
				if (stats.size > 1_000_000) continue;
				const text = readFileSync(fullPath, 'utf-8');
				if (referenceNeedles.some((needle) => text.includes(needle))) {
					referenceFileCount += 1;
					referenceFamilyCounts[family] = (referenceFamilyCounts[family] ?? 0) + 1;
					const owner = family === 'src' || family === 'scripts' ? 'runtime' : 'non_runtime';
					referenceOwnerCounts[owner] = (referenceOwnerCounts[owner] ?? 0) + 1;
					if (owner === 'runtime') runtimeReferenceFileCount += 1;
					else nonRuntimeReferenceFileCount += 1;
				}
			} catch (err) {
				console.warn('[spawner-state] file scan entry failed:', err);
				continue;
			}
		}
	};

	for (const root of scannedRoots) {
		scanDirectory(root, path.join(sourceRoot, root));
	}

	let helperText = '';
	try {
		helperText = readFileSync(path.join(sourceRoot, 'src', 'lib', 'server', 'spawner-state.ts'), 'utf-8');
	} catch (err) {
		console.warn('[spawner-state] helper text read failed:', err);
		helperText = '';
	}

	return {
		schema_version: 'spark.spawner_state_source_reference_audit.v1',
		source_root: sourceRoot,
		scanned_roots: scannedRoots,
		reference_file_count: referenceFileCount,
		reference_family_counts: referenceFamilyCounts,
		runtime_reference_file_count: runtimeReferenceFileCount,
		non_runtime_reference_file_count: nonRuntimeReferenceFileCount,
		reference_owner_counts: referenceOwnerCounts,
		cwd_spawner_fallback_helper_present: helperText.includes("'.spawner'") || helperText.includes('".spawner"'),
		spark_home_state_fallback_helper_present:
			helperText.includes('SPARK_HOME') && helperText.includes('state') && helperText.includes('spawner-ui'),
		redaction: 'source metadata only; file contents, state files, mission bodies, prompts, provider output, chat ids, and secrets omitted'
	};
}

export function spawnerStateArchiveReadiness(
	audit: Pick<
		SpawnerStateRootAudit,
		| 'configured_state_dir_present'
		| 'spark_home_state_dir_present'
		| 'cwd_fallback_used'
		| 'legacy_local_state_exists'
		| 'state_dir'
		| 'fallback_state_dir'
	>,
	sourceAudit: SpawnerStateSourceReferenceAudit
): SpawnerStateArchiveReadiness {
	const blockers: string[] = [];

	if (audit.cwd_fallback_used) blockers.push('current_runtime_uses_cwd_spawner_fallback');
	if (audit.legacy_local_state_exists) blockers.push('module_local_state_exists_without_archive_proof');
	if (sourceAudit.cwd_spawner_fallback_helper_present) blockers.push('cwd_spawner_fallback_still_supported_by_state_helper');
	if (sourceAudit.reference_file_count > 0) blockers.push('spawner_state_references_require_owner_classification');
	if (!audit.configured_state_dir_present && !audit.spark_home_state_dir_present) {
		blockers.push('no_configured_or_spark_home_state_root_for_current_runtime');
	}

	const archiveCandidate = blockers.length === 0;

	return {
		schema_version: 'spark.spawner_state_archive_readiness.v1',
		classification: archiveCandidate ? 'candidate' : 'blocked',
		archive_candidate: archiveCandidate,
		blockers,
		required_proofs: [
			'source-owner dependency scan shows no current reader or writer depends on module-local .spawner',
			'two clean spark os compile runs agree on canonical state root and duplicate-truth classification',
			'one fresh Telegram -> Builder -> Spawner trace proof writes to canonical state root',
			'operator-approved backup exists before any archive or delete action'
		],
		next_safe_action: archiveCandidate
			? 'Prepare an owner-approved backup/archive proposal; do not delete state from this route.'
			: 'Keep module-local .spawner read-only and warning-only; classify source references before any archive action.',
		redaction: `metadata only; canonical state root ${audit.state_dir} and legacy candidate ${audit.fallback_state_dir} were not opened for contents`
	};
}

export function spawnerStateRootAudit(
	runtimeEnv: HostedUiAuthEnv = env,
	fallbackCwd = process.cwd(),
	exists = existsSync
): SpawnerStateRootAudit {
	const configuredStateDir = configuredSpawnerStateDir(runtimeEnv);
	const sparkHomeState = sparkHomeStateDir(runtimeEnv);
	const fallbackStateDir = path.resolve(fallbackCwd, '.spawner');
	const baseStateDir = spawnerBaseStateDir(runtimeEnv, fallbackCwd);
	const stateDir = spawnerStateDir(runtimeEnv, fallbackCwd);
	const fallbackUsed = !configuredStateDir;
	const sparkHomeStateFallbackUsed = !configuredStateDir && Boolean(sparkHomeState);
	const cwdFallbackUsed = !configuredStateDir && !sparkHomeState;
	const legacyLocalStateExists = exists(fallbackStateDir);
	const hostedWorkspaceScoped = path.resolve(stateDir) !== path.resolve(baseStateDir);
	const warnings: string[] = [];
	const sourceReferenceAudit = spawnerStateSourceReferenceAudit(fallbackCwd);

	if (cwdFallbackUsed) {
		warnings.push('SPAWNER_STATE_DIR is not configured; runtime falls back to process working directory .spawner.');
	}
	if (!fallbackUsed && legacyLocalStateExists && path.resolve(fallbackStateDir) !== path.resolve(stateDir)) {
		warnings.push('Module-local .spawner exists beside configured state root; treat it as legacy until read/write audit completes.');
	}

	const classification = cwdFallbackUsed
		? 'canonical_fallback'
		: warnings.length
			? 'active_legacy_present'
			: sparkHomeStateFallbackUsed
				? 'canonical_spark_home'
			: 'canonical_configured';

	return {
		schema_version: 'spark.spawner_state_root_audit.v1',
		checked_at: new Date().toISOString(),
		base_state_dir: baseStateDir,
		state_dir: stateDir,
		configured_state_dir_present: Boolean(configuredStateDir),
		spark_home_state_dir_present: Boolean(sparkHomeState),
		fallback_state_dir: fallbackStateDir,
		fallback_used: fallbackUsed,
		spark_home_state_fallback_used: sparkHomeStateFallbackUsed,
		cwd_fallback_used: cwdFallbackUsed,
		hosted_workspace_scoped: hostedWorkspaceScoped,
		legacy_local_state_exists: legacyLocalStateExists,
		classification,
		warnings,
		redaction: 'path metadata only; mission bodies, provider output, prompts, chat ids, and secrets omitted',
		source_reference_audit: sourceReferenceAudit,
		archive_readiness: spawnerStateArchiveReadiness(
			{
				configured_state_dir_present: Boolean(configuredStateDir),
				spark_home_state_dir_present: Boolean(sparkHomeState),
				cwd_fallback_used: cwdFallbackUsed,
				legacy_local_state_exists: legacyLocalStateExists,
				state_dir: stateDir,
				fallback_state_dir: fallbackStateDir
			},
			sourceReferenceAudit
		)
	};
}
