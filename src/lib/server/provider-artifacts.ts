import { safeJsonParse } from '$lib/server/safe-json';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ProviderArtifactFile {
	path: string;
	content: string;
}

export interface ProviderArtifactBundle {
	summary?: string;
	files: ProviderArtifactFile[];
	verification?: string[];
}

export function buildFilesystemArtifactPrompt(prompt: string): string {
	return [
		'API filesystem artifact contract:',
		'You are connected through an API and cannot edit the filesystem directly.',
		'Ignore any instructions below about curl, lifecycle events, event posting, or shell commands.',
		'Complete the requested implementation by returning ONLY valid JSON with this shape as your entire response:',
		'{"summary":"short summary","files":[{"path":"index.html","content":"full file contents"}],"verification":["check performed"]}',
		'Rules:',
		'- File paths must be relative to the project root.',
		'- Do not use absolute paths, parent-directory traversal, or hidden system paths.',
		'- Include every file needed to open or run the project.',
		'- For no-build static web projects, include index.html and any referenced CSS or JavaScript files.',
		'- Keep the implementation compact enough to fit in one response: no README unless asked, no giant CSS reset, no decorative canvas, no unnecessary data sets.',
		'- Prefer 3 files or fewer for simple static pages: index.html, styles.css, and script.js.',
		'- Each file should be complete but concise.',
		'- Do not wrap the JSON in markdown fences.',
		'',
		'Project brief and task context:',
		prompt
	].join('\n');
}

function stripJsonFence(value: string): string {
	const trimmed = value.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fenced) return fenced[1].trim();
	const artifactJson = extractJsonObjectContainingFiles(trimmed);
	if (artifactJson) return artifactJson;
	const firstBrace = trimmed.indexOf('{');
	const lastBrace = trimmed.lastIndexOf('}');
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return trimmed.slice(firstBrace, lastBrace + 1);
	}
	return trimmed;
}

function findMatchingBrace(value: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < value.length; index += 1) {
		const char = value[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === '{') depth += 1;
		if (char === '}') {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function extractJsonObjectContainingFiles(value: string): string | null {
	let filesIndex = value.lastIndexOf('"files"');
	while (filesIndex >= 0) {
		const start = value.lastIndexOf('{', filesIndex);
		if (start < 0) return null;
		const end = findMatchingBrace(value, start);
		if (end > start) return value.slice(start, end + 1);
		filesIndex = value.lastIndexOf('"files"', filesIndex - 1);
	}
	return null;
}

function normalizeFiles(value: unknown): ProviderArtifactFile[] {
	if (Array.isArray(value)) {
		return value
			.map((entry) => {
				if (!entry || typeof entry !== 'object') return null;
				const record = entry as Record<string, unknown>;
				const filePath = record.path ?? record.name ?? record.file;
				const content = record.content ?? record.body ?? record.text;
				return typeof filePath === 'string' && typeof content === 'string'
					? { path: filePath, content }
					: null;
			})
			.filter((entry): entry is ProviderArtifactFile => Boolean(entry));
	}

	if (value && typeof value === 'object') {
		return Object.entries(value as Record<string, unknown>)
			.map(([filePath, content]) =>
				typeof content === 'string' ? { path: filePath, content } : null
			)
			.filter((entry): entry is ProviderArtifactFile => Boolean(entry));
	}

	return [];
}

export function parseProviderArtifactBundle(response: string): ProviderArtifactBundle {
	const parsed = JSON.parse(stripJsonFence(response)) as Record<string, unknown>;
	const files = normalizeFiles(parsed.files);
	return {
		summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
		files,
		verification: Array.isArray(parsed.verification)
			? parsed.verification.filter((entry): entry is string => typeof entry === 'string')
			: undefined
	};
}

function safeRelativeArtifactPath(filePath: string): string | null {
	const normalized = path.normalize(filePath.replace(/\\/g, '/'));
	if (!normalized || normalized === '.' || path.isAbsolute(normalized)) return null;
	if (normalized.split(/[\\/]+/).includes('..')) return null;
	return normalized.replace(/\\/g, '/');
}

export async function materializeProviderArtifacts(input: {
	response: string;
	workingDirectory: string;
}): Promise<{ ok: true; files: string[]; summary?: string } | { ok: false; error: string }> {
	let bundle: ProviderArtifactBundle;
	try {
		bundle = parseProviderArtifactBundle(input.response);
	} catch {
		return {
			ok: false,
			error:
				'Provider returned text, but hosted API execution requires JSON files so Spark can write the project workspace.'
		};
	}

	const files = bundle.files
		.map((file) => ({ ...file, path: safeRelativeArtifactPath(file.path) }))
		.filter((file): file is { path: string; content: string } => Boolean(file.path));

	if (files.length === 0) {
		return {
			ok: false,
			error: 'Provider returned no writable project files for the hosted workspace.'
		};
	}

	await mkdir(input.workingDirectory, { recursive: true });
	const written: string[] = [];
	for (const file of files) {
		const target = path.resolve(input.workingDirectory, file.path);
		const root = path.resolve(input.workingDirectory);
		if (target !== root && !target.startsWith(`${root}${path.sep}`)) continue;
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, file.content, 'utf-8');
		written.push(file.path);
	}

	if (written.length === 0) {
		return {
			ok: false,
			error: 'Provider artifact paths were rejected by workspace safety checks.'
		};
	}

	return { ok: true, files: written, summary: bundle.summary };
}
