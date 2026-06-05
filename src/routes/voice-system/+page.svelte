<script lang="ts">
	import type { VoiceReadinessStatus, VoiceSystemDashboard } from '$lib/services/voice-system';

	interface PageData {
		dashboard: VoiceSystemDashboard;
	}

	let { data } = $props<{ data: PageData }>();
	const dashboard = $derived(data.dashboard);
	const readyMetrics = $derived(dashboard.metrics.filter((metric: { status: VoiceReadinessStatus }) => metric.status === 'ready').length);
	const totalMetrics = $derived(Math.max(1, dashboard.metrics.length));
	const primaryMetric = $derived(dashboard.metrics[0]);

	function statusClass(status: VoiceReadinessStatus) {
		if (status === 'ready') return 'border-status-success/35 bg-status-success-bg text-status-success';
		if (status === 'configured') return 'border-accent-primary/35 bg-accent-primary/10 text-accent-primary';
		if (status === 'partial') return 'border-status-warning/35 bg-status-warning-bg text-status-warning';
		if (status === 'blocked') return 'border-status-error/35 bg-status-error-bg text-status-error';
		return 'border-surface-border bg-bg-secondary text-text-secondary';
	}

	function railClass(status: VoiceReadinessStatus) {
		if (status === 'ready') return 'border-status-success/40 bg-status-success-bg/60 text-status-success';
		if (status === 'configured') return 'border-accent-primary/35 bg-accent-primary/10 text-accent-primary';
		if (status === 'partial') return 'border-status-warning/40 bg-status-warning-bg/70 text-status-warning';
		if (status === 'blocked') return 'border-status-error/40 bg-status-error-bg text-status-error';
		return 'border-surface-border bg-bg-secondary text-text-secondary';
	}

	function dotClass(status: VoiceReadinessStatus) {
		if (status === 'ready') return 'bg-status-success';
		if (status === 'configured') return 'bg-accent-primary';
		if (status === 'partial') return 'bg-status-warning';
		if (status === 'blocked') return 'bg-status-error';
		return 'bg-text-faint';
	}

	function formatTime(value: string) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}).format(date);
	}
</script>

<svelte:head>
	<title>Voice System - Spawner</title>
</svelte:head>

<main class="min-h-screen bg-bg-primary text-text-primary">
	<section class="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-4 py-4 sm:px-5">
		<header class="grid gap-4 border-b border-surface-border pb-4 lg:grid-cols-[1fr_auto] lg:items-end">
			<div class="min-w-0">
				<p class="font-mono text-xs uppercase text-accent-primary">Voice System</p>
				<h1 class="mt-1 text-2xl font-semibold text-text-bright sm:text-3xl">Telegram voice runtime</h1>
				<p class="mt-1 max-w-3xl text-sm text-text-secondary">
					A live operating view for provider scope, delivery proof, and the path from Telegram to Builder to speech.
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-2 text-xs font-mono lg:justify-end">
				{#if dashboard.isSampleData}
					<span data-testid="sample-data-indicator" class="border border-status-warning/40 bg-status-warning-bg px-2 py-1 text-status-warning">Sample view</span>
				{:else}
					<span data-testid="live-data-indicator" class="border border-status-success/40 bg-status-success-bg px-2 py-1 text-status-success">Live snapshot</span>
				{/if}
				<span class="border border-surface-border bg-bg-secondary px-2 py-1 text-text-secondary">{formatTime(dashboard.generatedAt)}</span>
				<span class="border border-accent-primary/30 bg-accent-primary/10 px-2 py-1 text-accent-primary">{readyMetrics}/{totalMetrics} proven</span>
			</div>
		</header>

		{#if dashboard.warnings.length > 0}
			<section class="grid gap-2 border border-status-warning/30 bg-status-warning-bg p-3 text-sm text-status-warning sm:grid-cols-[auto_1fr]" aria-label="Voice dashboard notice">
				<span class="font-mono uppercase">Needs proof</span>
				<p>{dashboard.warnings[0]}</p>
			</section>
		{/if}

		<section class="border border-surface-border bg-bg-tertiary p-3" aria-label="Voice proof ladder">
			<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h2 class="text-sm font-semibold text-text-bright">Proof ladder</h2>
				<p class="font-mono text-xs text-text-tertiary">configured is not the same as delivered</p>
			</div>
			<div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
				{#each dashboard.metrics as metric, index}
					<div class="grid grid-cols-[auto_1fr_auto] items-center gap-2 border border-surface-border bg-bg-primary px-3 py-2 text-sm">
						<span class={`h-2.5 w-2.5 ${dotClass(metric.status)}`}></span>
						<div class="min-w-0">
							<p class="truncate font-semibold text-text-bright">{metric.label}</p>
							<p class="truncate font-mono text-xs text-text-tertiary">{String(index + 1).padStart(2, '0')} / {metric.value}</p>
						</div>
						<span class={`border px-2 py-0.5 font-mono text-[10px] ${statusClass(metric.status)}`}>{metric.status}</span>
					</div>
				{/each}
			</div>
		</section>

		<section class="grid gap-3 lg:grid-cols-[1.2fr_0.8fr]" aria-label="Voice profile and runtime path">
			<article class="border border-surface-border bg-bg-tertiary p-4">
				<div class="grid gap-4 lg:grid-cols-[1fr_auto]">
					<div>
						<p class="font-mono text-xs uppercase text-text-tertiary">Current voice</p>
						<h2 class="mt-1 max-w-2xl text-2xl font-semibold leading-tight text-text-bright">{dashboard.profile.voiceName}</h2>
						<p class="mt-2 text-sm text-text-secondary">
							{dashboard.profile.agentLabel} uses {dashboard.profile.providerLabel} in {dashboard.profile.preferenceScope}.
						</p>
					</div>
					<div class="self-start border border-accent-primary/35 bg-accent-primary/10 px-3 py-2 text-left font-mono text-xs text-accent-primary lg:min-w-48">
						<p>{dashboard.profile.providerLabel}</p>
						<p class="mt-1 text-text-secondary">{dashboard.profile.voiceIdMasked}</p>
					</div>
				</div>

				<div class="mt-5 grid gap-0 border border-surface-border bg-bg-primary text-sm sm:grid-cols-4">
					<div class="border-b border-surface-border p-3 sm:border-b-0 sm:border-r">
						<p class="font-mono text-xs uppercase text-text-tertiary">Agent</p>
						<p class="mt-1 text-text-bright">{dashboard.profile.agentLabel}</p>
					</div>
					<div class="border-b border-surface-border p-3 sm:border-b-0 sm:border-r">
						<p class="font-mono text-xs uppercase text-text-tertiary">Profile</p>
						<p class="mt-1 text-text-bright">{dashboard.profile.telegramProfile}</p>
					</div>
					<div class="border-b border-surface-border p-3 sm:border-b-0 sm:border-r">
						<p class="font-mono text-xs uppercase text-text-tertiary">Effect</p>
						<p class="mt-1 text-text-bright">{dashboard.profile.audioEffect}</p>
					</div>
					<div class="p-3">
						<p class="font-mono text-xs uppercase text-text-tertiary">Snapshot</p>
						<p class="mt-1 text-text-bright">{dashboard.isSampleData ? 'Waiting' : 'Live'}</p>
					</div>
				</div>
			</article>

			<article class="border border-surface-border bg-bg-tertiary p-4" aria-label="Last Telegram delivery">
				<div class="flex items-start justify-between gap-3">
					<div>
						<p class="font-mono text-xs uppercase text-text-tertiary">Last Telegram delivery</p>
						<h2 class="mt-2 text-3xl font-semibold text-text-bright">{dashboard.lastDelivery.status}</h2>
					</div>
					<span class="border border-surface-border bg-bg-primary px-2 py-1 font-mono text-xs text-text-tertiary">{dashboard.lastDelivery.method}</span>
				</div>
				<p class="mt-2 font-mono text-xs text-text-tertiary">{dashboard.lastDelivery.when}</p>
				<p class="mt-3 text-sm text-text-secondary">{dashboard.lastDelivery.detail}</p>
				<div class="mt-4 border-t border-surface-border pt-3">
					<p class="font-mono text-xs uppercase text-text-tertiary">Next useful check</p>
					<p class="mt-1 text-sm text-text-bright">Run <span class="font-mono text-accent-primary">/voice ask &lt;question&gt;</span>, then confirm text and audio match.</p>
				</div>
			</article>
		</section>

		<section class="border border-surface-border bg-bg-tertiary p-4" aria-label="Runtime path">
			<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 class="text-sm font-semibold text-text-bright">Runtime path</h2>
					<p class="mt-1 text-sm text-text-secondary">A single Builder-authored answer moves through speech I/O, then Telegram delivery proves it.</p>
				</div>
				<span class="font-mono text-xs text-text-tertiary">Telegram -> Builder -> voice chip -> Telegram</span>
			</div>
			<div class="grid gap-3 md:grid-cols-4">
				{#each dashboard.runtimePath as step, index}
					<div class="relative min-h-[132px] border border-surface-border bg-bg-primary p-3">
						<div class="mb-3 flex items-center justify-between gap-2">
							<span class={`h-2.5 w-2.5 ${dotClass(step.status)}`}></span>
							<span class={`border px-2 py-0.5 font-mono text-[10px] ${railClass(step.status)}`}>{String(index + 1).padStart(2, '0')}</span>
						</div>
						<h3 class="text-sm font-semibold text-text-bright">{step.label}</h3>
						<p class="mt-1 font-mono text-xs text-accent-primary">{step.owner}</p>
						<p class="mt-2 text-xs text-text-secondary">{step.detail}</p>
					</div>
				{/each}
			</div>
		</section>

		<section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Voice readiness metrics">
			{#each dashboard.metrics as metric}
				<article data-testid={`metric-${metric.id}`} class={`min-h-[116px] border bg-bg-tertiary p-3 ${primaryMetric?.id === metric.id ? 'border-accent-primary/35' : 'border-surface-border'}`}>
					<div class="flex items-start justify-between gap-2">
						<h2 class="text-sm font-semibold text-text-bright">{metric.label}</h2>
						<span class={`border px-2 py-0.5 font-mono text-xs ${statusClass(metric.status)}`}>{metric.status}</span>
					</div>
					<p class="mt-3 text-2xl font-semibold text-text-bright sm:text-3xl">{metric.value}</p>
					<p class="mt-2 text-sm text-text-secondary">{metric.help}</p>
				</article>
			{/each}
		</section>

		<div class="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
			<section class="grid gap-4">
				<article class="border border-surface-border bg-bg-tertiary p-3" aria-label="Provider readiness">
					<div class="mb-3 flex items-center justify-between gap-3">
						<h2 class="text-sm font-semibold text-text-bright">Provider readiness</h2>
						<span class="font-mono text-xs text-text-tertiary">selection lives in Builder state</span>
					</div>
					<div class="divide-y divide-surface-border border border-surface-border bg-bg-primary">
						{#each dashboard.providers as provider}
							<div class="grid gap-2 p-3 text-sm sm:grid-cols-[128px_1fr_auto] sm:items-center">
								<div>
									<p class="font-semibold text-text-bright">{provider.label}</p>
									<p class="font-mono text-xs text-text-tertiary">{provider.role}</p>
								</div>
								<p class="text-text-secondary">{provider.detail}</p>
								<span class={`w-fit border px-2 py-0.5 font-mono text-xs ${statusClass(provider.status)}`}>{provider.status}</span>
							</div>
						{/each}
					</div>
				</article>

				<article class="border border-surface-border bg-bg-tertiary p-3" aria-label="Telegram commands">
					<h2 class="mb-3 text-sm font-semibold text-text-bright">Telegram commands</h2>
					<div class="flex flex-wrap gap-2">
						{#each dashboard.telegramCommands as command}
							<span class="border border-surface-border bg-bg-primary px-2 py-1 font-mono text-xs text-text-secondary">{command}</span>
						{/each}
					</div>
				</article>
			</section>

			<section class="grid gap-4">
				<article class="border border-surface-border bg-bg-tertiary p-3" aria-label="Ownership boundaries">
					<h2 class="mb-3 text-sm font-semibold text-text-bright">Ownership boundaries</h2>
					<div class="divide-y divide-surface-border border border-surface-border bg-bg-primary">
						{#each dashboard.boundaries as boundary}
							<div class="grid gap-2 p-3 text-sm md:grid-cols-[128px_1fr_1fr]">
								<p class="font-semibold text-text-bright">{boundary.owner}</p>
								<p class="text-text-secondary">{boundary.owns}</p>
								<p class="text-text-tertiary">{boundary.notOwner}</p>
							</div>
						{/each}
					</div>
				</article>

				<article class="border border-surface-border bg-bg-tertiary p-3" aria-label="Production checks">
					<div class="mb-3 flex items-center justify-between gap-3">
						<h2 class="text-sm font-semibold text-text-bright">Production checks</h2>
						<span class="font-mono text-xs text-text-tertiary">before public voice claims</span>
					</div>
					<ul class="grid gap-2 text-sm text-text-secondary sm:grid-cols-2">
						{#each dashboard.checks as check}
							<li class="flex gap-2"><span class="mt-2 h-1.5 w-1.5 shrink-0 bg-accent-primary"></span><span>{check}</span></li>
						{/each}
					</ul>
				</article>
			</section>
		</div>

		<footer class="border-t border-surface-border pt-3 text-xs text-text-tertiary">
			Source: {dashboard.sourceLabel}
		</footer>
	</section>
</main>
