<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		pipelines,
		activePipeline,
		activePipelineId,
		createNewPipeline,
		switchPipeline,
		renamePipeline,
		duplicatePipeline,
		deletePipeline,
		exportPipeline,
		importPipeline,
		exportAllPipelines,
		type PipelineMetadata,
		type PipelineData
	} from '$lib/stores/pipelines.svelte';
	import { polishMissionTitleForDisplay } from '$lib/services/mission-title';
	import { get } from 'svelte/store';

	// Events
	interface Props {
		onSwitch?: (data: PipelineData | null) => void;
		onBeforeSwitch?: () => PipelineData;
		navigateOnSwitch?: boolean; // When true, navigate to /canvas on switch (for Navbar usage)
	}

	let { onSwitch, onBeforeSwitch, navigateOnSwitch = false }: Props = $props();

	let isOpen = $state(false);
	let isRenaming = $state<string | null>(null);
	let renameValue = $state('');
	let dropdownEl = $state<HTMLDivElement>();
	let renameInputEl = $state<HTMLInputElement>();
	let fileInputEl = $state<HTMLInputElement>();
	let renameOpenTimer: ReturnType<typeof setTimeout> | null = null;
	let renameFocusTimer: ReturnType<typeof setTimeout> | null = null;

	// Get current values from stores
	let currentPipelines = $state<PipelineMetadata[]>([]);
	let currentActive = $state<PipelineMetadata | null>(null);

	// Subscribe to store changes
	$effect(() => {
		const unsubPipelines = pipelines.subscribe(v => currentPipelines = v);
		const unsubActive = activePipeline.subscribe(v => currentActive = v);
		return () => {
			unsubPipelines();
			unsubActive();
		};
	});

	// Close dropdown when clicking outside
	function handleClickOutside(e: MouseEvent) {
		if (dropdownEl && !dropdownEl.contains(e.target as Node)) {
			isOpen = false;
			isRenaming = null;
		}
	}

	onMount(() => {
		document.addEventListener('click', handleClickOutside);
		return () => document.removeEventListener('click', handleClickOutside);
	});

	function handleToggle(e: MouseEvent) {
		e.stopPropagation();
		isOpen = !isOpen;
		if (!isOpen) isRenaming = null;
	}

	function handleSelect(pipeline: PipelineMetadata) {
		if (pipeline.id === get(activePipelineId)) {
			isOpen = false;
			// If navigating is enabled, still go to canvas page even if same pipeline
			if (navigateOnSwitch) {
				window.location.href = '/canvas';
			}
			return;
		}

		// Get current canvas data before switching
		const currentData = onBeforeSwitch?.();

		// Switch to selected pipeline
		const newData = switchPipeline(pipeline.id);

		// Notify parent to update canvas
		onSwitch?.(newData);
		isOpen = false;

		// Navigate to canvas if enabled (for Navbar usage)
		if (navigateOnSwitch) {
			window.location.href = '/canvas';
		}
	}

	function handleCreate() {
		// Save current first
		onBeforeSwitch?.();

		const newPipeline = createNewPipeline();
		onSwitch?.({ nodes: [], connections: [], zoom: 1, pan: { x: 0, y: 0 } });
		isOpen = false;

		// Navigate to canvas if enabled (for Navbar usage)
		if (navigateOnSwitch) {
			window.location.href = '/canvas';
			// Note: setTimeout for renaming won't work with full page reload
			// User can rename manually
		} else {
			// Start renaming the new pipeline
			if (renameOpenTimer) clearTimeout(renameOpenTimer);
			renameOpenTimer = setTimeout(() => {
				renameOpenTimer = null;
				isOpen = true;
				startRename(newPipeline);
			}, 100);
		}
	}

	function startRename(pipeline: PipelineMetadata) {
		isRenaming = pipeline.id;
		renameValue = pipeline.name;
		if (renameFocusTimer) clearTimeout(renameFocusTimer);
		renameFocusTimer = setTimeout(() => {
			renameFocusTimer = null;
			renameInputEl?.focus();
		}, 50);
	}

	onDestroy(() => {
		if (renameOpenTimer) clearTimeout(renameOpenTimer);
		if (renameFocusTimer) clearTimeout(renameFocusTimer);
	});

	function commitRename() {
		if (isRenaming && renameValue.trim()) {
			renamePipeline(isRenaming, renameValue.trim());
		}
		isRenaming = null;
	}

	function handleRenameKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			commitRename();
		} else if (e.key === 'Escape') {
			isRenaming = null;
		}
	}

	function handleDuplicate(e: MouseEvent, pipeline: PipelineMetadata) {
		e.stopPropagation();
		duplicatePipeline(pipeline.id);
	}

	function handleDelete(e: MouseEvent, pipeline: PipelineMetadata) {
		e.stopPropagation();

		if (currentPipelines.length <= 1) {
			return; // Can't delete last pipeline
		}

		if (confirm(`Delete "${pipeline.name}"? This cannot be undone.`)) {
			const wasActive = pipeline.id === get(activePipelineId);
			deletePipeline(pipeline.id);

			if (wasActive) {
				// Load the new active pipeline
				const newActiveId = get(activePipelineId);
				if (newActiveId) {
					const data = switchPipeline(newActiveId);
					onSwitch?.(data);
				}
			}
		}
	}

	function formatDate(dateStr: string): string {
		const date = new Date(dateStr);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return 'just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		return date.toLocaleDateString();
	}

	function handleExport(pipeline: PipelineMetadata) {
		exportPipeline(pipeline.id);
	}

	function handleImport() {
		fileInputEl?.click();
	}

	async function handleFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const imported = await importPipeline(file);
		if (imported) {
			// Switch to the imported pipeline
			const data = switchPipeline(imported.id);
			onSwitch?.(data);
			isOpen = false;
		}
		
		// Clear the input for next use
		input.value = '';
	}

	function handleBackupAll() {
		exportAllPipelines();
	}
</script>

<div class="relative" bind:this={dropdownEl}>
	<!-- Trigger button -->
	<button
		class="flex items-center gap-2 px-2.5 py-1.5 text-sm font-mono bg-bg-tertiary border border-surface-border rounded-md hover:border-text-tertiary transition-all max-w-[200px]"
		onclick={handleToggle}
		title={currentActive ? polishMissionTitleForDisplay(currentActive.name) : 'Select pipeline'}
	>
		<svg class="w-4 h-4 text-accent-primary shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
		</svg>
		<span class="truncate text-text-primary">{currentActive ? polishMissionTitleForDisplay(currentActive.name) : 'No pipeline'}</span>
		<svg class="w-3 h-3 text-text-tertiary shrink-0 transition-transform" class:rotate-180={isOpen} fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
		</svg>
	</button>

	<!-- Dropdown -->
	{#if isOpen}
		<div class="absolute top-full left-0 mt-1 w-80 bg-bg-secondary border border-surface-border rounded-lg shadow-xl z-50 overflow-hidden">
			<!-- Header -->
			<div class="px-3 py-2 border-b border-surface-border">
				<span class="text-xs font-mono text-text-tertiary uppercase tracking-wide">Your Pipelines</span>
			</div>

			<!-- Pipeline list -->
			<div class="max-h-72 overflow-y-auto">
				{#each currentPipelines as pipeline (pipeline.id)}
					<div
						class="group px-3 py-2.5 cursor-pointer border-b border-surface-border/30 last:border-b-0 transition-all"
						class:bg-accent-primary={pipeline.id === currentActive?.id}
						class:bg-opacity-10={pipeline.id === currentActive?.id}
						class:hover:bg-bg-tertiary={pipeline.id !== currentActive?.id}
						class:hover:bg-accent-primary={pipeline.id === currentActive?.id}
						class:hover:bg-opacity-15={pipeline.id === currentActive?.id}
						onclick={() => handleSelect(pipeline)}
						role="button"
						tabindex="0"
						onkeydown={(e) => e.key === 'Enter' && handleSelect(pipeline)}
					>
						<div class="flex items-start justify-between gap-2">
							<!-- Pipeline info -->
							<div class="flex-1 min-w-0">
								{#if isRenaming === pipeline.id}
									<input
										bind:this={renameInputEl}
										bind:value={renameValue}
										class="w-full px-1.5 py-0.5 text-sm font-mono bg-bg-primary border border-accent-primary rounded-sm text-text-primary focus:outline-none"
										onclick={(e) => e.stopPropagation()}
										onblur={commitRename}
										onkeydown={handleRenameKeydown}
									/>
								{:else}
									<div class="flex items-center gap-2">
										<!-- Pipeline icon -->
										<svg class="w-4 h-4 shrink-0 {pipeline.id === currentActive?.id ? 'text-accent-primary' : 'text-text-tertiary'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
										</svg>
										<span class="text-sm font-mono text-text-primary truncate font-medium">{polishMissionTitleForDisplay(pipeline.name)}</span>
										{#if pipeline.id === currentActive?.id}
											<span class="text-[10px] font-mono px-1.5 py-0.5 bg-accent-primary/20 text-accent-primary rounded">ACTIVE</span>
										{/if}
									</div>
								{/if}
								<div class="flex items-center gap-2 mt-1 ml-6 text-xs text-text-tertiary">
									<span class="flex items-center gap-1">
										<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16m-7 6h7"/>
										</svg>
										{pipeline.nodeCount} nodes
									</span>
									<span class="text-text-quaternary">|</span>
									<span>{formatDate(pipeline.updatedAt)}</span>
								</div>
							</div>

							<!-- Actions -->
							<div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
								<button
									class="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-bg-primary/50 rounded transition-colors"
									onclick={(e) => { e.stopPropagation(); startRename(pipeline); }}
									title="Rename"
								>
									<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
									</svg>
								</button>
								<button
									class="p-1.5 text-text-tertiary hover:text-accent-primary hover:bg-accent-primary/10 rounded transition-colors"
									onclick={(e) => {
										e.stopPropagation();
										handleExport(pipeline);
									}}
									title="Export"
								>
									<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
									</svg>
								</button>
								<button
									class="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-bg-primary/50 rounded transition-colors"
									onclick={(e) => handleDuplicate(e, pipeline)}
									title="Duplicate"
								>
									<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
									</svg>
								</button>
								{#if currentPipelines.length > 1}
									<button
										class="p-1.5 text-text-tertiary hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
										onclick={(e) => handleDelete(e, pipeline)}
										title="Delete"
									>
										<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
										</svg>
									</button>
								{/if}
							</div>
						</div>
					</div>
				{/each}
			</div>

			<!-- Empty state -->
			{#if currentPipelines.length === 0}
				<div class="px-4 py-8 text-center">
					<svg class="w-10 h-10 mx-auto mb-3 text-text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
					</svg>
					<p class="text-sm text-text-tertiary mb-1">No pipelines yet</p>
					<p class="text-xs text-text-quaternary">Create your first pipeline to get started</p>
				</div>
			{/if}

			<!-- Action Buttons - Always visible at bottom -->
			<div class="border-t border-surface-border p-2 space-y-2">
				<!-- Main actions row -->
				<div class="flex gap-2">
					<button
						class="flex-1 flex items-center justify-center gap-2 px-3 py-2 font-mono text-sm text-accent-primary bg-accent-primary/5 hover:bg-accent-primary/15 border border-accent-primary/30 hover:border-accent-primary/50 rounded-md transition-all"
						onclick={handleCreate}
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
						</svg>
						<span>New</span>
					</button>
					<button
						class="flex-1 flex items-center justify-center gap-2 px-3 py-2 font-mono text-sm text-text-secondary bg-bg-tertiary hover:bg-bg-primary border border-surface-border hover:border-text-tertiary rounded-md transition-all"
						onclick={handleImport}
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
						</svg>
						<span>Import</span>
					</button>
				</div>
				<!-- Secondary action -->
				{#if currentPipelines.length > 0}
					<button
						class="w-full flex items-center justify-center gap-2 px-3 py-1.5 font-mono text-xs text-text-tertiary bg-bg-secondary hover:bg-bg-tertiary border border-surface-border/50 hover:border-surface-border rounded-md transition-all"
						onclick={handleBackupAll}
						title="Export all pipelines as backup"
					>
						<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V2"/>
						</svg>
						<span>Backup All Pipelines</span>
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>

<!-- Hidden file input for import -->
<input 
	bind:this={fileInputEl}
	type="file" 
	accept=".json"
	class="hidden" 
	onchange={handleFileSelect}
/>

<style>
	/* Scrollbar styling */
	.max-h-72::-webkit-scrollbar {
		width: 6px;
	}

	.max-h-72::-webkit-scrollbar-track {
		background: transparent;
	}

	.max-h-72::-webkit-scrollbar-thumb {
		background: var(--color-surface-border);
		border-radius: 3px;
	}

	.max-h-72::-webkit-scrollbar-thumb:hover {
		background: var(--color-text-tertiary);
	}
</style>
