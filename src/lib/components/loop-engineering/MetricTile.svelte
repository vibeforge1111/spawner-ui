<script lang="ts">
	import LoopHelp from './LoopHelp.svelte';

	interface Props {
		label: string;
		value: string | number | null | undefined;
		help?: string;
		tone?: 'default' | 'success' | 'warning' | 'error';
		class?: string;
	}

	let { label, value, help = '', tone = 'default', class: className = '' }: Props = $props();

	const toneClasses = {
		default: 'text-text-bright',
		success: 'text-status-success',
		warning: 'text-status-warning',
		error: 'text-status-error'
	};
</script>

<div class="min-w-0 border border-surface-border bg-bg-primary p-3 {className}">
	<div class="flex items-center gap-1">
		<p class="truncate font-mono text-[10px] uppercase text-text-tertiary">{label}</p>
		{#if help}
			<LoopHelp text={help} label={`${label} help`} />
		{/if}
	</div>
	<p class="mt-2 truncate text-2xl font-semibold {toneClasses[tone]}" title={String(value ?? 'n/a')}>
		{value ?? 'n/a'}
	</p>
</div>
