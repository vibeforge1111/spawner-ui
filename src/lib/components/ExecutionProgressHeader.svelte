<script lang="ts">
	import type {
		AgentRuntimeStatus,
		ExecutionProgress,
		LoadedSkillInfo
	} from '$lib/services/mission-executor';
	import type { MCPRuntimeTool } from '$lib/services/mcp-runtime';
	import Icon from './Icon.svelte';
	import {
		buildTaskRowBreakdown,
		summarizeTaskRows,
		type TaskStatusRow
	} from '$lib/services/execution-task-rows';

	interface Props {
		executionProgress: ExecutionProgress;
		nodeCount: number;
		executionDuration: string;
		mcpConnectedCount: number;
		mcpTools: MCPRuntimeTool[];
		runtimeAgents: AgentRuntimeStatus[];
		currentTaskSkills: LoadedSkillInfo[];
		taskRows?: TaskStatusRow[];
		mcpDetailOpen: boolean;
		copyPromptCollapsed: boolean;
		copyToClipboard: (text: string, successMessage: string) => void;
	}

	let {
		executionProgress,
		nodeCount,
		executionDuration,
		mcpConnectedCount,
		mcpTools,
		runtimeAgents,
		currentTaskSkills,
		taskRows = [],
		mcpDetailOpen = $bindable(),
		copyPromptCollapsed = $bindable(),
		copyToClipboard
	}: Props = $props();

	let missionTaskCount = $derived(executionProgress.mission?.tasks?.length || nodeCount);
	let missionCompletedTaskCount = $derived(
		executionProgress.mission?.tasks?.filter((task) => task.status === 'completed').length || 0
	);
	let taskSummary = $derived.by(() => summarizeTaskRows(taskRows));
	let taskBreakdown = $derived.by(() => buildTaskRowBreakdown(taskRows));
	let buildRows = $derived(taskBreakdown.buildRows);
	let preparationRows = $derived(taskBreakdown.preparationRows);
	let buildSummary = $derived(taskBreakdown.buildSummary);
	let preparationSummary = $derived(taskBreakdown.preparationSummary);
	let visibleTaskRows = $derived(buildRows.length > 0 ? buildRows : taskRows);
	let hasPreparationRows = $derived(preparationRows.length > 0);
	let buildTaskCount = $derived(buildRows.length || missionTaskCount);
	let buildCompletedTaskCount = $derived(buildRows.length > 0 ? buildSummary.completed : missionCompletedTaskCount);
	let activeTaskRow = $derived.by(() => {
		const runningTasks = taskRows.filter((task) => task.status === 'running');
		return runningTasks[runningTasks.length - 1] || null;
	});
	let taskBuckets = $derived.by(() => [
		{
			key: 'completed',
			label: 'Done',
			count: buildRows.length > 0 ? buildSummary.completed : taskSummary.completed,
			tasks: visibleTaskRows.filter((task) => task.status === 'completed'),
			tone: 'text-status-success'
		},
		{
			key: 'running',
			label: 'Active',
			count: buildRows.length > 0 ? buildSummary.running : taskSummary.running,
			tasks: visibleTaskRows.filter((task) => task.status === 'running'),
			tone: 'text-sky-300'
		},
		{
			key: 'pending',
			label: 'Queued',
			count: buildRows.length > 0 ? buildSummary.pending : taskSummary.pending,
			tasks: visibleTaskRows.filter((task) => task.status === 'pending' || task.status === 'blocked'),
			tone: 'text-amber-300'
		},
		{
			key: 'failed',
			label: 'Failed',
			count: buildRows.length > 0 ? buildSummary.failed : taskSummary.failed,
			tasks: visibleTaskRows.filter((task) => task.status === 'failed'),
			tone: 'text-status-error'
		}
	]);

	function conciseTaskLabel(progress: ExecutionProgress): string {
		if (progress.currentTaskName) return progress.currentTaskName;
		if (progress.status === 'completed') return 'Run finished.';
		if (progress.status === 'failed') return progress.error || 'Mission needs attention.';
		if (progress.status === 'cancelled') return 'Mission cancelled.';
		if (progress.status === 'paused') return 'Mission paused.';
		if (progress.status === 'running' || progress.status === 'creating') return 'Preparing next task...';
		const message = progress.currentTaskMessage?.trim();
		if (!message) return 'Waiting for next task';
		if (/^Codex:\s*/i.test(message) && message.length > 90) return 'Provider summary is available in the execution log.';
		return message;
	}

	let activeTaskLabel = $derived(
		activeTaskRow?.title ||
			conciseTaskLabel(executionProgress)
	);
	let shouldShowActiveTaskLabel = $derived(
		executionProgress.status === 'running' ||
			executionProgress.status === 'creating' ||
			executionProgress.status === 'paused' ||
			executionProgress.status === 'partial'
	);
	let providerRuntimeStatus = $derived.by(() => {
		const multiPack = executionProgress.multiLLMExecution;
		if (!multiPack?.enabled) return [];

		return multiPack.providers.map((provider) => ({
			provider,
			assignment: multiPack.assignments[provider.id],
			status: runtimeAgents.find((agent) => agent.agentId === provider.id)?.status || 'assigned'
		}));
	});

	function taskDotClass(status: TaskStatusRow['status']): string {
		if (status === 'completed') return 'bg-status-success';
		if (status === 'running') return 'bg-sky-400';
		if (status === 'failed') return 'bg-status-error';
		if (status === 'blocked') return 'bg-status-warning';
		return 'bg-text-tertiary';
	}
</script>

<div class="rounded-lg border border-surface-border bg-bg-primary/65 p-4">
	<div class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
		<div class="min-w-0">
			<div class="font-mono text-[10px] uppercase tracking-[0.18em] text-text-tertiary">Execution Summary</div>
			{#if shouldShowActiveTaskLabel}
				<div class="mt-1 truncate text-xs font-mono text-text-tertiary">{activeTaskLabel}</div>
			{/if}
			<div class="mt-2 flex flex-wrap items-center gap-1.5">
				<span class="rounded border border-surface-border bg-bg-secondary px-2 py-1 text-[10px] font-mono text-text-secondary">
					<span class="text-text-tertiary">build</span>
					<span class="ml-1 font-semibold tabular-nums text-text-primary">{buildCompletedTaskCount}/{buildTaskCount}</span>
				</span>
				{#if hasPreparationRows}
				<span class="rounded border border-surface-border bg-bg-secondary px-2 py-1 text-[10px] font-mono text-text-secondary">
					<span class="text-text-tertiary">prep</span>
					<span class="ml-1 font-semibold tabular-nums text-text-primary">{preparationSummary.completed}/{preparationRows.length}</span>
				</span>
				{/if}
				<span class="rounded border border-surface-border bg-bg-secondary px-2 py-1 text-[10px] font-mono text-text-secondary">
					<span class="text-text-tertiary">elapsed</span>
					<span class="ml-1 font-semibold tabular-nums text-text-primary">{executionDuration}</span>
				</span>
				<span class="rounded border border-surface-border bg-bg-secondary px-2 py-1 text-[10px] font-mono text-text-secondary">
					<span class="text-text-tertiary">mcp</span>
					<span class="ml-1 font-semibold {mcpConnectedCount > 0 ? 'text-accent-primary' : 'text-text-primary'}">
						{mcpConnectedCount > 0 ? mcpConnectedCount : 'local'}
					</span>
				</span>
			</div>
		</div>
		<div class="flex min-h-12 min-w-20 items-center justify-center justify-self-end rounded-md border border-surface-border bg-bg-secondary px-3 py-2 text-center">
			<div class="text-xl font-semibold leading-none tabular-nums text-text-primary">
				{executionProgress.progress}<span class="ml-0.5 text-xs font-medium text-text-tertiary">%</span>
			</div>
		</div>
	</div>

	<div class="mt-4 h-2 w-full overflow-hidden rounded-full bg-surface">
		<div
			class="execution-progress-fill h-full rounded-full transition-all duration-500 ease-out"
			class:bg-accent-primary={executionProgress.status === 'completed'}
			class:bg-status-warning={executionProgress.status === 'partial'}
			class:bg-vibe-teal={executionProgress.status === 'running' || executionProgress.status === 'creating'}
			class:bg-blue-500={executionProgress.status === 'paused'}
			class:bg-status-error={executionProgress.status === 'failed'}
			class:bg-gray-500={executionProgress.status === 'cancelled'}
			style="width: {executionProgress.progress}%"
		></div>
	</div>

	{#if taskRows.length > 0}
		<div class="mt-3 rounded-md border border-surface-border bg-bg-secondary/85 px-3 py-2">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="min-w-0">
					<div class="flex min-w-0 items-center gap-2">
						<span class="shrink-0 text-[10px] font-mono uppercase tracking-[0.14em] text-text-tertiary">Task flow</span>
						<div class="flex max-w-full items-center gap-1.5 overflow-hidden">
							{#if hasPreparationRows}
								<span
									class="h-2 w-2 shrink-0 rounded-full border border-text-tertiary/50 {preparationSummary.failed > 0 ? 'bg-status-error' : preparationSummary.running > 0 ? 'bg-sky-400' : preparationSummary.completed === preparationRows.length ? 'bg-status-success' : 'bg-text-tertiary'}"
									title={`Preparation ${preparationSummary.completed}/${preparationRows.length}`}
								></span>
								<span class="h-px w-3 shrink-0 bg-surface-border"></span>
							{/if}
							{#each visibleTaskRows.slice(0, 16) as task}
								<span
									class="h-2 w-2 shrink-0 rounded-full {taskDotClass(task.status)}"
									title={`#${task.index} ${task.title} - ${task.status}`}
								></span>
							{/each}
							{#if visibleTaskRows.length > 16}
								<span class="text-[10px] font-mono text-text-tertiary">+{visibleTaskRows.length - 16}</span>
							{/if}
						</div>
						<span class="shrink-0 text-xs font-semibold tabular-nums text-text-primary">
							{buildCompletedTaskCount}/{buildTaskCount}
						</span>
					</div>
					{#if hasPreparationRows}
						<div class="mt-1 text-[10px] font-mono text-text-tertiary">
							Preparation {preparationSummary.completed}/{preparationRows.length} · Build tasks {buildCompletedTaskCount}/{buildTaskCount}
						</div>
					{/if}
				</div>

				<div class="grid grid-cols-2 gap-1.5 sm:grid-cols-4" aria-label="Task state summary">
					{#each taskBuckets as bucket}
						<div class="task-bucket relative">
							<button
								type="button"
								class="task-bucket-trigger w-full rounded-md border border-surface-border bg-bg-primary px-2.5 py-1.5 text-center outline-none transition-colors hover:border-accent-primary/30 focus-visible:border-accent-primary"
								aria-label={`${bucket.count} ${bucket.label} tasks`}
							>
								<div class="text-sm font-semibold leading-none tabular-nums text-text-primary">{bucket.count}</div>
								<div class="mt-1 text-[8.5px] font-semibold uppercase tracking-[0.08em] {bucket.tone}">
									{bucket.label}
								</div>
							</button>
							<div class="task-bucket-popover">
								<div class="mb-1 flex items-center justify-between gap-3">
									<span class="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] {bucket.tone}">
										{bucket.label}
									</span>
									<span class="text-[10px] font-mono text-text-tertiary">{bucket.count}</span>
								</div>
								{#if bucket.tasks.length > 0}
									<div class="space-y-1">
										{#each bucket.tasks.slice(0, 6) as task}
											<div class="min-w-0 rounded border border-surface-border bg-bg-secondary px-2 py-1.5">
												<div class="truncate text-xs font-medium text-text-primary">#{task.index} {task.title}</div>
												{#if task.message}
													<div class="mt-0.5 truncate text-[10px] text-text-tertiary">{task.message}</div>
												{/if}
												{#if task.skills.length > 0}
													<div class="mt-1 truncate text-[10px] font-mono text-text-tertiary">
														{task.skills.slice(0, 3).join(' / ')}
													</div>
												{/if}
											</div>
										{/each}
										{#if bucket.tasks.length > 6}
											<div class="text-[10px] font-mono text-text-tertiary">+{bucket.tasks.length - 6} more</div>
										{/if}
									</div>
								{:else}
									<div class="rounded border border-surface-border bg-bg-secondary px-2 py-2 text-xs text-text-tertiary">
										No tasks in this state.
									</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	{#if executionProgress.multiLLMExecution?.enabled}
		{@const multiPack = executionProgress.multiLLMExecution}
		<div class="mt-3 flex flex-wrap items-center gap-2 border-t border-surface-border pt-3">
			<span class="text-[10px] font-mono uppercase tracking-[0.14em] text-text-tertiary">Providers</span>
			<span class="rounded-md border border-vibe-teal/20 bg-vibe-teal/10 px-2 py-1 text-[11px] font-semibold text-vibe-teal">
				{multiPack.strategy}
			</span>
			{#each providerRuntimeStatus as item}
				<span class="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-surface-border bg-bg-secondary px-2 py-1 text-[11px] text-text-secondary">
					<span
						class="h-1.5 w-1.5 shrink-0 rounded-full"
						class:bg-vibe-teal={item.status === 'running'}
						class:bg-status-success={item.status === 'completed'}
						class:bg-red-400={item.status === 'failed'}
						class:bg-text-tertiary={!['running', 'completed', 'failed'].includes(item.status)}
					></span>
					<span class="font-semibold text-text-primary">{item.provider.label}</span>
					<span class="truncate text-text-tertiary">{item.provider.model}</span>
					<span class="rounded border border-vibe-teal/20 bg-vibe-teal/10 px-1.5 py-0.5 font-mono text-[10px] text-vibe-teal">
						{item.assignment?.taskIds?.length || 0} tasks
					</span>
				</span>
			{/each}
		</div>
	{/if}
</div>

{#if mcpConnectedCount > 0}
	<button
		class="mt-2 text-[10px] font-mono text-text-tertiary hover:text-accent-primary transition-colors text-left"
		onclick={() => (mcpDetailOpen = !mcpDetailOpen)}
	>
		{mcpDetailOpen ? '\u25BE' : '\u25B8'} {mcpTools.length} tools across {mcpConnectedCount} MCP{mcpConnectedCount > 1 ? 's' : ''}
	</button>
	{#if mcpDetailOpen}
		<div class="mt-1 pl-2 border-l border-accent-primary/30 space-y-0.5">
			{#each [...new Map(mcpTools.map((tool) => [tool.mcpName, tool])).keys()] as mcpName}
				{@const tools = mcpTools.filter((tool) => tool.mcpName === mcpName)}
				<div class="text-[10px] font-mono">
					<span class="text-accent-primary">{mcpName}</span>
					<span class="text-text-tertiary">: {tools.map((tool) => tool.toolName).join(', ')}</span>
				</div>
			{/each}
		</div>
	{/if}
{/if}

<style>
	.execution-progress-fill {
		background-image: linear-gradient(
			135deg,
			rgb(255 255 255 / 0.32) 0 18%,
			transparent 18% 50%,
			rgb(255 255 255 / 0.2) 50% 68%,
			transparent 68% 100%
		);
		background-size: 20px 20px;
	}

	.task-bucket-popover {
		position: absolute;
		right: 0;
		top: calc(100% + 8px);
		z-index: 20;
		display: none;
		width: min(280px, 72vw);
		border: 1px solid var(--border);
		border-radius: 6px;
		background: rgb(var(--bg-rgb) / 0.98);
		padding: 10px;
		text-align: left;
		box-shadow:
			0 22px 60px rgb(0 0 0 / 0.45),
			0 0 0 1px rgb(255 255 255 / 0.04);
	}

	.task-bucket:hover .task-bucket-popover,
	.task-bucket:focus-within .task-bucket-popover {
		display: block;
	}
</style>

{#if executionProgress.executionPrompt && !executionProgress.multiLLMExecution?.enabled}
	<div class="mt-3 border border-accent-primary/30 rounded-lg overflow-hidden">
		<div
			onclick={() => (copyPromptCollapsed = !copyPromptCollapsed)}
			onkeydown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					copyPromptCollapsed = !copyPromptCollapsed;
				}
			}}
			role="button"
			tabindex="0"
			aria-expanded={!copyPromptCollapsed}
			aria-label="Toggle single-LLM prompt panel"
			class="w-full flex items-center justify-between px-3 py-2 bg-accent-primary/10 hover:bg-accent-primary/15 transition-colors cursor-pointer"
		>
			<div class="flex items-center gap-2">
				<svg class="w-4 h-4 text-accent-primary transition-transform {copyPromptCollapsed ? '' : 'rotate-90'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
				</svg>
				<span class="text-xs font-mono text-accent-primary uppercase tracking-wider">Single-LLM Prompt</span>
			</div>
			<button
				class="px-3 py-1 bg-accent-primary hover:bg-accent-primary-hover text-bg-primary text-xs font-mono transition-all flex items-center gap-2"
				onclick={(event) => {
					event.stopPropagation();
					copyToClipboard(executionProgress.executionPrompt || '', 'Copied single-LLM prompt');
				}}
			>
				<Icon name="copy" size={14} class="shrink-0" />
				Copy
			</button>
		</div>
		{#if !copyPromptCollapsed}
			<div class="p-3 bg-accent-primary/5">
				<div class="max-h-32 overflow-y-auto bg-bg-primary p-2 border border-surface-border text-xs font-mono text-text-secondary select-text">
					<pre class="whitespace-pre-wrap break-all">{(executionProgress.executionPrompt || '').slice(0, 500)}{(executionProgress.executionPrompt || '').length > 500 ? '...' : ''}</pre>
				</div>
				<p class="mt-2 text-xs text-text-tertiary">
					Optional fallback only. Direct auto-run does not require copy/paste.
				</p>
			</div>
		{/if}
	</div>
{/if}

{#if executionProgress.loadedSkills && executionProgress.loadedSkills.length > 0}
	<div class="mt-5 flex items-center gap-2 px-1 font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
		<span>Skill at work</span>
	</div>
	<div
		class="group relative mt-2 flex items-center gap-4 rounded-md border border-indigo-500/35 bg-indigo-500/10 px-4 py-3 shadow-[0_18px_48px_rgba(99,102,241,0.08)] outline-none transition-colors hover:border-indigo-400/55 focus-visible:border-indigo-400/70"
		tabindex="0"
		role="button"
		aria-label={`Show ${executionProgress.loadedSkills.length} loaded skills`}
	>
		<div class="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-indigo-400/30 bg-indigo-400/10">
			{#if currentTaskSkills.length > 0}
				<svg class="w-5 h-5 text-indigo-300 animate-[hammer_0.4s_ease-in-out_infinite]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
				</svg>
				<span class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-300 animate-ping"></span>
				<span class="absolute bottom-1 left-1 h-1.5 w-1.5 rounded-full bg-indigo-200 animate-ping" style="animation-delay: 0.2s"></span>
			{:else}
				<svg class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
				</svg>
			{/if}
		</div>
		<div class="min-w-0 flex-1">
			{#if currentTaskSkills.length > 0}
				<div class="truncate text-sm font-semibold text-indigo-100">{currentTaskSkills[0].name}</div>
				<div class="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-indigo-300/75">working now</div>
			{:else}
				<div class="truncate text-sm font-semibold text-indigo-200">Skills loaded</div>
				<div class="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-indigo-300/75">waiting for active task</div>
			{/if}
		</div>
		<div class="shrink-0 rounded-md border border-indigo-400/30 bg-indigo-500/20 px-2.5 py-1 text-center">
			<div class="text-sm font-semibold tabular-nums text-indigo-100">{executionProgress.loadedSkills.length}</div>
			<div class="mt-0.5 font-mono text-[8.5px] uppercase tracking-[0.08em] text-indigo-300">skills</div>
		</div>
		<div class="absolute right-0 top-full z-30 hidden h-2 w-[min(24rem,calc(100vw-3rem))] group-hover:block group-focus-within:block"></div>
		<div class="absolute right-0 top-[calc(100%+0.5rem)] z-30 hidden w-[min(24rem,calc(100vw-3rem))] rounded-md border border-indigo-400/30 bg-bg-primary/98 p-3 text-left shadow-[0_22px_70px_rgba(0,0,0,0.42)] backdrop-blur group-hover:block group-focus-within:block">
			<div class="mb-2 flex items-center justify-between gap-3">
				<span class="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-indigo-300">Loaded skills</span>
				<span class="font-mono text-[10px] text-text-tertiary">{executionProgress.loadedSkills.length}</span>
			</div>
			<div class="max-h-56 space-y-1.5 overflow-y-auto pr-1">
				{#each executionProgress.loadedSkills as skill}
					<div class="rounded-md border border-surface-border bg-bg-secondary px-2.5 py-2">
						<div class="flex min-w-0 items-center justify-between gap-2">
							<span class="truncate text-xs font-semibold text-text-primary">{skill.name}</span>
							{#if skill.taskIds.length > 0}
								<span class="shrink-0 rounded border border-indigo-400/25 px-1.5 py-0.5 font-mono text-[9px] text-indigo-300">
									{skill.taskIds.length} task{skill.taskIds.length === 1 ? '' : 's'}
								</span>
							{/if}
						</div>
						{#if skill.description}
							<div class="mt-1 line-clamp-2 text-[10px] leading-4 text-text-tertiary">{skill.description}</div>
						{:else}
							<div class="mt-1 truncate font-mono text-[10px] text-text-tertiary">{skill.id}</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}
