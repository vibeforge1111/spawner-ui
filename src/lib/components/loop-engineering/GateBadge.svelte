<script lang="ts">
	import StatusBadge from './StatusBadge.svelte';
	import LoopHelp from './LoopHelp.svelte';

	interface Props {
		label: string;
		passed: boolean;
		help?: string;
		class?: string;
	}

	let { label, passed, help = '', class: className = '' }: Props = $props();
</script>

<span class="inline-flex items-center gap-1 {className}">
	<StatusBadge status={passed ? 'passed' : 'missing'} label={label} />
	{#if help}
		<LoopHelp text={help} label={`${label} help`} />
	{/if}
</span>
