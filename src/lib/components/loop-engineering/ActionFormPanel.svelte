<script lang="ts">
	import type { Snippet } from 'svelte';
	import ActionButton from './ActionButton.svelte';
	import LoopHelp from './LoopHelp.svelte';

	interface Props {
		title: string;
		help?: string;
		buttonLabel: string;
		disabled?: boolean;
		loading?: boolean;
		openByDefault?: boolean;
		onsubmit?: () => void | Promise<void>;
		children: Snippet;
	}

	let {
		title,
		help = '',
		buttonLabel,
		disabled = false,
		loading = false,
		openByDefault = false,
		onsubmit,
		children
	}: Props = $props();

	let open = $state(false);
	let syncedOpenDefault = $state(false);

	$effect(() => {
		if (openByDefault && !syncedOpenDefault) {
			open = true;
			syncedOpenDefault = true;
		}
	});
</script>

<div class="border border-surface-border bg-bg-primary">
	<div class="flex items-center justify-between gap-3 px-3 py-2 hover:bg-bg-secondary">
		<div class="flex min-w-0 items-center gap-2">
			<button
				type="button"
				class="min-w-0 truncate text-left text-sm font-medium text-text-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
				aria-expanded={open}
				onclick={() => (open = !open)}
			>
				{title}
			</button>
			{#if help}
				<LoopHelp text={help} label={`${title} help`} />
			{/if}
		</div>
		<button
			type="button"
			class="shrink-0 font-mono text-xs text-text-tertiary hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
			aria-label={`${open ? 'Hide' : 'Show'} ${title}`}
			aria-expanded={open}
			onclick={() => (open = !open)}
		>
			{open ? 'hide' : 'show'}
		</button>
	</div>
	{#if open}
		<form
			class="grid gap-2 border-t border-surface-border p-3"
			onsubmit={(event) => {
				event.preventDefault();
				onsubmit?.();
			}}
		>
			{@render children()}
			<ActionButton
				type="submit"
				variant="secondary"
				size="sm"
				{disabled}
				{loading}
				label={buttonLabel}
				help={help || `Submit ${title}.`}
			>
				{buttonLabel}
			</ActionButton>
		</form>
	{/if}
</div>
