import { existsSync } from 'fs';
import { mkdir, readFile } from 'fs/promises';
import path from 'path';
import { spawnerStateDir } from '$lib/server/spawner-state';
import { tryParseJson } from '$lib/utils/safe-json';
import {
	MEMORY_FAILURE_MODES,
	MEMORY_OUTCOMES,
	MEMORY_SOURCES,
	SOURCE_STATUSES,
	type MemoryFailureMode,
	type MemoryOutcome,
	type MemoryQualityDataset,
	type MemoryRecallEvent,
	type MemorySource,
	type MemorySourceHealth,
	type MemorySourceWarning,
	type SourceStatus
} from './memory-quality-types';

export {
	MEMORY_FAILURE_MODES,
	MEMORY_OUTCOMES,
	MEMORY_SOURCES,
	SOURCE_STATUSES,
	type MemoryFailureMode,
	type MemoryOutcome,
	type MemoryQualityDataset,
	type MemoryRecallEvent,
	type MemorySource,
	type MemorySourceHealth,
	type MemorySourceWarning,
	type SourceStatus
};

export interface MemoryQualityPaths {
	baseDir: string;
	recallEventsFile: string;
	sourceHealthFile: string;
	evaluationsFile: string;
}

const SAMPLE_NOW = '2026-04-28T08:00:00.000Z';

export function getMemoryQualityPaths(): MemoryQualityPaths {
	const baseDir = process.env.SPARK_MEMORY_QUALITY_DIR || path.join(spawnerStateDir(), 'memory-quality');
	return {
		baseDir,
		recallEventsFile: process.env.MEMORY_QUALITY_RECALL_EVENTS_FILE || path.join(baseDir, 'recall-events.json'),
		sourceHealthFile: process.env.MEMORY_QUALITY_SOURCE_HEALTH_FILE || path.join(baseDir, 'source-health.json'),
		evaluationsFile: process.env.MEMORY_QUALITY_EVALUATIONS_FILE || path.join(baseDir, 'evaluations.json')
	};
}

export async function ensureMemoryQualityDir(paths = getMemoryQualityPaths()): Promise<void> {
	await mkdir(path.dirname(paths.evaluationsFile), { recursive: true });
}

export async function loadMemoryQualityDataset(paths = getMemoryQualityPaths()): Promise<MemoryQualityDataset> {
	const warnings: MemorySourceWarning[] = [];
	const liveEvents = await readJsonFile(paths.recallEventsFile, 'recall events', warnings);
	const liveHealth = await readJsonFile(paths.sourceHealthFile, 'source health', warnings);
	const evaluations = await readJsonFile(paths.evaluationsFile, 'manual evaluations', warnings, true);

	const normalizedLiveEvents = extractEvents(liveEvents);
	const normalizedEvaluations = extractEvents(evaluations).map((event) => ({ ...event, manual: true }));
	const hasLiveEvents = normalizedLiveEvents.length > 0;
	const events = [
		...normalizedEvaluations,
		...(hasLiveEvents ? normalizedLiveEvents : sampleEvents())
	];

	const health = normalizeSourceHealth(extractSourceHealth(liveHealth), hasLiveEvents);

	return {
		events,
		sourceHealth: health,
		generatedAt: new Date().toISOString(),
		isSampleData: !hasLiveEvents,
		warnings
	};
}

async function readJsonFile(
	filePath: string,
	source: string,
	warnings: MemorySourceWarning[],
	optional = false
): Promise<unknown> {
	if (!existsSync(filePath)) {
		// NOTE: existsSync check then use is a TOCTOU pattern in concurrent code. The file may be deleted between the check and the read. Consider using try/catch ENOENT or async fs.promises.access.
		if (!optional) {
			warnings.push({ source, path: filePath, message: 'Metric file is missing; sample data is in use.' });
		}
		return null;
	}

	try {
		const parsed = tryParseJson<unknown | null>(await readFile(filePath, 'utf-8'), null, `memory-quality:${source}`);
		if (!parsed.ok) {
			warnings.push({
				source,
				path: filePath,
				message: parsed.error instanceof Error ? parsed.error.message : 'Metric file contains invalid JSON.'
			});
		}
		return parsed.value;
	} catch (error) {
		warnings.push({
			source,
			path: filePath,
			message: error instanceof Error ? error.message : 'Metric file could not be read.'
		});
		return null;
	}
}

function extractEvents(input: unknown): MemoryRecallEvent[] {
	if (Array.isArray(input)) return input.map(normalizeEvent).filter(isDefined);
	if (isRecord(input) && Array.isArray(input.events)) {
		return input.events.map(normalizeEvent).filter(isDefined);
	}
	return [];
}

function extractSourceHealth(input: unknown): MemorySourceHealth[] {
	if (Array.isArray(input)) return input.map(normalizeHealth).filter(isDefined);
	if (isRecord(input) && Array.isArray(input.sourceHealth)) {
		return input.sourceHealth.map(normalizeHealth).filter(isDefined);
	}
	return [];
}

function normalizeEvent(input: unknown): MemoryRecallEvent | null {
	if (!isRecord(input)) return null;
	const source = normalizeSource(input.source);
	const outcome = normalizeOutcome(input.outcome);
	if (!source || !outcome || typeof input.query !== 'string') return null;

	return {
		id: stringOr(input.id, `recall-${hashParts(input.timestamp, input.query, input.source)}`),
		timestamp: normalizeTimestamp(input.timestamp),
		query: input.query,
		source,
		outcome,
		latencyMs: numberOr(input.latencyMs, input.latency, 0),
		failureMode: normalizeFailureMode(input.failureMode),
		notes: stringOr(input.notes, ''),
		evaluator: typeof input.evaluator === 'string' ? input.evaluator : undefined,
		manual: input.manual === true
	};
}

function normalizeHealth(input: unknown): MemorySourceHealth | null {
	if (!isRecord(input)) return null;
	const source = normalizeSource(input.source);
	if (!source) return null;
	return {
		source,
		status: normalizeStatus(input.status),
		lastSeenAt: input.lastSeenAt === null ? null : normalizeTimestamp(input.lastSeenAt),
		successRate: clamp(numberOr(input.successRate, input.recallAccuracy, 0), 0, 1),
		warningCount: Math.max(0, Math.round(numberOr(input.warningCount, input.warnings, 0))),
		notes: stringOr(input.notes, '')
	};
}

function normalizeSourceHealth(records: MemorySourceHealth[], hasLiveEvents: boolean): MemorySourceHealth[] {
	const bySource = new Map(records.map((record) => [record.source, record]));
	return MEMORY_SOURCES.map((source) => {
		const record = bySource.get(source);
		if (record) return record;
		return sampleHealth(hasLiveEvents).find((sample) => sample.source === source) as MemorySourceHealth;
	});
}

function sampleEvents(): MemoryRecallEvent[] {
	return [
		{
			id: 'sample-001',
			timestamp: '2026-04-28T07:45:00.000Z',
			query: 'What did the user decide about promoting creator dossiers?',
			source: 'domain-chip-memory',
			outcome: 'hit',
			latencyMs: 148,
			failureMode: null,
			notes: 'Matched the saved promotion boundary and recent creator research packet.'
		},
		{
			id: 'sample-002',
			timestamp: '2026-04-28T07:20:00.000Z',
			query: 'Recall the Telegram handoff around live mission failures.',
			source: 'Telegram conversation memory',
			outcome: 'miss',
			latencyMs: 432,
			failureMode: 'omission',
			notes: 'Did not retrieve the most recent operator instruction.'
		},
		{
			id: 'sample-003',
			timestamp: '2026-04-27T18:12:00.000Z',
			query: 'Summarize current-state constraints for content memory.',
			source: 'current-state injection',
			outcome: 'drift',
			latencyMs: 286,
			failureMode: 'stale recall',
			notes: 'Pulled an older boundary and missed the latest sample-data rule.'
		},
		{
			id: 'sample-004',
			timestamp: '2026-04-27T10:04:00.000Z',
			query: 'Find evidence for the outcome scoring rule.',
			source: 'structured evidence retrieval',
			outcome: 'unsure',
			latencyMs: 795,
			failureMode: 'source unavailable',
			notes: 'Evidence index was unavailable during the probe.'
		},
		{
			id: 'sample-005',
			timestamp: '2026-04-26T16:33:00.000Z',
			query: 'Recover the internal name for manual promotion checks.',
			source: 'domain-chip-memory',
			outcome: 'miss',
			latencyMs: 1210,
			failureMode: 'confabulation',
			notes: 'Returned a plausible but unsupported label.'
		}
	];
}

function sampleHealth(hasLiveEvents: boolean): MemorySourceHealth[] {
	const status: SourceStatus = hasLiveEvents ? 'unknown' : 'degraded';
	return MEMORY_SOURCES.map((source, index) => ({
		source,
		status,
		lastSeenAt: hasLiveEvents ? null : SAMPLE_NOW,
		successRate: hasLiveEvents ? 0 : [0.92, 0.74, 0.81, 0.68][index],
		warningCount: hasLiveEvents ? 0 : [0, 2, 1, 3][index],
		notes: hasLiveEvents ? 'No source health file provided.' : 'Sample health record; connect live metrics to replace.'
	}));
}

function normalizeSource(input: unknown): MemorySource | null {
	return MEMORY_SOURCES.find((source) => source === input) || null;
}

function normalizeOutcome(input: unknown): MemoryOutcome | null {
	return MEMORY_OUTCOMES.find((outcome) => outcome === input) || null;
}

function normalizeFailureMode(input: unknown): MemoryFailureMode | null {
	return MEMORY_FAILURE_MODES.find((mode) => mode === input) || null;
}

function normalizeStatus(input: unknown): SourceStatus {
	return SOURCE_STATUSES.find((status) => status === input) || 'unknown';
}

function normalizeTimestamp(input: unknown): string {
	const value = typeof input === 'string' || typeof input === 'number' ? new Date(input) : new Date();
	return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
}

function numberOr(...values: unknown[]): number {
	for (const value of values) {
		const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}

function stringOr(input: unknown, fallback: string): string {
	return typeof input === 'string' && input.trim() ? input : fallback;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === 'object' && input !== null;
}

function isDefined<T>(input: T | null | undefined): input is T {
	return input !== null && input !== undefined;
}

function hashParts(...parts: unknown[]): string {
	let hash = 0;
	for (const char of parts.join('|')) {
		hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	}
	return hash.toString(16);
}
