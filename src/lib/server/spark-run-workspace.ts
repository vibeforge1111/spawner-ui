import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class SparkRunWorkspaceError extends Error {
	status = 400;

	constructor(message: string) {
		super(message);
		this.name = 'SparkRunWorkspaceError';
	}
}

export function sparkWorkspaceRoot(
	envRecord: Record<string, string | undefined> = process.env
): string {
	return resolve(
		envRecord.SPARK_WORKSPACE_ROOT?.trim() ||
			envRecord.SPAWNER_WORKSPACE_ROOT?.trim() ||
			(envRecord.SPARK_HOME?.trim()
			? join(envRecord.SPARK_HOME.trim(), 'workspaces')
			: join(homedir(), '.spark', 'workspaces'))
	);
}

export function externalProjectPathsAllowed(): boolean {
	const value = process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS?.trim().toLowerCase();
	return value === '1' || value === 'true' || value === 'yes';
}

function isForeignOperatingSystemAbsolutePath(candidate: string): boolean {
	const looksWindowsDriveAbsolute = /^[A-Za-z]:[\\/]/.test(candidate);
	const looksWindowsUncAbsolute = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(candidate);
	const looksPosixAbsolute = candidate.startsWith('/');
	return process.platform === 'win32'
		? looksPosixAbsolute && !looksWindowsUncAbsolute
		: looksWindowsDriveAbsolute || looksWindowsUncAbsolute;
}

function unsafeProjectPathReason(candidate: string): string | null {
	if (/[\u0000-\u001f`$;&|<>"'!%^]/u.test(candidate) || /[*?]/.test(candidate)) {
		return 'unsafe shell metacharacters';
	}
	const withoutDrivePrefix = candidate.replace(/^[A-Za-z]:[\\/]/, '');
	if (process.platform === 'win32' && withoutDrivePrefix.includes(':')) {
		return 'unsafe Windows alternate-data-stream separator';
	}
	return null;
}

function untrustedProjectPathPortion(candidate: string, trustedRoots: string[]): string {
	const primaryRoot = trustedRoots[0] || sparkWorkspaceRoot();
	const absoluteCandidate = isAbsolute(candidate)
		? resolve(candidate)
		: resolve(primaryRoot, candidate);
	for (const trustedRoot of trustedRoots) {
		if (isWithinDirectory(trustedRoot, absoluteCandidate)) {
			return relative(resolve(trustedRoot), absoluteCandidate);
		}
	}
	return candidate;
}

export function assertSafeLocalProjectPath(
	candidate: string,
	label = 'Project path',
	trustedRoots: string[] = [sparkWorkspaceRoot()]
): void {
	const requested = candidate.trim();
	if (isForeignOperatingSystemAbsolutePath(requested)) {
		throw new SparkRunWorkspaceError(
			`${label} uses a foreign operating-system absolute path and cannot become a local provider working directory.`
		);
	}
	// Configured Spark roots are trusted runtime configuration. Validate only the
	// user-controlled suffix for contained paths so a legitimate home/root such
	// as `/Users/O'Brien/100%!/workspaces` does not disable generated missions.
	const unsafeReason = unsafeProjectPathReason(untrustedProjectPathPortion(requested, trustedRoots));
	if (unsafeReason) {
		throw new SparkRunWorkspaceError(`${label} contains ${unsafeReason}.`);
	}
}

export function isWithinDirectory(baseDir: string, targetPath: string): boolean {
	const normalizedBase = resolve(baseDir);
	const normalizedTarget = resolve(targetPath);
	const baseLower = process.platform === 'win32' ? normalizedBase.toLowerCase() : normalizedBase;
	const targetLower = process.platform === 'win32' ? normalizedTarget.toLowerCase() : normalizedTarget;
	return targetLower === baseLower || targetLower.startsWith(`${baseLower}${sep}`);
}

function resolveExistingPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function resolveThroughExistingParent(path: string): string {
	const absolutePath = resolve(path);
	const missingSegments: string[] = [];
	let cursor = absolutePath;
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) return absolutePath;
		missingSegments.unshift(basename(cursor));
		cursor = parent;
	}
	return resolve(resolveExistingPath(cursor), ...missingSegments);
}

export function resolveContainedPathInRoots(
	baseDirs: string[],
	targetPath: string,
	label = 'Path'
): string {
	const baseResolved = baseDirs.map((baseDir) => resolveThroughExistingParent(baseDir));
	const targetResolved = resolveThroughExistingParent(targetPath);
	if (!baseResolved.some((baseDir) => isWithinDirectory(baseDir, targetResolved))) {
		throw new SparkRunWorkspaceError(
			`${label} must stay inside Spark workspace root or another Spark-controlled root (${baseResolved.join(', ')}). ` +
				`Use a relative workspace name like "${basename(targetResolved) || 'project'}", ` +
				'or set SPARK_ALLOW_EXTERNAL_PROJECT_PATHS=1 for trusted local development.'
		);
	}
	return targetResolved;
}

export function resolveContainedPath(baseDir: string, targetPath: string, label = 'Path'): string {
	return resolveContainedPathInRoots([baseDir], targetPath, label);
}

export function recheckContainedDirectoryInRoots(
	baseDirs: string[],
	targetPath: string,
	label = 'Path'
): string {
	if (!existsSync(targetPath)) {
		throw new SparkRunWorkspaceError(`${label} disappeared before use.`);
	}
	let canonicalTarget: string;
	try {
		canonicalTarget = realpathSync(targetPath);
		if (!statSync(canonicalTarget).isDirectory()) {
			throw new SparkRunWorkspaceError(`${label} must resolve to a directory.`);
		}
	} catch (error) {
		if (error instanceof SparkRunWorkspaceError) throw error;
		throw new SparkRunWorkspaceError(`${label} could not be resolved immediately before use.`);
	}
	return resolveContainedPathInRoots(baseDirs, canonicalTarget, label);
}

export function ensureContainedDirectoryInRoots(
	baseDirs: string[],
	targetPath: string,
	label = 'Path'
): string {
	const containedPath = resolveContainedPathInRoots(baseDirs, targetPath, label);
	mkdirSync(containedPath, { recursive: true });
	return recheckContainedDirectoryInRoots(baseDirs, containedPath, label);
}

export function resolveWorkspaceContainedPath(targetPath: string, label = 'Project path'): string {
	return resolveContainedPath(sparkWorkspaceRoot(), targetPath, label);
}

export function resolveSparkRunProjectPath(projectPath?: string): string {
	const requested = projectPath?.trim();
	if (requested) assertSafeLocalProjectPath(requested);
	const defaultRoot = sparkWorkspaceRoot();
	const rawPath = requested || join(defaultRoot, 'default');
	const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(defaultRoot, rawPath);

	if (externalProjectPathsAllowed()) {
		mkdirSync(absolutePath, { recursive: true });
		return realpathSync(absolutePath);
	}
	return ensureContainedDirectoryInRoots([defaultRoot], absolutePath, 'Project path');
}

export function recheckSparkRunProjectPath(projectPath: string): string {
	const requested = projectPath.trim();
	assertSafeLocalProjectPath(requested);
	if (externalProjectPathsAllowed()) {
		if (!existsSync(requested) || !statSync(requested).isDirectory()) {
			throw new SparkRunWorkspaceError('Project path disappeared before provider dispatch.');
		}
		return realpathSync(requested);
	}
	return recheckContainedDirectoryInRoots([sparkWorkspaceRoot()], requested, 'Project path');
}
