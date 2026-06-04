<script lang="ts">
	import { validateCanvas, validateCanvasFull, getValidationSummary, type ValidationResult, type ValidationIssue, type SharpEdge } from '$lib/services/validation';
	import { nodes, connections, selectNode } from '$lib/stores/canvas.svelte';
	import { mcpState } from '$lib/stores/mcp.svelte';
	import type { CanvasNode, Connection } from '$lib/stores/canvas.svelte';
	import Icon from './Icon.svelte';
	import { SKILL_MCP_MAP } from '$lib/types/mcp';
	import { connectedInstances } from '$lib/stores/mcps.svelte';
	import type { MCPInstance } from '$lib/types/mcp';

	interface Props {
		onClose: () => void;
	}

	let { onClose }: Props = $props();

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			onClose();
		}
	}

	let currentNodes = $state<CanvasNode[]>([]);
	let currentConnections = $state<Connection[]>([]);
	let result = $state<ValidationResult | null>(null);
	let sharpEdges = $state<SharpEdge[]>([]);
	let mcpConnected = $state(false);
	let loadingMcp = $state(false);
	let showSharpEdges = $state(false);
	let connectedMcpIds = $state<Set<string>>(new Set());

	$effect(() => {
		const unsub1 = nodes.subscribe((n) => (currentNodes = n));
		const unsub2 = connections.subscribe((c) => (currentConnections = c));
		const unsub3 = mcpState.subscribe((s) => (mcpConnected = s.status === 'connected'));
		const unsub4 = connectedInstances.subscribe((instances: MCPInstance[]) => {
			connectedMcpIds = new Set(instances.map((i) => i.definitionId));
		});
		return () => {
			unsub1();
			unsub2();
			unsub3();
			unsub4();
		};
	});

	// Run local validation + MCP availability checks
	$effect(() => {
		const baseResult = validateCanvas(currentNodes, currentConnections);

		// Add MCP availability warnings
		const mcpWarnings: ValidationIssue[] = [];
		for (const node of currentNodes) {
			const entries = SKILL_MCP_MAP[node.skillId] || [];
			const recommended = entries
				.filter((e) => e.priority !== 'optional')
				.flatMap((e) => e.mcps);
			if (recommended.length > 0) {
				const connected = recommended.filter((id) => connectedMcpIds.has(id));
				if (connected.length === 0) {
					mcpWarnings.push({
						id: `mcp-${node.id}`,
						severity: 'warning',
						message: `"${node.skill.name}" recommends MCPs (${recommended.join(', ')}) but none are connected`,
						suggestion: 'Go to MCPs page to connect recommended tools',
						nodeId: node.id
					});
				}
			}
		}

		if (mcpWarnings.length > 0) {
			result = {
				...baseResult,
				issues: [...baseResult.issues, ...mcpWarnings]
			};
		} else {
			result = baseResult;
		}
	});

	// Run MCP validation when connected
	async function runMcpValidation() {
		if (!mcpConnected || currentNodes.length === 0) return;
		loadingMcp = true;
		try {
			const fullResult = await validateCanvasFull(currentNodes, currentConnections);
			result = fullResult;
			sharpEdges = fullResult.sharpEdges || [];
		} catch (e) {
			console.error('MCP validation failed:', e);
		} finally {
			loadingMcp = false;
		}
	}

	function getScoreColor(score: number): string {
		if (score >= 80) return 'text-accent-primary';
		if (score >= 50) return 'text-yellow-500';
		return 'text-red-500';
	}

	function getSeverityIcon(severity: ValidationIssue['severity']): string {
		switch (severity) {
			case 'error':
				return '!';
			case 'warning':
				return '⚠';
			case 'info':
				return 'i';
		}
	}

	function getSeverityColor(severity: ValidationIssue['severity']): string {
		switch (severity) {
			case 'error':
				return 'bg-red-500/20 text-red-400 border-red-500/50';
			case 'warning':
				return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50';
			case 'info':
				return 'bg-blue-500/20 text-blue-400 border-blue-500/50';
		}
	}

	function handleIssueClick(issue: ValidationIssue) {
		if (issue.nodeId) {
			selectNode(issue.nodeId);
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />
<div class="fixed inset-0 flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-label="Workflow validation">
	<button class="absolute inset-0 bg-black/50" onclick={onClose} aria-label="Close validation panel"></button>
	<div
		class="relative bg-bg-secondary border border-surface-border w-full max-w-lg max-h-[80vh] flex flex-col"
	>
		<!-- Header -->
		<div class="flex items-center justify-between p-4 border-b border-surface-border">
			<h2 class="font-serif text-lg text-text-primary">Workflow Validation</h2>
			<button onclick={onClose} class="text-text-tertiary hover:text-text-primary">
				X
			</button>
		</div>

		{#if result}
			<!-- Score -->
			<div class="p-4 border-b border-surface-border">
				<div class="flex items-center justify-between mb-2">
					<span class="text-sm text-text-secondary">Validation Score</span>
					<span class="text-2xl font-mono {getScoreColor(result.score)}">{result.score}/100</span>
				</div>
				<div class="w-full h-2 bg-surface rounded-full overflow-hidden">
					<div
						class="h-full transition-all duration-300"
						class:bg-accent-primary={result.score >= 80}
						class:bg-yellow-500={result.score >= 50 && result.score < 80}
						class:bg-red-500={result.score < 50}
						style="width: {result.score}%"
					></div>
				</div>
				<p class="text-sm text-text-tertiary mt-2">{getValidationSummary(result)}</p>

				<!-- MCP Validation Button -->
				{#if mcpConnected && currentNodes.length > 0}
					<button
						onclick={runMcpValidation}
						disabled={loadingMcp}
						class="mt-3 w-full px-3 py-2 text-xs font-mono border border-accent-primary/50 text-accent-primary hover:bg-accent-primary/10 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
					>
						{#if loadingMcp}
							<div class="w-3 h-3 border-2 border-accent-primary border-t-transparent rounded-full animate-spin"></div>
							<span>Running MCP checks...</span>
						{:else}
							<Icon name="zap" size={12} />
							<span>Run MCP Validation</span>
						{/if}
					</button>
				{:else if !mcpConnected}
					<div class="mt-3 px-3 py-2 text-xs font-mono text-text-tertiary bg-bg-tertiary border border-surface-border flex items-center gap-2">
						<span class="w-2 h-2 rounded-full bg-gray-500"></span>
						<span>MCP offline - local validation only</span>
					</div>
				{/if}
			</div>

			<!-- Stats -->
			<div class="grid grid-cols-3 gap-2 p-4 border-b border-surface-border text-center">
				<div>
					<div class="text-lg font-mono text-text-primary">{result.stats.totalNodes}</div>
					<div class="text-xs text-text-tertiary">Nodes</div>
				</div>
				<div>
					<div class="text-lg font-mono text-text-primary">{result.stats.totalConnections}</div>
					<div class="text-xs text-text-tertiary">Connections</div>
				</div>
				<div>
					<div class="text-lg font-mono text-text-primary">{result.stats.connectedNodes}</div>
					<div class="text-xs text-text-tertiary">Connected</div>
				</div>
			</div>

			<!-- Sharp Edges Toggle -->
			{#if sharpEdges.length > 0}
				<div class="border-b border-surface-border">
					<button
						onclick={() => showSharpEdges = !showSharpEdges}
						class="w-full p-3 flex items-center justify-between text-left hover:bg-bg-tertiary/50 transition-colors"
					>
						<div class="flex items-center gap-2">
							<Icon name="alert-triangle" size={14} />
							<span class="text-sm text-amber-400 font-mono">Sharp Edges ({sharpEdges.length})</span>
						</div>
						<span class="text-text-tertiary text-xs">{showSharpEdges ? '▲' : '▼'}</span>
					</button>

					{#if showSharpEdges}
						<div class="p-3 pt-0 space-y-2">
							{#each sharpEdges as edge, i}
								<div class="p-2 text-xs bg-amber-500/10 border border-amber-500/30 text-amber-400">
									<p>{edge.warning}</p>
									{#if edge.tech}
										<p class="mt-1 text-amber-400/70">Tech: {edge.tech}</p>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}

			<!-- Issues -->
			<div class="flex-1 overflow-y-auto p-4">
				{#if result.issues.length === 0}
					<div class="text-center py-8">
						<div class="text-3xl mb-2">✓</div>
						<p class="text-text-primary">No issues found</p>
						<p class="text-sm text-text-tertiary">Your workflow is ready to run</p>
					</div>
				{:else}
					<div class="space-y-2">
						{#each result.issues as issue (issue.id)}
							<button
								class="w-full text-left p-3 border {getSeverityColor(issue.severity)} transition-all hover:opacity-80"
								onclick={() => handleIssueClick(issue)}
							>
								<div class="flex items-start gap-2">
									<span class="font-mono text-sm w-5 h-5 flex items-center justify-center border rounded-full flex-shrink-0">
										{getSeverityIcon(issue.severity)}
									</span>
									<div class="flex-1 min-w-0">
										<p class="text-sm">{issue.message}</p>
										{#if issue.suggestion}
											<p class="text-xs opacity-70 mt-1">{issue.suggestion}</p>
										{/if}
									</div>
								</div>
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Footer -->
			<div class="p-4 border-t border-surface-border flex justify-between">
				<div class="text-xs text-text-tertiary">
					{result.stats.entryPoints} entry • {result.stats.exitPoints} exit
				</div>
				<button
					onclick={onClose}
					class="px-4 py-1.5 text-sm font-mono bg-accent-primary text-bg-primary hover:bg-accent-primary-hover transition-all"
				>
					Close
				</button>
			</div>
		{/if}
	</div>
</div>
