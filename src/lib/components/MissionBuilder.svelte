<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		missionsState,
		currentMission,
		missionLogs,
		isLoading,
		loadMissions,
		createMission,
		loadMission,
		updateMission,
		deleteMission,
		setCurrentMission,
		startLogPolling,
		stopLogPolling,
		generateClaudeCodePrompt
	} from '$lib/stores/missions.svelte';
	import { mcpState, isConnected } from '$lib/stores/mcp.svelte';
	import { selectedAgents as selectedAgentsStore } from '$lib/stores/stack.svelte';
	import type { MissionAgent, MissionTask, MissionContext } from '$lib/services/mcp-client';

	// Form state
	let missionName = $state('');
	let missionDescription = $state('');
	let projectPath = $state('');
	let projectType = $state('saas');
	let techStack = $state('');
	let goals = $state('');
	let showPrompt = $state(false);

	// Get agents from stack store
	let agentsList = $state<Array<{id: string; name: string; role: string; skills: string[]; model?: 'sonnet' | 'opus' | 'haiku'}>>([]);

	$effect(() => {
		const unsub = selectedAgentsStore.subscribe((selected) => {
			agentsList = selected.map((a) => ({
				id: a.id,
				name: a.name,
				role: a.role,
				skills: a.skills,
				model: undefined
			}));
		});
		return unsub;
	});

	const agents = $derived(agentsList);

	// Tasks state
	let tasks: MissionTask[] = $state([]);
	let newTaskTitle = $state('');
	let newTaskDescription = $state('');
	let newTaskAssignee = $state('');
	let newTaskHandoffType = $state<MissionTask['handoffType']>('sequential');

	onMount(() => {
		if ($isConnected) {
			loadMissions();
		}
	});

	onDestroy(() => {
		stopLogPolling();
	});

	function addTask() {
		if (!newTaskTitle || !newTaskDescription || !newTaskAssignee) return;

		const task: MissionTask = {
			id: `task_${tasks.length + 1}`,
			title: newTaskTitle,
			description: newTaskDescription,
			assignedTo: newTaskAssignee,
			status: 'pending',
			handoffType: newTaskHandoffType,
			dependsOn: tasks.length > 0 ? [tasks[tasks.length - 1].id] : undefined
		};

		tasks = [...tasks, task];
		newTaskTitle = '';
		newTaskDescription = '';
	}

	function removeTask(taskId: string) {
		tasks = tasks.filter((t) => t.id !== taskId);
	}

	async function handleCreateMission() {
		if (!missionName) return;

		const context: Partial<MissionContext> = {
			projectPath: projectPath || '',
			projectType: projectType,
			techStack: techStack.split(',').map((s) => s.trim()).filter(Boolean),
			goals: goals.split('\n').map((s) => s.trim()).filter(Boolean)
		};

		const mission = await createMission({
			name: missionName,
			description: missionDescription,
			mode: 'claude-code',
			agents: agents as MissionAgent[],
			tasks: tasks,
			context
		});

		if (mission) {
			// Reset form
			missionName = '';
			missionDescription = '';
			tasks = [];
		}
	}

	async function handleDeleteMission(missionId: string) {
		if (confirm('Are you sure you want to delete this mission?')) {
			await deleteMission(missionId);
		}
	}

	function copyPromptToClipboard() {
		if ($currentMission) {
			const prompt = generateClaudeCodePrompt($currentMission);
			navigator.clipboard.writeText(prompt);
		}
	}

	function getStatusColor(status: string): string {
		switch (status) {
			case 'draft':
				return 'bg-gray-500';
			case 'ready':
				return 'bg-blue-500';
			case 'running':
				return 'bg-yellow-500';
			case 'paused':
				return 'bg-orange-500';
			case 'completed':
				return 'bg-green-500';
			case 'failed':
				return 'bg-red-500';
			default:
				return 'bg-gray-500';
		}
	}

	function getLogTypeIcon(type: string): string {
		switch (type) {
			case 'start':
				return '>';
			case 'progress':
				return '-';
			case 'handoff':
				return '>>';
			case 'complete':
				return 'v';
			case 'error':
				return 'x';
			default:
				return '*';
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h2 class="text-xl font-bold">Mission Control</h2>
		{#if !$isConnected}
			<span class="text-sm text-orange-400">Connect to MCP to manage missions</span>
		{/if}
	</div>

	{#if $isConnected}
		<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
			<!-- Mission List -->
			<div class="bg-zinc-900/50 rounded-lg p-4 border border-zinc-800">
				<h3 class="text-lg font-semibold mb-4">Your Missions</h3>

				{#if $missionsState.missions.length === 0}
					<p class="text-zinc-500 text-sm">No missions yet. Create one below.</p>
				{:else}
					<div class="space-y-2 max-h-64 overflow-y-auto">
						{#each $missionsState.missions as mission}
							<button
								type="button"
								class="w-full text-left p-3 rounded-lg border transition-colors {$currentMission?.id === mission.id
									? 'bg-violet-900/30 border-violet-500'
									: 'bg-zinc-800/50 border-zinc-700 hover:border-zinc-600'}"
								onclick={() => {
									loadMission(mission.id);
									if (mission.status === 'running') {
										startLogPolling(mission.id);
									}
								}}
							>
								<div class="flex items-center justify-between">
									<span class="font-medium">{mission.name}</span>
									<span class="text-xs px-2 py-1 rounded {getStatusColor(mission.status)}">{mission.status}</span>
								</div>
								<p class="text-xs text-zinc-500 mt-1">
									{mission.agents.length} agents, {mission.tasks.length} tasks
								</p>
							</button>
						{/each}
					</div>
				{/if}

				<!-- Refresh button -->
				<button
					type="button"
					class="mt-4 w-full py-2 px-4 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm transition-colors"
					onclick={() => loadMissions()}
					disabled={$isLoading}
				>
					{$isLoading ? 'Loading...' : 'Refresh Missions'}
				</button>
			</div>

			<!-- Current Mission / Create Form -->
			<div class="bg-zinc-900/50 rounded-lg p-4 border border-zinc-800">
				{#if $currentMission}
					<!-- Mission Details -->
					<div class="space-y-4">
						<div class="flex items-center justify-between">
							<h3 class="text-lg font-semibold">{$currentMission.name}</h3>
							<div class="flex gap-2">
								<button
									type="button"
									class="text-xs px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded"
									onclick={() => setCurrentMission(null)}
								>
									Close
								</button>
								<button
									type="button"
									class="text-xs px-2 py-1 bg-red-700 hover:bg-red-600 rounded"
									onclick={() => handleDeleteMission($currentMission!.id)}
								>
									Delete
								</button>
							</div>
						</div>

						<p class="text-sm text-zinc-400">{$currentMission.description || 'No description'}</p>

						<!-- Status -->
						<div class="flex items-center gap-2">
							<span class="text-sm">Status:</span>
							<span class="text-xs px-2 py-1 rounded {getStatusColor($currentMission.status)}">
								{$currentMission.status}
							</span>
						</div>

						<!-- Agents -->
						<div>
							<h4 class="text-sm font-medium mb-2">Agents ({$currentMission.agents.length})</h4>
							<div class="flex flex-wrap gap-2">
								{#each $currentMission.agents as agent}
									<span class="text-xs px-2 py-1 bg-violet-900/50 rounded">{agent.name}</span>
								{/each}
							</div>
						</div>

						<!-- Tasks -->
						<div>
							<h4 class="text-sm font-medium mb-2">Tasks ({$currentMission.tasks.length})</h4>
							<div class="space-y-1 max-h-32 overflow-y-auto">
								{#each $currentMission.tasks as task}
									<div class="text-xs p-2 bg-zinc-800/50 rounded flex items-center gap-2">
										<span class="w-4">{task.status === 'completed' ? 'v' : task.status === 'in_progress' ? '~' : 'o'}</span>
										<span class="flex-1">{task.title}</span>
									</div>
								{/each}
							</div>
						</div>
						<!-- Actions -->
						<div class="flex gap-2 pt-4 border-t border-zinc-700">
							<button
								type="button"
								class="flex-1 py-2 bg-violet-600 hover:bg-violet-500 rounded-lg text-sm font-medium transition-colors"
								onclick={() => (showPrompt = !showPrompt)}
							>
								{showPrompt ? 'Hide' : 'Show'} Claude Code Prompt
							</button>
						</div>

						<!-- Claude Code Prompt -->
						{#if showPrompt}
							<div class="mt-4 p-3 bg-zinc-800 rounded-lg">
								<div class="flex items-center justify-between mb-2">
									<span class="text-sm font-medium">Claude Code Prompt</span>
									<button
										type="button"
										class="text-xs px-2 py-1 bg-violet-600 hover:bg-violet-500 rounded"
										onclick={copyPromptToClipboard}
									>
										Copy
									</button>
								</div>
								<pre class="text-xs text-zinc-400 whitespace-pre-wrap max-h-48 overflow-y-auto">{generateClaudeCodePrompt($currentMission)}</pre>
							</div>
						{/if}

						<!-- Live Logs (when running) -->
						{#if $currentMission.status === 'running' && $missionLogs.length > 0}
							<div class="mt-4">
								<h4 class="text-sm font-medium mb-2">Live Logs</h4>
								<div class="space-y-1 max-h-48 overflow-y-auto bg-zinc-800/50 rounded-lg p-2">
									{#each $missionLogs as log}
										<div class="text-xs font-mono flex gap-2">
											<span class="text-zinc-600">{new Date(log.created_at).toLocaleTimeString()}</span>
											<span class="w-4">{getLogTypeIcon(log.type)}</span>
											<span class="{log.type === 'error' ? 'text-red-400' : 'text-zinc-300'}">{log.message}</span>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{:else}
					<!-- Create Mission Form -->
					<h3 class="text-lg font-semibold mb-4">Create New Mission</h3>

					<form class="space-y-4" onsubmit={(e) => { e.preventDefault(); handleCreateMission(); }}>
						<div>
							<label for="mission-name" class="block text-sm font-medium mb-1">Mission Name</label>
							<input
								id="mission-name"
								type="text"
								bind:value={missionName}
								placeholder="e.g., Build User Dashboard"
								class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none"
							/>
						</div>

						<div>
							<label for="mission-desc" class="block text-sm font-medium mb-1">Description</label>
							<textarea
								id="mission-desc"
								bind:value={missionDescription}
								placeholder="What should be built?"
								rows="2"
								class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none resize-none"
							></textarea>
						</div>

						<div class="grid grid-cols-2 gap-4">
							<div>
								<label for="project-path" class="block text-sm font-medium mb-1">Project Path</label>
								<input
									id="project-path"
									type="text"
									bind:value={projectPath}
									placeholder="/path/to/project"
									class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none"
								/>
							</div>
							<div>
								<label for="project-type" class="block text-sm font-medium mb-1">Project Type</label>
								<select
									id="project-type"
									bind:value={projectType}
									class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none"
								>
									<option value="saas">SaaS</option>
									<option value="marketplace">Marketplace</option>
									<option value="ai-app">AI App</option>
									<option value="web3">Web3</option>
									<option value="tool">Tool</option>
									<option value="other">Other</option>
								</select>
							</div>
						</div>

						<div>
							<label for="tech-stack" class="block text-sm font-medium mb-1">Tech Stack (comma separated)</label>
							<input
								id="tech-stack"
								type="text"
								bind:value={techStack}
								placeholder="e.g., Next.js, Supabase, Tailwind"
								class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none"
							/>
						</div>

						<div>
							<label for="goals" class="block text-sm font-medium mb-1">Goals (one per line)</label>
							<textarea
								id="goals"
								bind:value={goals}
								placeholder="What does success look like?"
								rows="3"
								class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none resize-none"
							></textarea>
						</div>

						<!-- Tasks -->
						<div class="border-t border-zinc-700 pt-4">
							<h4 class="text-sm font-medium mb-2">Tasks</h4>

							{#if tasks.length > 0}
								<div class="space-y-2 mb-4 max-h-32 overflow-y-auto">
									{#each tasks as task, i}
										<div class="flex items-center gap-2 p-2 bg-zinc-800/50 rounded text-sm">
											<span class="text-zinc-500">{i + 1}.</span>
											<span class="flex-1">{task.title}</span>
											<span class="text-xs text-zinc-500">{task.handoffType}</span>
											<button
												type="button"
												class="text-red-400 hover:text-red-300"
												onclick={() => removeTask(task.id)}
												aria-label={`Remove task ${i + 1}: ${task.title}`}
											><span aria-hidden="true">x</span></button>
										</div>
									{/each}
								</div>
							{/if}

							<div class="space-y-2">
								<input
									type="text"
									bind:value={newTaskTitle}
									placeholder="Task title"
									class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none"
								/>
								<textarea
									bind:value={newTaskDescription}
									placeholder="Task description"
									rows="2"
									class="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none resize-none"
								></textarea>
								<div class="flex gap-2">
									<select
										bind:value={newTaskAssignee}
										class="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none"
									>
										<option value="">Assign to agent...</option>
										{#each agents as agent}
											<option value={agent.id}>{agent.name}</option>
										{/each}
									</select>
									<select
										bind:value={newTaskHandoffType}
										class="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:border-violet-500 focus:outline-none"
									>
										<option value="sequential">Sequential</option>
										<option value="parallel">Parallel</option>
										<option value="review">Review</option>
									</select>
									<button
										type="button"
										class="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm transition-colors"
										onclick={addTask}
									>
										Add
									</button>
								</div>
							</div>
						</div>

						<!-- Submit -->
						<button
							type="submit"
							class="w-full py-3 bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 rounded-lg font-medium transition-colors"
							disabled={$isLoading || !missionName}
						>
							{$isLoading ? 'Creating...' : 'Create Mission'}
						</button>
					</form>
				{/if}
			</div>
		</div>

		<!-- Error display -->
		{#if $missionsState.error}
			<div class="p-3 bg-red-900/30 border border-red-800 rounded-lg text-sm text-red-400">
				{$missionsState.error}
			</div>
		{/if}
	{:else}
		<div class="text-center py-12 text-zinc-500">
			<p class="mb-4">Connect to the MCP server to create and manage missions.</p>
			<p class="text-sm">Use the MCP Connection panel above to connect.</p>
		</div>
	{/if}
</div>
