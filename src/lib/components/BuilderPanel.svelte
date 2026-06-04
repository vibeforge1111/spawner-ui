<script lang="ts">
	import { onDestroy } from 'svelte';
	import Icon from './Icon.svelte';
	import { skills, type Skill } from '$lib/stores/skills.svelte';
	import { addNode, addNodesWithConnections, snapPosition } from '$lib/stores/canvas.svelte';
	import { mcpState } from '$lib/stores/mcp.svelte';
	import { workflowTemplates, agentBundles, projectTypes, getTemplatesForProject } from '$lib/data/templates';
	import type { WorkflowTemplate, AgentBundle, ProjectType } from '$lib/types/builder';

	let frameSelectedTimer: ReturnType<typeof setTimeout> | null = null;

	// Dispatch event to request framing of selected nodes
	function requestFrameSelected() {
		// Use a small delay to let nodes render first
		if (frameSelectedTimer) clearTimeout(frameSelectedTimer);
		frameSelectedTimer = setTimeout(() => {
			frameSelectedTimer = null;
			window.dispatchEvent(new CustomEvent('builder:frame-selected'));
		}, 50);
	}

	onDestroy(() => {
		if (frameSelectedTimer) clearTimeout(frameSelectedTimer);
	});

	// State
	let expandedSection = $state<'templates' | 'bundles' | null>('templates');
	let selectedProjectType = $state<ProjectType>('saas');
	let mcpConnected = $state(false);
	let currentSkills = $state<Skill[]>([]);

	// Subscribe to MCP state
	$effect(() => {
		const unsub = mcpState.subscribe((s) => (mcpConnected = s.status === 'connected'));
		return unsub;
	});

	// Subscribe to skills
	$effect(() => {
		const unsub = skills.subscribe((s) => (currentSkills = s));
		return unsub;
	});

	// Filter templates by project type
	const filteredTemplates = $derived(getTemplatesForProject(selectedProjectType));

	// Icon mapping
	const templateIcons: Record<string, string> = {
		shield: 'shield',
		'message-circle': 'message-circle',
		server: 'server',
		layers: 'layers',
		'git-branch': 'git-branch'
	};

	const bundleIcons: Record<string, string> = {
		rocket: 'zap',
		cpu: 'cpu',
		server: 'server',
		layout: 'layout',
		shield: 'shield',
		'check-circle': 'check'
	};

	// Get skill by ID from current skills
	function getSkill(skillId: string): Skill | undefined {
		return currentSkills.find((s) => s.id === skillId);
	}

	// Add workflow template to canvas
	function addTemplate(template: WorkflowTemplate) {
		// Calculate base position with some randomness
		const baseX = 100 + Math.random() * 100;
		const baseY = 100 + Math.random() * 100;

		// Build node definitions
		const nodeDefs: { skill: Skill; position: { x: number; y: number } }[] = [];
		for (const templateNode of template.nodes) {
			const skill = getSkill(templateNode.skillId);
			if (!skill) {
				console.warn(`Skill not found: ${templateNode.skillId}`);
				continue;
			}

			nodeDefs.push({
				skill,
				position: snapPosition(baseX + templateNode.offsetX, baseY + templateNode.offsetY)
			});
		}

		if (nodeDefs.length === 0) {
			console.error('No valid skills found for template');
			return;
		}

		// Add nodes with connections
		addNodesWithConnections(nodeDefs, template.connections);
		requestFrameSelected();
	}

	// Add agent bundle to canvas (loose skills, no connections)
	function addBundle(bundle: AgentBundle) {
		const baseX = 100 + Math.random() * 100;
		const baseY = 100;
		const spacingX = 280;
		const spacingY = 120;
		const cols = 3;

		// Build node definitions
		const nodeDefs: { skill: Skill; position: { x: number; y: number } }[] = [];

		bundle.skillIds.forEach((skillId, index) => {
			const skill = getSkill(skillId);
			if (!skill) {
				console.warn(`Skill not found: ${skillId}`);
				return;
			}

			const col = index % cols;
			const row = Math.floor(index / cols);
			const position = snapPosition(
				baseX + col * spacingX,
				baseY + row * spacingY
			);
			nodeDefs.push({ skill, position });
		});

		if (nodeDefs.length === 0) {
			console.error('No valid skills found for bundle');
			return;
		}

		// Add nodes without connections (empty array)
		addNodesWithConnections(nodeDefs, []);
		requestFrameSelected();
	}

	// Toggle section
	function toggleSection(section: 'templates' | 'bundles') {
		expandedSection = expandedSection === section ? null : section;
	}

	// Count available skills in bundle
	function countAvailableSkills(bundle: AgentBundle): number {
		return bundle.skillIds.filter((id) => getSkill(id)).length;
	}
</script>

<div class="builder-panel h-full flex flex-col">
	<!-- MCP Status -->
	<div class="px-3 py-2 border-b border-surface-border flex items-center gap-2">
		<div class="w-2 h-2 rounded-full {mcpConnected ? 'bg-accent-primary' : 'bg-red-400'}"></div>
		<span class="text-xs font-mono text-text-tertiary">
			{mcpConnected ? 'MCP Connected' : 'MCP Offline'}
		</span>
	</div>

	<!-- Project Type Selector -->
	<div class="p-3 border-b border-surface-border">
		<div class="block text-xs font-mono text-text-tertiary mb-2">Project Type</div>
		<div class="flex flex-wrap gap-1">
			{#each projectTypes as type}
				<button
					class="px-2 py-1 text-xs font-mono border transition-all
						{selectedProjectType === type.id
							? 'bg-accent-primary/10 border-accent-primary text-accent-primary'
							: 'border-surface-border text-text-secondary hover:border-text-tertiary hover:text-text-primary'}"
					onclick={() => (selectedProjectType = type.id)}
				>
					{type.label}
				</button>
			{/each}
		</div>
	</div>

	<!-- Scrollable Content -->
	<div class="flex-1 overflow-y-auto">
		<!-- Workflow Templates Section -->
		<div class="border-b border-surface-border">
			<button
				class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-tertiary transition-colors"
				onclick={() => toggleSection('templates')}
			>
				<Icon name="layers" size={14} />
				<span class="flex-1 text-sm font-medium text-text-primary">Workflow Templates</span>
				<span class="text-xs text-text-tertiary">{filteredTemplates.length}</span>
				<Icon name={expandedSection === 'templates' ? 'chevron-down' : 'chevron-right'} size={12} />
			</button>

			{#if expandedSection === 'templates'}
				<div class="pb-2">
					{#each filteredTemplates as template}
						<div class="mx-2 mb-2 p-2 bg-bg-primary border border-surface-border hover:border-accent-primary transition-colors">
							<div class="flex items-center gap-2 mb-1">
								<Icon name={templateIcons[template.icon] || 'layers'} size={14} />
								<span class="text-sm font-medium text-text-primary">{template.name}</span>
							</div>
							<p class="text-xs text-text-tertiary mb-2 line-clamp-2">{template.description}</p>
							<div class="flex items-center gap-2 mb-2 text-xs text-text-tertiary">
								<span class="flex items-center gap-1">
									<Icon name="cpu" size={10} />
									{template.nodes.length} nodes
								</span>
								<span class="flex items-center gap-1">
									<Icon name="git-branch" size={10} />
									{template.connections.length} connections
								</span>
							</div>
							<button
								class="w-full py-1.5 text-xs font-mono text-accent-primary border border-accent-primary/30 hover:bg-accent-primary hover:text-bg-primary transition-colors"
								onclick={() => addTemplate(template)}
							>
								+ Add to Canvas
							</button>
						</div>
					{:else}
						<div class="px-3 py-2 text-xs text-text-tertiary">
							No templates for this project type
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Agent Bundles Section -->
		<div class="border-b border-surface-border">
			<button
				class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-tertiary transition-colors"
				onclick={() => toggleSection('bundles')}
			>
				<Icon name="package" size={14} />
				<span class="flex-1 text-sm font-medium text-text-primary">Agent Bundles</span>
				<span class="text-xs text-text-tertiary">{agentBundles.length}</span>
				<Icon name={expandedSection === 'bundles' ? 'chevron-down' : 'chevron-right'} size={12} />
			</button>

			{#if expandedSection === 'bundles'}
				<div class="pb-2">
					{#each agentBundles as bundle}
						{@const availableCount = countAvailableSkills(bundle)}
						<div class="mx-2 mb-2 p-2 bg-bg-primary border border-surface-border hover:border-accent-secondary transition-colors">
							<div class="flex items-center gap-2 mb-1">
								<Icon name={bundleIcons[bundle.icon] || 'package'} size={14} />
								<span class="text-sm font-medium text-text-primary">{bundle.name}</span>
								{#if bundle.tier === 'premium'}
									<span class="px-1 py-0.5 text-[10px] font-mono bg-accent-secondary/20 text-accent-secondary">PRO</span>
								{/if}
							</div>
							<p class="text-xs text-text-tertiary mb-2">{bundle.description}</p>

							<!-- Skills preview -->
							<div class="flex flex-wrap gap-1 mb-2">
								{#each bundle.skillIds.slice(0, 3) as skillId}
									{@const skill = getSkill(skillId)}
									<span class="px-1 py-0.5 text-[10px] font-mono bg-bg-tertiary {skill ? 'text-text-secondary' : 'text-text-tertiary line-through'}">
										{skillId.split('-').slice(0, 2).join('-')}
									</span>
								{/each}
								{#if bundle.skillIds.length > 3}
									<span class="text-[10px] text-text-tertiary">+{bundle.skillIds.length - 3} more</span>
								{/if}
							</div>

							<button
								class="w-full py-1.5 text-xs font-mono text-accent-secondary border border-accent-secondary/30 hover:bg-accent-secondary hover:text-bg-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
								onclick={() => addBundle(bundle)}
								disabled={availableCount === 0}
							>
								+ Add {availableCount} Skills
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<!-- Footer -->
	<div class="p-3 border-t border-surface-border bg-bg-tertiary">
		<a href="/canvas" class="flex items-center justify-center gap-1 text-xs text-accent-primary hover:underline">
			<span>Mission canvas</span>
			<Icon name="git-branch" size={10} />
		</a>
	</div>
</div>

<style>
	.line-clamp-2 {
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
</style>
