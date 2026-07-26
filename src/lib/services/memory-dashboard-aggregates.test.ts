import { describe, expect, it } from 'vitest';
import { sampleMemoryDashboardRecords } from './memory-dashboard';
import {
	buildActivityTrend,
	buildCategoryDistribution,
	defaultMemoryDashboardFilters,
	filterMemoryDashboardRecords,
	selectActionableInsights,
	summarizeMemoryDashboard
} from './memory-dashboard-aggregates';

const now = new Date('2026-04-30T08:00:00.000Z');

describe('memory dashboard aggregates', () => {
	it('calculates the three primary metrics deterministically', () => {
		const summary = summarizeMemoryDashboard(sampleMemoryDashboardRecords(), now);

		expect(summary.metrics.map((metric) => metric.id)).toEqual([
			'memory-volume',
			'retrieval-usefulness',
			'stale-risky'
		]);
		expect(summary.totalMemories).toBe(10);
		expect(summary.metrics[0].value).toBe('10');
		expect(summary.metrics[1].value).toBe('75%');
		expect(summary.metrics[2].value).toBe('3');
	});

	it('handles empty datasets without throwing or producing NaN values', () => {
		const summary = summarizeMemoryDashboard([], now);

		expect(summary.totalMemories).toBe(0);
		expect(summary.retrievalUsefulness).toBe(0);
		expect(summary.metrics[1].value).toBe('0%');
		expect(summary.categoryDistribution).toEqual([]);
		expect(summary.activityTrend).toHaveLength(14);
	});

	it('filters category, status, and time range consistently', () => {
		const filters = { ...defaultMemoryDashboardFilters(), category: 'product direction' as const, status: 'healthy' as const };
		const filtered = filterMemoryDashboardRecords(sampleMemoryDashboardRecords(), filters, now);

		expect(filtered.map((memory) => memory.id)).toEqual(['mem-sample-003', 'mem-sample-008']);
	});

	it('builds category distribution and activity trend from records', () => {
		const records = sampleMemoryDashboardRecords();
		const distribution = buildCategoryDistribution(records);
		const trend = buildActivityTrend(records, now, 7);

		expect(distribution[0]).toMatchObject({ category: 'product direction', count: 3 });
		expect(trend).toHaveLength(7);
		expect(trend.at(-1)).toMatchObject({ day: '2026-04-30', touched: 3 });
	});

	it('prioritizes risky, stale, review, and reinforcement rows for the insight list', () => {
		const insights = selectActionableInsights(sampleMemoryDashboardRecords(), now);

		expect(insights.map((memory) => memory.status)).toEqual(['risky', 'stale', 'needs review', 'reinforce']);
		expect(insights[0].recommendedAction).toBe('archive');
	});

	it('sorts malformed timestamps after valid timestamps within the same priority', () => {
		const [first, second] = sampleMemoryDashboardRecords();
		const insights = selectActionableInsights(
			[
				{ ...first, id: 'malformed-time', status: 'risky', lastTouchedAt: 'not-a-date' },
				{ ...second, id: 'valid-time', status: 'risky', lastTouchedAt: '2026-04-01T00:00:00.000Z' }
			],
			now
		);

		expect(insights.map((memory) => memory.id)).toEqual(['valid-time', 'malformed-time']);
	});
});
