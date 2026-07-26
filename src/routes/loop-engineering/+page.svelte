<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import Navbar from '$lib/components/Navbar.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import {
		GateBadge,
		LoopHelp,
		MetricTile,
		StatusBadge
	} from '$lib/components/loop-engineering';
	import {
		LOOP_ENGINEERING_AUTO_REFRESH_MS,
		shouldAutoRefreshLoopEngineering
	} from '$lib/loop-engineering/client-actions';
	import {
		formatLoopEngineeringList,
		formatLoopEngineeringSentence,
		formatLoopEngineeringToken
	} from '$lib/loop-engineering/display';
	import type {
		LoopEngineeringEvent,
		LoopEngineeringRegistry,
		LoopEngineeringChipSummary
	} from '$lib/server/loop-engineering-registry';

	let { data }: { data: { registry: LoopEngineeringRegistry } } = $props();
	const registry = $derived(data.registry);
	let autoRefreshEnabled = $state(true);
	let refreshLoading = $state(false);
	let lastRefreshAt = $state<Date | null>(null);
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let showAllChips = $state(false);
	const needsAttention = $derived(
		registry.chips.filter((chip) => chip.status === 'blocked' || chip.blockers.length > 0 || !chip.benchmark.blindVerified)
	);
	const visibleChips = $derived(showAllChips ? registry.chips : registry.chips.slice(0, 8));
	const hiddenChipCount = $derived(Math.max(registry.chips.length - visibleChips.length, 0));

	const pathSteps = [
		{
			label: 'Define',
			help: 'Name the domain workflow and the situations where this chip should help.'
		},
		{
			label: 'Benchmark',
			help: 'Add visible, held-out, trap, no-op, or regression cases that judge useful behavior.'
		},
		{
			label: 'Improve',
			help: 'Run private loops against selected cases and keep generator output separate from evaluator scoring.'
		},
		{
			label: 'Review',
			help: 'Accept only separated evaluator evidence before distilling lessons or claiming improvement.'
		},
		{
			label: 'Activate',
			help: 'Stage a scoped use case with rollback and approval. Nothing is globally activated from this board.'
		}
	];

	function formatScore(value: number | null) {
		return typeof value === 'number' ? value.toFixed(1) : 'n/a';
	}

	function formatDelta(value: number | null) {
		if (typeof value !== 'number') return 'n/a';
		return value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
	}

	function deltaTone(value: number | null): 'default' | 'success' | 'warning' | 'error' {
		if (typeof value !== 'number') return 'default';
		if (value > 0) return 'success';
		if (value < 0) return 'error';
		return 'warning';
	}

	function evaluatorLabel(event: LoopEngineeringEvent) {
		if (!event.evaluatorSeparated) return 'needs review';
		if (event.status === 'queued' || event.status === 'running') return 'review pending';
		return 'reviewed';
	}

	function eventStatusHelp(event: LoopEngineeringEvent) {
		if (event.evaluatorSeparated) return 'This event has separated evaluator handling in the ledger.';
		return 'This record is provenance or staging only; it is not evaluator proof of improvement.';
	}

	function evidenceRefSummary(refs: string[]) {
		if (refs.length === 0) return '';
		return refs.length === 1 ? '1 evidence ref' : `${refs.length} evidence refs`;
	}

	function chipBoundary(chip: LoopEngineeringChipSummary) {
		if (chip.status === 'local_fast_path') return 'usable locally';
		if (chip.status === 'blocked') return 'needs proof';
		if (chip.status === 'private_candidate' || chip.status === 'loop_proven_private') return 'private candidate';
		return 'private only';
	}

	function formatRefreshTime(value: Date | null) {
		if (!value) return 'waiting for first check';
		return value.toLocaleTimeString([], {
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	async function refreshLoopEngineeringRegistry(source: 'auto' | 'manual' = 'auto') {
		if (!shouldAutoRefreshLoopEngineering({
			autoRefresh: source === 'manual' ? true : autoRefreshEnabled,
			documentVisible: typeof document === 'undefined' ? true : document.visibilityState === 'visible',
			refreshing: refreshLoading
		})) {
			return;
		}
		refreshLoading = true;
		try {
			await invalidateAll();
			lastRefreshAt = new Date();
		} finally {
			refreshLoading = false;
		}
	}

	function startAutoRefresh() {
		if (refreshTimer) return;
		refreshTimer = setInterval(() => {
			void refreshLoopEngineeringRegistry('auto');
		}, LOOP_ENGINEERING_AUTO_REFRESH_MS);
	}

	function stopAutoRefresh() {
		if (!refreshTimer) return;
		clearInterval(refreshTimer);
		refreshTimer = null;
	}

	onMount(() => {
		lastRefreshAt = new Date();
		startAutoRefresh();
	});

	onDestroy(() => {
		stopAutoRefresh();
	});
</script>

<svelte:head>
	<title>Loop Engineering · spawner</title>
</svelte:head>

<div class="flex min-h-screen flex-col bg-bg-primary text-text-primary">
	<Navbar />

	<main class="mx-auto flex w-full max-w-[180rem] flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
		<header class="grid gap-4 border-b border-surface-border pb-5 xl:grid-cols-[1fr_auto] xl:items-end">
			<div class="min-w-0">
				<p class="overline">Loop engineering</p>
				<h1 class="text-2xl font-semibold tracking-tight text-text-bright sm:text-3xl">Domain Chip control plane</h1>
				<p class="mt-2 max-w-4xl text-sm leading-6 text-text-secondary">
					Inspect chips, review private checks and staged improvements, and keep the proof trail in Spawner. Fresh Governor-approved Telegram or server actions remain the execution lane.
				</p>
				<div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
					<span class="inline-flex items-center gap-2 border border-surface-border bg-bg-secondary px-2 py-1 font-mono text-text-tertiary">
						<span>{autoRefreshEnabled ? 'Live refresh on' : 'Live refresh paused'}</span>
						<span>checked {formatRefreshTime(lastRefreshAt)}</span>
						<LoopHelp text="The registry refreshes while this tab is visible so Telegram-triggered chips, loop runs, and scheduled-loop results appear without a manual reload. Refreshing reads state only." />
					</span>
					<button
						type="button"
						class="inline-flex items-center gap-1 border border-surface-border bg-bg-secondary px-2 py-1 font-mono text-[11px] text-text-tertiary transition-colors hover:border-accent-primary/40 hover:text-text-primary disabled:opacity-60"
						disabled={refreshLoading}
						onclick={() => {
							autoRefreshEnabled = !autoRefreshEnabled;
							if (autoRefreshEnabled) void refreshLoopEngineeringRegistry('manual');
						}}
					>
						<Icon name={autoRefreshEnabled ? 'pause' : 'refresh-cw'} size={12} />
						{autoRefreshEnabled ? 'Pause' : 'Resume'}
					</button>
					<button
						type="button"
						class="inline-flex items-center gap-1 border border-surface-border bg-bg-secondary px-2 py-1 font-mono text-[11px] text-text-tertiary transition-colors hover:border-accent-primary/40 hover:text-text-primary disabled:opacity-60"
						disabled={refreshLoading}
						onclick={() => refreshLoopEngineeringRegistry('manual')}
					>
						<Icon name="refresh-cw" size={12} />
						{refreshLoading ? 'Refreshing' : 'Refresh'}
					</button>
				</div>
			</div>
			<div class="grid w-full grid-cols-2 gap-2 sm:grid-cols-4 xl:w-[38rem]">
				<MetricTile label="chips" value={registry.summary.total} help="Domain Chips discovered in the configured local chip root." />
				<MetricTile label="need review" value={registry.summary.blocked} tone={registry.summary.blocked > 0 ? 'warning' : 'success'} help="Chips with a blocker or missing proof before broader use." />
				<MetricTile label="benchmarked" value={registry.summary.benchmarkPasses} tone="success" help="Chips with benchmark evidence that currently passes local checks." />
				<MetricTile label="ready locally" value={registry.summary.localFastPaths} help="Chips with local fast-path support. They stay private unless activation is approved." />
			</div>
		</header>

		<section class="grid gap-3 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
			<div class="border border-surface-border bg-bg-secondary p-4">
				<div class="flex items-center gap-2">
					<p class="font-mono text-[10px] uppercase text-text-tertiary">What this is</p>
					<LoopHelp text="A Domain Chip is a private domain-specific operating pack: prompts, rules, benchmarks, loops, evidence, and activation notes for one repeatable workflow." />
				</div>
				<h2 class="mt-2 text-lg font-semibold text-text-bright">Useful chips improve only when evidence says they do.</h2>
				<p class="mt-2 text-sm leading-6 text-text-secondary">
					Use this board to choose a chip and inspect benchmark coverage, private checks, accepted lessons, and activation state without publishing or globally enabling anything.
				</p>
			</div>

			<div class="border border-surface-border bg-bg-secondary p-4">
				<div class="flex items-center gap-2">
					<p class="font-mono text-[10px] uppercase text-text-tertiary">Build path</p>
					<LoopHelp text="This is the product sequence a new user should follow. Advanced evidence remains available below." />
				</div>
				<div class="mt-3 grid gap-2 sm:grid-cols-5">
					{#each pathSteps as step, index}
						<div class="border border-surface-border bg-bg-primary p-3">
							<div class="flex items-center justify-between gap-2">
								<span class="flex h-6 w-6 items-center justify-center border border-accent-primary/35 bg-accent-primary/10 font-mono text-xs text-accent-primary">{index + 1}</span>
								<LoopHelp text={step.help} label={`${step.label} help`} />
							</div>
							<p class="mt-3 text-sm font-medium text-text-bright">{step.label}</p>
						</div>
					{/each}
				</div>
			</div>
		</section>

		{#if needsAttention.length > 0}
			<section class="border border-surface-border bg-bg-secondary p-4">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div>
						<p class="font-mono text-[10px] uppercase text-text-tertiary">Review queue</p>
						<h2 class="mt-1 text-lg font-semibold text-text-bright">Chips that need a look</h2>
					</div>
					<StatusBadge status="attention" label={`${needsAttention.length} to review`} />
				</div>
				<div class="mt-3 grid gap-2 lg:grid-cols-2">
					{#each needsAttention.slice(0, 4) as chip}
						<a class="block border border-surface-border bg-bg-primary p-3 hover:border-accent-primary/40" href={`/loop-engineering/${encodeURIComponent(chip.id)}`}>
							<div class="flex flex-wrap items-center justify-between gap-2">
								<p class="font-medium text-text-bright">{chip.domain}</p>
								<StatusBadge status={chip.status} label={chip.statusLabel} />
							</div>
							<p class="mt-2 text-sm leading-5 text-text-secondary" title={chip.blockers[0] || chip.nextAction}>
								{chip.blockers.length ? formatLoopEngineeringList(chip.blockers, 2) : formatLoopEngineeringSentence(chip.nextAction)}
							</p>
						</a>
					{/each}
				</div>
			</section>
		{/if}

		<section>
			<div class="mb-3 flex flex-wrap items-end justify-between gap-3">
				<div>
					<p class="font-mono text-[10px] uppercase text-text-tertiary">Chip registry</p>
					<h2 class="mt-1 text-lg font-semibold text-text-bright">Open a chip and take the next safe action</h2>
				</div>
				<p class="text-xs text-text-tertiary">{registry.chips.length} chip{registry.chips.length === 1 ? '' : 's'} found</p>
			</div>

			{#if registry.chips.length === 0}
				<div class="border border-surface-border bg-bg-secondary p-6 text-sm text-text-secondary">
					No Domain Chip evidence was found in the configured chips root.
				</div>
			{:else}
				<div class="grid gap-4 xl:grid-cols-2">
					{#each visibleChips as chip}
						<article class="border border-surface-border bg-bg-secondary p-4">
							<div class="flex flex-wrap items-start justify-between gap-3">
								<div class="min-w-0">
									<div class="flex flex-wrap items-center gap-2">
										<StatusBadge status={chip.status} label={chip.statusLabel} />
										<span class="border border-surface-border bg-bg-primary px-2 py-1 text-xs text-text-tertiary">{chip.visibility}</span>
										<span class="border border-surface-border bg-bg-primary px-2 py-1 text-xs text-text-tertiary">{chipBoundary(chip)}</span>
									</div>
									<h3 class="mt-3 truncate text-lg font-semibold text-text-bright" title={chip.name}>{chip.domain}</h3>
									<p class="mt-1 text-sm leading-5 text-text-secondary" title={chip.nextAction}>{formatLoopEngineeringSentence(chip.nextAction)}</p>
								</div>
								<a
									href={`/loop-engineering/${encodeURIComponent(chip.id)}`}
									class="inline-flex items-center justify-center gap-2 border border-surface-border bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:border-accent-primary/40 hover:text-text-primary"
								>
									Open
									<Icon name="arrow-right" size={14} />
								</a>
							</div>

							<div class="mt-4 grid gap-2 sm:grid-cols-3">
								<MetricTile label="improvement" value={formatDelta(chip.benchmark.utilityDelta)} tone={deltaTone(chip.benchmark.utilityDelta)} help="How much the chip-assisted result improved against the current baseline. Positive results still need review before activation." />
								<MetricTile label="loop rounds" value={`${chip.loop.roundsObserved}/${chip.loop.requiredRounds || 'n/a'}`} help="Observed private improvement loop rounds compared with this chip's expected proof depth." />
								<MetricTile label="blockers" value={chip.blockers.length} tone={chip.blockers.length > 0 ? 'warning' : 'success'} help="Open issues to resolve before this chip is trusted more broadly." />
							</div>

							<div class="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
								<div class="grid grid-cols-3 gap-2 border border-surface-border bg-bg-primary p-3 text-xs">
									<div>
										<div class="flex items-center gap-1 text-text-tertiary">
											<span>Before</span>
											<LoopHelp text="The baseline result without this chip's guidance." />
										</div>
										<p class="mt-1 font-mono text-text-bright">{formatScore(chip.benchmark.noChipScore)}</p>
									</div>
									<div>
										<div class="flex items-center gap-1 text-text-tertiary">
											<span>With chip</span>
											<LoopHelp text="The chip-assisted result being compared against baseline." />
										</div>
										<p class="mt-1 font-mono text-text-bright">{formatScore(chip.benchmark.chipScore)}</p>
									</div>
									<div>
										<div class="flex items-center gap-1 text-text-tertiary">
											<span>Blind review</span>
											<LoopHelp text="Whether scoring avoided exposing source labels before evaluator scoring." />
										</div>
										<p class="mt-1 font-mono text-text-bright">{chip.benchmark.blindVerified ? 'yes' : 'no'}</p>
									</div>
								</div>
								<div class="border border-surface-border bg-bg-primary p-3">
									<p class="font-mono text-[10px] uppercase text-text-tertiary">Readiness</p>
									<div class="mt-3 flex flex-wrap gap-2">
										<GateBadge label="reviewed" passed={chip.gates.sealedEvaluator} help="Separated or sealed evaluator evidence exists." />
										<GateBadge label="regression checked" passed={chip.gates.watchtower} help="Regression/watchtower checks have evidence." />
										<GateBadge label="rollback ready" passed={chip.gates.rollback} help="Rollback proof is present." />
										<GateBadge label="use scoped" passed={chip.activation.loopModeAllowed || chip.activation.reviewPacketAllowed} help="Activation is at least supported for review or loop mode; approval may still be required." />
									</div>
								</div>
							</div>
						</article>
					{/each}
				</div>
				{#if hiddenChipCount > 0 || showAllChips}
					<div class="mt-4 flex flex-wrap items-center justify-between gap-2 border border-surface-border bg-bg-secondary p-3">
						<p class="text-sm text-text-tertiary">
							{showAllChips
								? `Showing all ${registry.chips.length} chips.`
								: `Showing ${visibleChips.length}; ${hiddenChipCount} more are hidden until you expand the registry.`}
						</p>
						<button
							type="button"
							class="inline-flex items-center gap-2 border border-surface-border bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:border-accent-primary/40 hover:text-text-primary"
							onclick={() => (showAllChips = !showAllChips)}
						>
							<Icon name={showAllChips ? 'chevron-up' : 'chevron-down'} size={14} />
							{showAllChips ? 'Show fewer' : 'Show all chips'}
						</button>
					</div>
				{/if}
			{/if}
		</section>

		<details class="border border-surface-border bg-bg-secondary">
			<summary class="cursor-pointer px-4 py-3 text-sm font-medium text-text-bright hover:bg-bg-primary">
				Raw proof ledger
				<span class="ml-2 font-normal text-text-tertiary">{registry.summary.resultEvents} records, hidden from the daily workflow</span>
			</summary>
			{#if registry.events.length === 0}
				<p class="border-t border-surface-border p-4 text-sm text-text-tertiary">No loop-engineering proof records were found yet.</p>
			{:else}
				<div class="border-t border-surface-border p-4">
					<p class="mb-3 max-w-3xl text-sm leading-6 text-text-secondary">
						This is the audit view for operators who need source records. The chip cards above are the normal place to decide what to run, improve, or review next.
					</p>
					<div class="overflow-x-auto">
						<table class="w-full min-w-[72rem] border-collapse text-left text-sm">
							<thead class="font-mono text-[10px] uppercase text-text-tertiary">
								<tr class="border-b border-surface-border">
									<th class="py-2 pr-3">Status</th>
									<th class="py-2 pr-3">Chip</th>
									<th class="py-2 pr-3">Event</th>
									<th class="py-2 pr-3">Before</th>
									<th class="py-2 pr-3">With chip</th>
									<th class="py-2 pr-3">Gain</th>
									<th class="py-2 pr-3">Rounds</th>
									<th class="py-2 pr-3">Review</th>
									<th class="py-2 pr-3">Next action</th>
								</tr>
							</thead>
							<tbody>
								{#each registry.events.slice(0, 32) as event}
									<tr class="border-b border-surface-border/70 align-top">
										<td class="py-3 pr-3">
											<StatusBadge status={event.status} />
										</td>
										<td class="max-w-[14rem] py-3 pr-3">
											<a class="block truncate text-text-bright hover:text-accent-primary" href={`/loop-engineering/${encodeURIComponent(event.chipId)}`} title={event.domain}>
												{event.domain}
											</a>
											<p class="mt-1 truncate font-mono text-[11px] text-text-tertiary" title={event.chipId}>control key on hover</p>
										</td>
										<td class="py-3 pr-3">
											<p class="text-text-secondary">{event.label}</p>
											<p class="mt-1 font-mono text-[11px] text-text-tertiary">{formatLoopEngineeringToken(event.sourceSurface)}</p>
										</td>
										<td class="py-3 pr-3 font-mono text-text-secondary">{formatScore(event.previousScore)}</td>
										<td class="py-3 pr-3 font-mono text-text-secondary">{formatScore(event.candidateScore)}</td>
										<td class="py-3 pr-3 font-mono text-text-bright">{formatDelta(event.utilityDelta)}</td>
										<td class="py-3 pr-3 font-mono text-text-secondary">{event.roundsObserved ?? 'n/a'}</td>
										<td class="py-3 pr-3">
											<span class="inline-flex items-center gap-1 font-mono text-xs text-text-secondary">
												{evaluatorLabel(event)}
												<LoopHelp text={eventStatusHelp(event)} />
											</span>
										</td>
										<td class="max-w-[22rem] py-3 pr-3">
											<p class="break-words text-text-secondary" title={event.nextAction}>{formatLoopEngineeringSentence(event.nextAction)}</p>
											{#if event.evidenceRefs.length}
												<p class="mt-1 truncate font-mono text-[11px] text-text-tertiary" title={event.evidenceRefs.join(', ')}>
													{evidenceRefSummary(event.evidenceRefs)}
												</p>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
			{/if}
		</details>
	</main>

	<Footer />
</div>
