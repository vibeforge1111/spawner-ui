<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { Tooltip } from '$lib/components/ui';

	interface Props {
		text: string;
		label?: string;
		position?: 'top' | 'bottom' | 'left' | 'right';
		class?: string;
	}

	let { text, label = 'More context', position = 'top', class: className = '' }: Props = $props();
</script>

<Tooltip {text} {position} wrap class={className}>
	<button
		type="button"
		class="inline-flex h-5 w-5 items-center justify-center border border-surface-border bg-bg-primary text-text-tertiary transition-colors hover:border-accent-primary/40 hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
		aria-label={label}
	>
		<Icon name="info" size={12} />
	</button>
</Tooltip>
