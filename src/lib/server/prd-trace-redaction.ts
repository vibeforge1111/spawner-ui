import { createHash } from 'node:crypto';
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TRACE_PATH_PATTERN = /(?:file:\/\/[^\s"',)]+|\/(?:Users|home|private\/var|var\/folders)\/[^\s"',)]+|[A-Za-z]:[\\/][^\s"',)]+|\\\\[^\s"',)]+)/g;
const INLINE_SECRET_PATTERN = /\b(?:Bearer\s+[^\s"',)]+|(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,})\b/gi;
const SENSITIVE_FIELD_PATTERN = /^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|password|secret|cookie)$/i;

export interface PrdTraceRedactionRepairResult {
	ok: boolean;
	path: string;
	backupPath: string | null;
	dryRun: boolean;
	rowsRead: number;
	rowsWritten: number;
	parseErrors: number;
	error?: 'trace_log_missing';
}

function redactedTracePathRef(value: string): string {
	return `path:sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

export function sanitizePrdTraceValue(value: unknown): unknown {
	if (typeof value === 'string') {
		return value
			.replace(INLINE_SECRET_PATTERN, '[redacted]')
			.replace(TRACE_PATH_PATTERN, (match) => redactedTracePathRef(match));
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitizePrdTraceValue(item));
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, child]) => [
				key,
				SENSITIVE_FIELD_PATTERN.test(key) ? '[redacted]' : sanitizePrdTraceValue(child)
			])
		);
	}
	return value;
}

export function sanitizePrdTraceDetails(details: Record<string, unknown>): Record<string, unknown> {
	return sanitizePrdTraceValue(details) as Record<string, unknown>;
}

export async function redactPrdAutoTraceLog(
	traceFilePath: string,
	options: { backup?: boolean; dryRun?: boolean } = {}
): Promise<PrdTraceRedactionRepairResult> {
	const backup = options.backup ?? false;
	const dryRun = options.dryRun ?? false;
	const result: PrdTraceRedactionRepairResult = {
		ok: true,
		path: traceFilePath,
		backupPath: null,
		dryRun,
		rowsRead: 0,
		rowsWritten: 0,
		parseErrors: 0
	};
	let original = '';
	try {
		original = await readFile(traceFilePath, 'utf-8');
	} catch {
		return {
			...result,
			ok: false,
			error: 'trace_log_missing'
		};
	}

	const redactedLines: string[] = [];
	for (const line of original.split(/\r?\n/)) {
		if (!line.trim()) continue;
		result.rowsRead += 1;
		try {
			redactedLines.push(JSON.stringify(sanitizePrdTraceValue(JSON.parse(line))));
		} catch {
			result.parseErrors += 1;
		}
	}
	if (result.parseErrors > 0) {
		return { ...result, ok: false };
	}

	if (!dryRun && backup) {
		const backupPath = `${traceFilePath}.raw-backup`;
		await writeFile(backupPath, original, 'utf-8');
		await chmod(backupPath, 0o600);
		result.backupPath = backupPath;
	}
	if (!dryRun) {
		const tempPath = `${traceFilePath}.redacting-${Date.now()}`;
		await writeFile(tempPath, redactedLines.length ? `${redactedLines.join('\n')}\n` : '', { encoding: 'utf-8', mode: 0o600 });
		try {
			await rename(tempPath, traceFilePath);
		} catch (error) {
			await unlink(tempPath).catch(() => undefined);
			throw error;
		}
	}
	result.rowsWritten = redactedLines.length;
	result.ok = result.parseErrors === 0;
	return {
		...result,
		path: path.resolve(traceFilePath),
		backupPath: result.backupPath ? path.resolve(result.backupPath) : null
	};
}
