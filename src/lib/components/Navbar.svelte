<script lang="ts">
	import Icon from './Icon.svelte';
	import PipelineSelector from './PipelineSelector.svelte';
	import BrandLogo from './BrandLogo.svelte';
	import { initPipelines } from '$lib/stores/pipelines.svelte';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';

	let { publicPreviewLocked = false }: { publicPreviewLocked?: boolean } = $props();
	let pipelinesReady = $state(false);

	onMount(() => {
		if (browser && !publicPreviewLocked) {
			initPipelines();
			pipelinesReady = true;
		}
	});
</script>

<nav class="h-[52px] sticky top-0 border-b border-surface-border bg-bg-primary z-50">
	<div class="h-full max-w-6xl mx-auto flex items-center justify-between px-4 sm:px-6">
		<div class="flex items-center gap-4">
			<BrandLogo size="sm" />
		</div>

		<div class="flex items-center gap-1 sm:gap-2">
			{#if publicPreviewLocked}
				<a
					href="https://sparkswarm.ai/waitlist"
					class="nav-pop group inline-flex items-center gap-2 px-3.5 py-2 font-sans text-[15px] font-semibold text-text-primary border border-accent-primary/35 rounded-md bg-accent-primary/10"
				>
					<Icon name="sparkles" size={14} class="nav-pop-icon" />
					<span class="nav-pop-label">Private preview</span>
				</a>
			{:else}
				<a
					href="/canvas"
					aria-label="Canvas"
					class="nav-pop group inline-flex items-center gap-2 px-2 py-2 font-sans text-[15px] font-medium text-text-secondary border border-transparent rounded-md sm:px-3.5"
				>
					<Icon name="grid" size={14} class="nav-pop-icon" />
					<span class="nav-pop-label hidden sm:inline">Canvas</span>
				</a>

				<a
					href="/kanban"
					aria-label="Kanban"
					class="nav-pop group inline-flex items-center gap-2 px-2 py-2 font-sans text-[15px] font-medium text-text-secondary border border-transparent rounded-md sm:px-3.5"
				>
					<Icon name="clipboard" size={14} class="nav-pop-icon" />
					<span class="nav-pop-label hidden sm:inline">Kanban</span>
				</a>

				<a
					href="/trace"
					aria-label="Trace"
					class="nav-pop group inline-flex items-center gap-2 px-2 py-2 font-sans text-[15px] font-medium text-text-secondary border border-transparent rounded-md sm:px-3.5"
				>
					<Icon name="scan" size={14} class="nav-pop-icon" />
					<span class="nav-pop-label hidden sm:inline">Trace</span>
				</a>

				<a
					href="/skills"
					aria-label="Skills"
					class="nav-pop group inline-flex items-center gap-2 px-2 py-2 font-sans text-[15px] font-medium text-text-secondary border border-transparent rounded-md sm:px-3.5"
				>
					<Icon name="layers" size={14} class="nav-pop-icon" />
					<span class="nav-pop-label hidden sm:inline">Skills</span>
				</a>

				<a
					href="/settings"
					aria-label="Settings"
					class="nav-pop group inline-flex items-center gap-2 px-2 py-2 font-sans text-[15px] font-medium text-text-secondary border border-transparent rounded-md sm:px-3.5"
				>
					<Icon name="settings" size={14} class="nav-pop-icon" />
					<span class="nav-pop-label hidden sm:inline">Settings</span>
				</a>

				<div class="w-px h-5 bg-surface-border hidden md:block"></div>

				{#if pipelinesReady}
					<div class="hidden md:block">
						<PipelineSelector navigateOnSwitch={true} />
					</div>
				{/if}
			{/if}
		</div>
	</div>
</nav>

<style>
	.nav-pop {
		position: relative;
		overflow: hidden;
		isolation: isolate;
		transition:
			background-color 220ms cubic-bezier(0.23, 1, 0.32, 1),
			border-color 220ms cubic-bezier(0.23, 1, 0.32, 1),
			color 220ms cubic-bezier(0.23, 1, 0.32, 1),
			transform 220ms cubic-bezier(0.23, 1, 0.32, 1);
	}

	.nav-pop::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -1;
		border-radius: inherit;
		background:
			linear-gradient(
				105deg,
				transparent 0%,
				transparent 34%,
				rgb(var(--accent-rgb) / 0.08) 46%,
				rgb(var(--accent-rgb) / 0.14) 52%,
				transparent 66%,
				transparent 100%
			),
			rgb(var(--bg-subtle-rgb) / 0.62);
		background-size: 230% 100%, auto;
		background-position: 125% 0, 0 0;
		opacity: 0;
		pointer-events: none;
		transition:
			opacity 280ms cubic-bezier(0.23, 1, 0.32, 1),
			background-position 980ms cubic-bezier(0.23, 1, 0.32, 1);
	}

	.nav-pop::after {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -2;
		border-radius: inherit;
		background: rgb(var(--bg-subtle-rgb) / 0.52);
		opacity: 0;
		pointer-events: none;
		transition: opacity 240ms cubic-bezier(0.23, 1, 0.32, 1);
	}

	.nav-pop:hover {
		color: var(--text);
		border-color: rgb(var(--accent-rgb) / 0.34);
		transform: translateY(-1px);
	}

	.nav-pop:hover::before {
		opacity: 1;
		background-position: -95% 0, 0 0;
	}

	.nav-pop:hover::after {
		opacity: 1;
	}

	.nav-pop:active {
		transform: translateY(0) scale(0.97);
		transition-duration: 100ms;
	}

	:global(.nav-pop-icon) {
		position: relative;
		z-index: 1;
		transition:
			color 260ms cubic-bezier(0.23, 1, 0.32, 1),
			transform 260ms cubic-bezier(0.23, 1, 0.32, 1);
	}

	.nav-pop:hover :global(.nav-pop-icon) {
		color: var(--accent);
		transform: scale(1.12) rotate(-10deg);
	}

	.nav-pop-label {
		position: relative;
		z-index: 1;
		transition: transform 260ms cubic-bezier(0.23, 1, 0.32, 1);
	}

	.nav-pop:hover .nav-pop-label {
		transform: translateX(2px);
	}
</style>
