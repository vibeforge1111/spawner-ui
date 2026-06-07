<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		open?: boolean;
		title?: string;
		size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
		closeOnOverlay?: boolean;
		onclose?: () => void;
		children: Snippet;
		footer?: Snippet;
	}

	let {
		open = $bindable(false),
		title = '',
		size = 'md',
		closeOnOverlay = true,
		onclose,
		children,
		footer
	}: Props = $props();

	const sizeClasses = {
		sm: 'max-w-sm',
		md: 'max-w-lg',
		lg: 'max-w-2xl',
		xl: 'max-w-4xl',
		full: 'max-w-[90vw] max-h-[90dvh]'
	};

	function handleOverlayClick() {
		if (closeOnOverlay) {
			open = false;
			onclose?.();
		}
	}

	function handleClose() {
		open = false;
		onclose?.();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			handleClose();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="overlay" onclick={handleOverlayClick}></div>

	<div
		class="modal top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full {sizeClasses[size]}"
		role="dialog"
		aria-modal="true"
		aria-labelledby={title ? 'modal-title' : undefined}
	>
		{#if title}
			<div class="flex items-center justify-between px-6 py-4 border-b border-surface-border">
				<h2 id="modal-title" class="font-serif text-lg text-text-primary">{title}</h2>
				<button
					onclick={handleClose}
					class="p-1 text-text-tertiary hover:text-text-primary transition-colors"
					aria-label="Close modal"
				>
					<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
		{/if}

		<div class="p-6 max-h-[70dvh] overflow-y-auto overscroll-contain">
			{@render children()}
		</div>

		{#if footer}
			<div class="flex justify-end gap-3 px-6 py-4 border-t border-surface-border bg-bg-primary/50">
				{@render footer()}
			</div>
		{/if}
	</div>
{/if}
