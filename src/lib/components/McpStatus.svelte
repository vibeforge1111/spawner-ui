<script lang="ts">
	import { mcpState, connect, disconnect, connectLocal } from '$lib/stores/mcp.svelte';

	let showDropdown = $state(false);

	async function handleConnect() {
		await connectLocal();
	}

	function toggleDropdown() {
		showDropdown = !showDropdown;
	}

	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (!target.closest('.mcp-status-container')) {
			showDropdown = false;
		}
	}

	$effect(() => {
		if (!showDropdown) {
			return;
		}
		document.addEventListener('click', handleClickOutside);
		return () => document.removeEventListener('click', handleClickOutside);
	});

	const statusConfig = {
		disconnected: { color: 'bg-text-tertiary', text: 'Disconnected', pulse: false },
		connecting: { color: 'bg-status-warning', text: 'Connecting...', pulse: true },
		connected: { color: 'bg-status-success', text: 'Connected', pulse: false },
		error: { color: 'bg-status-error', text: 'Error', pulse: false }
	};

	const status = $derived(statusConfig[$mcpState.status]);
</script>

<div class="mcp-status-container relative">
	<!-- Status Button -->
	<button
		type="button"
		class="flex items-center gap-2 px-3 py-1.5 border transition-colors
			{$mcpState.status === 'connected'
				? 'border-status-success/30 bg-status-success-bg text-status-success'
				: $mcpState.status === 'error'
					? 'border-status-error/30 bg-status-error-bg text-status-error'
					: 'border-surface-border bg-bg-secondary text-text-secondary hover:bg-surface-hover'}"
		onclick={toggleDropdown}
		aria-haspopup="menu"
		aria-expanded={showDropdown}
		aria-label={`MCP server: ${status.text}`}
	>
		<div class="w-1.5 h-1.5 {status.color} {status.pulse ? 'animate-pulse' : ''}" aria-hidden="true"></div>
		<span class="text-xs font-medium">MCP</span>
		{#if $mcpState.status === 'connected'}
			<span class="text-xs text-text-tertiary">{$mcpState.tools.length}</span>
		{/if}
	</button>

	<!-- Dropdown -->
	{#if showDropdown}
		<div class="absolute right-0 top-full mt-1 w-72 bg-bg-secondary border border-surface-border shadow-lg z-50 animate-fade-in">
			<!-- Header -->
			<div class="flex items-center justify-between px-4 py-3 border-b border-surface-border">
				<span class="text-sm font-medium text-text-primary">MCP Server</span>
				<span class="text-xs px-2 py-0.5 border
					{$mcpState.status === 'connected'
						? 'border-status-success/30 bg-status-success-bg text-status-success'
						: $mcpState.status === 'error'
							? 'border-status-error/30 bg-status-error-bg text-status-error'
							: 'border-surface-border bg-bg-tertiary text-text-secondary'}">
					{status.text}
				</span>
			</div>

			<!-- Content -->
			<div class="p-4">
				{#if $mcpState.status === 'connected'}
					<div class="space-y-3">
						<div class="space-y-2 text-xs">
							<div class="flex items-center justify-between">
								<span class="text-text-tertiary">Server</span>
								<code class="px-1.5 py-0.5 bg-bg-tertiary text-text-secondary font-mono">
									{$mcpState.serverInfo?.name} v{$mcpState.serverInfo?.version}
								</code>
							</div>
							<div class="flex items-center justify-between">
								<span class="text-text-tertiary">Tools</span>
								<span class="text-status-success">{$mcpState.tools.length} available</span>
							</div>
							<div class="flex items-center justify-between">
								<span class="text-text-tertiary">Endpoint</span>
								<code class="px-1.5 py-0.5 bg-bg-tertiary text-text-tertiary font-mono text-[10px]">
									{$mcpState.baseUrl}
								</code>
							</div>
						</div>

						<button
							type="button"
							class="w-full py-2 text-xs font-medium border border-surface-border bg-bg-tertiary text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors"
							onclick={() => { disconnect(); showDropdown = false; }}
						>
							Disconnect
						</button>
					</div>

				{:else if $mcpState.status === 'error'}
					<div class="space-y-3">
						<p class="text-xs text-status-error">{$mcpState.error}</p>
						<button
							type="button"
							class="w-full py-2 text-xs font-medium bg-accent-primary text-bg-primary hover:bg-accent-primary-hover transition-colors"
							onclick={handleConnect}
						>
							Retry Connection
						</button>
					</div>

				{:else if $mcpState.status === 'connecting'}
					<div class="flex items-center gap-3 py-2">
						<div class="w-3 h-3 border-2 border-surface-border border-t-accent-primary animate-spin"></div>
						<span class="text-xs text-text-secondary">Connecting to {$mcpState.baseUrl}</span>
					</div>

				{:else}
					<div class="space-y-3">
						<p class="text-xs text-text-tertiary">
							Connect to the MCP server to access missions and live skill updates.
						</p>
						<button
							type="button"
							class="w-full py-2 text-xs font-medium bg-accent-primary text-bg-primary hover:bg-accent-primary-hover transition-colors"
							onclick={handleConnect}
						>
							Connect to Local Server
						</button>
						<div class="text-[10px] text-text-tertiary text-center">
				not configured
						</div>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
