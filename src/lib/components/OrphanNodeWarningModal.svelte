<script lang="ts">
	import type { CanvasNode } from '$lib/stores/canvas.svelte';

	interface Props {
		orphanedNodes: CanvasNode[];
		onDismiss: () => void;
		onAutoConnect: () => void;
		onViewOnCanvas: () => void;
		onProceed: () => void;
	}

	let { orphanedNodes, onDismiss, onAutoConnect, onViewOnCanvas, onProceed }: Props = $props();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onDismiss();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="fixed inset-0 flex items-center justify-center z-[60]" role="dialog" aria-modal="true" aria-label="Orphan node warning">
	<button class="absolute inset-0 bg-black/60" onclick={onDismiss} aria-label="Close orphan warning"></button>
	<div class="relative bg-bg-secondary border border-surface-border w-full max-w-md p-6">
		<div class="flex items-center gap-3 mb-4">
			<div class="w-10 h-10 bg-status-warning/20 border border-status-warning/30 flex items-center justify-center">
				<svg class="w-6 h-6 text-status-warning" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
					<path stroke-linecap="square" stroke-linejoin="miter" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
				</svg>
			</div>
			<div>
				<h3 class="font-serif text-lg text-text-primary">Disconnected Nodes</h3>
				<p class="text-sm text-text-secondary">{orphanedNodes.length} node{orphanedNodes.length > 1 ? 's are' : ' is'} not connected</p>
			</div>
		</div>

		<div class="mb-5 p-3 bg-bg-tertiary border border-surface-border">
			<p class="text-xs font-mono text-text-tertiary uppercase tracking-wider mb-2">Disconnected:</p>
			<ul class="space-y-1">
				{#each orphanedNodes as node}
					<li class="flex items-center gap-2 text-sm text-text-secondary">
						<span class="w-2 h-2 bg-amber-400"></span>
						<span class="font-mono">{node.skill.name}</span>
					</li>
				{/each}
			</ul>
		</div>

		<p class="text-sm text-text-secondary mb-5">
			Would you like to proceed? You can auto-connect these nodes or view the canvas to connect them manually.
		</p>

		<div class="flex flex-col gap-2">
			<button
				onclick={onAutoConnect}
				class="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-mono bg-accent-primary text-bg-primary rounded-md hover:bg-accent-primary-hover transition-all"
			>
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
				</svg>
				Auto-Connect Nodes
			</button>

			<button
				onclick={onViewOnCanvas}
				class="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-mono text-text-secondary border border-surface-border hover:border-text-tertiary rounded-md transition-all"
			>
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
				</svg>
				View on Canvas
			</button>

			<button
				onclick={onProceed}
				class="w-full px-4 py-2 text-sm font-mono text-text-tertiary hover:text-text-secondary transition-all"
			>
				Proceed Anyway
			</button>
		</div>
	</div>
</div>
