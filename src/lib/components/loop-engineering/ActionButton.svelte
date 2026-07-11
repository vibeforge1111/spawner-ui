<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { Button } from '$lib/components/ui';
	import LoopHelp from './LoopHelp.svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		variant?: 'primary' | 'secondary' | 'ghost';
		size?: 'sm' | 'md' | 'lg';
		icon?: string;
		disabled?: boolean;
		loading?: boolean;
		help?: string;
		label?: string;
		title?: string;
		type?: 'button' | 'submit' | 'reset';
		onclick?: (event: MouseEvent) => void;
		class?: string;
		children: Snippet;
	}

	let {
		variant = 'secondary',
		size = 'sm',
		icon = '',
		disabled = false,
		loading = false,
		help = '',
		label = '',
		title = '',
		type = 'button',
		onclick,
		class: className = '',
		children
	}: Props = $props();
</script>

<span class="inline-flex items-center gap-1">
	<Button {variant} {size} {disabled} {loading} {type} {onclick} class={className} title={title || help} ariaLabel={label}>
		{#if icon}
			<Icon name={icon} size={14} />
		{/if}
		{@render children()}
	</Button>
	{#if help}
		<LoopHelp text={help} />
	{/if}
</span>
