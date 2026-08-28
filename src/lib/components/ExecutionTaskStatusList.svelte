<script lang="ts">
	import type { ExecutionStatus, ReconciliationResult } from '$lib/services/mission-executor';
	import {
		getNextTaskRow,
		summarizeTaskRows,
		type TaskStatusRow
	} from '$lib/services/execution-task-rows';
	import { getTaskBadgeClass, getTaskRowClass } from '$lib/services/execution-panel-formatting';

	interface ReworkTask {
		name: string;
		retry: number;
		maxRetries: number;
	}

	interface Props {
		taskRows: TaskStatusRow[];
		reworkTasks: Map<string, ReworkTask>;
		status: ExecutionStatus;
		isRunning: boolean;
		reconciliation: ReconciliationResult | null;
		error: string | null;
		nodeCount: number;
		executionDuration: string;
		showTaskList?: boolean;
		onResumePartial: () => void;
		onDismissPartial: () => void;
	}

	let {
		taskRows,
		reworkTasks,
		status,
		isRunning,
		reconciliation,
		error,
		nodeCount,
		executionDuration,
		showTaskList = true,
		onResumePartial,
		onDismissPartial
	}: Props = $props();

	let taskSummary = $derived.by(() => summarizeTaskRows(taskRows));
	let nextTask = $derived.by(() => getNextTaskRow(taskRows));
	let taskCompletionLabel = $derived(`${taskSummary.completed}/${taskRows.length} done`);

	function taskDotClass(status: TaskStatusRow['status']): string {
		if (status === 'completed') return 'bg-status-success';
		if (status === 'running') return 'bg-sky-400 shadow-[0_0_12px_rgba(56,189,248,0.45)]';
		if (status === 'failed') return 'bg-status-error';
		if (status === 'blocked') return 'bg-status-warning';
		return 'bg-text-tertiary';
	}
</script>

{#if showTaskList && taskRows.length > 0}
	<div class="mt-4 overflow-hidden rounded-lg border border-surface-border bg-bg-primary/70">
		<div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-bg-secondary border-b border-surface-border">
			<div>
				<span class="text-xs font-mono text-text-tertiary uppercase tracking-[0.16em]">Tasks</span>
				<div class="mt-1 text-sm font-semibold text-text-primary">
					{taskCompletionLabel}
				</div>
				{#if nextTask && isRunning}
					<div class="mt-1 max-w-[36rem] truncate text-[11px] font-medium text-sky-300">
						Running {nextTask.index}/{taskRows.length}: {nextTask.title}
					</div>
				{/if}
			</div>
			<div class="grid grid-cols-2 gap-1.5 text-right sm:grid-cols-4">
				<div class="min-w-16 rounded-md border border-surface-border bg-bg-primary px-2.5 py-2 transition-colors hover:border-status-success/30">
					<div class="flex items-center justify-end gap-1.5">
						<span class="h-1.5 w-1.5 rounded-full bg-status-success"></span>
						<span class="text-base font-semibold leading-none tabular-nums text-text-primary">{taskSummary.completed}</span>
					</div>
					<div class="mt-1 text-[9px] font-medium uppercase tracking-[0.1em] text-status-success/80">Done</div>
				</div>
				<div class="min-w-16 rounded-md border border-surface-border bg-bg-primary px-2.5 py-2 transition-colors hover:border-sky-400/35">
					<div class="flex items-center justify-end gap-1.5">
						<span class="h-1.5 w-1.5 rounded-full bg-sky-400"></span>
						<span class="text-base font-semibold leading-none tabular-nums text-text-primary">{taskSummary.running}</span>
					</div>
					<div class="mt-1 text-[9px] font-medium uppercase tracking-[0.1em] text-sky-300/75">Active</div>
				</div>
				<div class="min-w-16 rounded-md border border-surface-border bg-bg-primary px-2.5 py-2 transition-colors hover:border-amber-400/35">
					<div class="flex items-center justify-end gap-1.5">
						<span class="h-1.5 w-1.5 rounded-full bg-amber-300"></span>
						<span class="text-base font-semibold leading-none tabular-nums text-text-primary">{taskSummary.pending}</span>
					</div>
					<div class="mt-1 text-[9px] font-medium uppercase tracking-[0.1em] text-amber-300/75">Queued</div>
				</div>
				<div class="min-w-16 rounded-md border border-surface-border bg-bg-primary px-2.5 py-2 transition-colors hover:border-status-error/35">
					<div class="flex items-center justify-end gap-1.5">
						<span class="h-1.5 w-1.5 rounded-full bg-status-error"></span>
						<span class="text-base font-semibold leading-none tabular-nums text-text-primary">{taskSummary.failed}</span>
					</div>
					<div class="mt-1 text-[9px] font-medium uppercase tracking-[0.1em] text-status-error/75">Failed</div>
				</div>
			</div>
		</div>
		<div class="max-h-56 overflow-y-auto bg-bg-primary/80">
			{#each taskRows as task}
				<div class="relative px-4 py-2.5 border-b last:border-b-0 {getTaskRowClass(task.status)}">
					{#if task.status === 'running'}
						<span class="absolute left-0 top-0 h-full w-0.5 bg-sky-400 shadow-[0_0_18px_rgba(56,189,248,0.45)]"></span>
					{/if}
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="w-6 shrink-0 text-[10px] font-mono text-text-tertiary">#{task.index}</span>
								<span class="h-1.5 w-1.5 shrink-0 rounded-full {taskDotClass(task.status)}"></span>
								<span class="truncate text-sm font-medium text-text-primary" title={task.title}>{task.title}</span>
							</div>
							{#if task.message && task.status === 'running'}
								<div class="mt-1 text-[11px] text-text-tertiary truncate" title={task.message}>{task.message}</div>
							{/if}
							{#if task.skills.length > 0}
								<div class="mt-1 flex flex-wrap gap-1">
									{#each task.skills.slice(0, 4) as skill}
										<span class="rounded border border-surface-border bg-bg-secondary px-1.5 py-0.5 text-[10px] font-mono text-text-tertiary">
											{skill}
										</span>
									{/each}
								</div>
							{/if}
						</div>
						<span class="rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] {getTaskBadgeClass(task.status)}">
							{task.status}
						</span>
					</div>
				</div>
			{/each}
		</div>
		{#if reworkTasks.size > 0}
			<div class="px-3 py-2 bg-orange-500/5 border-t border-orange-500/20">
				{#each [...reworkTasks.entries()] as [taskId, rework]}
					<div class="flex items-center gap-2 py-0.5">
						<span class="px-1.5 py-0.5 bg-orange-500/20 border border-orange-500/40 text-orange-400 text-[10px] font-mono uppercase tracking-wider">Rework</span>
						<span class="text-xs text-text-primary font-mono">{rework.name}</span>
						<span class="text-[10px] text-orange-400/60 font-mono">retry {rework.retry}/{rework.maxRetries}</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

{#if showTaskList && status === 'completed'}
	<div class="mt-3 rounded-lg border border-surface-border bg-bg-secondary px-4 py-3">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex min-w-0 items-center gap-2">
				<span class="h-2 w-2 shrink-0 rounded-full bg-status-success"></span>
				<span class="font-sans text-sm font-semibold text-text-primary">Run finished</span>
				<span class="text-xs text-text-tertiary">
					{taskSummary.completed} task{taskSummary.completed !== 1 ? 's' : ''} in {executionDuration}
				</span>
			</div>
			<span class="rounded-md border border-status-success/25 bg-bg-primary px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-status-success">
				Ready
			</span>
		</div>
	</div>
{:else if status === 'partial'}
	<div class="mt-3 p-3 bg-status-warning/10 border border-yellow-500/30">
		<div class="flex items-center gap-2 mb-2">
			<div class="w-5 h-5 flex items-center justify-center bg-status-warning/20 border border-yellow-500/50">
				<svg class="w-3 h-3 text-status-warning" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="square" stroke-linejoin="miter" stroke-width="3" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.194-.833-2.964 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
				</svg>
			</div>
			<span class="text-status-warning font-medium font-mono uppercase tracking-wide text-sm">Mission Partially Complete</span>
		</div>
		{#if reconciliation}
			<p class="text-xs text-text-secondary">
				{reconciliation.completedTasks}/{reconciliation.totalTasks} tasks completed
				{#if reconciliation.failedTasks > 0}
					, {reconciliation.failedTasks} failed
				{/if}
			</p>
			{#if reconciliation.pendingTasks.length > 0}
				<div class="mt-2 text-xs text-status-warning/70">
					<span class="font-mono uppercase text-[10px] tracking-wider">Incomplete:</span>
					{#each reconciliation.pendingTasks as task}
						<div class="ml-2 mt-0.5 text-text-tertiary">- {task.title} <span class="text-status-warning/50">({task.status})</span></div>
					{/each}
				</div>
				<div class="mt-3 flex gap-2">
					<button
						class="px-3 py-1.5 bg-status-warning/20 border border-yellow-500/50 text-status-warning text-xs font-mono uppercase tracking-wider hover:bg-status-warning/30 transition-colors"
						onclick={onResumePartial}
					>
						Resume {reconciliation.pendingTasks.length} Pending Task{reconciliation.pendingTasks.length !== 1 ? 's' : ''}
					</button>
					<button
						class="px-3 py-1.5 bg-surface-secondary border border-surface-border text-text-secondary text-xs font-mono uppercase tracking-wider hover:bg-surface-hover transition-colors"
						onclick={onDismissPartial}
					>
						Dismiss
					</button>
				</div>
			{/if}
		{:else}
			<p class="text-xs text-text-secondary">
				Agent reported completion but some tasks were not finished.
			</p>
		{/if}
	</div>
{:else if status === 'failed'}
	<div class="mt-3 p-3 bg-status-error/10 border border-status-error/30 rounded-lg">
		<div class="flex items-center gap-2 mb-2">
			<div class="w-5 h-5 flex items-center justify-center bg-status-error/20 border border-red-500/50">
				<svg class="w-3 h-3 text-status-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="square" stroke-linejoin="miter" stroke-width="3" d="M6 6l12 12M6 18L18 6" />
				</svg>
			</div>
			<span class="text-status-error font-medium font-mono uppercase tracking-wide text-sm">Workflow Failed</span>
		</div>
		<p class="text-xs text-text-secondary">
			Completed {taskSummary.completed} of {taskRows.length || nodeCount} tasks before failure.
			{#if error}
				<br/>Error: {error}
			{/if}
		</p>
	</div>
{/if}
