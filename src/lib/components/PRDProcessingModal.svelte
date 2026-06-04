<script lang="ts">
	import { logger } from '$lib/utils/logger';
	import { scale, fade } from 'svelte/transition';
	import { backOut } from 'svelte/easing';

	// PRD Processing Modal - shows progress as PRD is analyzed
	let {
		isOpen = false,
		currentStage = 0,
		projectName = 'Your Project',
		featuresFound = 0,
		tasksGenerated = 0,
		clarificationMode = false,
		waitingForClaude = false,
		prdRequestId = '',
		onComplete,
		onSkipToLocal
	}: {
		isOpen: boolean;
		currentStage: number;
		projectName?: string;
		featuresFound?: number;
		tasksGenerated?: number;
		clarificationMode?: boolean;
		waitingForClaude?: boolean;
		prdRequestId?: string;
		onComplete?: () => void;
		onSkipToLocal?: () => void;
	} = $props();

	// Copyable prompt for Claude Code
	const claudePrompt = $derived(`Analyze the pending PRD and send results to Spawner UI`);
	let copied = $state(false);
	let copyError = $state(false);

	async function copyPrompt() {
		try {
			await navigator.clipboard.writeText(claudePrompt);
			copied = true;
			copyError = false;
		} catch (e) {
			copyError = true;
			console.error('Failed to copy:', e);
		}
		setTimeout(() => { copied = false; copyError = false; }, 2000);
	}

	const stages = [
		{ label: 'Reading PRD', icon: '◈' },
		{ label: 'Analyzing Features', icon: '◧' },
		{ label: 'Detecting Stack', icon: '⬡' },
		{ label: 'Matching Skills', icon: '⚙' },
		{ label: 'Building Pipeline', icon: '◉' },
		{ label: 'Ready', icon: '✓' }
	];

	$effect(() => {
		progressPercent = Math.round((currentStage / (stages.length - 1)) * 100);
	});

	let progressPercent = $state(0);
	const isComplete = $derived(currentStage === stages.length - 1);

	function handleViewPipeline() {
		logger.info('[PRD Modal] View Pipeline clicked, onComplete:', !!onComplete);
		if (onComplete) {
			onComplete();
		}
	}

	function getIconClasses(i: number): string {
		if (currentStage > i) {
			return 'border-accent-primary bg-accent-primary text-bg-primary';
		} else if (currentStage === i) {
			return 'border-accent-primary text-accent-primary';
		}
		return 'border-surface-border text-text-tertiary';
	}
</script>

{#if isOpen}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
		in:fade={{ duration: 200 }}
		out:fade={{ duration: 150 }}
	>
		<!-- Modal container -->
		<div
			class="bg-bg-secondary border border-surface-border w-full max-w-md"
			in:scale={{ duration: 250, start: 0.96, easing: backOut }}
			out:scale={{ duration: 150, start: 0.96 }}
		>
			<!-- Progress bar at top -->
			<div class="h-0.5 bg-surface w-full overflow-hidden">
				<div
					class="h-full bg-accent-primary transition-all duration-500 ease-out"
					style="width: {progressPercent}%"
				></div>
			</div>

			<!-- Header -->
			<div class="px-6 py-4 border-b border-surface-border">
				<p class="font-mono text-xs text-accent-primary tracking-widest mb-1">
					PRD → PIPELINE
				</p>
				<h2 class="font-serif text-xl text-text-primary">Generating Workflow</h2>
				{#if clarificationMode}
					<p class="mt-2 text-sm text-text-secondary">
						Spark understood that you are asking whether the previous message was understood. Share the missing audience, core workflow, saved memory, and vibe details to continue.
					</p>
				{/if}
			</div>

			<!-- Progress stages -->
			<div class="px-6 py-5">
				<div class="space-y-2">
					{#each stages as stage, i}
						<div
							class="flex items-center gap-3 p-2 transition-all duration-200 {currentStage < i ? 'opacity-40' : ''} {currentStage === i ? 'bg-accent-primary/5' : ''}"
						>
							<!-- Icon -->
							<div
								class="w-7 h-7 flex items-center justify-center border text-sm transition-all duration-200 {getIconClasses(i)}"
							>
								{#if currentStage > i}
									<span in:fade={{ duration: 150 }}>✓</span>
								{:else if currentStage === i && i < stages.length - 1}
									<span class="animate-pulse">{stage.icon}</span>
								{:else}
									<span>{stage.icon}</span>
								{/if}
							</div>

							<!-- Label -->
							<span class="text-sm {currentStage >= i ? 'text-text-primary' : 'text-text-tertiary'}">
								{stage.label}
							</span>

							<!-- Spinner only for active stage -->
							{#if currentStage === i && i < stages.length - 1}
								<div class="ml-auto w-3.5 h-3.5 border-2 border-accent-primary border-t-transparent rounded-full animate-spin"></div>
							{/if}
						</div>
					{/each}
				</div>
			</div>

			<!-- Waiting for Claude section -->
			{#if waitingForClaude}
				<div class="px-6 pb-5" in:fade={{ duration: 200 }}>
					<div class="pt-4 border-t border-surface-border">
						<div class="bg-accent-primary/5 border border-accent-primary/20 p-4">
							<div class="flex items-start gap-3 mb-3">
								<div class="w-8 h-8 flex items-center justify-center border border-accent-primary text-accent-primary animate-pulse">
									<span class="text-lg">◈</span>
								</div>
								<div>
									<p class="text-sm font-medium text-text-primary mb-1">Automatic analysis in progress</p>
									<p class="text-xs text-text-secondary">Spawner is trying connected runtimes first. No copy/paste required.</p>
								</div>
							</div>

							<!-- Optional manual fallback prompt -->
							<div class="relative">
								<code class="block p-3 bg-bg-primary border border-surface-border text-sm font-mono text-accent-primary break-all opacity-80">
									{claudePrompt}
								</code>
								<button
									type="button"
									class="absolute top-2 right-2 px-2 py-1 text-xs font-mono bg-surface hover:bg-surface-active border border-surface-border transition-colors"
									onclick={copyPrompt}
								>
									{copyError ? '⚠ Select & copy manually' : copied ? '✓ Copied' : 'Copy fallback'}
								</button>
							</div>

							<p class="text-xs text-text-tertiary mt-3 flex items-center gap-2">
								<span class="w-2 h-2 bg-yellow-500 rounded-full animate-pulse"></span>
								Waiting for runtime response. Auto-fallback to local analyzer if no response.
							</p>
						</div>

						<!-- Skip to local analysis option -->
						{#if onSkipToLocal}
							<button
								type="button"
								class="mt-3 w-full py-2 text-sm text-text-tertiary hover:text-text-secondary border border-surface-border hover:border-surface-active transition-colors"
								onclick={onSkipToLocal}
							>
								Skip → Use local analyzer instead
							</button>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Stats section - separate from stages -->
			{#if currentStage >= 2 && !waitingForClaude}
				<div class="px-6 pb-5">
					<div class="pt-4 border-t border-surface-border">
						<div class="grid grid-cols-3 gap-4 text-center" in:fade={{ duration: 200 }}>
							<div>
								<p class="text-xl font-bold text-accent-primary">{featuresFound}</p>
								<p class="text-xs text-text-tertiary font-mono">Features</p>
							</div>
							<div>
								<p class="text-xl font-bold text-accent-secondary">{tasksGenerated}</p>
								<p class="text-xs text-text-tertiary font-mono">Tasks</p>
							</div>
							<div>
								<p class="text-xl font-bold text-text-primary">{tasksGenerated > 0 ? tasksGenerated - 1 : 0}</p>
								<p class="text-xs text-text-tertiary font-mono">Connections</p>
							</div>
						</div>
					</div>
				</div>
			{/if}

			<!-- Footer with button -->
			<div class="px-6 py-4 border-t border-surface-border">
				{#if isComplete}
					<button
						type="button"
						class="w-full py-3 font-medium bg-accent-primary text-bg-primary cursor-pointer hover:bg-accent-primary/90 flex items-center justify-center gap-2 relative z-50"
						onclick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							logger.info('[PRD Modal] Button clicked!');
							if (onComplete) {
								onComplete();
							}
						}}
					>
						<span>View Pipeline</span>
						<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6" />
						</svg>
					</button>
				{:else}
					<div class="w-full py-3 font-medium bg-surface text-text-tertiary text-center opacity-40">
						Processing...
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
