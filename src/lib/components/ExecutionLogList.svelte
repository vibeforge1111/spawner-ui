<script lang="ts">
	import type { MissionLog } from '$lib/services/mcp-client';
	import type { ExecutionStatus, TaskTransitionEvent } from '$lib/services/mission-executor';
	import {
		filterExecutionLogsForDisplay,
		formatExecutionLogForDisplay,
		type DisplayLog
	} from '$lib/services/execution-log-display';
	import { toasts } from '$lib/stores/toast.svelte';
	import Icon from './Icon.svelte';

	interface Props {
		logs: MissionLog[];
		isRunning: boolean;
		historyMode?: boolean;
		historyLoading?: boolean;
		status?: ExecutionStatus;
		transitions?: TaskTransitionEvent[];
		formatTime?: (timestamp: string | Date) => string;
		getTransitionBadge?: (state: TaskTransitionEvent['state']) => string;
	}

	let { logs, isRunning, historyMode = false, historyLoading = false, status }: Props = $props();
	let logsContainer = $state<HTMLDivElement | undefined>(undefined);
	let displayLogs = $derived(filterExecutionLogsForDisplay(logs));

	function formatTime(dateStr: string | Date): string {
		const date = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	async function copyAllLogs(): Promise<void> {
		const logText = displayLogs.map((log) => `${formatTime(log.created_at)}  ${formatExecutionLogForDisplay(log).message}`).join('\n');
		try {
			await navigator.clipboard.writeText(logText);
			toasts.success('Logs copied to clipboard');
		} catch {
			toasts.error('Could not copy logs — clipboard is blocked. Select the log text manually.');
		}
	}

	async function copyLogMessage(log: MissionLog): Promise<void> {
		try {
			await navigator.clipboard.writeText(formatExecutionLogForDisplay(log).message);
			toasts.success('Copied');
		} catch {
			toasts.error('Could not copy — clipboard is blocked.');
		}
	}

	function getLogDotClass(display: DisplayLog): string {
		switch (display.tone) {
			case 'success':
				return 'bg-accent-primary';
			case 'error':
				return 'bg-status-error';
			case 'start':
				return 'bg-vibe-teal';
			case 'warning':
				return 'bg-status-warning';
			default:
				return 'bg-text-tertiary';
		}
	}

	function getLogRowClass(display: DisplayLog): string {
		if (display.tone === 'error') return 'border-status-error/25 bg-status-error/5';
		if (display.tone === 'warning') return 'border-status-warning/25 bg-status-warning/5';
		if (display.tone === 'success') return 'border-accent-primary/20 bg-accent-primary/[0.04]';
		return 'border-transparent hover:border-surface-border hover:bg-bg-secondary/70';
	}

	function getLogLabelClass(display: DisplayLog): string {
		if (display.tone === 'error') return 'border-status-error/30 bg-status-error/10 text-status-error';
		if (display.tone === 'warning') return 'border-status-warning/30 bg-status-warning/10 text-status-warning';
		if (display.tone === 'success') return 'border-accent-primary/25 bg-accent-primary/10 text-accent-primary';
		return 'border-vibe-teal/25 bg-vibe-teal/10 text-vibe-teal';
	}

	$effect(() => {
		if (displayLogs.length > 0 && logsContainer) {
			logsContainer.scrollTop = logsContainer.scrollHeight;
		}
	});
</script>

<div class="shrink-0 border-t border-surface-border bg-bg-primary/40">
	<div class="sticky top-0 z-10 flex items-center justify-between border-b border-surface-border bg-bg-secondary px-4 py-3">
		<div class="flex items-center gap-2">
			<svg class="w-4 h-4 text-text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16m-7 6h7" />
			</svg>
			<span class="text-xs font-mono text-text-secondary uppercase tracking-[0.14em]">Execution Log</span>
			{#if displayLogs.length > 0}
				<span class="rounded-md border border-surface-border bg-bg-primary px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-text-tertiary">{displayLogs.length}</span>
			{/if}
		</div>
		{#if displayLogs.length > 0}
			<button
				onclick={copyAllLogs}
				class="inline-flex items-center gap-1.5 rounded-md border border-surface-border bg-bg-primary px-2.5 py-1.5 text-xs font-medium text-text-tertiary transition-all hover:border-vibe-teal/50 hover:text-text-secondary"
			>
				<Icon name="copy" size={13} class="shrink-0" />
				Copy
			</button>
		{/if}
	</div>

	<div bind:this={logsContainer} class="max-h-72 min-h-36 overflow-y-auto bg-bg-primary px-3 py-3 text-sm select-text">
		{#if displayLogs.length === 0}
			<div class="flex flex-col items-center justify-center h-full py-8 text-text-tertiary">
				{#if isRunning}
					<div class="flex items-center gap-2">
						<div class="w-2 h-2 bg-vibe-teal animate-pulse"></div>
						<span>{status === 'creating' ? 'Creating mission...' : 'Starting execution...'}</span>
					</div>
				{:else if historyMode}
					<svg class="w-8 h-8 mb-2 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 6h16M4 12h16m-7 6h7" />
					</svg>
					<p class="text-sm">{historyLoading ? 'Loading mission history...' : 'No execution history found yet'}</p>
					<p class="text-xs text-text-muted mt-1">Mission logs will appear here</p>
				{:else}
					<svg class="w-8 h-8 mb-2 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 6h16M4 12h16m-7 6h7" />
					</svg>
					<p class="text-sm">Click "Run Workflow" to start execution</p>
					<p class="text-xs text-text-muted mt-1">Logs will appear here</p>
				{/if}
			</div>
		{:else}
			<div class="space-y-1.5">
				{#each displayLogs as log}
					{@const display = formatExecutionLogForDisplay(log)}
					<div class="group grid cursor-text grid-cols-[74px_8px_minmax(0,1fr)_28px] items-start gap-3 rounded-md border px-2.5 py-2.5 text-text-secondary transition-colors {getLogRowClass(display)}">
						<span class="select-text pt-0.5 font-mono text-[11px] tabular-nums leading-5 text-text-tertiary">
							{formatTime(log.created_at)}
						</span>
						<span class="mt-2 h-1.5 w-1.5 rounded-full {getLogDotClass(display)}"></span>
						<div class="min-w-0 select-text">
							{#if display.label}
								<span class="mb-1 inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] {getLogLabelClass(display)}">
									{display.label}
								</span>
							{/if}
							<p class="break-words font-sans text-sm leading-5 text-text-secondary">{display.message}</p>
						</div>
						<button
							onclick={() => copyLogMessage(log)}
							class="rounded-md p-1.5 text-xs text-text-tertiary opacity-0 transition-all hover:bg-bg-primary hover:text-vibe-teal group-hover:opacity-100"
							title="Copy this log"
							aria-label="Copy this log"
						>
							<Icon name="copy" size={13} class="shrink-0" />
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
