<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		variant?: 'primary' | 'secondary' | 'ghost';
		size?: 'sm' | 'md' | 'lg';
		disabled?: boolean;
		loading?: boolean;
		type?: 'button' | 'submit' | 'reset';
		onclick?: (e: MouseEvent) => void;
		class?: string;
		children: Snippet;
	}

	let {
		variant = 'primary',
		size = 'md',
		disabled = false,
		loading = false,
		type = 'button',
		onclick,
		class: className = '',
		children
	}: Props = $props();

	const variantClasses = {
		primary: 'btn-primary',
		secondary: 'btn-secondary',
		ghost: 'btn-ghost'
	};

	const sizeClasses = {
		sm: 'btn-sm',
		md: 'btn-md',
		lg: 'btn-lg'
	};
</script>

<button
	{type}
	{disabled}
	{onclick}
	class="{variantClasses[variant]} {sizeClasses[size]} {className}"
	class:opacity-50={disabled || loading}
	class:cursor-not-allowed={disabled || loading}
	aria-busy={loading ? 'true' : undefined}
	aria-disabled={disabled || loading ? 'true' : undefined}
>
	{#if loading}
		<span class="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>
		<span class="sr-only">Loading</span>
	{/if}
	{@render children()}
</button>
