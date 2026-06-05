<script lang="ts">
	import Icon from './Icon.svelte';
	import type { Agent } from '$lib/stores/stack.svelte';

	let { agent, selected = false, onToggle }: { agent: Agent; selected: boolean; onToggle: () => void } = $props();

	const roleColors: Record<string, string> = {
		planner: 'text-accent-primary',
		frontend: 'text-pink-400',
		backend: 'text-blue-400',
		database: 'text-orange-400',
		testing: 'text-green-400',
		devops: 'text-purple-400',
		payments: 'text-yellow-400',
		email: 'text-cyan-400',
		search: 'text-indigo-400',
		ai: 'text-rose-400',
		security: 'text-red-400',
		mobile: 'text-teal-400'
	};
</script>

<button
	class="agent-card w-full text-left p-4 border rounded-lg transition-all duration-200 {selected
		? 'bg-accent-primary/10 border-accent-primary'
		: 'bg-bg-secondary border-surface-border hover:border-text-tertiary'}"
	class:opacity-50={agent.required && !selected}
	onclick={onToggle}
	disabled={agent.required}
	aria-pressed={selected}
	aria-label={agent.required
		? `${agent.name} agent (required, always included)`
		: `${selected ? 'Deselect' : 'Select'} ${agent.name} agent`}
>
	<div class="flex items-start gap-3">
		<!-- Icon -->
		<div class="text-2xl flex-shrink-0" aria-hidden="true">{agent.icon}</div>

		<!-- Content -->
		<div class="flex-1 min-w-0">
			<div class="flex items-center gap-2 mb-1">
				<h3 class="font-medium text-text-primary">{agent.name}</h3>
				{#if agent.tier === 'premium'}
					<span class="px-1.5 py-0.5 text-[10px] font-medium bg-accent-secondary/20 text-accent-secondary">
						PRO
					</span>
				{/if}
				{#if agent.required}
					<span class="px-1.5 py-0.5 text-[10px] font-medium bg-accent-primary/20 text-accent-primary">
						REQUIRED
					</span>
				{/if}
			</div>

			<p class="text-sm text-text-secondary mb-2 line-clamp-2">{agent.description}</p>

			<!-- Skills -->
			<div class="flex flex-wrap gap-1">
				{#each agent.skills.slice(0, 3) as skill}
					<span class="px-1.5 py-0.5 text-[10px] font-mono bg-bg-tertiary text-text-tertiary">
						{skill}
					</span>
				{/each}
				{#if agent.skills.length > 3}
					<span class="px-1.5 py-0.5 text-[10px] font-mono text-text-tertiary">
						+{agent.skills.length - 3}
					</span>
				{/if}
			</div>
		</div>

		<!-- Toggle -->
		<div class="flex-shrink-0">
			<div
				class="w-5 h-5 border-2 flex items-center justify-center transition-colors {selected
					? 'bg-accent-primary border-accent-primary'
					: 'border-surface-border'}"
			>
				{#if selected}
					<Icon name="check" size={12} />
				{/if}
			</div>
		</div>
	</div>
</button>

<style>
	.line-clamp-2 {
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.agent-card:disabled {
		cursor: not-allowed;
	}
</style>
