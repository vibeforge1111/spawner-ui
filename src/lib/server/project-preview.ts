import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';

export class ProjectPreviewError extends Error {
	status: 400 | 403 | 404;

	constructor(message: string, status: 400 | 403 | 404) {
		super(message);
		this.name = 'ProjectPreviewError';
		this.status = status;
	}
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,4096}$/;

function uniqueResolved(paths: string[]): string[] {
	return [...new Set(paths.map((candidate) => resolve(candidate)))];
}

function splitConfiguredRoots(value: string | undefined): string[] {
	if (!value?.trim()) return [];
	return value
		.split(delimiter)
		.flatMap((part) => part.split('\n'))
		.map((part) => part.trim())
		.filter(Boolean);
}

function normalizePublicBaseUrl(value: string | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
	return `https://${trimmed.replace(/\/+$/, '')}`;
}

function configuredPreviewOrigins(env: NodeJS.ProcessEnv): string[] {
	return [
		env.SPAWNER_PROJECT_PREVIEW_BASE_URL,
		env.SPARK_PROJECT_PREVIEW_BASE_URL,
		env.SPAWNER_UI_PUBLIC_URL,
		env.PUBLIC_SPAWNER_UI_URL,
		env.RAILWAY_PUBLIC_DOMAIN,
		env.RAILWAY_STATIC_URL
	]
		.map(normalizePublicBaseUrl)
		.filter((value): value is string => Boolean(value))
		.flatMap((value) => {
			try {
				return [new URL(value).origin];
			} catch {
				return [];
			}
		});
}

function pathIsInside(candidate: string, parent: string): boolean {
	const resolvedCandidate = resolve(candidate).toLowerCase();
	const resolvedParent = resolve(parent).toLowerCase();
	return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${sep}`);
}

export function encodeProjectPreviewToken(projectPath: string): string {
	return Buffer.from(resolve(projectPath), 'utf8').toString('base64url');
}

export function decodeProjectPreviewToken(token: string): string {
	if (!TOKEN_PATTERN.test(token)) {
		throw new ProjectPreviewError('Invalid project preview token', 400);
	}
	const decoded = Buffer.from(token, 'base64url').toString('utf8').trim();
	if (!decoded) {
		throw new ProjectPreviewError('Invalid project preview token', 400);
	}
	return resolve(decoded);
}

export function projectPreviewUrl(baseUrl: string, projectPath: string): string {
	const trimmedBase = baseUrl.replace(/\/+$/, '');
	return `${trimmedBase}/preview/${encodeProjectPreviewToken(resolveProjectPreviewRoot(projectPath))}/index.html`;
}

function shouldPreferBuiltDistIndex(projectRoot: string): boolean {
	if (!existsSync(join(projectRoot, 'package.json'))) return false;
	if (!existsSync(join(projectRoot, 'dist', 'index.html'))) return false;
	const rootIndexPath = join(projectRoot, 'index.html');
	if (!existsSync(rootIndexPath)) return true;
	try {
		const rootIndex = readFileSync(rootIndexPath, 'utf-8');
		return /<script[^>]+type=["']module["'][^>]+src=["']\/src\//i.test(rootIndex);
	} catch {
		return true;
	}
}

export function resolveProjectPreviewRoot(projectPath: string): string {
	const resolvedProjectPath = resolve(projectPath);
	// NOTE: existsSync check then use is a TOCTOU pattern in concurrent code. The file may be deleted between the check and the read. Consider using try/catch ENOENT or async fs.promises.access.
	if (!existsSync(resolvedProjectPath)) return resolvedProjectPath;

	const stat = statSync(resolvedProjectPath);
	if (stat.isFile()) return dirname(resolvedProjectPath);
	if (!stat.isDirectory()) return resolvedProjectPath;

	if (shouldPreferBuiltDistIndex(resolvedProjectPath)) return join(resolvedProjectPath, 'dist');
	if (existsSync(join(resolvedProjectPath, 'index.html'))) return resolvedProjectPath;
	const nestedIndex = findNestedIndexFolder(resolvedProjectPath);
	return nestedIndex ?? resolvedProjectPath;
}

function findNestedIndexFolder(projectRoot: string): string | null {
	const queue: Array<{ folder: string; depth: number }> = [{ folder: projectRoot, depth: 0 }];
	const matches: string[] = [];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || current.depth >= 4) continue;

		let children: string[];
		try {
			children = readdirSync(current.folder);
		} catch {
			continue;
		}

		for (const child of children) {
			if (child === 'node_modules' || child === '.git' || child === '.svelte-kit') continue;
			const childPath = join(current.folder, child);
			let childStat;
			try {
				childStat = statSync(childPath);
			} catch {
				continue;
			}
			if (!childStat.isDirectory()) continue;
			if (existsSync(join(childPath, 'index.html'))) {
				matches.push(childPath);
				continue;
			}
			queue.push({ folder: childPath, depth: current.depth + 1 });
		}
	}

	if (matches.length === 0) return null;
	matches.sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b));
	return matches[0];
}

export function getProjectPreviewAllowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
	const configured = splitConfiguredRoots(env.SPARK_PROJECT_PREVIEW_ROOTS || env.SPAWNER_PROJECT_PREVIEW_ROOTS);
	if (configured.length > 0) return uniqueResolved(configured);

	const home = homedir();
	return uniqueResolved([
		env.SPAWNER_WORKSPACE_ROOT || '',
		env.SPARK_WORKSPACE_ROOT || '',
		join(home, 'Desktop'),
		join(home, 'Documents'),
		join(home, '.spark', 'workspaces'),
		env.SPARK_HOME ? join(env.SPARK_HOME, 'workspaces') : ''
	].filter(Boolean));
}

export function assertProjectPreviewHost(url: URL, env: NodeJS.ProcessEnv = process.env): void {
	if (env.SPAWNER_PROJECT_PREVIEW_ALLOW_REMOTE === '1') return;
	const hostname = url.hostname.toLowerCase();
	if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return;
	if (configuredPreviewOrigins(env).includes(url.origin)) return;
	throw new ProjectPreviewError('Project previews are local-only by default', 403);
}

export function mimeTypeForProjectPreview(filePath: string): string {
	const extension = filePath.split('.').pop()?.toLowerCase();
	switch (extension) {
		case 'html':
		case 'htm':
			return 'text/html; charset=utf-8';
		case 'css':
			return 'text/css; charset=utf-8';
		case 'js':
		case 'mjs':
			return 'text/javascript; charset=utf-8';
		case 'json':
			return 'application/json; charset=utf-8';
		case 'svg':
			return 'image/svg+xml';
		case 'png':
			return 'image/png';
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'gif':
			return 'image/gif';
		case 'webp':
			return 'image/webp';
		case 'ico':
			return 'image/x-icon';
		case 'woff':
			return 'font/woff';
		case 'woff2':
			return 'font/woff2';
		default:
			return 'application/octet-stream';
	}
}

export function resolveProjectPreviewAsset(input: {
	token: string;
	assetPath?: string | null;
	env?: NodeJS.ProcessEnv;
}): { projectRoot: string; filePath: string; displayName: string } {
	const decodedRoot = decodeProjectPreviewToken(input.token);
	const projectRoot = resolveProjectPreviewRoot(decodedRoot);
	const allowedRoots = getProjectPreviewAllowedRoots(input.env);
	if (!allowedRoots.some((root) => pathIsInside(decodedRoot, root) && pathIsInside(projectRoot, root))) {
		throw new ProjectPreviewError('Project preview path is outside allowed roots', 403);
	}

	if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
		throw new ProjectPreviewError('Project preview folder was not found', 404);
	}

	const safeAssetPath = (input.assetPath || 'index.html').replace(/^[/\\]+/, '') || 'index.html';
	let filePath = resolve(projectRoot, safeAssetPath);
	if (!pathIsInside(filePath, projectRoot)) {
		throw new ProjectPreviewError('Project preview asset escapes the project folder', 403);
	}

	if (existsSync(filePath) && statSync(filePath).isDirectory()) {
		filePath = join(filePath, 'index.html');
	}

	if (!existsSync(filePath) || !statSync(filePath).isFile()) {
		throw new ProjectPreviewError('Project preview asset was not found', 404);
	}

	return {
		projectRoot,
		filePath,
		displayName: basename(filePath)
	};
}

export function rewriteProjectPreviewHtml(html: string, token: string): string {
	const previewBase = `/preview/${token}`;
	return html.replace(
		/\b(src|href)=("|')\/(?!\/|preview\/|#)([^"']+)\2/g,
		(_match, attr: string, quote: string, assetPath: string) =>
			`${attr}=${quote}${previewBase}/${assetPath}${quote}`
	);
}
