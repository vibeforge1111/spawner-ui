import { describe, expect, it } from 'vitest';
import {
	buildAccuracyBuckets,
	countFailureModes,
	recentRecallEvents,
	rollupSourceHealth,
	summarizeLatency
} from './memory-quality-aggregates';
import { MEMORY_FAILURE_MODES, type MemoryQualityDataset, type MemoryRecallEvent } from './memory-quality';

const events: MemoryRecallEvent[] = [
	{ id: '1', timestamp: '2026-04-28T08:00:00Z', query: 'a', source: 'domain-chip-memory', outcome: 'hit', latencyMs: 100, failureMode: null, notes: 'a' },
	{ id: '2', timestamp: '2026-04-28T09:00:00Z', query: 'b', source: 'domain-chip-memory', outcome: 'miss', latencyMs: 500, failureMode: 'omission', notes: 'b' },
	{ id: '3', timestamp: '2026-04-27T09:00:00Z', query: 'c', source: 'current-state injection', outcome: 'drift', latencyMs: 900, failureMode: 'drift', notes: 'c' },
	{ id: '4', timestamp: '2026-04-27T10:00:00Z', query: 'd', source: 'structured evidence retrieval', outcome: 'unsure', latencyMs: 1200, failureMode: 'source unavailable', notes: 'd' }
];

describe('memory quality aggregates', () => {
	it('groups accuracy buckets by UTC day and outcome', () => {
		const buckets = buildAccuracyBuckets(events);
		expect(buckets).toHaveLength(2);
		expect(buckets[1]).toMatchObject({ day: '2026-04-28', hit: 1, miss: 1, drift: 0, unsure: 0 });
	});

	it('uses the timestamp UTC day regardless of its explicit offset', () => {
		const offsetEvent: MemoryRecallEvent = {
			...events[0],
			id: 'offset',
			timestamp: '2026-04-28T23:30:00-02:00'
		};
		expect(buildAccuracyBuckets([offsetEvent])).toEqual([
			expect.objectContaining({ day: '2026-04-29', hit: 1, total: 1 })
		]);
	});

	it('counts every failure mode with zeros for absent modes', () => {
		const counts = countFailureModes(events);
		expect(Object.keys(counts)).toEqual([...MEMORY_FAILURE_MODES]);
		expect(counts.omission).toBe(1);
		expect(counts.confabulation).toBe(0);
	});

	it('summarizes latency including empty datasets', () => {
		expect(summarizeLatency([])).toEqual({ p50: 0, p95: 0, slowest: null });
		expect(summarizeLatency(events)).toMatchObject({
			p50: 500,
			p95: 1200,
			slowest: { id: '4', latencyMs: 1200 }
		});
	});

	it('keeps the first event when the slowest latency is tied', () => {
		const tied = [
			{ ...events[0], id: 'first-slowest', latencyMs: 1200 },
			{ ...events[1], id: 'second-slowest', latencyMs: 1200 }
		];

		expect(summarizeLatency(tied).slowest?.id).toBe('first-slowest');
	});

	it('sorts recent events newest first with table-ready fields', () => {
		const recent = recentRecallEvents(events, 2);
		expect(recent).toEqual([
			expect.objectContaining({ query: 'b', source: 'domain-chip-memory', outcome: 'miss', latencyMs: 500, notes: 'b' }),
			expect.objectContaining({ query: 'a' })
		]);
	});

	it('places malformed recall timestamps after finite timestamps', () => {
		const malformed = { ...events[0], id: 'malformed', timestamp: 'not-a-date', query: 'bad timestamp' };
		const recent = recentRecallEvents([malformed, events[1]], 2);
		expect(recent.map((event) => event.query)).toEqual(['b', 'bad timestamp']);
	});

	it('rolls source health for all monitored sources', () => {
		const dataset: MemoryQualityDataset = {
			events,
			sourceHealth: [{ source: 'domain-chip-memory', status: 'healthy', lastSeenAt: null, successRate: 1, warningCount: 0, notes: 'ok' }],
			generatedAt: '2026-04-28T00:00:00Z',
			isSampleData: false,
			warnings: []
		};
		expect(rollupSourceHealth(dataset)).toHaveLength(4);
		expect(rollupSourceHealth(dataset)[0].status).toBe('healthy');
	});
});
