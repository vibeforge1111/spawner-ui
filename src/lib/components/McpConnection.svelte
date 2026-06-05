<script lang="ts">
	import { mcpState, connect, disconnect, setMcpUrl, connectLocal, connectProduction } from '$lib/stores/mcp.svelte';
	import { loadSkills, skillSource } from '$lib/stores/skills.svelte';

	let customUrl = $state($mcpState.baseUrl);
	let showAdvanced = $state(false);

	async function handleConnect() {
		const success = await connect();
		if (success) {
			// Reload skills from MCP
			await loadSkills();
		}
	}

	async function handleConnectLocal() {
		const success = await connectLocal();
		if (success) {
			await loadSkills();
		}
	}

	async function handleConnectProduction() {
		const success = await connectProduction();
		if (success) {
			await loadSkills();
		}
	}

	function handleDisconnect() {
		disconnect();
	}

	function handleCustomUrl() {
		setMcpUrl(customUrl);
	}

	const statusColor = $derived({
		disconnected: 'bg-gray-500',
		connecting: 'bg-yellow-500 animate-pulse',
		connected: 'bg-green-500',
		error: 'bg-red-500'
	}[$mcpState.status]);

	const statusText = $derived({
		disconnected: 'Disconnected',
		connecting: 'Connecting...',
		connected: 'Connected',
		error: 'Error'
	}[$mcpState.status]);
</script>

<div class="rounded-lg border border-gray-700 bg-gray-800/50 p-4">
	<div class="flex items-center justify-between mb-3">
		<div class="flex items-center gap-2">
			<div class="w-2.5 h-2.5 rounded-full {statusColor}"></div>
			<span class="text-sm font-medium text-gray-200">MCP Server</span>
			<span class="text-xs text-gray-400">({statusText})</span>
		</div>

		{#if $mcpState.status === 'connected'}
			<button
				onclick={handleDisconnect}
				class="px-3 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
			>
				Disconnect
			</button>
		{/if}
	</div>

	{#if $mcpState.status === 'connected'}
		<div class="space-y-2 text-sm">
			<div class="flex items-center gap-2 text-gray-400">
				<span>Server:</span>
				<code class="text-xs bg-gray-900 px-2 py-0.5 rounded">{$mcpState.serverInfo?.name} v{$mcpState.serverInfo?.version}</code>
			</div>
			<div class="flex items-center gap-2 text-gray-400">
				<span>Tools:</span>
				<span class="text-green-400">{$mcpState.tools.length} available</span>
			</div>
			<div class="flex items-center gap-2 text-gray-400">
				<span>Skills source:</span>
				<span class="text-blue-400 capitalize">{$skillSource}</span>
			</div>
		</div>
	{:else if $mcpState.status === 'error'}
		<div class="mb-3">
			<p class="text-sm text-red-400 mb-2">{$mcpState.error}</p>
		</div>
		<div class="flex gap-2">
			<button
				onclick={handleConnectLocal}
				class="flex-1 px-3 py-2 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
			>
				Retry Local
			</button>
			<button
				onclick={() => showAdvanced = !showAdvanced}
				class="px-3 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
			>
				{showAdvanced ? 'Hide' : 'Advanced'}
			</button>
		</div>
	{:else if $mcpState.status === 'connecting'}
		<div class="flex items-center gap-2 text-gray-400">
			<div class="w-4 h-4 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin"></div>
			<span class="text-sm">Connecting to {$mcpState.baseUrl}...</span>
		</div>
	{:else}
		<p class="text-sm text-gray-400 mb-3">
			Connect to the Spawner MCP server to access live skills and tools.
		</p>

		<div class="flex gap-2 mb-3">
			<button
				onclick={handleConnectLocal}
				class="flex-1 px-3 py-2 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
			>
				Connect Local
			</button>
			<button
				onclick={handleConnectProduction}
				class="flex-1 px-3 py-2 text-sm rounded bg-purple-600 hover:bg-purple-500 text-white transition-colors"
			>
				Connect Production
			</button>
		</div>

		<button
			onclick={() => showAdvanced = !showAdvanced}
			class="w-full px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-400 transition-colors"
		>
			{showAdvanced ? 'Hide Advanced' : 'Show Advanced'}
		</button>
	{/if}

	{#if showAdvanced}
		<div class="mt-3 pt-3 border-t border-gray-700">
			<label for="custom-mcp-url" class="block text-xs text-gray-400 mb-1">Custom MCP URL</label>
			<div class="flex gap-2">
				<input
					id="custom-mcp-url"
					type="text"
					inputmode="url"
					autocomplete="off"
					bind:value={customUrl}
					placeholder="Set PUBLIC_MCP_URL or enter a bridge URL"
					class="flex-1 px-2 py-1.5 text-base rounded bg-gray-900 border border-gray-700 text-gray-200 focus:border-blue-500 focus:outline-none"
				/>
				<button
					onclick={() => { handleCustomUrl(); handleConnect(); }}
					class="px-3 py-1.5 text-sm rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
				>
					Connect
				</button>
			</div>
			<p class="text-xs text-gray-500 mt-1">
				Local bridge URL is configured with PUBLIC_MCP_URL.
			</p>
		</div>
	{/if}
</div>
