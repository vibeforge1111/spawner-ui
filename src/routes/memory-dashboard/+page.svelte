<script lang="ts">
	import {
		MEMORY_DASHBOARD_CATEGORIES,
		MEMORY_DASHBOARD_STATUSES,
		type MemoryDashboardDataset,
		type MemoryDashboardFilters,
		type MemoryDashboardRecord
	} from '$lib/services/memory-dashboard';
	import {
		defaultMemoryDashboardFilters,
		filterMemoryDashboardRecords,
		summarizeMemoryDashboard,
		type MemoryDashboardSummary
	} from '$lib/services/memory-dashboard-aggregates';

	interface PageData {
		state: 'ready' | 'error';
		dataset: MemoryDashboardDataset;
		summary: MemoryDashboardSummary;
		error: string | null;
	}

	let { data } = $props<{ data: PageData }>();
	let filters = $state<MemoryDashboardFilters>(defaultMemoryDashboardFilters());
	let loading = $state(false);

	const filteredMemories = $derived(filterMemoryDashboardRecords(data.dataset.memories, filters));
	const summary = $derived(summarizeMemoryDashboard(filteredMemories));
	const maxTrend = $derived(Math.max(1, ...summary.activityTrend.map((bucket) => bucket.touched + bucket.created)));
	const maxDistribution = $derived(Math.max(1, ...summary.categoryDistribution.map((item) => item.count)));

	function setFilter<Key extends keyof MemoryDashboardFilters>(key: Key, value: MemoryDashboardFilters[Key]) {
		loading = true;
		filters = { ...filters, [key]: value };
		queueMicrotask(() => {
			loading = false;
		});
	}

	function formatDate(value: string) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
	}

	function barHeight(value: number) {
		return `${Math.max(8, Math.round((value / maxTrend) * 100))}%`;
	}

	function barWidth(value: number) {
		return `${Math.max(4, Math.round((value / maxDistribution) * 100))}%`;
	}

	function statusClass(status: MemoryDashboardRecord['status']) {
		if (status === 'healthy') return 'border-status-success/30 bg-status-success-bg text-status-success';
		if (status === 'stale' || status === 'risky') return 'border-status-error/30 bg-status-error-bg text-status-error';
		return 'border-status-warning/30 bg-status-warning-bg text-status-warning';
	}
</script>

<svelte:head>
	<title>Memory Dashboard - Spawner</title>
</svelte:head>

<main class="min-h-screen bg-bg-primary text-text-primary">
	<section class="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-4 py-4 sm:px-5">
		<header class="flex flex-wrap items-start justify-between gap-3 border-b border-surface-border pb-3">
			<div class="min-w-0">
				<p class="font-mono text-xs uppercase text-accent-primary">Memory Dashboard v1</p>
				<h1 class="mt-1 text-2xl font-semibold text-text-bright">Memory health and review queue</h1>
				<p class="mt-1 max-w-3xl text-sm text-text-secondary">
					A focused idea surface for memory volume, retrieval usefulness, and stale or risky memories.
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-2 text-xs font-mono">
				{#if data.dataset.isSampleData}
					<span data-testid="sample-data-indicator" class="border border-status-warning/40 bg-status-warning-bg px-2 py-1 text-status-warning">Sample data</span>
				{:else}
					<span class="border border-status-success/40 bg-status-success-bg px-2 py-1 text-status-success">Live data</span>
				{/if}
				<span class="border border-surface-border bg-bg-secondary px-2 py-1 text-text-secondary">{data.dataset.sourceLabel}</span>
			</div>
		</header>

		{#if data.state === 'error'}
			<section class="border border-status-error/40 bg-status-error-bg p-3 text-sm text-status-error" role="alert">
				{data.error}
			</section>
		{:else if data.dataset.warnings.length > 0}
			<section class="border border-status-warning/30 bg-status-warning-bg p-3 text-sm text-status-warning" aria-label="Memory dashboard data notice">
				{data.dataset.warnings[0]}
			</section>
		{/if}

		<section class="grid gap-3 md:grid-cols-3" aria-label="Primary memory metrics">
			{#each summary.metrics as metric}
				<article data-testid={`metric-${metric.id}`} class="min-h-[132px] border border-surface-border bg-bg-tertiary p-3">
					<div class="flex items-start justify-between gap-2">
						<h2 class="text-sm font-semibold text-text-bright">{metric.label}</h2>
						<span class={metric.tone === 'warning' ? 'text-status-warning' : metric.tone === 'good' ? 'text-status-success' : 'text-text-tertiary'}>{metric.deltaLabel}</span>
					</div>
					<p class="mt-3 text-4xl font-semibold text-text-bright">{metric.value}</p>
					<p class="mt-2 text-sm text-text-secondary">{metric.help}</p>
				</article>
			{/each}
		</section>

		<section class="border border-surface-border bg-bg-tertiary p-3" aria-label="Dashboard filters">
			<div class="grid gap-3 md:grid-cols-3">
				<label class="grid gap-1 text-sm">
					<span class="font-mono text-xs uppercase text-text-tertiary">Category</span>
					<select data-testid="category-filter" class="h-10 border border-surface-border bg-bg-primary px-2 text-text-primary" value={filters.category} onchange={(event) => setFilter('category', event.currentTarget.value as MemoryDashboardFilters['category'])}>
						<option value="all">All categories</option>
						{#each MEMORY_DASHBOARD_CATEGORIES as category}
							<option value={category}>{category}</option>
						{/each}
					</select>
				</label>
				<label class="grid gap-1 text-sm">
					<span class="font-mono text-xs uppercase text-text-tertiary">Status</span>
					<select data-testid="status-filter" class="h-10 border border-surface-border bg-bg-primary px-2 text-text-primary" value={filters.status} onchange={(event) => setFilter('status', event.currentTarget.value as MemoryDashboardFilters['status'])}>
						<option value="all">All statuses</option>
						{#each MEMORY_DASHBOARD_STATUSES as status}
							<option value={status}>{status}</option>
						{/each}
					</select>
				</label>
				<label class="grid gap-1 text-sm">
					<span class="font-mono text-xs uppercase text-text-tertiary">Time range</span>
					<select data-testid="time-filter" class="h-10 border border-surface-border bg-bg-primary px-2 text-text-primary" value={filters.timeRange} onchange={(event) => setFilter('timeRange', event.currentTarget.value as MemoryDashboardFilters['timeRange'])}>
						<option value="7d">Last 7 days</option>
						<option value="30d">Last 30 days</option>
						<option value="90d">Last 90 days</option>
						<option value="all">All time</option>
					</select>
				</label>
			</div>
		</section>

		{#if loading}
			<section class="grid min-h-[220px] place-items-center border border-surface-border bg-bg-tertiary text-sm text-text-secondary" aria-live="polite">
				Updating dashboard filters...
			</section>
		{:else if filteredMemories.length === 0}
			<section class="grid min-h-[220px] place-items-center border border-surface-border bg-bg-tertiary p-6 text-center" data-testid="empty-state">
				<div>
					<h2 class="text-lg font-semibold text-text-bright">No memories match these filters</h2>
					<p class="mt-2 text-sm text-text-secondary">Try a wider category, status, or time range to restore the dashboard slice.</p>
				</div>
			</section>
		{:else}
			<div class="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
				<section class="grid gap-4">
					<article class="border border-surface-border bg-bg-tertiary p-3" aria-label="Memory activity trend">
						<div class="mb-3 flex items-center justify-between gap-2">
							<h2 class="text-sm font-semibold text-text-bright">Activity trend</h2>
							<span class="font-mono text-xs text-text-tertiary">created + touched</span>
						</div>
						<div class="flex h-36 items-end gap-1" role="img" aria-label="Fourteen day activity trend for created and touched memories">
							{#each summary.activityTrend as bucket}
								<div class="flex min-w-0 flex-1 flex-col items-center gap-1">
									<div class="flex h-28 w-full max-w-7 items-end bg-bg-primary">
										<div class="w-full bg-accent-primary" style:height={barHeight(bucket.touched + bucket.created)} title={`${bucket.day}: ${bucket.touched + bucket.created}`}></div>
									</div>
									<span class="hidden font-mono text-[10px] text-text-tertiary sm:block">{bucket.day.slice(5)}</span>
								</div>
							{/each}
						</div>
					</article>

					<article class="border border-surface-border bg-bg-tertiary p-3" aria-label="Category distribution">
						<h2 class="mb-3 text-sm font-semibold text-text-bright">Category distribution</h2>
						<div class="space-y-2">
							{#each summary.categoryDistribution as item}
								<div class="grid grid-cols-[128px_1fr_36px] items-center gap-2 text-xs">
									<span class="truncate text-text-secondary">{item.category}</span>
									<div class="h-2 bg-bg-primary">
										<div class="h-full bg-iris" style:width={barWidth(item.count)}></div>
									</div>
									<span class="text-right font-mono text-text-tertiary">{item.count}</span>
								</div>
							{/each}
						</div>
					</article>
				</section>

				<section class="border border-surface-border bg-bg-tertiary" aria-label="Actionable memory insight list">
					<div class="border-b border-surface-border px-3 py-2">
						<h2 class="text-sm font-semibold text-text-bright">Actionable memory insights</h2>
					</div>
					<div class="divide-y divide-surface-border">
						{#if summary.insights.length === 0}
							<div class="p-4 text-sm text-text-secondary">No memories need review in this filtered slice.</div>
						{:else}
							{#each summary.insights as memory}
								<article data-testid="insight-row" class="grid gap-2 p-3 text-sm">
									<div class="flex flex-wrap items-center gap-2">
										<span class="font-mono text-xs text-accent-primary">{memory.category}</span>
										<span class={`border px-2 py-0.5 font-mono text-xs ${statusClass(memory.status)}`}>{memory.status}</span>
										<span class="font-mono text-xs text-text-tertiary">{memory.recommendedAction}</span>
									</div>
									<p class="text-text-bright">{memory.summary}</p>
									<div class="grid gap-1 text-xs text-text-secondary sm:grid-cols-[1fr_1fr_1fr]">
										<span>Last touched {formatDate(memory.lastTouchedAt)}</span>
										<span>{memory.usefulnessSignal} usefulness</span>
										<span>{Math.round(memory.confidence * 100)}% confidence</span>
									</div>
									{#if memory.riskReasons.length > 0}
										<p class="text-xs text-status-warning">{memory.riskReasons.join(' / ')}</p>
									{/if}
								</article>
							{/each}
						{/if}
					</div>
				</section>
			</div>
		{/if}

		<section class="border border-surface-border bg-bg-secondary p-3" aria-label="Metric contract">
			<h2 class="mb-2 text-sm font-semibold text-text-bright">V1 metric contract</h2>
			<div class="grid gap-2 md:grid-cols-3">
				{#each data.dataset.metricContract as metric}
					<article class="border border-surface-border bg-bg-primary p-2 text-xs text-text-secondary">
						<h3 class="font-semibold text-text-bright">{metric.label}</h3>
						<p class="mt-1">{metric.meaning}</p>
						<p class="mt-1 font-mono text-text-tertiary">{metric.calculationSource}</p>
					</article>
				{/each}
			</div>
		</section>
	</section>
</main>
