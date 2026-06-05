<script lang="ts">
	import type { Service } from '$lib/types/dashboard';

	interface Props {
		service: Service;
		onRemove: () => void;
		onSelect: () => void;
	}

	let { service, onRemove, onSelect }: Props = $props();

	function getStatusColor(status: string): string {
		switch (status) {
			case 'healthy': return 'bg-green-500';
			case 'degraded': return 'bg-yellow-500';
			case 'down': return 'bg-red-500';
			default: return 'bg-gray-500';
		}
	}

	function getStatusBorder(status: string): string {
		switch (status) {
			case 'healthy': return 'border-green-500/30';
			case 'degraded': return 'border-yellow-500/30';
			case 'down': return 'border-red-500/30';
			default: return 'border-surface-border';
		}
	}

	function formatTime(date: Date | null): string {
		if (!date) return 'Never';
		return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}
</script>

<div
	class="p-4 bg-bg-secondary border {getStatusBorder(service.status)} hover:border-text-tertiary transition-all cursor-pointer group"
	onclick={onSelect}
	role="button"
	tabindex="0"
	onkeydown={(e) => e.key === 'Enter' && onSelect()}
>
	<!-- Header -->
	<div class="flex items-start justify-between mb-3">
		<div class="flex items-center gap-2">
			<div class="w-3 h-3 rounded-full {getStatusColor(service.status)} {service.status === 'healthy' ? '' : 'animate-pulse'}"></div>
			<h3 class="font-mono text-sm text-text-primary truncate">{service.name}</h3>
		</div>
		<button
			onclick={(e) => { e.stopPropagation(); onRemove(); }}
			class="p-1 text-text-tertiary hover:text-red-400 transition-all [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
			title="Remove service"
			aria-label="Remove service"
		>
			<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
			</svg>
		</button>
	</div>

	<!-- Status Badge -->
	<div class="mb-3">
		<span class="px-2 py-0.5 text-xs font-mono uppercase tracking-wider {
			service.status === 'healthy' ? 'bg-green-500/20 text-green-400' :
			service.status === 'degraded' ? 'bg-yellow-500/20 text-yellow-400' :
			service.status === 'down' ? 'bg-red-500/20 text-red-400' :
			'bg-gray-500/20 text-gray-400'
		}">
			{service.status}
		</span>
	</div>

	<!-- URL (truncated) -->
	<p class="text-xs text-text-tertiary font-mono truncate mb-3" title={service.url}>
		{service.url}
	</p>

	<!-- Stats -->
	<div class="grid grid-cols-3 gap-2 text-center">
		<div>
			<p class="text-xs text-text-tertiary">Response</p>
			<p class="text-sm font-mono text-text-primary">
				{service.lastResponseTime !== null ? `${service.lastResponseTime}ms` : '-'}
			</p>
		</div>
		<div>
			<p class="text-xs text-text-tertiary">Uptime</p>
			<p class="text-sm font-mono text-accent-primary">{service.uptimePercentage}%</p>
		</div>
		<div>
			<p class="text-xs text-text-tertiary">Last Check</p>
			<p class="text-sm font-mono text-text-secondary">{formatTime(service.lastCheck)}</p>
		</div>
	</div>
</div>
