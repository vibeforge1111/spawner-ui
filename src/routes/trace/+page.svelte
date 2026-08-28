<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import Navbar from '$lib/components/Navbar.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { MissionControlCompletionEvidence } from '$lib/types/mission-control';
	import {
		completionEvidenceTooltipForDisplay,
		summarizeCompletionEvidenceForDisplay
	} from '$lib/services/completion-evidence-display';

	type TaskCounts = {
		queued: number;
		running: number;
		completed: number;
		failed: number;
		cancelled: number;
		total: number;
	};

	type TimelineEntry = {
		eventType: string;
		missionId: string;
		taskName: string | null;
		summary: string;
		timestamp: string;
		source: string;
	};

	type AgentBlackBoxEntry = {
		event_id: string;
		event_type: string;
		created_at: string;
		perceived_intent: string | null;
		route_chosen: string | null;
		sources_used: Array<{ source: string; freshness: string; summary: string }>;
		blockers: string[];
		changed: string[];
		summary: string;
	};

	type TracePayload = {
		ok: true;
		missionId: string | null;
		requestId: string | null;
		phase: string;
		summary: string;
		progress: {
			percent: number;
			taskCounts: TaskCounts | null;
			currentTask: string | null;
		};
		surfaces: {
			telegram: {
				relay: { port: number | null; profile: string | null; url: string | null } | null;
				chatId: string | null;
				userId: string | null;
			};
			canvas: {
				pipelineId: string | null;
				pipelineName: string | null;
				autoRun: boolean | null;
				nodeCount: number | null;
			};
			kanban: {
				bucket: string | null;
				entry: {
					taskCount: number;
					tasks: Array<{ title: string; status?: string; skills: string[] }>;
				} | null;
			};
			dispatch: {
				allComplete: boolean;
				anyFailed: boolean;
				paused: boolean;
				providers: Record<string, string>;
				lastReason: string | null;
			} | null;
		};
		prdTrace: {
			file: string;
			entryCount: number;
			entries: Array<Record<string, unknown>>;
		};
		timeline: TimelineEntry[];
		providerSummary: string | null;
		completionEvidence: MissionControlCompletionEvidence | null;
		projectLineage: {
			projectId: string | null;
			projectPath: string | null;
			previewUrl: string | null;
			parentMissionId: string | null;
			iterationNumber: number | null;
			improvementFeedback: string | null;
		} | null;
		skillPairing: {
			taskCount: number;
			pairedTaskCount: number;
			skillCount: number;
			pairingRatio: number;
			status: string;
			source: string;
			unpairedTasks: string[];
		};
		agentBlackBox: {
			counts: {
				entries: number;
				blocker_events: number;
				memory_candidates: number;
			};
			entries: AgentBlackBoxEntry[];
		};
		serverTime: string;
	};

	type BoardEntry = {
		missionId: string;
		lastUpdated: string;
		status: string;
	};

	let missionId = $state('');
	let requestId = $state('');
	let trace = $state<TracePayload | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let autoRefresh = $state(true);
	let poller: ReturnType<typeof setInterval> | null = null;

	const phaseClass = $derived.by(() => {
		switch (trace?.phase) {
			case 'completed':
				return 'border-green-500/30 bg-green-500/10 text-green-300';
			case 'failed':
				return 'border-red-500/30 bg-red-500/10 text-red-300';
			case 'executing':
				return 'border-accent-primary/30 bg-accent-primary/10 text-accent-primary';
			case 'planning':
			case 'canvas_ready':
				return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300';
			default:
				return 'border-surface-border bg-surface text-text-secondary';
		}
	});

	function shortDate(value: string | null | undefined): string {
		if (!value) return 'n/a';
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function taskCountValue(key: keyof TaskCounts): number {
		return trace?.progress.taskCounts?.[key] ?? 0;
	}

	function providerList(): Array<{ id: string; status: string }> {
		const providers = trace?.surfaces.dispatch?.providers || {};
		return Object.entries(providers).map(([id, status]) => ({ id, status }));
	}

	function evidenceLabel(evidence: MissionControlCompletionEvidence | null | undefined): string | null {
		return summarizeCompletionEvidenceForDisplay(evidence);
	}

	function evidenceTitle(evidence: MissionControlCompletionEvidence | null | undefined): string | null {
		return completionEvidenceTooltipForDisplay(evidence);
	}

	function evidenceClass(evidence: MissionControlCompletionEvidence | null | undefined): string {
		if (evidence?.state === 'complete') return 'border-green-500/30 bg-green-500/10 text-green-300';
		if (evidence?.state === 'incomplete') return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300';
		return 'border-surface-border bg-surface text-text-secondary';
	}

	function firstSource(entry: AgentBlackBoxEntry): string {
		const source = entry.sources_used[0];
		if (!source) return 'unknown';
		return `${source.source} / ${source.freshness}`;
	}

	function traceUrl(): string {
		const params = new URLSearchParams();
		if (missionId.trim()) params.set('missionId', missionId.trim());
		if (requestId.trim()) params.set('requestId', requestId.trim());
		return `/api/mission-control/trace${params.toString() ? `?${params.toString()}` : ''}`;
	}

	function parseLastUpdatedOrTail(value: string | null | undefined): number {
		const parsed = Date.parse(value || '');
		return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
	}

	async function selectLatestMission(): Promise<void> {
		const response = await fetch('/api/mission-control/board');
		if (!response.ok) return;
		const body = await response.json();
		const entries: BoardEntry[] = [
			...(body.board?.running || []),
			...(body.board?.created || []),
			...(body.board?.completed || []),
			...(body.board?.failed || []),
			...(body.board?.paused || [])
		];
		const latest = entries
			.filter((entry) => entry?.missionId)
			.sort((a, b) => parseLastUpdatedOrTail(b.lastUpdated) - parseLastUpdatedOrTail(a.lastUpdated))[0];
		if (latest && !missionId.trim() && !requestId.trim()) {
			missionId = latest.missionId;
		}
	}

	async function loadTrace(): Promise<void> {
		loading = true;
		error = null;
		try {
			if (!missionId.trim() && !requestId.trim()) {
				await selectLatestMission();
			}
			const response = await fetch(traceUrl());
			if (!response.ok) throw new Error(`Trace request failed (${response.status})`);
			trace = (await response.json()) as TracePayload;
			if (trace.missionId) missionId = trace.missionId;
			if (trace.requestId) requestId = trace.requestId;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Unable to load trace';
		} finally {
			loading = false;
		}
	}

	function startPolling(): void {
		if (poller) return;
		poller = setInterval(() => {
			if (autoRefresh) void loadTrace();
		}, 4000);
	}

	function stopPolling(): void {
		if (!poller) return;
		clearInterval(poller);
		poller = null;
	}

	function applyUrlParams(): void {
		const params = new URLSearchParams(window.location.search);
		missionId = params.get('missionId') || params.get('mission') || '';
		requestId = params.get('requestId') || '';
	}

	function handleVisibilityChange(): void {
		if (!browser) return;
		if (document.visibilityState === 'visible') {
			// Tab is back in the foreground: refetch immediately so the
			// operator sees current mission state, then resume the 4s
			// poll if autoRefresh is on.
			if (autoRefresh) {
				void loadTrace();
				startPolling();
			}
		} else {
			// Tab hidden: pause polling. Without this, the 4s trace poll
			// keeps firing in a background tab and burns network for a
			// stream the operator cannot see. Polling resumes on
			// visibility=visible above (only if autoRefresh is on).
			stopPolling();
		}
	}

	onMount(() => {
		applyUrlParams();
		void loadTrace();
		startPolling();
		if (browser) {
			document.addEventListener('visibilitychange', handleVisibilityChange);
		}
	});

	onDestroy(() => {
		stopPolling();
		if (browser) {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		}
	});
</script>

<svelte:head>
	<title>Trace Plane · spawner</title>
</svelte:head>

<div class="min-h-screen bg-bg-primary flex flex-col">
	<Navbar />

	<main class="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-8 space-y-6">
		<section class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
			<div>
				<div class="flex items-center gap-3 text-accent-primary font-mono text-sm uppercase tracking-[0.18em]">
					<Icon name="scan" size={16} />
					<span>Trace Plane</span>
				</div>
				<h1 class="mt-2 text-3xl font-bold text-text-primary">Mission Control</h1>
			</div>

			<div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] lg:min-w-[760px]">
				<label class="space-y-1">
					<span class="text-xs font-mono uppercase tracking-[0.16em] text-text-tertiary">Mission ID</span>
					<input
						class="w-full rounded-md border border-surface-border bg-bg-secondary px-3 py-2 font-mono text-sm text-text-primary outline-none focus:border-accent-primary"
						bind:value={missionId}
						placeholder="mission-..."
					/>
				</label>
				<label class="space-y-1">
					<span class="text-xs font-mono uppercase tracking-[0.16em] text-text-tertiary">Request ID</span>
					<input
						class="w-full rounded-md border border-surface-border bg-bg-secondary px-3 py-2 font-mono text-sm text-text-primary outline-none focus:border-accent-primary"
						bind:value={requestId}
						placeholder="tg-build-..."
					/>
				</label>
				<button
					type="button"
					class="h-10 self-end rounded-md border border-accent-primary/40 bg-accent-primary/15 px-4 font-mono text-sm text-accent-primary hover:bg-accent-primary/25"
					onclick={() => void loadTrace()}
				>
					Refresh
				</button>
				<button
					type="button"
					class={`h-10 self-end rounded-md border px-4 font-mono text-sm ${
						autoRefresh
							? 'border-accent-primary/40 bg-accent-primary/15 text-accent-primary'
							: 'border-surface-border bg-surface text-text-secondary'
					}`}
					onclick={() => (autoRefresh = !autoRefresh)}
				>
					{autoRefresh ? 'Live' : 'Paused'}
				</button>
			</div>
		</section>

		{#if error}
			<div class="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-red-200">{error}</div>
		{/if}

		<section class="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
			<div class="rounded-md border border-surface-border bg-bg-secondary p-5">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div>
						<div class="font-mono text-xs uppercase tracking-[0.16em] text-text-tertiary">Current phase</div>
						<div class="mt-2 flex flex-wrap items-center gap-3">
							<span class={`rounded-md border px-3 py-1 font-mono text-sm uppercase ${phaseClass}`}>
								{trace?.phase || 'unknown'}
							</span>
							<span class="font-mono text-sm text-text-secondary">{trace?.missionId || 'No mission selected'}</span>
						</div>
					</div>
					<div class="text-right">
						<div class="text-4xl font-bold text-text-primary">{trace?.progress.percent ?? 0}%</div>
						<div class="font-mono text-xs text-text-tertiary">{loading ? 'refreshing' : shortDate(trace?.serverTime)}</div>
					</div>
				</div>

				<div class="mt-5 h-3 rounded-full bg-bg-primary overflow-hidden">
					<div
						class="h-full bg-accent-primary transition-all"
						style={`width: ${trace?.progress.percent ?? 0}%`}
					></div>
				</div>

				<div class="mt-5 text-text-secondary">{trace?.summary || 'No trace loaded yet.'}</div>
				{#if trace?.providerSummary}
					<div class="mt-3 rounded-md border border-surface-border bg-bg-primary p-3 text-sm text-text-secondary">
						<span class="font-mono text-accent-primary">Provider</span>
						<span class="ml-2">{trace.providerSummary}</span>
					</div>
				{/if}
				{#if evidenceLabel(trace?.completionEvidence)}
					<div class={`mt-3 rounded-md border p-3 text-sm ${evidenceClass(trace?.completionEvidence)}`} title={evidenceTitle(trace?.completionEvidence)}>
						<span class="font-mono">Evidence</span>
						<span class="ml-2">{evidenceLabel(trace?.completionEvidence)}</span>
					</div>
				{/if}
				{#if trace?.projectLineage}
					<div class="mt-3 rounded-md border border-accent-primary/30 bg-accent-primary/10 p-3 text-sm text-text-secondary">
						<div class="font-mono text-accent-primary">
							Project iteration{trace.projectLineage.iterationNumber ? ` ${trace.projectLineage.iterationNumber}` : ''}
						</div>
						<div class="mt-1 grid gap-1 font-mono text-xs">
							{#if trace.projectLineage.projectPath}<span>Project: {trace.projectLineage.projectPath}</span>{/if}
							{#if trace.projectLineage.parentMissionId}<span>Parent: {trace.projectLineage.parentMissionId}</span>{/if}
							{#if trace.projectLineage.improvementFeedback}<span>Feedback: {trace.projectLineage.improvementFeedback}</span>{/if}
						</div>
					</div>
				{/if}
			</div>

			<div class="grid grid-cols-2 gap-3">
				<div class="rounded-md border border-surface-border bg-bg-secondary p-4">
					<div class="font-mono text-xs uppercase tracking-[0.16em] text-text-tertiary">Queued</div>
					<div class="mt-2 text-3xl font-bold text-yellow-300">{taskCountValue('queued')}</div>
				</div>
				<div class="rounded-md border border-surface-border bg-bg-secondary p-4">
					<div class="font-mono text-xs uppercase tracking-[0.16em] text-text-tertiary">Running</div>
					<div class="mt-2 text-3xl font-bold text-accent-primary">{taskCountValue('running')}</div>
				</div>
				<div class="rounded-md border border-surface-border bg-bg-secondary p-4">
					<div class="font-mono text-xs uppercase tracking-[0.16em] text-text-tertiary">Completed</div>
					<div class="mt-2 text-3xl font-bold text-green-300">{taskCountValue('completed')}</div>
				</div>
				<div class="rounded-md border border-surface-border bg-bg-secondary p-4">
					<div class="font-mono text-xs uppercase tracking-[0.16em] text-text-tertiary">Failed</div>
					<div class="mt-2 text-3xl font-bold text-red-300">{taskCountValue('failed')}</div>
				</div>
			</div>
		</section>

		<section class="grid gap-4 xl:grid-cols-5">
			<div class="rounded-md border border-surface-border bg-bg-secondary p-4">
				<div class="flex items-center gap-2 font-mono text-sm uppercase tracking-[0.16em] text-text-tertiary">
					<Icon name="message-circle" size={15} />
					<span>Telegram</span>
				</div>
				<div class="mt-4 space-y-2 font-mono text-sm">
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">chat</span><span class="truncate text-text-primary">{trace?.surfaces.telegram.chatId || 'n/a'}</span></div>
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">profile</span><span class="truncate text-text-primary">{trace?.surfaces.telegram.relay?.profile || 'n/a'}</span></div>
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">port</span><span class="text-text-primary">{trace?.surfaces.telegram.relay?.port || 'n/a'}</span></div>
				</div>
			</div>

			<div class="rounded-md border border-surface-border bg-bg-secondary p-4">
				<div class="flex items-center gap-2 font-mono text-sm uppercase tracking-[0.16em] text-text-tertiary">
					<Icon name="grid" size={15} />
					<span>Canvas</span>
				</div>
				<div class="mt-4 space-y-2 font-mono text-sm">
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">pipeline</span><span class="truncate text-text-primary">{trace?.surfaces.canvas.pipelineId || 'n/a'}</span></div>
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">nodes</span><span class="text-text-primary">{trace?.surfaces.canvas.nodeCount ?? 'n/a'}</span></div>
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">auto</span><span class="text-text-primary">{trace?.surfaces.canvas.autoRun === null ? 'n/a' : trace?.surfaces.canvas.autoRun ? 'yes' : 'no'}</span></div>
				</div>
			</div>

			<div class="rounded-md border border-surface-border bg-bg-secondary p-4">
				<div class="flex items-center gap-2 font-mono text-sm uppercase tracking-[0.16em] text-text-tertiary">
					<Icon name="clipboard" size={15} />
					<span>Kanban</span>
				</div>
				<div class="mt-4 space-y-2 font-mono text-sm">
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">bucket</span><span class="text-text-primary">{trace?.surfaces.kanban.bucket || 'n/a'}</span></div>
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">tasks</span><span class="text-text-primary">{trace?.surfaces.kanban.entry?.taskCount ?? 0}</span></div>
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">current</span><span class="truncate text-text-primary">{trace?.progress.currentTask || 'n/a'}</span></div>
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">iteration</span><span class="text-text-primary">{trace?.projectLineage?.iterationNumber ?? 'n/a'}</span></div>
				</div>
			</div>

			<div class="rounded-md border border-surface-border bg-bg-secondary p-4">
				<div class="flex items-center gap-2 font-mono text-sm uppercase tracking-[0.16em] text-text-tertiary">
					<Icon name="sparkles" size={15} />
					<span>Skills</span>
				</div>
				<div class="mt-4 space-y-2 font-mono text-sm">
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">paired</span><span class="text-text-primary">{trace?.skillPairing.pairedTaskCount ?? 0}/{trace?.skillPairing.taskCount ?? 0}</span></div>
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">ratio</span><span class="text-text-primary">{trace?.skillPairing.pairingRatio ?? 0}%</span></div>
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">source</span><span class="truncate text-text-primary">{trace?.skillPairing.source || 'n/a'}</span></div>
				</div>
			</div>

			<div class="rounded-md border border-surface-border bg-bg-secondary p-4">
				<div class="flex items-center gap-2 font-mono text-sm uppercase tracking-[0.16em] text-text-tertiary">
					<Icon name="cpu" size={15} />
					<span>Dispatch</span>
				</div>
				<div class="mt-4 space-y-2 font-mono text-sm">
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">done</span><span class="text-text-primary">{trace?.surfaces.dispatch?.allComplete ? 'yes' : 'no'}</span></div>
					<div class="flex justify-between gap-3"><span class="text-text-tertiary">failed</span><span class="text-text-primary">{trace?.surfaces.dispatch?.anyFailed ? 'yes' : 'no'}</span></div>
					{#each providerList() as provider}
						<div class="flex justify-between gap-3"><span class="text-text-tertiary">{provider.id}</span><span class="text-text-primary">{provider.status}</span></div>
					{/each}
				</div>
			</div>
		</section>

		<section class="rounded-md border border-surface-border bg-bg-secondary">
			<div class="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border px-4 py-3">
				<div class="flex items-center gap-2 font-mono text-sm uppercase tracking-[0.16em] text-text-tertiary">
					<Icon name="brain" size={15} />
					<span>Agent Black Box</span>
				</div>
				<div class="flex flex-wrap gap-2 font-mono text-xs text-text-tertiary">
					<span class="rounded border border-surface-border bg-bg-primary px-2 py-1">{trace?.agentBlackBox.counts.entries ?? 0} events</span>
					<span class="rounded border border-surface-border bg-bg-primary px-2 py-1">{trace?.agentBlackBox.counts.blocker_events ?? 0} blockers</span>
					<span class="rounded border border-surface-border bg-bg-primary px-2 py-1">{trace?.agentBlackBox.counts.memory_candidates ?? 0} memory</span>
				</div>
			</div>
			<div class="divide-y divide-surface-border">
				{#each (trace?.agentBlackBox.entries || []).slice(0, 6) as item}
					<div class="grid gap-3 px-4 py-3 md:grid-cols-[112px_168px_minmax(0,1fr)]">
						<div class="font-mono text-xs text-text-tertiary">{shortDate(item.created_at)}</div>
						<div class="min-w-0">
							<div class="truncate font-mono text-xs uppercase text-accent-primary">{item.event_type}</div>
							<div class="mt-1 truncate font-mono text-xs text-text-tertiary">{item.route_chosen || 'unknown route'}</div>
						</div>
						<div class="min-w-0">
							<div class="truncate text-sm text-text-secondary">{item.summary}</div>
							<div class="mt-1 flex flex-wrap gap-2 font-mono text-xs text-text-tertiary">
								<span>{firstSource(item)}</span>
								{#if item.changed.length > 0}<span>{item.changed[0]}</span>{/if}
								{#if item.blockers.length > 0}<span class="text-red-300">{item.blockers[0]}</span>{/if}
							</div>
						</div>
					</div>
				{:else}
					<div class="px-4 py-8 text-center text-text-tertiary">No agent events recorded</div>
				{/each}
			</div>
		</section>

		<section class="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
			<div class="rounded-md border border-surface-border bg-bg-secondary">
				<div class="border-b border-surface-border px-4 py-3 font-mono text-sm uppercase tracking-[0.16em] text-text-tertiary">Tasks</div>
				<div class="divide-y divide-surface-border">
					{#each trace?.surfaces.kanban.entry?.tasks || [] as task}
						<div class="flex items-center justify-between gap-4 px-4 py-3">
							<div class="min-w-0">
								<div class="truncate text-sm font-semibold text-text-primary">{task.title}</div>
								<div class="mt-1 truncate font-mono text-xs text-text-tertiary">{task.skills.join(', ') || 'no skills recorded'}</div>
							</div>
							<span class="rounded border border-surface-border bg-bg-primary px-2 py-1 font-mono text-xs text-text-secondary">
								{task.status || 'queued'}
							</span>
						</div>
					{:else}
						<div class="px-4 py-8 text-center text-text-tertiary">No tasks recorded</div>
					{/each}
				</div>
			</div>

			<div class="rounded-md border border-surface-border bg-bg-secondary">
				<div class="border-b border-surface-border px-4 py-3 font-mono text-sm uppercase tracking-[0.16em] text-text-tertiary">Timeline</div>
				<div class="max-h-[520px] overflow-auto divide-y divide-surface-border">
					{#each trace?.timeline || [] as item}
						<div class="grid gap-3 px-4 py-3 sm:grid-cols-[92px_128px_minmax(0,1fr)]">
							<div class="font-mono text-xs text-text-tertiary">{shortDate(item.timestamp)}</div>
							<div class="font-mono text-xs uppercase text-accent-primary">{item.eventType}</div>
							<div class="min-w-0">
								<div class="truncate text-sm text-text-secondary">{item.summary}</div>
								<div class="mt-1 font-mono text-xs text-text-tertiary">{item.source}{item.taskName ? ` · ${item.taskName}` : ''}</div>
							</div>
						</div>
					{:else}
						<div class="px-4 py-8 text-center text-text-tertiary">No timeline events</div>
					{/each}
				</div>
			</div>

			<div class="rounded-md border border-surface-border bg-bg-secondary">
				<div class="border-b border-surface-border px-4 py-3 font-mono text-sm uppercase tracking-[0.16em] text-text-tertiary">
					PRD Trace ({trace?.prdTrace?.entryCount ?? 0})
				</div>
				<div class="max-h-[520px] overflow-auto divide-y divide-surface-border">
					{#each trace?.prdTrace?.entries || [] as row}
						<div class="grid gap-3 px-4 py-3 sm:grid-cols-[92px_minmax(0,1fr)]">
							<div class="font-mono text-xs text-text-tertiary">{shortDate(typeof row.ts === 'string' ? row.ts : null)}</div>
							<div class="min-w-0">
								<div class="font-mono text-xs uppercase text-accent-primary">{row.event}</div>
								<div class="mt-1 truncate font-mono text-xs text-text-tertiary">
									{typeof row.requestId === 'string' ? row.requestId : ''}{typeof row.traceRef === 'string' ? ` · ${row.traceRef}` : ''}
								</div>
							</div>
						</div>
					{:else}
						<div class="px-4 py-8 text-center text-text-tertiary">No PRD trace entries</div>
					{/each}
				</div>
			</div>
		</section>
	</main>

	<Footer />
</div>
