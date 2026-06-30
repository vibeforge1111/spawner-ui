<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import Navbar from '$lib/components/Navbar.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import {
		missionsState,
		loadMission,
		loadMissionLogs,
		startLogPolling,
		stopLogPolling,
		generateClaudeCodePrompt,
		type MissionsState
	} from '$lib/stores/missions.svelte';
	import { mcpState } from '$lib/stores/mcp.svelte';
	import type { Mission, MissionLog, MissionTask, MissionAgent } from '$lib/services/mcp-client';
	import type {
		MissionControlBoardEntry,
		MissionControlCompletionEvidence,
		MissionControlProjectLineage,
		MissionControlProviderResultSummary
	} from '$lib/types/mission-control';
	import {
		completionEvidenceTooltipForDisplay,
		summarizeCompletionEvidenceForDisplay
	} from '$lib/services/completion-evidence-display';
	import {
		buildSparkMissionDetail,
		buildSparkMissionDetailFromBoardEntry,
		type MissionDetailBoardEntry,
		type MissionControlEntry
	} from '$lib/services/mission-detail-view-model';
	import { canShowMissionBoardProjectActions } from '$lib/services/mission-board-cards';

	let missionId = $state('');
	let currentState = $state<MissionsState>({
		missions: [],
		currentMission: null,
		logs: [],
		loading: false,
		error: null,
		pollingInterval: null
	});
	let mcpConnected = $state(false);
	let showPrompt = $state(false);
	let copiedPrompt = $state(false);

	type MissionControlSnapshot = {
		enabled: { sparkIngest: boolean; webhooks: boolean };
		targets: { sparkIngestUrl: string | null; webhookCount: number };
		stats: { totalRelayed: number; perMission: Record<string, number> };
		recent: MissionControlEntry[];
		providerSummary?: string | null;
		providerResults?: MissionControlProviderResultSummary[];
		completionEvidence?: MissionControlCompletionEvidence | null;
		projectLineage?: MissionControlProjectLineage | null;
	};

	type MissionTraceSnapshot = {
		progress: {
			percent: number;
			taskCounts: {
				queued: number;
				running: number;
				completed: number;
				failed: number;
				cancelled: number;
				total: number;
			} | null;
			currentTask: string | null;
		};
		surfaces: {
			kanban: {
				entry:
					| (MissionDetailBoardEntry &
							Pick<
								MissionControlBoardEntry,
								'taskCount' | 'taskStatusCounts' | 'taskName' | 'lastEventType'
							>)
					| null;
			};
		};
		completionEvidence?: MissionControlCompletionEvidence | null;
		projectLineage?: MissionControlProjectLineage | null;
	};

	let missionControlLoading = $state(false);
	let missionControlError = $state<string | null>(null);
	let missionControl = $state<MissionControlSnapshot | null>(null);
	let missionTrace = $state<MissionTraceSnapshot | null>(null);
	let missionControlPoller: ReturnType<typeof setInterval> | null = null;
	let missionControlActionLoading = $state(false);
	let missionControlActionMessage = $state<string | null>(null);

	$effect(() => {
		const unsub = page.subscribe((p) => {
			missionId = p.params.id ?? '';
		});
		return unsub;
	});

	$effect(() => {
		const unsub1 = missionsState.subscribe((s) => (currentState = s));
		const unsub2 = mcpState.subscribe((s) => (mcpConnected = s.status === 'connected'));
		return () => { unsub1(); unsub2(); };
	});

	async function loadMissionControlStatus(): Promise<void> {
		if (!missionId) return;
		missionControlLoading = true;
		missionControlError = null;
		try {
			const response = await fetch(`/api/mission-control/status?missionId=${encodeURIComponent(missionId)}`);
			if (!response.ok) {
				throw new Error(`Mission control status failed (${response.status})`);
			}
			const body = await response.json();
			missionControl = (body?.snapshot || null) as MissionControlSnapshot | null;
			const traceResponse = await fetch(`/api/mission-control/trace?missionId=${encodeURIComponent(missionId)}`);
			missionTrace = traceResponse.ok ? ((await traceResponse.json()) as MissionTraceSnapshot) : null;
		} catch (error) {
			missionControlError = error instanceof Error ? error.message : 'Unable to load mission control status';
		} finally {
			missionControlLoading = false;
		}
	}

	function startMissionControlPolling(): void {
		if (missionControlPoller) return;
		missionControlPoller = setInterval(() => {
			void loadMissionControlStatus();
		}, 4000);
	}

	function stopMissionControlPolling(): void {
		if (!missionControlPoller) return;
		clearInterval(missionControlPoller);
		missionControlPoller = null;
	}

	onMount(async () => {
		await new Promise(r => setTimeout(r, 300));
		if (!missionId) return;

		// Relay always works regardless of MCP — Spark missions live there.
		await loadMissionControlStatus();
		startMissionControlPolling();

		if (mcpConnected) {
			await loadMission(missionId);
			await loadMissionLogs(missionId);
			if (currentState.currentMission?.status === 'running') {
				startLogPolling(missionId);
			}
		}
	});

	onDestroy(() => {
		stopLogPolling();
		stopMissionControlPolling();
	});

	// Reload when missionId changes
	$effect(() => {
		if (!missionId) return;
		void loadMissionControlStatus();
		startMissionControlPolling();
		if (mcpConnected && !currentState.loading) {
			loadMission(missionId);
			loadMissionLogs(missionId);
		}
	});

	function getStatusColor(status: Mission['status'] | MissionTask['status'] | 'success' | 'error'): string {
		switch (status) {
			case 'running':
			case 'in_progress': return 'text-yellow-400';
			case 'completed':
			case 'success': return 'text-green-400';
			case 'failed':
			case 'error': return 'text-red-400';
			case 'paused':
			case 'blocked': return 'text-blue-400';
			case 'ready': return 'text-accent-primary';
			default: return 'text-text-tertiary';
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

	function getLogIcon(type: MissionLog['type']): string {
		switch (type) {
			case 'start': return '>';
			case 'progress': return '-';
			case 'handoff': return '=>';
			case 'complete': return 'v';
			case 'error': return 'x';
		}
	}

	function getLogColor(type: MissionLog['type']): string {
		switch (type) {
			case 'start': return 'text-accent-primary';
			case 'progress': return 'text-text-secondary';
			case 'handoff': return 'text-accent-secondary';
			case 'complete': return 'text-green-400';
			case 'error': return 'text-red-400';
		}
	}

	function formatTime(dateStr: string): string {
		const date = new Date(dateStr);
		return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function formatDate(dateStr: string): string {
		const date = new Date(dateStr);
		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	function copyPrompt() {
		if (!currentState.currentMission) return;
		const prompt = generateClaudeCodePrompt(currentState.currentMission);
		navigator.clipboard.writeText(prompt);
		copiedPrompt = true;
		setTimeout(() => copiedPrompt = false, 2000);
	}

	const mission = $derived(currentState.currentMission);
	const logs = $derived(currentState.logs);

	const completedTasks = $derived(() => mission?.tasks.filter(t => t.status === 'completed').length ?? 0);
	const progress = $derived(() => mission && mission.tasks.length > 0 ? (completedTasks() / mission.tasks.length) * 100 : 0);
	const traceBoardEntry = $derived(missionTrace?.surfaces.kanban.entry ?? null);
	const sparkMissionDetail = $derived(
		(missionControl ? buildSparkMissionDetail(missionId, missionControl.recent) : null) ??
			buildSparkMissionDetailFromBoardEntry(missionId, traceBoardEntry)
	);
	const sparkProjectLineage = $derived(
		missionControl?.projectLineage ??
			missionTrace?.projectLineage ??
			sparkMissionDetail?.projectLineage ??
			null
	);
	const sparkCompletionEvidence = $derived(
		missionControl?.completionEvidence ?? missionTrace?.completionEvidence ?? null
	);
	const sparkProviderResults = $derived(missionControl?.providerResults ?? []);
	const sparkActivityTraceLabel = $derived(
		missionControl
			? `sparkIngest: ${missionControl.enabled.sparkIngest ? 'on' : 'off'} / webhooks: ${missionControl.targets.webhookCount}`
			: 'Mission Control board fallback'
	);
	const canShowSparkProjectActions = $derived(
		canShowMissionBoardProjectActions({
			status: sparkMissionDetail?.sparkStatus,
			projectLineage: sparkProjectLineage
		})
	);
	const traceTasks = $derived(missionTrace?.surfaces.kanban.entry?.tasks ?? []);
	const sparkTaskCounts = $derived(() => {
		const traceCounts = missionTrace?.progress.taskCounts;
		if (traceCounts) {
			return {
				total: traceCounts.total,
				completed: traceCounts.completed,
				running: traceCounts.running,
				failed: traceCounts.failed,
				cancelled: traceCounts.cancelled,
				pending: traceCounts.queued
			};
		}
		const tasks = sparkMissionDetail?.taskRollups ?? [];
		return {
			total: tasks.length,
			completed: tasks.filter((task) => task.status === 'completed').length,
			running: tasks.filter((task) => task.status === 'running').length,
			failed: tasks.filter((task) => task.status === 'failed').length,
			cancelled: tasks.filter((task) => task.status === 'cancelled').length,
			pending: tasks.filter((task) => task.status === 'pending').length
		};
	});
	const sparkProgressPercent = $derived(() => {
		if (missionTrace) return missionTrace.progress.percent;
		const counts = sparkTaskCounts();
		if (counts.total === 0) return sparkMissionDetail?.sparkStatus === 'completed' ? 100 : 0;
		return Math.round(((counts.completed + counts.failed + counts.cancelled) / counts.total) * 100);
	});
	const sparkCurrentTask = $derived(
		sparkProgressPercent() >= 100
			? null
			: missionTrace?.progress.currentTask
				? { title: missionTrace.progress.currentTask }
				: sparkMissionDetail?.taskRollups.find((task) => task.status === 'running') ||
			sparkMissionDetail?.taskRollups.find((task) => task.status === 'pending') ||
			sparkMissionDetail?.taskRollups.at(-1) ||
			null
	);
	function sparkStatusBadge(status: string): string {
		if (status === 'completed') return 'border-status-success/30 bg-status-success/10 text-status-success';
		if (status === 'failed') return 'border-status-error/30 bg-status-error/10 text-status-error';
		if (status === 'cancelled') return 'border-text-tertiary bg-bg-secondary text-text-tertiary';
		if (status === 'paused') return 'border-status-amber/30 bg-status-amber/10 text-status-amber';
		return 'border-accent-primary/30 bg-accent-primary/10 text-accent-primary';
	}

	function taskDot(status: string): string {
		if (status === 'completed') return 'bg-status-success';
		if (status === 'failed') return 'bg-status-error';
		if (status === 'cancelled') return 'bg-text-tertiary';
		if (status === 'running') return 'bg-accent-primary animate-pulse';
		return 'bg-text-faint';
	}

	function shortTime(value: string | null | undefined): string {
		if (!value) return '';
		return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function improveHref(): string {
		const params = new URLSearchParams();
		if (sparkProjectLineage?.projectPath) params.set('improveProjectPath', sparkProjectLineage.projectPath);
		params.set('parentMissionId', missionId);
		if (sparkProjectLineage?.projectId) params.set('projectId', sparkProjectLineage.projectId);
		if (sparkProjectLineage?.previewUrl) params.set('previewUrl', sparkProjectLineage.previewUrl);
		if (sparkProjectLineage?.iterationNumber) params.set('iterationNumber', String(sparkProjectLineage.iterationNumber));
		if (sparkProjectLineage?.improvementFeedback) params.set('improvementFeedback', sparkProjectLineage.improvementFeedback);
		return `/kanban?${params.toString()}`;
	}

	function sparkCanvasHref(): string {
		return `/canvas?mission=${encodeURIComponent(missionId)}`;
	}

	function evidenceLabel(evidence: MissionControlCompletionEvidence | null | undefined): string | null {
		return summarizeCompletionEvidenceForDisplay(evidence);
	}

	function evidenceTitle(evidence: MissionControlCompletionEvidence | null | undefined): string | null {
		return completionEvidenceTooltipForDisplay(evidence);
	}

	function evidenceClass(evidence: MissionControlCompletionEvidence | null | undefined): string {
		if (evidence?.state === 'complete') return 'border-status-success/30 bg-status-success/10 text-status-success';
		if (evidence?.state === 'incomplete') return 'border-status-amber/30 bg-status-amber/10 text-status-amber';
		return 'border-surface-border bg-bg-secondary text-text-secondary';
	}

	function taskProgressLabel(): string {
		const counts = sparkTaskCounts();
		return `${counts.completed}/${counts.total} task${counts.total === 1 ? '' : 's'} completed`;
	}

	function missionDateLabel(): string {
		const timestamp = sparkMissionDetail?.earliest.timestamp || mission?.created_at || null;
		return timestamp ? formatDate(timestamp) : '';
	}

	function statusLabel(status: string): string {
		if (status === 'completed') return 'Completed';
		if (status === 'running') return 'Running';
		if (status === 'failed') return 'Failed';
		if (status === 'cancelled') return 'Cancelled';
		if (status === 'paused') return 'Paused';
		if (status === 'ready' || status === 'draft') return 'Queued';
		return status;
	}

	function taskStatusText(status: string | undefined): string {
		return statusLabel(status || 'pending');
	}

	function taskStatusPill(status: string | undefined): string {
		if (status === 'completed') return 'border-status-success/30 bg-status-success/10 text-status-success';
		if (status === 'failed') return 'border-status-error/30 bg-status-error/10 text-status-error';
		if (status === 'cancelled') return 'border-text-tertiary bg-bg-primary text-text-tertiary';
		if (status === 'running') return 'border-accent-primary/30 bg-accent-primary/10 text-accent-primary';
		return 'border-surface-border bg-bg-primary text-text-tertiary';
	}

	function headerStatusPill(status: string): string {
		if (status === 'completed') return 'border-status-success/50 bg-status-success/10 text-status-success shadow-[0_0_24px_-12px_rgb(var(--accent-rgb)/0.85)]';
		if (status === 'failed') return 'border-status-error/40 bg-status-error/10 text-status-error';
		if (status === 'cancelled') return 'border-text-tertiary/40 bg-bg-primary text-text-tertiary';
		return 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary';
	}

	function headerStatusRail(status: string): string {
		if (status === 'completed') return 'bg-status-success shadow-[0_0_12px_rgb(var(--accent-rgb)/0.85)]';
		if (status === 'failed') return 'bg-status-error';
		if (status === 'cancelled') return 'bg-text-tertiary';
		return 'bg-accent-primary';
	}
</script>

<div class="min-h-screen bg-bg-primary flex flex-col">
	<Navbar />

	<main class="flex-1 max-w-6xl mx-auto w-full overflow-x-hidden px-4 py-12 sm:px-6">
		<!-- Back link -->
		<a href="/kanban" class="inline-flex items-center gap-1 text-sm font-mono text-text-tertiary hover:text-text-secondary mb-6">
			&larr; Back to Mission board
		</a>

		{#if sparkMissionDetail && (!mcpConnected || (!currentState.loading && !mission))}

			<!-- Spark mission detail: MCP has no record but relay tracked the lifecycle -->
			<section class="mb-6 rounded-md border border-surface-border bg-bg-secondary px-5 py-5">
				<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
					<div class="min-w-0">
						<div class="mb-2 flex min-w-0 flex-wrap items-center gap-3">
							<span class="h-2.5 w-2.5 shrink-0 rounded-full {taskDot(sparkMissionDetail.sparkStatus)}"></span>
							<h1 class="min-w-0 text-2xl font-sans font-semibold tracking-tight text-text-primary">{sparkMissionDetail.sparkName}</h1>
							<span class="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 font-sans text-xs font-semibold {headerStatusPill(sparkMissionDetail.sparkStatus)}">
								<span class="h-4 w-0.5 rounded-full {headerStatusRail(sparkMissionDetail.sparkStatus)}"></span>
								<Icon name="check" size={13} />
								{statusLabel(sparkMissionDetail.sparkStatus)}
							</span>
						</div>
						<p class="ml-5 flex flex-wrap items-center gap-2 font-mono text-xs text-text-secondary">
							<Icon name="clock" size={12} class="text-text-tertiary" />
							<span>{missionDateLabel()}</span>
							<span class="text-text-faint">/</span>
							<span class="break-all">{missionId}</span>
						</p>
					</div>
					<div class="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-start lg:justify-end">
						<a
							href={sparkCanvasHref()}
							class="inline-flex items-center justify-center gap-1.5 rounded-sm border border-surface-border bg-bg-primary px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-text-secondary transition-colors hover:border-iris/70 hover:text-iris"
							title="Open this mission in Canvas"
						>
							<Icon name="box" size={12} />
							Canvas
						</a>
						{#if canShowSparkProjectActions && sparkProjectLineage?.previewUrl}
							<a
								href={sparkProjectLineage.previewUrl}
								class="inline-flex items-center justify-center gap-1.5 rounded-sm border border-surface-border bg-bg-primary px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-text-secondary transition-colors hover:border-accent-primary/50 hover:text-accent-primary"
							>
								<Icon name="external-link" size={12} />
								Preview
							</a>
						{/if}
						{#if canShowSparkProjectActions && sparkProjectLineage?.projectPath}
							<a
								href={improveHref()}
								class="inline-flex items-center justify-center gap-1.5 rounded-sm border border-surface-border bg-bg-primary px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-text-secondary transition-colors hover:border-accent-primary/50 hover:text-accent-primary"
							>
								<Icon name="tool" size={12} />
								Improve
							</a>
						{/if}
					</div>
				</div>
			</section>

			<section class="mb-6 overflow-hidden rounded-md border border-surface-border bg-bg-secondary">
				<div class="px-5 py-5">
					<div class="grid gap-4 sm:flex sm:items-start sm:justify-between">
						<div class="min-w-0">
							<p class="font-mono text-xs uppercase tracking-[0.16em] text-text-tertiary">Progress</p>
							<h2 class="mt-2 text-xl font-sans font-semibold text-text-primary">
								{sparkCurrentTask ? sparkCurrentTask.title : sparkProgressPercent() >= 100 ? 'Mission complete' : 'Waiting for next task'}
							</h2>
						</div>
						<div class="text-left font-sans sm:text-right">
							<div class="text-[15px] font-medium text-text-secondary">
								<span class="font-semibold tabular-nums text-text-primary">{sparkTaskCounts().completed}/{sparkTaskCounts().total}</span>
								tasks completed
							</div>
							<div class="mt-1 text-3xl font-semibold leading-none tabular-nums text-text-primary">{sparkProgressPercent()}%</div>
						</div>
					</div>
					<div class="mission-progress-track mission-progress-main mt-4">
						<div
							class="mission-progress-fill progress-variant-clean"
							style="width: {sparkProgressPercent()}%"
						></div>
					</div>
				</div>
				<div class="grid grid-cols-2 divide-x divide-y divide-surface-border border-t border-surface-border bg-bg-primary/35 sm:grid-cols-4 sm:divide-y-0">
					<div class="px-4 py-3">
						<div class="font-mono text-[10px] uppercase tracking-wider text-text-tertiary">Completed</div>
						<div class="mt-1 text-lg font-semibold text-status-success">{sparkTaskCounts().completed}</div>
					</div>
					<div class="px-4 py-3">
						<div class="font-mono text-[10px] uppercase tracking-wider text-text-tertiary">Running</div>
						<div class="mt-1 text-lg font-semibold text-accent-primary">{sparkTaskCounts().running}</div>
					</div>
					<div class="px-4 py-3">
						<div class="font-mono text-[10px] uppercase tracking-wider text-text-tertiary">Open</div>
						<div class="mt-1 text-lg font-semibold text-text-secondary">{sparkTaskCounts().pending}</div>
					</div>
					<div class="px-4 py-3">
						<div class="font-mono text-[10px] uppercase tracking-wider text-text-tertiary">Total</div>
						<div class="mt-1 text-lg font-semibold text-text-primary">{sparkTaskCounts().total}</div>
					</div>
				</div>
			</section>

			<div id="result" class="mb-6 scroll-mt-24">
				<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
					<h2 class="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-text-bright">{canShowSparkProjectActions ? 'Project output' : 'Project target'}</h2>
				</div>
				{#if sparkProjectLineage}
					<div class="mb-3 rounded-md border border-surface-border bg-bg-secondary px-5 py-4">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div>
								<div class="font-mono text-xs font-semibold uppercase tracking-wider text-accent-primary">
									{canShowSparkProjectActions ? `Project iteration${sparkProjectLineage.iterationNumber ? ` ${sparkProjectLineage.iterationNumber}` : ''}` : 'Target project'}
								</div>
								{#if sparkProjectLineage.projectPath}
									<div class="mt-1 max-w-3xl break-all font-mono text-xs text-text-tertiary">{sparkProjectLineage.projectPath}</div>
								{/if}
							</div>
							{#if canShowSparkProjectActions && sparkProjectLineage.previewUrl}
								<a
									class="inline-flex items-center gap-1.5 rounded-md border border-accent-primary/40 bg-accent-primary/10 px-3 py-2 font-sans text-sm font-semibold text-accent-primary transition-colors hover:border-accent-primary/70 hover:bg-accent-primary/15"
									href={sparkProjectLineage.previewUrl}
								>
									<Icon name="external-link" size={14} />
									Open preview
								</a>
							{/if}
						</div>
						{#if sparkProjectLineage.improvementFeedback}
							<div class="mt-4 rounded-md border border-surface-border bg-bg-primary/60 px-4 py-3">
								<div class="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Feedback</div>
								<p class="mt-1 font-sans text-sm leading-relaxed text-text-secondary">{sparkProjectLineage.improvementFeedback}</p>
							</div>
						{/if}
					</div>
				{/if}
				{#if evidenceLabel(sparkCompletionEvidence)}
					<div class="mb-3 rounded-lg border px-4 py-3 text-sm {evidenceClass(sparkCompletionEvidence)}" title={evidenceTitle(sparkCompletionEvidence)}>
						<span class="font-mono uppercase tracking-[0.12em] text-[10px]">Evidence</span>
						<span class="ml-2 font-sans">{evidenceLabel(sparkCompletionEvidence)}</span>
					</div>
				{/if}
				{#if sparkProviderResults.length > 0}
					<div class="grid gap-3">
						{#each sparkProviderResults as result (result.providerId)}
							<article class="px-4 py-3.5 rounded-lg border border-surface-border bg-bg-secondary">
								<div class="flex items-center gap-2 mb-2">
									<span class="w-1.5 h-1.5 rounded-full shrink-0 {result.status === 'failed' ? 'bg-status-error' : result.status === 'completed' ? 'bg-status-success' : 'bg-accent-primary animate-pulse'}"></span>
									<h3 class="font-sans text-sm font-semibold text-text-primary leading-tight flex-1">{result.providerId}</h3>
									<span class="font-mono text-[10px] text-text-tertiary uppercase tracking-wider">{result.status}</span>
								</div>
								<p class="font-mono text-xs text-text-secondary leading-relaxed pl-3.5">{result.summary}</p>
								{#if result.durationMs}
									<p class="font-mono text-[10px] text-text-faint pl-3.5 mt-2">{Math.round(result.durationMs / 1000)}s</p>
								{/if}
							</article>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Per-task cards -->
			{#if sparkTaskCounts().total > 0}
				<div class="mb-6">
					<div class="mb-3 flex items-center justify-between gap-3">
						<h2 class="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-text-bright">Execution</h2>
						<span class="font-sans text-sm font-medium text-text-secondary">{taskProgressLabel()}</span>
					</div>
					<div class="grid gap-2">
						{#if traceTasks.length > 0}
							{#each traceTasks as task (task.title)}
								<article class="rounded-md border border-surface-border bg-bg-secondary px-4 py-3.5">
									<div class="flex items-center gap-2 mb-2">
										<span class="w-2 h-2 rounded-full shrink-0 {taskDot(task.status || 'pending')}"></span>
										<h3 class="font-sans text-[15px] font-semibold text-text-primary leading-tight flex-1">{task.title}</h3>
										{#if task.status !== 'completed'}
											<span class="shrink-0 rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider {taskStatusPill(task.status)}">{taskStatusText(task.status)}</span>
										{/if}
									</div>
									{#if task.skills.length > 0}
										<div class="flex items-center gap-1.5 flex-wrap pl-3.5">
											{#each task.skills.slice(0, 6) as skill}
												<span class="rounded-sm border border-surface-border/70 bg-bg-primary/70 px-2 py-0.5 font-mono text-[10px] text-text-secondary">{skill}</span>
											{/each}
										</div>
									{/if}
								</article>
							{/each}
						{:else}
							{#each sparkMissionDetail.taskRollups as task (task.key)}
							{@const dot = task.status === 'failed' ? 'bg-status-error' : task.status === 'completed' ? 'bg-status-success' : task.status === 'running' ? 'bg-accent-primary animate-pulse' : task.status === 'cancelled' ? 'bg-text-faint' : 'bg-text-tertiary'}
							<article class="rounded-md border border-surface-border bg-bg-secondary px-4 py-3.5">
								<div class="flex items-center gap-2 mb-2">
									<span class="w-2 h-2 rounded-full shrink-0 {dot}"></span>
									<h3 class="font-sans text-[15px] font-semibold text-text-primary leading-tight flex-1">{task.title}</h3>
									{#if task.status !== 'completed'}
										<span class="shrink-0 rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider {taskStatusPill(task.status)}">{taskStatusText(task.status)}</span>
									{/if}
								</div>
								{#if task.skills.length > 0}
									<div class="flex items-center gap-1.5 flex-wrap mb-2 pl-3.5">
										{#each task.skills as skill}
											<span class="rounded-sm border border-surface-border/70 bg-bg-primary/70 px-2 py-0.5 font-mono text-[10px] text-text-secondary">{skill}</span>
										{/each}
									</div>
								{/if}
								<p class="font-mono text-[10px] text-text-faint pl-3.5">
									{new Date(task.startedAt).toLocaleTimeString()}{task.updatedAt !== task.startedAt ? ` → ${new Date(task.updatedAt).toLocaleTimeString()}` : ''}
								</p>
							</article>
						{/each}
						{/if}
					</div>
				</div>
			{/if}

			<!-- Compact mission-level events -->
			{#if sparkMissionDetail.missionEvents.length > 0}
				<details class="rounded-lg border border-surface-border bg-bg-secondary">
					<summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 marker:hidden">
						<span class="font-mono text-xs font-semibold tracking-wide text-text-bright">Activity trace</span>
						<span class="font-mono text-[10px] text-text-tertiary">
							{sparkActivityTraceLabel}
						</span>
					</summary>
					<ol class="divide-y divide-surface-border/50 border-t border-surface-border">
						{#each sparkMissionDetail.missionEvents as ev (ev.timestamp + '-' + ev.eventType)}
							<li class="px-5 py-2.5 flex items-start gap-3">
								<span class="w-1.5 h-1.5 rounded-full mt-2 shrink-0 {ev.eventType.endsWith('_failed') ? 'bg-status-error' : ev.eventType.endsWith('_completed') ? 'bg-status-success' : ev.eventType.endsWith('_started') ? 'bg-accent-primary' : 'bg-text-tertiary'}"></span>
								<div class="flex-1 min-w-0">
									<span class="text-sm font-medium text-text-primary">{ev.summary}</span>
									<p class="font-mono text-[10px] text-text-faint">
										{new Date(ev.timestamp).toLocaleString()} · {ev.source}
									</p>
								</div>
							</li>
						{/each}
					</ol>
				</details>
			{/if}

			<p class="mt-4 font-mono text-[11px] text-text-faint">
				This mission was dispatched through <code class="text-accent-primary">/api/spark/run</code>; provider output is retained separately from MCP task records.
			</p>
		{:else if !mcpConnected}
			<div class="border border-surface-border rounded-lg bg-bg-secondary p-12 text-center">
				<h3 class="text-lg text-text-primary mb-2">MCP Server Offline</h3>
				<p class="text-sm text-text-secondary">Connect to view canvas mission details.</p>
				{#if missionControl && missionControl.recent.length === 0}
					<p class="text-xs font-mono text-text-tertiary mt-3">No relay activity for {missionId} either.</p>
				{/if}
			</div>
		{:else if currentState.loading}
			<div class="border border-surface-border bg-bg-secondary p-12 text-center">
				<div class="animate-pulse text-text-tertiary font-mono">Loading mission...</div>
			</div>
		{:else if currentState.error}
			<div class="border border-red-500/30 bg-red-500/10 p-6">
				<p class="text-red-400 font-mono text-sm">{currentState.error}</p>
			</div>
		{:else if !mission}
			<div class="border border-surface-border bg-bg-secondary p-12 text-center">
				<h3 class="text-lg text-text-primary mb-2">Mission Not Found</h3>
				<p class="text-sm text-text-secondary">This mission may have been deleted.</p>
			</div>
		{:else}
			<!-- Header -->
			<div class="mb-8">
				<div class="flex items-center gap-3 mb-2">
					<h1 class="text-3xl font-serif text-text-primary">{mission.name}</h1>
					<span class="px-2 py-0.5 text-xs font-mono border {getStatusBadge(mission.status)}">
						{mission.status}
					</span>
				</div>
				{#if mission.description}
					<p class="text-text-secondary">{mission.description}</p>
				{/if}
			</div>

			<!-- Progress bar -->
			{#if mission.status === 'running' || mission.status === 'completed'}
				<div class="mb-8">
					<div class="flex items-center justify-between mb-2 text-sm font-mono">
						<span class="text-text-tertiary">Progress</span>
						<span class="text-text-secondary">{completedTasks()}/{mission.tasks.length} tasks</span>
					</div>
					<div class="h-2 bg-surface-border">
						<div
							class="h-full transition-all duration-500"
							class:bg-yellow-500={mission.status === 'running'}
							class:bg-green-500={mission.status === 'completed'}
							style="width: {progress()}%"
						></div>
					</div>
				</div>
			{/if}

			<div class="grid lg:grid-cols-3 gap-6">
				<!-- Left column: Tasks & Agents -->
				<div class="lg:col-span-2 space-y-6">
					<!-- Tasks -->
					<div class="border border-surface-border bg-bg-secondary">
						<div class="p-4 border-b border-surface-border">
							<h2 class="font-medium text-text-primary">Tasks</h2>
						</div>
						<div class="divide-y divide-surface-border">
							{#each mission.tasks as task (task.id)}
								{@const agent = mission.agents.find(a => a.id === task.assignedTo)}
								<div class="p-4">
									<div class="flex items-start gap-3">
										<span class="font-mono text-sm {getStatusColor(task.status)}">
											{task.status === 'completed' ? '[x]' : task.status === 'in_progress' ? '[~]' : '[ ]'}
										</span>
										<div class="flex-1">
											<div class="flex items-center gap-2">
												<span class="text-text-primary font-medium">{task.title}</span>
												{#if agent}
													<span class="text-xs font-mono text-accent-secondary">-> {agent.name}</span>
												{/if}
											</div>
											<p class="text-sm text-text-secondary mt-1">{task.description}</p>
											{#if task.dependsOn && task.dependsOn.length > 0}
												<p class="text-xs font-mono text-text-tertiary mt-1">
													Depends on: {task.dependsOn.join(', ')}
												</p>
											{/if}
										</div>
									</div>
								</div>
							{:else}
								<div class="p-4 text-sm text-text-tertiary">No tasks defined</div>
							{/each}
						</div>
					</div>

					<!-- Agents -->
					<div class="border border-surface-border bg-bg-secondary">
						<div class="p-4 border-b border-surface-border">
							<h2 class="font-medium text-text-primary">Agents</h2>
						</div>
						<div class="grid sm:grid-cols-2 gap-3 p-4">
							{#each mission.agents as agent (agent.id)}
								<div class="p-3 border border-surface-border">
									<div class="flex items-center gap-2 mb-1">
										<span class="w-2 h-2 bg-accent-secondary rounded-full"></span>
										<span class="font-medium text-text-primary">{agent.name}</span>
									</div>
									<p class="text-xs text-text-secondary mb-2">{agent.role}</p>
									<div class="flex flex-wrap gap-1">
										{#each agent.skills as skill}
											<span class="px-1.5 py-0.5 text-xs font-mono text-accent-primary bg-accent-primary/10">
												{skill}
											</span>
										{/each}
									</div>
								</div>
							{:else}
								<div class="text-sm text-text-tertiary">No agents assigned</div>
							{/each}
						</div>
					</div>
				</div>

				<!-- Right column: Logs & Actions -->
				<div class="space-y-6">
					<!-- Actions -->
					<div class="border border-surface-border bg-bg-secondary p-4">
						<h3 class="font-medium text-text-primary mb-4">Actions</h3>
						<div class="space-y-2">
							<button
								onclick={() => showPrompt = !showPrompt}
								class="w-full px-4 py-2 font-mono text-sm text-text-secondary border border-surface-border hover:border-text-tertiary transition-all"
							>
								{showPrompt ? 'Hide' : 'Show'} Claude Code Prompt
							</button>
						</div>
					</div>

					<!-- Mission Control -->
					<div class="border border-surface-border bg-bg-secondary p-4">
						<div class="flex items-center justify-between mb-3">
							<h3 class="font-medium text-text-primary">Mission Control</h3>
							<button
								onclick={() => loadMissionControlStatus()}
								class="text-xs font-mono text-accent-primary hover:underline"
							>
								Refresh
							</button>
						</div>

						{#if missionControlLoading && !missionControl}
							<p class="text-xs font-mono text-text-tertiary">Loading mission control telemetry...</p>
						{:else if missionControlError}
							<p class="text-xs font-mono text-red-400">{missionControlError}</p>
						{:else if missionControl}
							<div class="space-y-3 text-xs font-mono">
								<div class="grid grid-cols-2 gap-2 text-text-secondary">
									<div class="border border-surface-border p-2">
										<div class="text-text-tertiary mb-1">Spark Ingest</div>
										<div class={missionControl.enabled.sparkIngest ? 'text-green-400' : 'text-text-tertiary'}>
											{missionControl.enabled.sparkIngest ? 'ENABLED' : 'DISABLED'}
										</div>
									</div>
									<div class="border border-surface-border p-2">
										<div class="text-text-tertiary mb-1">Webhooks</div>
										<div class={missionControl.enabled.webhooks ? 'text-green-400' : 'text-text-tertiary'}>
											{missionControl.targets.webhookCount}
										</div>
									</div>
								</div>

								<div class="text-text-secondary">
									Relayed for this mission: {missionControl.stats.perMission[mission.id] || 0}
								</div>

								<div class="border border-surface-border max-h-36 overflow-y-auto">
									{#if missionControl.recent.length === 0}
										<div class="p-2 text-text-tertiary">No relay events yet.</div>
									{:else}
										{#each missionControl.recent as event, index (`${event.timestamp}-${index}`)}
											<div class="px-2 py-1.5 border-b border-surface-border/60 last:border-0">
												<div class="text-text-secondary">{event.summary}</div>
												<div class="text-text-tertiary">{formatTime(event.timestamp)} • {event.source}</div>
											</div>
										{/each}
									{/if}
								</div>
							</div>
						{:else}
							<p class="text-xs font-mono text-text-tertiary">Mission control not initialized yet.</p>
						{/if}
					</div>

					<!-- Claude Code Prompt -->
					{#if showPrompt}
						<div class="border border-surface-border bg-bg-secondary">
							<div class="p-3 border-b border-surface-border flex items-center justify-between">
								<span class="text-sm font-mono text-text-tertiary">Claude Code Prompt</span>
								<button
									onclick={copyPrompt}
									class="text-xs font-mono text-accent-primary hover:underline"
								>
									{copiedPrompt ? 'Copied!' : 'Copy'}
								</button>
							</div>
							<pre class="p-3 text-xs font-mono text-text-secondary overflow-x-auto max-h-64 whitespace-pre-wrap">{generateClaudeCodePrompt(mission)}</pre>
						</div>
					{/if}

					<!-- Meta -->
					<div class="border border-surface-border bg-bg-secondary p-4">
						<h3 class="font-medium text-text-primary mb-3">Details</h3>
						<dl class="space-y-2 text-sm">
							<div class="flex justify-between">
								<dt class="text-text-tertiary">Mode</dt>
								<dd class="text-text-secondary font-mono">{mission.mode}</dd>
							</div>
							<div class="flex justify-between">
								<dt class="text-text-tertiary">Created</dt>
								<dd class="text-text-secondary font-mono">{formatDate(mission.created_at)}</dd>
							</div>
							{#if mission.started_at}
								<div class="flex justify-between">
									<dt class="text-text-tertiary">Started</dt>
									<dd class="text-text-secondary font-mono">{formatDate(mission.started_at)}</dd>
								</div>
							{/if}
							{#if mission.completed_at}
								<div class="flex justify-between">
									<dt class="text-text-tertiary">Completed</dt>
									<dd class="text-text-secondary font-mono">{formatDate(mission.completed_at)}</dd>
								</div>
							{/if}
						</dl>
					</div>

					<!-- Logs -->
					<div class="border border-surface-border bg-bg-secondary">
						<div class="p-3 border-b border-surface-border flex items-center justify-between">
							<span class="text-sm font-medium text-text-primary">Logs</span>
							<span class="text-xs font-mono text-text-tertiary">{logs.length} entries</span>
						</div>
						<div class="max-h-64 overflow-y-auto">
							{#if logs.length === 0}
								<div class="p-4 text-sm text-text-tertiary text-center">No logs yet</div>
							{:else}
								<div class="font-mono text-xs">
									{#each logs as log (log.id)}
										<div class="px-3 py-1.5 border-b border-surface-border/50 last:border-0">
											<div class="flex items-start gap-2">
												<span class="text-text-tertiary w-16 flex-shrink-0">{formatTime(log.created_at)}</span>
												<span class="{getLogColor(log.type)} w-4">{getLogIcon(log.type)}</span>
												<span class="text-text-secondary flex-1">{log.message}</span>
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				</div>
			</div>
		{/if}
	</main>

	<Footer />
</div>

<style>
	@keyframes progressStripes {
		from {
			background-position: 0 0;
		}
		to {
			background-position: 34px 0;
		}
	}

	.mission-progress-track {
		position: relative;
		overflow: hidden;
		border: 1px solid rgb(var(--accent-rgb) / 0.18);
		background:
			linear-gradient(180deg, rgb(255 255 255 / 0.035), rgb(0 0 0 / 0.08)),
			rgb(var(--bg-primary-rgb, 10 13 17) / 0.92);
		box-shadow: inset 0 0 18px rgb(0 0 0 / 0.42);
	}

	.mission-progress-main {
		height: 1rem;
		border-radius: 999px;
	}

	.mission-progress-fill {
		position: relative;
		height: 100%;
		min-width: 0.45rem;
		overflow: hidden;
		border-radius: inherit;
		background: rgb(var(--accent-rgb));
		transition: width 700ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.mission-progress-fill::before {
		content: '';
		position: absolute;
		inset: 0;
		background: repeating-linear-gradient(
			105deg,
			rgb(255 255 255 / 0.62) 0 3px,
			transparent 3px 11px
		);
		background-size: 34px 100%;
		mix-blend-mode: soft-light;
		animation: progressStripes 1.8s linear infinite;
	}

	.mission-progress-fill::after {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, rgb(255 255 255 / 0.28), transparent 48%, rgb(0 0 0 / 0.15));
		pointer-events: none;
	}

	.progress-variant-clean {
		background: rgb(var(--accent-rgb));
		box-shadow: 0 0 20px rgb(var(--accent-rgb) / 0.28);
	}
</style>
