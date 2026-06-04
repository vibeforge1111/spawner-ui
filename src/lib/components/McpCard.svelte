<script lang="ts">
	import Icon from './Icon.svelte';
	import type { MCP } from '$lib/stores/stack.svelte';

	let { mcp, selected = false, onToggle }: { mcp: MCP; selected: boolean; onToggle: () => void } = $props();

	let showConfig = $state(false);
	let copyState = $state<'idle' | 'copied' | 'failed'>('idle');

	async function copyConfig() {
		try {
			await navigator.clipboard.writeText(mcp.configExample);
			copyState = 'copied';
		} catch {
			copyState = 'failed';
		}
		setTimeout(() => (copyState = 'idle'), 2000);
	}
</script>

<div
	class="mcp-card border rounded-lg transition-all duration-200 {selected
		? 'bg-accent-primary/10 border-accent-primary'
		: 'bg-bg-secondary border-surface-border hover:border-text-tertiary'}"
>
	<!-- Header -->
	<button class="w-full text-left p-4" onclick={onToggle}>
		<div class="flex items-start gap-3">
			<!-- Icon -->
			<div class="text-2xl flex-shrink-0">{mcp.icon}</div>

			<!-- Content -->
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-2 mb-1">
					<h3 class="font-medium text-text-primary">{mcp.name}</h3>
					{#if mcp.tier === 'premium'}
						<span class="px-1.5 py-0.5 text-[10px] font-medium bg-accent-secondary/20 text-accent-secondary">
							PRO
						</span>
					{/if}
				</div>

				<p class="text-sm text-text-secondary">{mcp.description}</p>
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

	<!-- Expandable Config Section -->
	{#if selected}
		<div class="border-t border-surface-border">
			<button
				class="w-full px-4 py-2 flex items-center justify-between text-sm text-text-secondary hover:text-text-primary transition-colors"
				onclick={() => (showConfig = !showConfig)}
			>
				<span class="font-mono text-xs">{mcp.installCommand}</span>
				<Icon name={showConfig ? 'chevron-up' : 'chevron-down'} size={14} />
			</button>

			{#if showConfig}
				<div class="px-4 pb-4">
					<div class="bg-bg-primary border border-surface-border p-3">
						<div class="flex items-center justify-between mb-2">
							<span class="text-xs text-text-tertiary font-medium">Configuration</span>
							<button
								class="text-xs text-accent-primary hover:underline"
								onclick={copyConfig}
							>
								{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Select & copy' : 'Copy'}
							</button>
						</div>
						<pre class="text-xs text-text-secondary font-mono overflow-x-auto whitespace-pre">{mcp.configExample}</pre>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
