<script lang="ts">
	import { toasts, type Toast } from '$lib/stores/toast.svelte';

	let currentToasts = $state<Toast[]>([]);

	$effect(() => {
		const unsub = toasts.subscribe((t) => (currentToasts = t));
		return unsub;
	});

	function getTypeStyles(type: Toast['type']): string {
		switch (type) {
			case 'success':
				return 'bg-green-900/90 border-green-500/50 text-green-100';
			case 'error':
				return 'bg-red-900/90 border-red-500/50 text-red-100';
			case 'warning':
				return 'bg-yellow-900/90 border-yellow-500/50 text-yellow-100';
			case 'info':
			default:
				return 'bg-blue-900/90 border-blue-500/50 text-blue-100';
		}
	}

	function getIcon(type: Toast['type']): string {
		switch (type) {
			case 'success':
				return '✓';
			case 'error':
				return '✗';
			case 'warning':
				return '⚠';
			case 'info':
			default:
				return 'ℹ';
		}
	}
</script>

{#if currentToasts.length > 0}
	<div class="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-md" aria-label="Notifications">
		{#each currentToasts as toast (toast.id)}
			<div
				class="flex items-start gap-3 p-4 border rounded shadow-lg backdrop-blur-sm animate-slide-in {getTypeStyles(toast.type)}"
				role={toast.type === 'error' || toast.type === 'warning' ? 'alert' : 'status'}
				aria-live={toast.type === 'error' || toast.type === 'warning' ? 'assertive' : 'polite'}
			>
				<span class="text-lg flex-shrink-0" aria-hidden="true">{getIcon(toast.type)}</span>
				<div class="flex-1 min-w-0">
					<p class="text-sm font-mono">{toast.message}</p>
					{#if toast.action}
						<button
							onclick={() => {
								toast.action?.onClick();
								toasts.remove(toast.id);
							}}
							class="mt-2 text-xs font-mono underline hover:no-underline"
						>
							{toast.action.label}
						</button>
					{/if}
				</div>
				<button
					onclick={() => toasts.remove(toast.id)}
					class="text-current opacity-60 hover:opacity-100 flex-shrink-0"
					aria-label="Dismiss"
				>
					×
				</button>
			</div>
		{/each}
	</div>
{/if}

<style>
	@keyframes slide-in {
		from {
			opacity: 0;
			transform: translateX(100%);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	.animate-slide-in {
		animation: slide-in 0.2s ease-out;
	}
</style>
