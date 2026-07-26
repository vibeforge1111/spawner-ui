<script lang="ts">
	import Navbar from '$lib/components/Navbar.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import SkillCard from '$lib/components/SkillCard.svelte';
	import { skills, filteredSkills, loading, loadSkills, setFilter, resetFilters, type Skill } from '$lib/stores/skills.svelte';
	import { onMount } from 'svelte';

	let searchQuery = $state('');
	let currentSkills = $state<Skill[]>([]);
	let isLoading = $state(false);
	let recommendations = $state<Skill[]>([]);

	// Common project types for recommendations
	const projectTypes = [
		{ id: 'saas', label: 'SaaS App', tags: ['nextjs', 'auth', 'payments', 'database'] },
		{ id: 'ai', label: 'AI Project', tags: ['ai-ml', 'llm', 'agents'] },
		{ id: 'mobile', label: 'Mobile App', tags: ['react-native', 'flutter', 'mobile'] },
		{ id: 'api', label: 'API Backend', tags: ['api', 'rest', 'graphql', 'database'] },
		{ id: 'ecommerce', label: 'E-Commerce', tags: ['payments', 'cart', 'inventory'] },
		{ id: 'devtools', label: 'Dev Tools', tags: ['cli', 'testing', 'devops'] }
	];

	$effect(() => {
		const unsub1 = filteredSkills.subscribe((s) => (currentSkills = s));
		const unsub2 = loading.subscribe((l) => (isLoading = l));
		return () => {
			unsub1();
			unsub2();
		};
	});

	onMount(() => {
		loadSkills();
	});

	function handleSearch() {
		setFilter('search', searchQuery);
	}

	function handleProjectType(type: typeof projectTypes[0]) {
		// Filter skills that match the project type tags — multi-word search
		// tokenizes, so the applied filter now matches the displayed query
		searchQuery = type.tags.join(' ');
		setFilter('search', searchQuery);
	}

	function getRecommendedSkills(type: typeof projectTypes[0]): Skill[] {
		return currentSkills
			.filter((skill) =>
				type.tags.some((tag) =>
					skill.tags.includes(tag) ||
					skill.category.includes(tag) ||
					skill.name.toLowerCase().includes(tag)
				)
			)
			.slice(0, 6);
	}
</script>

<svelte:head>
	<title>Find Skills - Vibeship Spawner</title>
</svelte:head>

<div class="min-h-screen flex flex-col bg-bg-primary">
	<Navbar />

	<main class="flex-1 py-16">
		<div class="max-w-6xl mx-auto px-6">
			<!-- Header -->
			<div class="text-center mb-12">
				<h1 class="font-serif text-4xl text-text-primary mb-4">Find the Right Skills</h1>
				<p class="text-text-secondary text-lg max-w-2xl mx-auto">
					Tell us what you're building and we'll recommend the best skills for your project.
				</p>
			</div>

			<!-- Search -->
			<div class="max-w-2xl mx-auto mb-12">
				<div class="relative">
					<input
						type="text"
						bind:value={searchQuery}
						onkeydown={(e) => e.key === 'Enter' && handleSearch()}
						placeholder="Describe your project or search for skills..."
						class="w-full px-4 py-3 pr-24 bg-surface border border-surface-border text-text-primary font-mono focus:outline-none focus:border-accent-primary"
					/>
					<button
						onclick={handleSearch}
						class="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-1.5 text-sm font-mono bg-accent-primary text-bg-primary hover:bg-accent-primary-hover transition-all"
					>
						Search
					</button>
				</div>
			</div>

			<!-- Project Types -->
			<div class="mb-12">
				<h2 class="font-serif text-xl text-text-primary mb-4 text-center">What are you building?</h2>
				<div class="flex flex-wrap justify-center gap-3">
					{#each projectTypes as type}
						<button
							onclick={() => handleProjectType(type)}
							class="px-4 py-2 text-sm font-mono border border-surface-border text-text-secondary hover:border-accent-primary hover:text-accent-primary transition-all"
						>
							{type.label}
						</button>
					{/each}
				</div>
			</div>

			<!-- Results -->
			{#if isLoading}
				<div class="text-center py-12">
					<p class="text-text-tertiary animate-pulse">Loading skills...</p>
				</div>
			{:else if currentSkills.length > 0}
				<div>
					<div class="flex items-center justify-between mb-6">
						<h2 class="font-serif text-xl text-text-primary">
							{searchQuery ? `Results for "${searchQuery}"` : 'All Skills'}
						</h2>
						<span class="text-sm text-text-tertiary">{currentSkills.length} skills</span>
					</div>

					<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
						{#each currentSkills.slice(0, 12) as skill (skill.id)}
							<SkillCard {skill} />
						{/each}
					</div>

					{#if currentSkills.length > 12}
						<div class="text-center mt-8">
							<a
								href="/skills"
								class="inline-block px-6 py-2 text-sm font-mono border border-accent-primary text-accent-primary hover:bg-accent-primary hover:text-bg-primary transition-all"
							>
								View all {currentSkills.length} skills
							</a>
						</div>
					{/if}
				</div>
			{:else}
				<div class="text-center py-12">
					<p class="text-text-tertiary">No skills found. Try a different search.</p>
					<button
						onclick={resetFilters}
						class="mt-4 text-sm text-accent-primary hover:underline"
					>
						Clear filters
					</button>
				</div>
			{/if}

			<!-- Popular Combinations -->
			<div class="mt-16">
				<h2 class="font-serif text-2xl text-text-primary mb-6 text-center">Popular Skill Combinations</h2>
				<div class="grid md:grid-cols-3 gap-6">
					<div class="p-6 border border-surface-border">
						<h3 class="font-medium text-text-primary mb-2">Full-Stack SaaS</h3>
						<p class="text-sm text-text-secondary mb-4">Complete stack for building SaaS applications</p>
						<div class="flex flex-wrap gap-2">
							<span class="px-2 py-1 text-xs bg-surface border border-surface-border">Next.js</span>
							<span class="px-2 py-1 text-xs bg-surface border border-surface-border">Supabase</span>
							<span class="px-2 py-1 text-xs bg-surface border border-surface-border">Stripe</span>
							<span class="px-2 py-1 text-xs bg-surface border border-surface-border">Auth</span>
						</div>
					</div>
					<div class="p-6 border border-surface-border">
						<h3 class="font-medium text-text-primary mb-2">AI Agent Builder</h3>
						<p class="text-sm text-text-secondary mb-4">Tools for building intelligent agents</p>
						<div class="flex flex-wrap gap-2">
							<span class="px-2 py-1 text-xs bg-surface border border-surface-border">LLM</span>
							<span class="px-2 py-1 text-xs bg-surface border border-surface-border">RAG</span>
							<span class="px-2 py-1 text-xs bg-surface border border-surface-border">Agents</span>
							<span class="px-2 py-1 text-xs bg-surface border border-surface-border">MCP</span>
						</div>
					</div>
					<div class="p-6 border border-surface-border">
						<h3 class="font-medium text-text-primary mb-2">Production Ready</h3>
						<p class="text-sm text-text-secondary mb-4">Essential patterns for production apps</p>
						<div class="flex flex-wrap gap-2">
							<span class="px-2 py-1 text-xs bg-surface border border-surface-border">Testing</span>
							<span class="px-2 py-1 text-xs bg-surface border border-surface-border">CI/CD</span>
							<span class="px-2 py-1 text-xs bg-surface border border-surface-border">Monitoring</span>
							<span class="px-2 py-1 text-xs bg-surface border border-surface-border">Security</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	</main>

	<Footer />
</div>
