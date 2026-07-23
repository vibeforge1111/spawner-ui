import {
	MEMORY_FAILURE_MODES,
	MEMORY_OUTCOMES,
	MEMORY_SOURCES,
	type MemoryFailureMode,
	type MemoryOutcome,
	type MemoryQualityDataset,
	type MemoryRecallEvent,
	type MemorySource
} from './memory-quality-types';

export interface AccuracyBucket {
	day: string;
	hit: number;
	miss: number;
	drift: number;
	unsure: number;
	total: number;
}

export interface LatencySummary {
	p50: number;
	p95: number;
	slowest: Pick<MemoryRecallEvent, 'id' | 'timestamp' | 'query' | 'source' | 'latencyMs'> | null;
}

export interface SourceHealthRollup {
	source: MemorySource;
	status: string;
	successRate: number;
	warningCount: number;
	notes: string;
}

export type FailureModeBreakdown = Record<MemoryFailureMode, number>;

export type RecentRecallEvent = Pick<
	MemoryRecallEvent,
	'timestamp' | 'query' | 'source' | 'outcome' | 'latencyMs' | 'notes'
>;

export function buildAccuracyBuckets(events: MemoryRecallEvent[]): AccuracyBucket[] {
	const buckets = new Map<string, AccuracyBucket>();
	for (const event of events) {
		const day = toUtcDay(event.timestamp);
		const bucket = buckets.get(day) || { day, hit: 0, miss: 0, drift: 0, unsure: 0, total: 0 };
		bucket[event.outcome] += 1;
		bucket.total += 1;
		buckets.set(day, bucket);
	}
	return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function countFailureModes(events: MemoryRecallEvent[]): FailureModeBreakdown {
	const counts = Object.fromEntries(MEMORY_FAILURE_MODES.map((mode) => [mode, 0])) as FailureModeBreakdown;
	for (const event of events) {
		if (event.failureMode) counts[event.failureMode] += 1;
	}
	return counts;
}

export function summarizeLatency(events: MemoryRecallEvent[]): LatencySummary {
	if (events.length === 0) return { p50: 0, p95: 0, slowest: null };
	const latencies = events.map((event) => Math.max(0, event.latencyMs)).sort((a, b) => a - b);
	const slowestEvent = [...events].sort((a, b) => b.latencyMs - a.latencyMs)[0];
	return {
		p50: percentile(latencies, 0.5),
		p95: percentile(latencies, 0.95),
		slowest: {
			id: slowestEvent.id,
			timestamp: slowestEvent.timestamp,
			query: slowestEvent.query,
			source: slowestEvent.source,
			latencyMs: slowestEvent.latencyMs
		}
	};
}

export function rollupSourceHealth(dataset: MemoryQualityDataset): SourceHealthRollup[] {
	const bySource = new Map(dataset.sourceHealth.map((record) => [record.source, record]));
	return MEMORY_SOURCES.map((source) => {
		const record = bySource.get(source);
		return {
			source,
			status: record?.status || 'unknown',
			successRate: record?.successRate || 0,
			warningCount: record?.warningCount || 0,
			notes: record?.notes || 'No source health reported.'
		};
	});
}

export function recentRecallEvents(events: MemoryRecallEvent[], limit = 12): RecentRecallEvent[] {
	return [...events]
		.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
		.slice(0, limit)
		.map(({ timestamp, query, source, outcome, latencyMs, notes }) => ({
			timestamp,
			query,
			source,
			outcome,
			latencyMs,
			notes
		}));
}

export function outcomeTotals(events: MemoryRecallEvent[]): Record<MemoryOutcome, number> {
	const totals = Object.fromEntries(MEMORY_OUTCOMES.map((outcome) => [outcome, 0])) as Record<MemoryOutcome, number>;
	for (const event of events) totals[event.outcome] += 1;
	return totals;
}

function percentile(sortedValues: number[], percentileValue: number): number {
	if (sortedValues.length === 0) return 0;
	const index = Math.ceil(sortedValues.length * percentileValue) - 1;
	return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))];
}

function toUtcDay(timestamp: string): string {
	const date = new Date(timestamp);
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	const day = String(date.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}
