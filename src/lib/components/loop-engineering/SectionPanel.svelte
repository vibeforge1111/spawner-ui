<script lang="ts">
	import type { Snippet } from 'svelte';
	import LoopHelp from './LoopHelp.svelte';
	import { Card } from '$lib/components/ui';

	interface Props {
		eyebrow?: string;
		title: string;
		help?: string;
		density?: 'compact' | 'normal';
		class?: string;
		children: Snippet;
		actions?: Snippet;
	}

	let {
		eyebrow = '',
		title,
		help = '',
		density = 'normal',
		class: className = '',
		children,
		actions
	}: Props = $props();
</script>

<Card padding="none" class="min-w-0 max-w-full {className}">
	<div class="flex flex-wrap items-start justify-between gap-3 border-b border-surface-border px-4 py-3">
		<div class="min-w-0">
			{#if eyebrow}
				<p class="font-mono text-[10px] uppercase text-text-tertiary">{eyebrow}</p>
			{/if}
			<div class="mt-1 flex min-w-0 items-center gap-2">
				<h2 class="{density === 'compact' ? 'text-base' : 'text-lg'} font-semibold text-text-bright">{title}</h2>
				{#if help}
					<LoopHelp text={help} label={`${title} help`} />
				{/if}
			</div>
	</div>
	{#if actions}
			<div class="flex w-full flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end">
				{@render actions()}
			</div>
	{/if}
	</div>
	<div class="min-w-0 {density === 'compact' ? 'p-3' : 'p-4'}">
		{@render children()}
	</div>
</Card>
