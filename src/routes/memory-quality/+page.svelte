<script lang="ts">
	import {
		MEMORY_FAILURE_MODES,
		MEMORY_OUTCOMES,
		MEMORY_SOURCES,
		type MemoryQualityDataset
	} from '$lib/services/memory-quality-types';
	import {
		buildAccuracyBuckets,
		countFailureModes,
		recentRecallEvents,
		rollupSourceHealth,
		summarizeLatency,
		type AccuracyBucket,
		type FailureModeBreakdown,
		type LatencySummary,
		type RecentRecallEvent,
		type SourceHealthRollup
	} from '$lib/services/memory-quality-aggregates';
	import { parseJsonResponse } from '$lib/services/http-response';
	import { getEventsAuthHeaders } from '$lib/services/events-auth-client';

	type MemoryQualityAggregates = {
		accuracyBuckets: AccuracyBucket[];
		failureModes: FailureModeBreakdown;
		latency: LatencySummary;
		sourceHealth: SourceHealthRollup[];
		recentEvents: RecentRecallEvent[];
	};

	interface PageData {
		dataset: MemoryQualityDataset;
		aggregates: MemoryQualityAggregates;
	}

	let { data } = $props<{ data: PageData }>();

	let submittedDataset = $state<MemoryQualityDataset | null>(null);
	let submittedAggregates = $state<MemoryQualityAggregates | null>(null);
	const dataset = $derived(submittedDataset ?? data.dataset);
	const aggregates = $derived(submittedAggregates ?? data.aggregates);
	let form = $state({
		query: '',
		source: MEMORY_SOURCES[0],
		outcome: 'hit',
		latencyMs: 0,
		failureMode: '',
		notes: '',
		evaluator: 'operator'
	});
	let errors = $state<Record<string, string>>({});
	let submitting = $state(false);

	const maxAccuracyTotal = $derived(
		Math.max(1, ...aggregates.accuracyBuckets.map((bucket: AccuracyBucket) => bucket.total))
	);
	const maxFailureTotal = $derived(Math.max(1, ...Object.values(aggregates.failureModes) as number[]));

	function recompute(nextDataset: MemoryQualityDataset) {
		submittedDataset = nextDataset;
		submittedAggregates = {
			accuracyBuckets: buildAccuracyBuckets(nextDataset.events),
			failureModes: countFailureModes(nextDataset.events),
			latency: summarizeLatency(nextDataset.events),
			sourceHealth: rollupSourceHealth(nextDataset),
			recentEvents: recentRecallEvents(nextDataset.events)
		};
	}

	async function submitEvaluation() {
		submitting = true;
		errors = {};
		try {
			const response = await fetch('/api/memory-quality/evaluations', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...getEventsAuthHeaders() },
				body: JSON.stringify(form)
			});
			const body = await parseJsonResponse<{
				errors?: Record<string, string>;
				dataset?: MemoryQualityDataset;
			} | null>(response, null);
			if (!response.ok || !body) {
				errors = body?.errors || { form: `Evaluation could not be saved (HTTP ${response.status}).` };
				if (body?.dataset) recompute(body.dataset);
				return;
			}
			if (!body.dataset) {
				errors = { form: 'Evaluation response missing dataset.' };
				return;
			}
			recompute(body.dataset);
			form.query = '';
			form.notes = '';
			form.latencyMs = 0;
			form.failureMode = '';
		} catch (error) {
			errors = { form: error instanceof Error ? error.message : 'Evaluation could not be saved.' };
		} finally {
			submitting = false;
		}
	}

	function pct(value: number, max: number) {
		return `${Math.max(4, Math.round((value / max) * 100))}%`;
	}

	function formatTime(timestamp: string) {
		return new Date(timestamp).toLocaleString();
	}
</script>

<svelte:head>
	<title>Memory Quality - Spawner</title>
</svelte:head>

<main class="min-h-screen bg-bg-primary text-text-primary">
	<section class="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-5 py-5">
		<header class="flex flex-wrap items-start justify-between gap-3 border-b border-surface-border pb-3">
			<div>
				<p class="font-mono text-xs uppercase text-accent-primary">Spark Memory Quality</p>
				<h1 class="mt-1 text-2xl font-semibold text-text-bright">Live recall trust monitor</h1>
			</div>
			<div class="flex flex-wrap items-center gap-2 text-xs font-mono">
				{#if dataset.isSampleData}
					<span class="border border-status-warning/40 bg-status-warning-bg px-2 py-1 text-status-warning">Sample data</span>
				{:else}
					<span class="border border-status-success/40 bg-status-success-bg px-2 py-1 text-status-success">Live metrics</span>
				{/if}
				<span class="border border-surface-border bg-bg-secondary px-2 py-1 text-text-secondary">Generated {formatTime(dataset.generatedAt)}</span>
			</div>
		</header>

		<div class="grid gap-3 xl:grid-cols-[1.1fr_0.9fr_0.8fr_1fr]">
			<section class="panel p-3" aria-label="Accuracy over time">
				<div class="mb-3 flex items-center justify-between">
					<h2 class="text-sm font-semibold">Accuracy over time</h2>
					<span class="font-mono text-xs text-text-tertiary">{dataset.events.length} recalls</span>
				</div>
				<div class="space-y-2">
					{#each aggregates.accuracyBuckets as bucket}
						<div class="grid grid-cols-[86px_1fr_42px] items-center gap-2 text-xs">
							<span class="font-mono text-text-secondary">{bucket.day}</span>
							<div class="flex h-5 overflow-hidden rounded-sm bg-bg-primary">
								<div class="bg-status-success" style:width={pct(bucket.hit, maxAccuracyTotal)} title={`hit ${bucket.hit}`}></div>
								<div class="bg-status-error" style:width={pct(bucket.miss, maxAccuracyTotal)} title={`miss ${bucket.miss}`}></div>
								<div class="bg-status-warning" style:width={pct(bucket.drift, maxAccuracyTotal)} title={`drift ${bucket.drift}`}></div>
								<div class="bg-iris" style:width={pct(bucket.unsure, maxAccuracyTotal)} title={`unsure ${bucket.unsure}`}></div>
							</div>
							<span class="text-right font-mono text-text-tertiary">{bucket.total}</span>
						</div>
					{/each}
				</div>
				<div class="mt-3 flex flex-wrap gap-2 text-[11px] text-text-tertiary">
					<span class="text-status-success">hit</span>
					<span class="text-status-error">miss</span>
					<span class="text-status-warning">drift</span>
					<span class="text-iris">unsure</span>
				</div>
			</section>

			<section class="panel p-3" aria-label="Failure modes">
				<h2 class="mb-3 text-sm font-semibold">Failure modes</h2>
				<div class="space-y-2">
					{#each MEMORY_FAILURE_MODES as mode}
						<div class="grid grid-cols-[116px_1fr_28px] items-center gap-2 text-xs">
							<span class="truncate text-text-secondary">{mode}</span>
							<div class="h-2 rounded-sm bg-bg-primary">
								<div class="h-full rounded-sm bg-status-error" style:width={pct(aggregates.failureModes[mode], maxFailureTotal)}></div>
							</div>
							<span class="text-right font-mono">{aggregates.failureModes[mode]}</span>
						</div>
					{/each}
				</div>
			</section>

			<section class="panel p-3" aria-label="Latency metrics">
				<h2 class="mb-3 text-sm font-semibold">Latency metrics</h2>
				<div class="grid grid-cols-2 gap-2">
					<div class="bg-bg-primary p-2">
						<p class="font-mono text-xs text-text-tertiary">p50</p>
						<p class="text-xl font-semibold">{aggregates.latency.p50}ms</p>
					</div>
					<div class="bg-bg-primary p-2">
						<p class="font-mono text-xs text-text-tertiary">p95</p>
						<p class="text-xl font-semibold">{aggregates.latency.p95}ms</p>
					</div>
				</div>
				<div class="mt-2 bg-bg-primary p-2">
					<p class="font-mono text-xs text-text-tertiary">slowest recent recall</p>
					<p class="mt-1 text-sm">{aggregates.latency.slowest?.latencyMs ?? 0}ms</p>
					<p class="mt-1 line-clamp-2 text-xs text-text-secondary">{aggregates.latency.slowest?.query ?? 'No recall events yet.'}</p>
				</div>
			</section>

			<section class="panel p-3" aria-label="Source health">
				<h2 class="mb-3 text-sm font-semibold">Source health</h2>
				<div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
					{#each aggregates.sourceHealth as health}
						<div class="grid grid-cols-[1fr_auto] gap-2 border border-surface-border bg-bg-primary p-2 text-xs">
							<div>
								<p class="font-medium text-text-bright">{health.source}</p>
								<p class="text-text-tertiary">{Math.round(health.successRate * 100)}% success · {health.warningCount} warnings</p>
							</div>
							<span class={health.status === 'healthy' ? 'badge-success' : health.status === 'degraded' ? 'badge-warning' : health.status === 'offline' ? 'badge-error' : 'badge-info'}>{health.status}</span>
						</div>
					{/each}
				</div>
			</section>
		</div>

		<div class="grid gap-4 lg:grid-cols-[1fr_360px]">
			<section class="panel overflow-hidden" aria-label="Recent recall events">
				<div class="border-b border-surface-border px-3 py-2">
					<h2 class="text-sm font-semibold">Recent recall events</h2>
				</div>
				<div class="overflow-x-auto">
					<table class="w-full min-w-[840px] text-left text-xs">
						<thead class="bg-bg-secondary text-text-tertiary">
							<tr>
								<th class="px-3 py-2 font-mono">Timestamp</th>
								<th class="px-3 py-2 font-mono">Query</th>
								<th class="px-3 py-2 font-mono">Source</th>
								<th class="px-3 py-2 font-mono">Outcome</th>
								<th class="px-3 py-2 text-right font-mono">Latency</th>
								<th class="px-3 py-2 font-mono">Notes</th>
							</tr>
						</thead>
						<tbody>
							{#each aggregates.recentEvents as event}
								<tr class="border-t border-surface-border">
									<td class="whitespace-nowrap px-3 py-2 font-mono text-text-tertiary">{formatTime(event.timestamp)}</td>
									<td class="max-w-[260px] px-3 py-2 text-text-bright">{event.query}</td>
									<td class="px-3 py-2 text-text-secondary">{event.source}</td>
									<td class="px-3 py-2"><span class="badge-info">{event.outcome}</span></td>
									<td class="px-3 py-2 text-right font-mono">{event.latencyMs}ms</td>
									<td class="max-w-[280px] px-3 py-2 text-text-secondary">{event.notes}</td>
								</tr>
							{:else}
								<tr class="border-t border-surface-border">
									<td colspan="6" class="px-3 py-6 text-center text-text-secondary">
										No recall events recorded yet. Use the Manual evaluation panel below to log the first one.
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>

			<section class="panel p-3" aria-label="Manual evaluation panel">
				<h2 class="text-sm font-semibold">Manual evaluation</h2>
				{#if errors.form}
					<p class="mt-2 border border-status-error/40 bg-status-error-bg px-2 py-1 text-xs text-status-error">{errors.form}</p>
				{/if}
				<form class="mt-3 space-y-3" onsubmit={(event) => { event.preventDefault(); submitEvaluation(); }}>
					<label class="block text-xs text-text-secondary">
						Query
						<input class="input mt-1 text-sm" bind:value={form.query} />
						{#if errors.query}<span class="mt-1 block text-status-error">{errors.query}</span>{/if}
					</label>

					<label class="block text-xs text-text-secondary">
						Source
						<select class="input mt-1 text-sm" bind:value={form.source}>
							{#each MEMORY_SOURCES as source}
								<option value={source}>{source}</option>
							{/each}
						</select>
						{#if errors.source}<span class="mt-1 block text-status-error">{errors.source}</span>{/if}
					</label>

					<div class="grid grid-cols-2 gap-2">
						<label class="block text-xs text-text-secondary">
							Outcome
							<select class="input mt-1 text-sm" bind:value={form.outcome}>
								{#each MEMORY_OUTCOMES as outcome}
									<option value={outcome}>{outcome}</option>
								{/each}
							</select>
							{#if errors.outcome}<span class="mt-1 block text-status-error">{errors.outcome}</span>{/if}
						</label>
						<label class="block text-xs text-text-secondary">
							Latency
							<input class="input mt-1 text-sm" type="number" min="0" bind:value={form.latencyMs} />
							{#if errors.latencyMs}<span class="mt-1 block text-status-error">{errors.latencyMs}</span>{/if}
						</label>
					</div>

					<label class="block text-xs text-text-secondary">
						Failure mode
						<select class="input mt-1 text-sm" bind:value={form.failureMode}>
							<option value="">none</option>
							{#each MEMORY_FAILURE_MODES as mode}
								<option value={mode}>{mode}</option>
							{/each}
						</select>
						{#if errors.failureMode}<span class="mt-1 block text-status-error">{errors.failureMode}</span>{/if}
					</label>

					<label class="block text-xs text-text-secondary">
						Notes
						<textarea class="input mt-1 min-h-20 text-sm" bind:value={form.notes}></textarea>
					</label>

					<button class="btn-primary btn-sm w-full" type="submit" disabled={submitting}>
						{submitting ? 'Saving...' : 'Record evaluation'}
					</button>
				</form>
			</section>
		</div>

		{#if dataset.warnings.length > 0}
			<section class="panel p-3" aria-label="Source warnings">
				<h2 class="text-sm font-semibold">Source warnings</h2>
				<ul class="mt-2 space-y-1 text-xs text-text-secondary">
					{#each dataset.warnings as warning}
						<li><span class="font-mono text-status-warning">{warning.source}</span>: {warning.message}</li>
					{/each}
				</ul>
			</section>
		{/if}
	</section>
</main>
