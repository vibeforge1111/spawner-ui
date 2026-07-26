<script lang="ts">
	import Icon from '../Icon.svelte';
	import SkillSearchPalette from '../SkillSearchPalette.svelte';
	import { filters, setFilter } from '$lib/stores/skills.svelte';
	import type { SkillCategory } from '$lib/stores/skills.svelte';
	import {
		buildExtraCategoryGroup,
		type CategoryDef,
		type CategoryGroupDef
	} from './category-browser-groups';

	let { categoryCounts = {} }: { categoryCounts: Record<string, number> } = $props();

	// Static category definitions (without counts)
	const categoryGroupDefs: CategoryGroupDef[] = [
		{
			name: 'AI & Machine Learning',
			icon: 'brain',
			categories: [
				{ id: 'ai', label: 'AI' },
				{ id: 'ai-agents', label: 'AI Agents' },
				{ id: 'ai-tools', label: 'AI Tools' },
				{ id: 'data', label: 'Data' },
				{ id: 'data-science', label: 'Data Science' }
			]
		},
		{
			name: 'Development',
			icon: 'cpu',
			categories: [
				{ id: 'development', label: 'Development' },
				{ id: 'backend', label: 'Backend' },
				{ id: 'frontend', label: 'Frontend' },
				{ id: 'frameworks', label: 'Frameworks' },
				{ id: 'mobile', label: 'Mobile' }
			]
		},
		{
			name: 'Infrastructure',
			icon: 'server',
			categories: [
				{ id: 'devops', label: 'DevOps' },
				{ id: 'infrastructure', label: 'Infrastructure' },
				{ id: 'security', label: 'Security' },
				{ id: 'testing', label: 'Testing' },
				{ id: 'performance', label: 'Performance' }
			]
		},
		{
			name: 'Game Development',
			icon: 'play',
			categories: [
				{ id: 'game-dev', label: 'Game Dev' },
				{ id: 'gamedev', label: 'GameDev' },
				{ id: 'game-dev-llm', label: 'Game Dev LLM' }
			]
		},
		{
			name: 'Web3 & Finance',
			icon: 'zap',
			categories: [
				{ id: 'blockchain', label: 'Blockchain' },
				{ id: 'web3', label: 'Web3' },
				{ id: 'finance', label: 'Finance' },
				{ id: 'trading', label: 'Trading' }
			]
		},
		{
			name: 'Business & Strategy',
			icon: 'compass',
			categories: [
				{ id: 'business', label: 'Business' },
				{ id: 'strategy', label: 'Strategy' },
				{ id: 'startup', label: 'Startup' },
				{ id: 'founder', label: 'Founder' },
				{ id: 'product', label: 'Product' }
			]
		},
		{
			name: 'Marketing & Growth',
			icon: 'megaphone',
			categories: [
				{ id: 'marketing', label: 'Marketing' },
				{ id: 'community', label: 'Community' },
				{ id: 'communications', label: 'Communications' }
			]
		},
		{
			name: 'Creative & Design',
			icon: 'palette',
			categories: [
				{ id: 'creative', label: 'Creative' },
				{ id: 'design', label: 'Design' }
			]
		},
		{
			name: 'Specialized',
			icon: 'sparkles',
			categories: [
				{ id: 'space', label: 'Space' },
				{ id: 'biotech', label: 'Biotech' },
				{ id: 'robotics', label: 'Robotics' },
				{ id: 'climate', label: 'Climate' },
				{ id: 'education', label: 'Education' },
				{ id: 'legal', label: 'Legal' },
				{ id: 'hardware', label: 'Hardware' }
			]
		}
	];

	let expandedGroups = $state<Set<string>>(new Set(['AI & Machine Learning', 'Development']));

	function toggleGroup(name: string) {
		const newSet = new Set(expandedGroups);
		if (newSet.has(name)) {
			newSet.delete(name);
		} else {
			newSet.add(name);
		}
		expandedGroups = newSet;
	}

	function selectCategory(categoryId: string) {
		setFilter('category', categoryId as SkillCategory | 'all');
	}

	// Helper to get count for a category (reactive)
	function getCount(id: string): number {
		return categoryCounts[id] || 0;
	}

	// Helper to get group total (reactive)
	function getGroupTotal(categories: CategoryDef[]): number {
		return categories.reduce((sum, cat) => sum + getCount(cat.id), 0);
	}

	// Categories the curated taxonomy already covers
	const knownCategoryIds = new Set(
		categoryGroupDefs.flatMap((group) => group.categories.map((cat) => cat.id))
	);

	// Filter out groups with no skills, and append a derived group for
	// categories present in the data but missing from the taxonomy so no
	// skill is unreachable through Browse by Category (reactive)
	const visibleGroups = $derived.by(() => {
		const groups = categoryGroupDefs.filter(group =>
			group.categories.some(cat => getCount(cat.id) > 0)
		);
		const extraGroup = buildExtraCategoryGroup(categoryCounts, knownCategoryIds);
		return extraGroup ? [...groups, extraGroup] : groups;
	});
</script>

<div class="space-y-4 mb-6">
	<!-- Search -->
	<div class="bg-bg-secondary border border-surface-border p-4">
		<SkillSearchPalette variant="sidebar" />
	</div>

	<!-- Categories -->
	<div class="bg-bg-secondary border border-surface-border p-4">
		<div class="flex items-center justify-between mb-4">
			<h3 class="font-mono text-xs text-text-tertiary uppercase tracking-wider">Browse by Category</h3>
			{#if $filters.category !== 'all'}
				<button
					onclick={() => setFilter('category', 'all')}
					class="flex items-center gap-1 text-xs font-mono text-accent-primary hover:underline"
				>
					<Icon name="x" size={12} />
					Clear
				</button>
			{/if}
		</div>

	<div class="space-y-2">
		{#each visibleGroups as group}
			<div class="border border-surface-border">
				<!-- Group header -->
				<button
					onclick={() => toggleGroup(group.name)}
					class="w-full flex items-center justify-between p-3 hover:bg-bg-tertiary/50 transition-colors"
				>
					<div class="flex items-center gap-2">
						<Icon name={group.icon} size={14} class="text-accent-primary/70" />
						<span class="font-medium text-sm text-text-primary">{group.name}</span>
						<span class="font-mono text-xs text-text-tertiary">
							({getGroupTotal(group.categories)})
						</span>
					</div>
					<Icon
						name="chevron-down"
						size={14}
						class="text-text-tertiary transition-transform {expandedGroups.has(group.name) ? 'rotate-180' : ''}"
					/>
				</button>

				<!-- Category items -->
				{#if expandedGroups.has(group.name)}
					<div class="border-t border-surface-border bg-bg-primary/30 p-2">
						<div class="flex flex-wrap gap-1.5">
							{#each group.categories.filter(cat => getCount(cat.id) > 0) as category}
								<button
									onclick={() => selectCategory(category.id)}
									class="px-2.5 py-1 text-xs font-mono transition-all {$filters.category === category.id
										? 'bg-accent-primary text-bg-primary'
										: 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/80 border border-surface-border'}"
								>
									{category.label}
									<span class="ml-1 opacity-70">{getCount(category.id)}</span>
								</button>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</div>
	</div>
</div>
