<!--
	Auto-cycling preview of upcoming Spark specializations.
	Each card shows what canvas + kanban look like when tuned for that domain.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	type Spec = {
		id: string;
		label: string;
		tagline: string;
		canvasNodes: string[];
		boardCols: { name: string; items: string[] }[];
		accent: string;
	};

	const SPECS: Spec[] = [
		{
			id: 'trading',
			label: 'Trading',
			tagline: 'Strategy, risk, execution.',
			canvasNodes: ['signal', 'risk-check', 'sizing', 'execute', 'pnl-log'],
			boardCols: [
				{ name: 'Setups', items: ['BTC reclaim', 'ETH funding flip'] },
				{ name: 'Live', items: ['SOL momentum'] },
				{ name: 'Closed', items: ['DOGE scalp +2.4%'] }
			],
			accent: 'text-accent-primary'
		},
		{
			id: 'content',
			label: 'Content',
			tagline: 'Angle, draft, score, ship.',
			canvasNodes: ['angle', 'draft', 'voice-check', 'virality-score', 'schedule'],
			boardCols: [
				{ name: 'Ideas', items: ['Spawner reveal', 'Skills launch'] },
				{ name: 'Drafting', items: ['Tool drop thread'] },
				{ name: 'Posted', items: ['Founder note 9.2/10'] }
			],
			accent: 'text-accent-primary'
		},
		{
			id: 'voice',
			label: 'Voice',
			tagline: 'Calls, transcribe, act.',
			canvasNodes: ['record', 'transcribe', 'extract', 'route', 'reply'],
			boardCols: [
				{ name: 'Inbox', items: ['VC call notes'] },
				{ name: 'Triaging', items: ['Customer call'] },
				{ name: 'Done', items: ['Team standup → tasks'] }
			],
			accent: 'text-accent-primary'
		},
		{
			id: 'ops',
			label: 'Ops',
			tagline: 'Watch, alert, fix.',
			canvasNodes: ['monitor', 'detect', 'triage', 'patch', 'verify'],
			boardCols: [
				{ name: 'Pages', items: ['DB latency'] },
				{ name: 'Fixing', items: ['Auth retry loop'] },
				{ name: 'Resolved', items: ['Deploy rollback'] }
			],
			accent: 'text-accent-primary'
		}
	];

	let active = $state(0);
	let timer: ReturnType<typeof setInterval> | null = null;
	let resumeDelay: ReturnType<typeof setTimeout> | null = null;

	const current = $derived(SPECS[active]);

	onMount(() => {
		timer = setInterval(() => {
			active = (active + 1) % SPECS.length;
		}, 8000);
	});

	onDestroy(() => {
		if (resumeDelay) clearTimeout(resumeDelay);
		if (timer) clearInterval(timer);
	});

	function pick(i: number) {
		active = i;
		if (timer) clearInterval(timer);
		if (resumeDelay) clearTimeout(resumeDelay);
		// Resume auto-cycle after 8s
		resumeDelay = setTimeout(() => {
			resumeDelay = null;
			timer = setInterval(() => {
				active = (active + 1) % SPECS.length;
			}, 8000);
		}, 8000);
	}
</script>

<div class="rounded-lg border border-surface-border bg-bg-secondary overflow-hidden">
	<!-- Tabs -->
	<div class="flex border-b border-surface-border overflow-x-auto">
		{#each SPECS as s, i}
			<button
				type="button"
				onclick={() => pick(i)}
				class="flex-1 min-w-[100px] px-5 py-4 text-base font-medium transition-all border-b-2"
				class:border-accent-primary={active === i}
				class:border-transparent={active !== i}
				class:text-text-primary={active === i}
				class:text-text-tertiary={active !== i}
				class:bg-bg-primary={active === i}
			>
				{s.label}
			</button>
		{/each}
	</div>

	<!-- Body -->
	<div class="p-8 md:p-10">
		{#key current.id}
			<p class="text-2xl md:text-3xl font-sans font-semibold text-text-primary mb-8 leading-tight fade-in">
				{current.tagline}
			</p>

			<div class="grid md:grid-cols-2 gap-6">
				<!-- Mini canvas -->
				<div class="rounded-md border border-surface-border bg-bg-primary p-5 fade-in" style="animation-delay: 100ms">
					<p class="font-mono text-xs text-text-tertiary tracking-widest mb-4">CANVAS</p>
					<div class="flex flex-wrap items-center gap-y-3">
						{#each current.canvasNodes as node, i}
							<span class="inline-flex items-center px-3 py-1.5 rounded-md border border-accent-primary/40 bg-accent-primary/10 font-mono text-sm text-text-primary shadow-[0_0_18px_-6px_rgb(var(--accent-rgb)/0.3)]">
								{node}
							</span>
							{#if i < current.canvasNodes.length - 1}
								<span class="inline-block w-5 mx-1 border-t border-dashed border-accent-primary/60" aria-hidden="true"></span>
							{/if}
						{/each}
					</div>
				</div>

				<!-- Mini kanban -->
				<div class="rounded-md border border-surface-border bg-bg-primary p-5 fade-in" style="animation-delay: 200ms">
					<p class="font-mono text-xs text-text-tertiary tracking-widest mb-4">KANBAN</p>
					<div class="grid grid-cols-3 gap-3">
						{#each current.boardCols as col}
							<div>
								<p class="font-mono text-[10px] text-text-tertiary tracking-widest mb-2">{col.name.toUpperCase()}</p>
								<div class="space-y-1.5">
									{#each col.items as item}
										<div class="px-2 py-1.5 rounded border border-surface-border bg-bg-secondary text-xs text-text-secondary leading-tight">
											{item}
										</div>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				</div>
			</div>
		{/key}
	</div>
</div>

<style>
	.fade-in {
		animation: fade 0.9s ease-out backwards;
	}
	@keyframes fade {
		from { opacity: 0; transform: translateY(8px); }
		to { opacity: 1; transform: translateY(0); }
	}
</style>
