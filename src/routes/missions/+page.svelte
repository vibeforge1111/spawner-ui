<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import Navbar from '$lib/components/Navbar.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import {
		missionsState,
		createMission,
		loadMissions,
		deleteMission,
		setCurrentMission,
		type MissionsState
	} from '$lib/stores/missions.svelte';
	import { mcpState } from '$lib/stores/mcp.svelte';
	import type { Mission } from '$lib/services/mcp-client';

	let currentState = $state<MissionsState>({
		missions: [],
		currentMission: null,
		logs: [],
		loading: false,
		error: null,
		pollingInterval: null
	});

	let mcpConnected = $state(false);
	let filterStatus = $state<string>('all');

	type SentinelAction = {
		receivedAt: string;
		kind: string;
		id: string;
		priority: string;
		title: string;
		reasons: string[];
		url?: string;
	};

	let sentinelLoading = $state(false);
	let sentinelError = $state<string | null>(null);
	let sentinelActions = $state<SentinelAction[]>([]);
	let sentinelPoller: ReturnType<typeof setInterval> | null = null;
	let reviewedSentinelIds = $state<string[]>([]);
	let sentinelActionBusy = $state<string | null>(null);

	$effect(() => {
		const unsub1 = missionsState.subscribe((s) => (currentState = s));
		const unsub2 = mcpState.subscribe((s) => (mcpConnected = s.status === 'connected'));
		return () => { unsub1(); unsub2(); };
	});

	async function loadSentinelActions(): Promise<void> {
		sentinelLoading = true;
		sentinelError = null;
		try {
			const response = await fetch('/api/sentinel/dispatch?limit=20');
			if (!response.ok) {
				throw new Error(`Sentinel queue request failed (${response.status})`);
			}
			const body = (await response.json()) as { actions?: SentinelAction[] };
			sentinelActions = Array.isArray(body.actions) ? body.actions : [];
		} catch (error) {
			sentinelError = error instanceof Error ? error.message : 'Unable to load sentinel queue';
		} finally {
			sentinelLoading = false;
		}
	}

	function startSentinelPolling(): void {
		if (sentinelPoller) return;
		sentinelPoller = setInterval(() => {
			void loadSentinelActions();
		}, 6000);
	}

	function stopSentinelPolling(): void {
		if (!sentinelPoller) return;
		clearInterval(sentinelPoller);
		sentinelPoller = null;
	}

	onMount(async () => {
		// Wait a bit for MCP connection to establish
		await new Promise(r => setTimeout(r, 500));
		if (mcpConnected) {
			await loadMissions();
		}
		await loadSentinelActions();
		startSentinelPolling();
	});

	onDestroy(() => {
		stopSentinelPolling();
	});

	// Reload when MCP connects
	$effect(() => {
		if (mcpConnected && currentState.missions.length === 0 && !currentState.loading) {
			loadMissions();
		}
	});

	function getStatusColor(status: Mission['status']): string {
		switch (status) {
			case 'running': return 'bg-yellow-500';
			case 'completed': return 'bg-green-500';
			case 'failed': return 'bg-red-500';
			case 'paused': return 'bg-blue-500';
			case 'ready': return 'bg-accent-primary';
			default: return 'bg-gray-500';
		}
	}

	function getStatusBadge(status: Mission['status']): string {
		switch (status) {
			case 'running': return 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10';
			case 'completed': return 'text-green-400 border-green-500/30 bg-green-500/10';
			case 'failed': return 'text-red-400 border-red-500/30 bg-red-500/10';
			case 'paused': return 'text-blue-400 border-blue-500/30 bg-blue-500/10';
			case 'ready': return 'text-accent-primary border-accent-primary/30 bg-accent-primary/10';
			default: return 'text-text-tertiary border-surface-border bg-surface';
		}
	}

	function formatDate(dateStr: string): string {
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) return dateStr;
		return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	function getSparkMetadata(mission: Mission): Record<string, unknown> | null {
		const spark = mission.outputs?.spark;
		return spark && typeof spark === 'object' ? (spark as Record<string, unknown>) : null;
	}

	function isSparkMission(mission: Mission): boolean {
		return Boolean(getSparkMetadata(mission));
	}

	function actionUrl(action: SentinelAction): string {
		if (action.url && action.url.trim()) return action.url;
		const prMatch = action.id.match(/^pr#(\d+)$/i);
		if (prMatch) {
			return `https://github.com/vibeforge1111/vibeship-spark-intelligence/pull/${prMatch[1]}`;
		}
		return '';
	}

	function markSentinelReviewed(action: SentinelAction): void {
		if (!reviewedSentinelIds.includes(action.id)) {
			reviewedSentinelIds = [action.id, ...reviewedSentinelIds].slice(0, 500);
		}
	}

	function clearReviewedSentinelActions(): void {
		reviewedSentinelIds = [];
	}

	async function createMissionFromSentinelAction(action: SentinelAction): Promise<void> {
		if (!mcpConnected) {
			sentinelError = 'MCP is not connected. Connect MCP first to create mission.';
			return;
		}

		sentinelActionBusy = action.id;
		sentinelError = null;
		try {
			const mission = await createMission({
				name: `[Sentinel] ${action.priority} ${action.id}`,
				description: action.title,
				mode: 'multi-llm-orchestrator',
				tasks: [
					{
						id: `sentinel-task-${Date.now()}`,
						title: action.title,
						description: [
							`Source: ${action.id}`,
							`Kind: ${action.kind}`,
							`Priority: ${action.priority}`,
							action.reasons?.length ? `Reasons: ${action.reasons.join(' | ')}` : '',
							actionUrl(action) ? `Reference: ${actionUrl(action)}` : ''
						]
							.filter(Boolean)
							.join('\n'),
						assignedTo: 'agent-1',
						status: 'pending',
						handoffType: 'sequential'
					}
				],
				agents: [
					{
						id: 'agent-1',
						name: 'Sentinel Reviewer',
						role: 'reviewer',
						skills: ['review', 'security', 'validation'],
						model: 'sonnet'
					}
				]
			});

			if (mission) {
				markSentinelReviewed(action);
				window.location.href = `/missions/${mission.id}`;
			}
		} catch (error) {
			sentinelError = error instanceof Error ? error.message : 'Unable to create mission from action';
		} finally {
			sentinelActionBusy = null;
		}
	}

	async function handleDelete(mission: Mission) {
		if (confirm(`Delete mission "${mission.name}"? This cannot be undone.`)) {
			await deleteMission(mission.id);
		}
	}

	const filteredMissions = $derived(() => {
		if (filterStatus === 'all') return currentState.missions;
		if (filterStatus === 'spark') return currentState.missions.filter((mission) => isSparkMission(mission));
		return currentState.missions.filter(m => m.status === filterStatus);
	});

	const statusCounts = $derived(() => {
		const counts: Record<string, number> = { all: currentState.missions.length };
		counts.spark = currentState.missions.filter((mission) => isSparkMission(mission)).length;
		for (const m of currentState.missions) {
			counts[m.status] = (counts[m.status] || 0) + 1;
		}
		return counts;
	});

	const visibleSentinelActions = $derived(() =>
		sentinelActions.filter((action) => !reviewedSentinelIds.includes(action.id))
	);

	const reviewedSentinelCount = $derived(() =>
		sentinelActions.filter((action) => reviewedSentinelIds.includes(action.id)).length
	);
</script>

<div class="min-h-screen bg-bg-primary flex flex-col">
	<Navbar />

	<main class="flex-1 max-w-6xl mx-auto w-full px-6 py-12">
		<!-- Header -->
		<div class="mb-8">
			<div class="flex items-center gap-3 mb-2">
				<h1 class="text-3xl font-serif text-text-primary">Missions</h1>
				{#if !mcpConnected}
					<span class="px-2 py-0.5 text-xs font-mono text-yellow-400 border border-yellow-500/30 bg-yellow-500/10">
						MCP Offline
					</span>
				{/if}
			</div>
			<p class="text-text-secondary">
				Orchestrate multi-agent workflows. Each mission coordinates skilled agents to complete complex tasks.
			</p>
		</div>

		<!-- Filters & Actions -->
		<div class="flex items-center justify-between mb-6">
			<div class="flex items-center gap-2">
				{#each ['all', 'spark', 'draft', 'ready', 'running', 'paused', 'completed', 'failed'] as status}
					{@const count = statusCounts()[status] || 0}
					<button
						onclick={() => filterStatus = status}
						class="px-3 py-1.5 font-mono text-sm border transition-all"
						class:bg-accent-primary={filterStatus === status}
						class:text-bg-primary={filterStatus === status}
						class:border-accent-primary={filterStatus === status}
						class:text-text-secondary={filterStatus !== status}
						class:border-surface-border={filterStatus !== status}
						class:hover:border-text-tertiary={filterStatus !== status}
					>
						{status} {#if count > 0}<span class="opacity-60">({count})</span>{/if}
					</button>
				{/each}
			</div>

			<a
				href="/canvas"
				data-sveltekit-reload
				class="px-4 py-2 font-mono text-sm bg-accent-primary text-bg-primary hover:bg-accent-primary-hover transition-all"
			>
				+ New Mission
			</a>
		</div>

		<!-- Sentinel Queue -->
		<div class="mb-6 border border-surface-border bg-bg-secondary p-4">
			<div class="flex items-center justify-between mb-3 gap-3">
				<div>
					<h3 class="text-sm font-mono text-text-primary">Sentinel Queue (latest actions)</h3>
					<p class="text-[11px] font-mono text-text-tertiary mt-1">
						Pending: {visibleSentinelActions().length} · Reviewed: {reviewedSentinelCount()}
					</p>
					<p class="text-[11px] text-text-tertiary mt-1">
						“Create mission” turns this queue item into a tracked work card for review (it does not auto-merge PRs).
					</p>
				</div>
				<div class="flex items-center gap-3">
					{#if reviewedSentinelCount() > 0}
						<button
							onclick={clearReviewedSentinelActions}
							class="text-xs font-mono text-text-tertiary hover:text-text-secondary hover:underline"
						>
							Clear reviewed
						</button>
					{/if}
					<button
						onclick={() => loadSentinelActions()}
						class="text-xs font-mono text-accent-primary hover:underline"
					>
						Refresh
					</button>
				</div>
			</div>

			{#if sentinelLoading && visibleSentinelActions().length === 0}
				<p class="text-xs font-mono text-text-tertiary">Loading sentinel queue...</p>
			{:else if sentinelError}
				<p class="text-xs font-mono text-red-400">{sentinelError}</p>
			{:else if visibleSentinelActions().length === 0}
				<p class="text-xs font-mono text-text-tertiary">No pending sentinel actions right now.</p>
			{:else}
				<div class="max-h-52 overflow-y-auto border border-surface-border">
					{#each visibleSentinelActions() as action, index (`${action.receivedAt}-${action.id}-${index}`)}
						<div class="px-3 py-2 border-b border-surface-border/60 last:border-0">
							<div class="flex items-center gap-2 mb-1">
								<span class="text-[10px] font-mono px-1.5 py-0.5 border border-surface-border text-text-secondary">{action.priority}</span>
								<span class="text-[10px] font-mono text-text-tertiary">{action.kind}</span>
								<span class="text-[10px] font-mono text-text-tertiary ml-auto">{formatDate(action.receivedAt)}</span>
							</div>
							<div class="text-sm text-text-primary truncate">{action.title}</div>
							{#if action.reasons?.length}
								<div class="text-xs text-text-tertiary truncate mb-2">{action.reasons[0]}</div>
							{/if}
							<div class="flex items-center gap-2">
								<button
									onclick={() => createMissionFromSentinelAction(action)}
									disabled={sentinelActionBusy === action.id}
									title="Creates a new mission card from this item so you or agents can review it."
									class="px-2 py-1 text-[11px] font-mono border border-accent-primary/40 text-accent-primary hover:bg-accent-primary/10 disabled:opacity-50"
								>
									{sentinelActionBusy === action.id ? 'Creating...' : 'Create mission'}
								</button>
								{#if actionUrl(action)}
									<a
										href={actionUrl(action)}
										target="_blank"
										rel="noopener noreferrer"
										class="px-2 py-1 text-[11px] font-mono border border-surface-border text-text-secondary hover:text-text-primary hover:border-text-tertiary"
									>
										Open
									</a>
								{/if}
								<button
									onclick={() => markSentinelReviewed(action)}
									class="px-2 py-1 text-[11px] font-mono border border-surface-border text-text-tertiary hover:text-text-secondary"
								>
									Mark reviewed
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Mission List -->
		{#if !mcpConnected}
			<div class="border border-surface-border bg-bg-secondary p-12 text-center">
				<div class="text-4xl mb-4 opacity-50">~</div>
				<h3 class="text-lg text-text-primary mb-2">MCP Server Offline</h3>
				<p class="text-sm text-text-secondary mb-4">
					Connect to the MCP server to view and manage missions.
				</p>
				<a href="/guide" class="font-mono text-sm text-accent-primary hover:underline">
					Setup Guide
				</a>
			</div>
		{:else if currentState.loading}
			<div class="border border-surface-border bg-bg-secondary p-12 text-center">
				<div class="animate-pulse text-text-tertiary font-mono">Loading missions...</div>
			</div>
		{:else if currentState.error}
			<div class="border border-red-500/30 bg-red-500/10 p-6">
				<p class="text-red-400 font-mono text-sm">{currentState.error}</p>
			</div>
		{:else if filteredMissions().length === 0}
			<div class="border border-surface-border bg-bg-secondary p-12 text-center">
				<div class="text-4xl mb-4 opacity-50">{filterStatus === 'all' ? '[ ]' : '0'}</div>
				<h3 class="text-lg text-text-primary mb-2">
					{filterStatus === 'all' ? 'No missions yet' : `No ${filterStatus} missions`}
				</h3>
				<p class="text-sm text-text-secondary mb-4">
					{filterStatus === 'all'
						? 'Create a workflow in the canvas, then export it as a mission.'
						: `No missions with status "${filterStatus}".`}
				</p>
				{#if filterStatus === 'all'}
					<a href="/canvas" data-sveltekit-reload class="font-mono text-sm text-accent-primary hover:underline">
						Open Canvas
					</a>
				{/if}
			</div>
		{:else}
			<div class="space-y-3">
				{#each filteredMissions() as mission (mission.id)}
					{@const sparkMeta = getSparkMetadata(mission)}
					<div class="group border border-surface-border bg-bg-secondary hover:border-surface-border-hover transition-all">
						<div class="p-4">
							<div class="flex items-start justify-between gap-4">
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-3 mb-1">
										<a
											href="/missions/{mission.id}"
											class="text-lg text-text-primary hover:text-accent-primary transition-colors font-medium truncate"
										>
											{mission.name}
										</a>
										<span class="px-2 py-0.5 text-xs font-mono border {getStatusBadge(mission.status)}">
											{mission.status}
										</span>
										{#if sparkMeta}
											<span class="px-2 py-0.5 text-xs font-mono border border-accent-primary/30 bg-accent-primary/10 text-accent-primary">
												spark
											</span>
										{/if}
									</div>
									{#if mission.description}
										<p class="text-sm text-text-secondary truncate">{mission.description}</p>
									{/if}
									{#if sparkMeta}
										<p class="mt-2 text-xs font-mono text-text-tertiary truncate">
											Req: {typeof sparkMeta.requestId === 'string' ? sparkMeta.requestId : 'n/a'}
											{#if typeof sparkMeta.chatId === 'string'}
												Â· Chat: {sparkMeta.chatId}
											{/if}
											{#if Array.isArray(sparkMeta.providers) && sparkMeta.providers.length > 0}
												Â· Providers: {sparkMeta.providers.join(', ')}
											{/if}
										</p>
									{/if}
								</div>

								<div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
									<a
										href="/missions/{mission.id}"
										class="px-3 py-1 text-xs font-mono text-text-secondary border border-surface-border hover:border-text-tertiary hover:text-text-primary transition-all"
									>
										View
									</a>
									{#if mission.status === 'draft' || mission.status === 'ready'}
										<button
											onclick={() => handleDelete(mission)}
											class="px-3 py-1 text-xs font-mono text-red-400 border border-red-500/30 hover:bg-red-500/10 transition-all"
										>
											Delete
										</button>
									{/if}
								</div>
							</div>

							<!-- Meta info -->
							<div class="flex items-center gap-4 mt-3 text-xs font-mono text-text-tertiary">
								<span>{mission.agents.length} agent{mission.agents.length !== 1 ? 's' : ''}</span>
								<span>{mission.tasks.length} task{mission.tasks.length !== 1 ? 's' : ''}</span>
								<span>Mode: {mission.mode}</span>
								<span class="ml-auto">{formatDate(mission.created_at)}</span>
							</div>
						</div>

						<!-- Progress bar for running missions -->
						{#if mission.status === 'running'}
							{@const completedTasks = mission.tasks.filter(t => t.status === 'completed').length}
							{@const progress = mission.tasks.length > 0 ? (completedTasks / mission.tasks.length) * 100 : 0}
							<div class="h-1 bg-surface-border">
								<div class="h-full bg-yellow-500 transition-all" style="width: {progress}%"></div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</main>

	<Footer />
</div>
