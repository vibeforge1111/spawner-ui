import type {
	MemoryDashboardCategory,
	MemoryDashboardFilters,
	MemoryDashboardRecord,
	MemoryDashboardStatus
} from './memory-dashboard-types';

export interface PrimaryMemoryMetric {
	id: 'memory-volume' | 'retrieval-usefulness' | 'stale-risky';
	label: string;
	value: string;
	help: string;
	delta: number;
	deltaLabel: string;
	tone: 'neutral' | 'good' | 'warning';
}

export interface CategoryDistribution {
	category: MemoryDashboardCategory;
	count: number;
	percentage: number;
}

export interface ActivityTrendBucket {
	day: string;
	touched: number;
	created: number;
}

export interface MemoryDashboardSummary {
	metrics: PrimaryMemoryMetric[];
	totalMemories: number;
	retrievalUsefulness: number;
	staleRiskyCount: number;
	categoryDistribution: CategoryDistribution[];
	activityTrend: ActivityTrendBucket[];
	insights: MemoryDashboardRecord[];
}

const STALE_AFTER_DAYS = 60;
const LOW_CONFIDENCE = 0.6;

export function defaultMemoryDashboardFilters(): MemoryDashboardFilters {
	return { category: 'all', status: 'all', timeRange: 'all' };
}

export function filterMemoryDashboardRecords(
	memories: MemoryDashboardRecord[],
	filters: MemoryDashboardFilters,
	now = new Date()
): MemoryDashboardRecord[] {
	const rangeStart = getRangeStart(filters.timeRange, now);
	return memories.filter((memory) => {
		if (filters.category !== 'all' && memory.category !== filters.category) return false;
		if (filters.status !== 'all' && memory.status !== filters.status) return false;
		if (rangeStart && new Date(memory.lastTouchedAt).getTime() < rangeStart.getTime()) return false;
		return true;
	});
}

export function summarizeMemoryDashboard(
	memories: MemoryDashboardRecord[],
	now = new Date('2026-04-30T08:00:00.000Z')
): MemoryDashboardSummary {
	const totalMemories = memories.length;
	const retrievals = memories.reduce(
		(total, memory) => ({
			total: total.total + Math.max(0, memory.retrievalCount || 0),
			useful: total.useful + Math.max(0, memory.usefulRetrievals || 0)
		}),
		{ total: 0, useful: 0 }
	);
	const retrievalUsefulness = retrievals.total === 0 ? 0 : retrievals.useful / retrievals.total;
	const staleRiskyCount = memories.filter((memory) => isStaleOrRisky(memory, now)).length;
	const volumeDelta = countCreatedInWindow(memories, now, 14) - countCreatedInPriorWindow(memories, now, 14);

	return {
		metrics: [
			{
				id: 'memory-volume',
				label: 'Memory volume',
				value: String(totalMemories),
				help: 'Records in the current slice',
				delta: volumeDelta,
				deltaLabel: formatSigned(volumeDelta, 'vs prior 14d'),
				tone: 'neutral'
			},
			{
				id: 'retrieval-usefulness',
				label: 'Retrieval usefulness',
				value: `${Math.round(retrievalUsefulness * 100)}%`,
				help: `${retrievals.useful}/${retrievals.total} useful retrievals`,
				delta: Math.round((retrievalUsefulness - 0.72) * 100),
				deltaLabel: formatSigned(Math.round((retrievalUsefulness - 0.72) * 100), 'pts vs target'),
				tone: retrievalUsefulness >= 0.75 || retrievals.total === 0 ? 'good' : 'warning'
			},
			{
				id: 'stale-risky',
				label: 'Stale or risky memories',
				value: String(staleRiskyCount),
				help: 'Review, stale, risky, or low-confidence records',
				delta: -staleRiskyCount,
				deltaLabel: staleRiskyCount === 0 ? 'clear' : `${staleRiskyCount} need action`,
				tone: staleRiskyCount === 0 ? 'good' : 'warning'
			}
		],
		totalMemories,
		retrievalUsefulness,
		staleRiskyCount,
		categoryDistribution: buildCategoryDistribution(memories),
		activityTrend: buildActivityTrend(memories, now, 14),
		insights: selectActionableInsights(memories, now)
	};
}

export function buildCategoryDistribution(memories: MemoryDashboardRecord[]): CategoryDistribution[] {
	const counts = new Map<MemoryDashboardCategory, number>();
	for (const memory of memories) {
		counts.set(memory.category, (counts.get(memory.category) || 0) + 1);
	}
	return [...counts.entries()]
		.map(([category, count]) => ({
			category,
			count,
			percentage: memories.length === 0 ? 0 : count / memories.length
		}))
		.sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

export function buildActivityTrend(
	memories: MemoryDashboardRecord[],
	now = new Date('2026-04-30T08:00:00.000Z'),
	days = 14
): ActivityTrendBucket[] {
	const buckets = new Map<string, ActivityTrendBucket>();
	for (let offset = days - 1; offset >= 0; offset -= 1) {
		const day = toDay(addDays(now, -offset));
		buckets.set(day, { day, touched: 0, created: 0 });
	}
	for (const memory of memories) {
		const touchedDay = toDay(new Date(memory.lastTouchedAt));
		const createdDay = toDay(new Date(memory.createdAt));
		const touchedBucket = buckets.get(touchedDay);
		const createdBucket = buckets.get(createdDay);
		if (touchedBucket) touchedBucket.touched += 1;
		if (createdBucket) createdBucket.created += 1;
	}
	return [...buckets.values()];
}

export function selectActionableInsights(
	memories: MemoryDashboardRecord[],
	now = new Date('2026-04-30T08:00:00.000Z'),
	limit = 6
): MemoryDashboardRecord[] {
	const priority: Record<MemoryDashboardStatus, number> = {
		risky: 0,
		stale: 1,
		'needs review': 2,
		reinforce: 3,
		healthy: 4
	};
	return [...memories]
		.filter((memory) => memory.recommendedAction !== 'keep' || isStaleOrRisky(memory, now))
		.sort((a, b) => {
			const byPriority = priority[a.status] - priority[b.status];
			if (byPriority !== 0) return byPriority;
			return touchedMs(a.lastTouchedAt) - touchedMs(b.lastTouchedAt);
		})
		.slice(0, limit);
}

function touchedMs(value: string): number {
	const ms = new Date(value).getTime();
	return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

export function isStaleOrRisky(memory: MemoryDashboardRecord, now = new Date('2026-04-30T08:00:00.000Z')): boolean {
	const ageDays = (now.getTime() - new Date(memory.lastTouchedAt).getTime()) / 86_400_000;
	return (
		memory.status === 'stale' ||
		memory.status === 'risky' ||
		memory.status === 'needs review' ||
		memory.confidence < LOW_CONFIDENCE ||
		ageDays > STALE_AFTER_DAYS
	);
}

function countCreatedInWindow(memories: MemoryDashboardRecord[], now: Date, days: number): number {
	const start = addDays(now, -days).getTime();
	return memories.filter((memory) => new Date(memory.createdAt).getTime() >= start).length;
}

function countCreatedInPriorWindow(memories: MemoryDashboardRecord[], now: Date, days: number): number {
	const currentStart = addDays(now, -days).getTime();
	const priorStart = addDays(now, -days * 2).getTime();
	return memories.filter((memory) => {
		const created = new Date(memory.createdAt).getTime();
		return created >= priorStart && created < currentStart;
	}).length;
}

function getRangeStart(range: MemoryDashboardFilters['timeRange'], now: Date): Date | null {
	if (range === 'all') return null;
	const days = Number(range.replace('d', ''));
	return addDays(now, -days);
}

function addDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + days);
	return next;
}

function toDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function formatSigned(value: number, suffix: string): string {
	if (value === 0) return `0 ${suffix}`;
	return `${value > 0 ? '+' : ''}${value} ${suffix}`;
}
