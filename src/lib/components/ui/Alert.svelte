<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		variant?: 'info' | 'success' | 'warning' | 'error';
		title?: string;
		dismissible?: boolean;
		class?: string;
		ondismiss?: () => void;
		children: Snippet;
	}

	let {
		variant = 'info',
		title = '',
		dismissible = false,
		class: className = '',
		ondismiss,
		children
	}: Props = $props();

	let visible = $state(true);

	const variantClasses = {
		info: 'bg-status-info-bg border-status-info text-status-info',
		success: 'bg-status-success-bg border-status-success text-status-success',
		warning: 'bg-status-warning-bg border-status-warning text-status-warning',
		error: 'bg-status-error-bg border-status-error text-status-error'
	};

	const iconPaths = {
		info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
		success: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
		warning: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
		error: 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z'
	};

	function handleDismiss() {
		visible = false;
		ondismiss?.();
	}
</script>

{#if visible}
	<div
		class="flex items-start gap-3 p-4 border {variantClasses[variant]} {className}"
		role={variant === 'error' || variant === 'warning' ? 'alert' : 'status'}
	>
		<svg class="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={iconPaths[variant]} />
		</svg>

		<div class="flex-1 min-w-0">
			{#if title}
				<h4 class="font-medium mb-1">{title}</h4>
			{/if}
			<div class="text-sm opacity-90">
				{@render children()}
			</div>
		</div>

		{#if dismissible}
			<button
				onclick={handleDismiss}
				class="flex-shrink-0 p-1 hover:opacity-75 transition-opacity"
				aria-label="Dismiss"
			>
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		{/if}
	</div>
{/if}
