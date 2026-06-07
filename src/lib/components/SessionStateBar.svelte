<script lang="ts">
	/**
	 * Session State Bar
	 *
	 * Shows the current mission/session state when returning to the project.
	 * Displays:
	 * - Current mission name and progress
	 * - Active task being worked on
	 * - Quick actions (resume, view details)
	 */

	import { missionExecutor, type ExecutionProgress } from '$lib/services/mission-executor';
	import { getActiveMissionState, hasResumableMission, type PersistedMissionState } from '$lib/services/persistence';
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';

	// Props
	interface Props {
		onOpenExecution?: () => void;
	}

	let { onOpenExecution }: Props = $props();

	// State
	let sessionState = $state<PersistedMissionState | null>(null);
	let isVisible = $state(false);

	onMount(() => {
		if (!browser) return;

		// Check for resumable mission state
		const state = getActiveMissionState();
		if (state && (state.status === 'running' || state.status === 'paused' || state.status === 'creating')) {
			sessionState = state;
			isVisible = true;
		}

		// Also check mission executor's current state
		const currentProgress = missionExecutor.getProgress();
		if (currentProgress.status !== 'idle' && currentProgress.missionId) {
			sessionState = {
				...currentProgress,
				taskProgressMap: Object.fromEntries(currentProgress.taskProgressMap),
				taskSkillMap: Object.fromEntries(currentProgress.taskSkillMap),
				startTime: currentProgress.startTime?.toISOString() || null,
				endTime: currentProgress.endTime?.toISOString() || null,
				savedAt: new Date().toISOString(),
				version: 1
			};
			isVisible = true;
		}
	});

	function getStatusColor(status: string): string {
		switch (status) {
			case 'running':
			case 'creating':
			case 'completed':
				return 'bg-accent-primary';
			case 'paused':
				return 'bg-status-amber';
			case 'failed':
				return 'bg-status-error';
			default:
				return 'bg-text-tertiary';
		}
	}

	function getStatusText(status: string): string {
		switch (status) {
			case 'running':
				return 'running';
			case 'creating':
				return 'creating';
			case 'paused':
				return 'paused';
			case 'completed':
				return 'complete';
			case 'failed':
				return 'failed';
			default:
				return status;
		}
	}

	function isLive(status: string | undefined): boolean {
		return status === 'running' || status === 'creating';
	}

	function handleResume() {
		if (onOpenExecution) {
			onOpenExecution();
		}
	}

	function handleDismiss() {
		isVisible = false;
	}
</script>

{#if isVisible && sessionState}
	<div class="px-6 py-3 border-b border-surface-border bg-bg-secondary">
		<div class="flex items-center gap-5 flex-wrap">
			<!-- Status + mission name -->
			<div class="flex items-center gap-3 min-w-0">
				{#if isLive(sessionState.status)}
					<span class="relative flex h-2.5 w-2.5 shrink-0">
						<span class="absolute inline-flex h-full w-full rounded-full bg-accent-primary opacity-60 animate-ping-slow"></span>
						<span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-accent-primary"></span>
					</span>
				{:else}
					<span class="w-2.5 h-2.5 rounded-full shrink-0 {getStatusColor(sessionState.status)}"></span>
				{/if}
				<div class="flex flex-col min-w-0">
					<span class="font-mono text-xs text-accent-primary tracking-widest uppercase">{getStatusText(sessionState.status)}</span>
					<span class="text-base font-sans font-semibold text-text-primary truncate" title={sessionState.mission?.name ?? ''}>{sessionState.mission?.name || 'Mission'}</span>
				</div>
			</div>

			<!-- Progress -->
			<div class="flex items-center gap-3 min-w-[180px] flex-1 max-w-[280px]">
				<div class="flex-1 h-1.5 rounded-full bg-surface overflow-hidden" role="progressbar" aria-valuenow={sessionState.progress} aria-valuemin="0" aria-valuemax="100" aria-label="Mission progress">
					<div
						class="h-full rounded-full bg-accent-primary transition-all duration-500 ease-out"
						style="width: {sessionState.progress}%"
					></div>
				</div>
				<span class="font-mono text-sm text-text-primary tabular-nums shrink-0">{sessionState.progress}%</span>
			</div>

			<!-- Current task -->
			{#if sessionState.currentTaskName}
				<div class="flex items-center gap-2.5 px-3 py-1.5 rounded-md bg-bg-primary/60 border border-surface-border min-w-0 max-w-[420px]">
					<span class="font-mono text-[10px] text-text-tertiary tracking-widest uppercase shrink-0">Current</span>
					<span class="text-sm text-text-secondary truncate" title={sessionState.currentTaskName}>{sessionState.currentTaskName}</span>
				</div>
			{/if}

			<!-- Actions -->
			<div class="flex items-center gap-2 ml-auto shrink-0">
				<button
					type="button"
					class="px-4 py-2 rounded-md text-sm font-semibold bg-accent-primary text-accent-fg hover:opacity-85 active:scale-[0.98] transition-all"
					onclick={handleResume}
					aria-label={`${sessionState.status === 'paused' ? 'Resume' : 'Open'} mission ${sessionState.mission?.name ?? ''}`}
				>
					{sessionState.status === 'paused' ? 'Resume' : 'Open'}
				</button>
				<button
					type="button"
					class="p-2 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface transition-all"
					onclick={handleDismiss}
					title="Dismiss"
					aria-label="Dismiss"
				>
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
		</div>
	</div>
{/if}

