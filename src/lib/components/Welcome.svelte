<script lang="ts">
	import { logger } from '$lib/utils/logger';
	// Note: Using window.location.href instead of goto() for navigation
	// to avoid Svelte reactivity issues with canvas (see handleProcessingComplete)
	import Navbar from './Navbar.svelte';
	import Footer from './Footer.svelte';
	import Icon from './Icon.svelte';
	import MissionLive from './MissionLive.svelte';
	import PublicSpawnerPreview from './PublicSpawnerPreview.svelte';
	import JourneyDemo from './JourneyDemo.svelte';
	import SkillCloud from './SkillCloud.svelte';
	import TelegramPhone from './TelegramPhone.svelte';
	import PRDProcessingModal from './PRDProcessingModal.svelte';
	import { setPRD, setProjectName } from '$lib/stores/project-docs.svelte';
	import { analyzePRD, generateTasksFromPRD, tasksToWorkflow, type PRDAnalysis, type GeneratedTask } from '$lib/utils/prd-analyzer';
	import { processSmartPRD, type SmartPRDAnalysis, type SmartMission } from '$lib/utils/smart-prd-analyzer';
	import { initPRDBridge, requestPRDAnalysis, analysisStatus, analysisResult, prdResultToWorkflow, type PRDAnalysisResult } from '$lib/services/prd-bridge';
	import { queuePipelineLoad } from '$lib/services/pipeline-loader';
	import { onMount } from 'svelte';
	import { skills as skillsStore, loadSkills, addSkills } from '$lib/stores/skills.svelte';
	import { addNodesWithConnections, clearCanvas, nodes, connections } from '$lib/stores/canvas.svelte';
	import { initPipelines } from '$lib/stores/pipelines.svelte';
	import type { Skill } from '$lib/stores/skills.svelte';
	import { toasts } from '$lib/stores/toast.svelte';
	import { get } from 'svelte/store';
	import { parseJsonResponse } from '$lib/services/http-response';
	import { getEventsAuthHeaders } from '$lib/services/events-auth-client';

	let {
		onStart: _onStart,
		publicPreviewLocked = false
	}: {
		onStart?: (goal: string, options?: { includeSkills?: boolean; includeMCPs?: boolean }) => void;
		publicPreviewLocked?: boolean;
	} = $props();

	// Smart Mode - uses new analyzer that generates smaller, completable missions
	let useSmartMode = $state(true);  // Default ON
	let smartPrompt = $state<string | null>(null);  // Store generated prompt

	// AI Mode - uses real Claude AI via bridge for intelligent PRD analysis
	let useAIMode = $state(true);  // Default ON - this is the PREFERRED mode
	let aiAnalysisStatus = $state<'idle' | 'pending' | 'analyzing' | 'complete' | 'error'>('idle');

	// Pipeline options - what to include in generated pipeline
	let includeSkills = $state(true);   // Include H70 skill recommendations per task
	let includeMCPs = $state(true);     // Include best MCP tool recommendations per task

	// Initialize PRD bridge on mount
	onMount(() => {
		// Subscribe to analysis status updates
		const unsubscribe = analysisStatus.subscribe(status => {
			aiAnalysisStatus = status;
		});
		return unsubscribe;
	});

	// PRD Processing Modal state
	let showProcessingModal = $state(false);
	let processingStage = $state(0);
	let processingProjectName = $state('');
	let processingFeaturesFound = $state(0);
	let processingTasksGenerated = $state(0);
	let processingClarificationMode = $state(false);
	let waitingForClaude = $state(false);
	let currentPrdRequestId = $state('');
	// Workflow type matches tasksToWorkflow return type
	let pendingWorkflow: {
		nodes: { skill: Skill; position: { x: number; y: number } }[];
		connections: { sourceIndex: number; targetIndex: number }[];
	} | null = null;

	function createQueuedPipelineId(): string {
		return `pipe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	}

	async function handlePRDUpload(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = async (event) => {
			const content = event.target?.result as string;
			setPRD(content);

			// Extract project name from file name
			const fileName = file.name.replace(/\.(md|txt)$/i, '').replace(/[-_]/g, ' ');
			if (fileName.length > 2 && fileName.length < 50 && !fileName.toLowerCase().includes('prd')) {
				setProjectName(fileName);
				processingProjectName = fileName;
			}

			// Show processing modal
			showProcessingModal = true;
			processingStage = 0;
			processingClarificationMode = false;

			try {
				// Stage 0: Reading PRD
				logger.info('[PRD] Starting analysis, content length:', content.length, 'aiMode:', useAIMode, 'smartMode:', useSmartMode);
				await delay(600);

				// Load skills first (needed for all modes)
				let skillsList = get(skillsStore);
				if (skillsList.length === 0) {
					await loadSkills();
					skillsList = get(skillsStore);
				}

				if (useAIMode) {
					// === AI MODE ===
					// Uses REAL Claude AI intelligence via bridge (PREFERRED)
					logger.info('[PRD-AI] Setting up for Claude analysis...');
					await initPRDBridge();

					// Stage 1: Writing PRD for Claude
					processingStage = 1;

					try {
						// Write PRD to file for Claude to read
						const writeResponse = await fetch('/api/prd-bridge/write', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								content,
								requestId: `prd-${crypto.randomUUID()}`,
								projectName: processingProjectName,
								options: { includeSkills, includeMCPs }
							})
						});

						if (!writeResponse.ok) {
							throw new Error('Failed to write PRD');
						}

						const { requestId } = await writeResponse.json();
						currentPrdRequestId = requestId;

						// Show "waiting for Claude" with copyable prompt
						waitingForClaude = true;

						logger.info('[PRD-AI] PRD written, waiting for Claude. Request ID:', requestId);

						// Capture skillsList in closure
						const capturedSkills = skillsList;

						// Shared function to process result from either SSE or polling
						let resultProcessed = false;
						let pollInterval: ReturnType<typeof setInterval> | null = null;

						function processClaudeResult(result: PRDAnalysisResult) {
							if (resultProcessed) return;
							resultProcessed = true;

							if (pollInterval) {
								clearInterval(pollInterval);
								pollInterval = null;
							}

							try {
								waitingForClaude = false;
								processingClarificationMode = result.projectType === 'clarification-understanding';
								processingProjectName = result.projectName || processingProjectName;
								processingFeaturesFound = result.tasks?.length || 0;
								processingStage = 4;
								processingTasksGenerated = result.tasks?.length || 0;

								logger.info('[PRD-AI] Converting to workflow with', capturedSkills.length, 'skills');
								pendingWorkflow = prdResultToWorkflow(result, capturedSkills);
								logger.info('[PRD-AI] Workflow created:', pendingWorkflow?.nodes?.length, 'nodes');

								smartPrompt = result.executionPrompt;
								processingStage = 5;

								if (result.projectName && result.projectName !== 'New Project') {
									setProjectName(result.projectName);
								}

								logger.info('[PRD-AI] Pipeline ready! Stage:', processingStage);
							} catch (err) {
								console.error('[PRD-AI] Error processing result:', err);
								waitingForClaude = false;
								processingStage = 5;
							}
						}

						let unsubscribe = () => {};
						const aiCompleted = await new Promise<boolean>((resolve) => {
							let settled = false;
							const settle = (success: boolean) => {
								if (settled) return;
								settled = true;
								if (pollInterval) {
									clearInterval(pollInterval);
									pollInterval = null;
								}
								unsubscribe();
								resolve(success);
							};

							// Set up listener for Claude's response
							unsubscribe = analysisStatus.subscribe(status => {
								logger.info('[PRD-AI] Status changed to:', status);
								if (status === 'complete' && !resultProcessed) {
									// Claude responded! Get the result from the store.
									const result = get(analysisResult);
									logger.info('[PRD-AI] Got result via SSE:', result?.projectName);

									if (result) {
										processClaudeResult(result);
										settle(true);
									}
								}
							});

							// POLLING FALLBACK: Check for stored results every 2 seconds
							pollInterval = setInterval(async () => {
								if (resultProcessed) {
									settle(true);
									return;
								}

								try {
									const authHeaders = getEventsAuthHeaders();
									const response = await fetch(`/api/prd-bridge/result?requestId=${requestId}`, {
										headers: authHeaders
									});
									const data = await response.json();

									if (data.found && data.result && !resultProcessed) {
										logger.info('[PRD-AI] Got result via POLLING:', data.result.projectName);
										processClaudeResult(data.result);
										await fetch('/api/prd-bridge/pending', { method: 'DELETE', headers: authHeaders });
										settle(true);
									}
								} catch (err) {
									console.debug('[PRD-AI] Polling check failed:', err);
								}
							}, 2000);

							// Give runtime bridge/codex auto-analysis enough time before local fallback
							setTimeout(() => settle(false), 45000);
						});

						if (aiCompleted) {
							return;
						}

						waitingForClaude = false;
						useAIMode = false;
						toasts.info('Runtime analysis did not respond in time. Continuing automatically with local smart analysis.');

					} catch (err) {
						console.error('[PRD-AI] Setup failed:', err);
						waitingForClaude = false;
						toasts.warning('Could not set up Claude analysis, using local analyzer');
						useAIMode = false;
					}

				}

				// Only run smart/legacy mode if AI mode didn't succeed
				if (!useAIMode && useSmartMode) {
					// === SMART MODE ===
					// Uses new analyzer that generates smaller, completable missions

					// Stage 1: Smart Analysis
					processingStage = 1;
					await delay(400);
					const result = processSmartPRD(content, skillsList);

					logger.info('[PRD-Smart] Analysis complete:', {
						projectName: result.analysis.projectName,
						projectType: result.analysis.projectType,
						pipelineType: result.analysis.pipelineType,
						features: result.analysis.explicitFeatures.length,
						tasks: result.mission.totalTasks,
						infrastructure: result.analysis.infrastructure
					});

					processingProjectName = result.analysis.projectName || processingProjectName;
					processingFeaturesFound = result.analysis.explicitFeatures.length;

					// Stage 2: Stack Detection
					processingStage = 2;
					await delay(300);

					// Stage 3: Skills
					processingStage = 3;
					await delay(300);

					// Stage 4: Building Pipeline
					processingStage = 4;
					processingTasksGenerated = result.mission.totalTasks;

					if (result.mission.tasks.length === 0) {
						showProcessingModal = false;
						toasts.error('Could not extract tasks from PRD. Try adding more detail.');
						return;
					}

					// Apply pipeline options
					if (!includeSkills) {
						// Strip skill assignments from workflow nodes
						for (const node of result.workflow.nodes) {
							if (node.skill) {
								node.skill.skillChain = [];
							}
						}
						// Strip skills from mission tasks
						for (const task of result.mission.tasks) {
							task.skills = [];
						}
					}

					pendingWorkflow = result.workflow;
					smartPrompt = result.prompt;  // Store for later copy
					await delay(400);

					// Stage 5: Ready
					processingStage = 5;

					if (result.analysis.projectName && result.analysis.projectName !== 'New Project') {
						setProjectName(result.analysis.projectName);
					}

					logger.info('[PRD-Smart] Pipeline ready:',
						result.mission.totalTasks, 'tasks,',
						result.mission.estimatedComplexity, 'complexity');

				} else if (!useAIMode && !useSmartMode) {
					// === LEGACY MODE ===
					// Original analyzer (only used if both AI and Smart modes are disabled)

					// Stage 1: Analyzing Features
					processingStage = 1;
					await delay(500);
					const analysis = analyzePRD(content);
					logger.info('[PRD-Legacy] Analysis complete:', { projectName: analysis.projectName, features: analysis.features.length });
					processingProjectName = analysis.projectName || processingProjectName;
					processingFeaturesFound = analysis.features.length;

					// Stage 2: Detecting Stack
					processingStage = 2;
					await delay(500);

					// Stage 3: Matching Skills
					processingStage = 3;
					await delay(500);

					// Stage 4: Building Pipeline
					processingStage = 4;
					const tasks = generateTasksFromPRD(analysis, skillsList);
					logger.info('[PRD-Legacy] Generated tasks:', tasks.length);
					processingTasksGenerated = tasks.length;

					if (tasks.length === 0) {
						showProcessingModal = false;
						toasts.error('Could not extract tasks from PRD. Try adding more detail.');
						return;
					}

					// Generate workflow
					const workflow = tasksToWorkflow(tasks, skillsList);
					logger.info('[PRD-Legacy] Workflow nodes:', workflow.nodes.length, 'connections:', workflow.connections.length);
					pendingWorkflow = workflow;
					smartPrompt = null;  // No smart prompt in legacy mode
					await delay(600);

					// Stage 5: Ready
					processingStage = 5;

					if (analysis.projectName && analysis.projectName !== 'New Project') {
						setProjectName(analysis.projectName);
					}
				}

			} catch (err) {
				console.error('[PRD] Analysis failed at stage', processingStage, ':', err);
				showProcessingModal = false;
				toasts.error(`Failed to analyze PRD: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		};
		reader.readAsText(file);
		input.value = '';
	}

	async function handleProcessingComplete() {
		logger.info('[PRD] handleProcessingComplete called, pendingWorkflow:', !!pendingWorkflow);

		const pipelineName = processingProjectName || 'PRD Pipeline';

		if (pendingWorkflow && pendingWorkflow.nodes.length > 0) {
			logger.info('[PRD] Queueing pipeline with', pendingWorkflow.nodes.length, 'nodes and', pendingWorkflow.connections.length, 'connections');

			// Extract skills from workflow nodes and add to skills store (for sidebar)
			const workflowSkills = pendingWorkflow.nodes.map(n => n.skill);
			addSkills(workflowSkills);

			// Queue the pipeline load - canvas will pick this up on mount
			const queued = await queuePipelineLoad({
				pipelineId: createQueuedPipelineId(),
				pipelineName,
				nodes: pendingWorkflow.nodes,
				connections: pendingWorkflow.connections,
				source: 'prd'
			});

			if (queued) {
				toasts.success(`Pipeline ready with ${pendingWorkflow.nodes.length} agents`);
			} else {
				toasts.error('Failed to queue pipeline');
			}
		} else {
			// Queue empty pipeline so we don't load old one
			console.warn('[PRD] No workflow nodes, queueing empty pipeline');
			await queuePipelineLoad({
				pipelineId: createQueuedPipelineId(),
				pipelineName,
				nodes: [],
				connections: [],
				source: 'prd'
			});
			toasts.warning('Pipeline created but no tasks were generated. Try re-analyzing the PRD.');
		}

		showProcessingModal = false;
		pendingWorkflow = null;
		logger.info('[PRD] Navigating to /canvas');
		window.location.href = '/canvas';
	}

	function delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * Skip Claude AI and use local smart analyzer instead
	 */
	async function handleSkipToLocal() {
		logger.info('[PRD] Skipping to local analyzer...');
		waitingForClaude = false;

		// Read the pending PRD content
		const prdResponse = await fetch('/api/prd-bridge/pending');
		if (!prdResponse.ok) {
			toasts.error(`Could not read pending PRD (HTTP ${prdResponse.status})`);
			showProcessingModal = false;
			return;
		}
		const prdData = await parseJsonResponse<{ pending?: boolean; prdContent?: string }>(prdResponse, {});

		if (!prdData.pending || !prdData.prdContent) {
			toasts.error('No pending PRD found');
			showProcessingModal = false;
			return;
		}

		// Load skills if needed
		let skillsList = get(skillsStore);
		if (skillsList.length === 0) {
			await loadSkills();
			skillsList = get(skillsStore);
		}

		// Use smart analyzer
		processingStage = 1;
		await delay(300);
		const result = processSmartPRD(prdData.prdContent, skillsList);

		processingProjectName = result.analysis.projectName || processingProjectName;
		processingFeaturesFound = result.analysis.explicitFeatures.length;

		processingStage = 2;
		await delay(200);
		processingStage = 3;
		await delay(200);
		processingStage = 4;
		processingTasksGenerated = result.mission.totalTasks;

		if (result.mission.tasks.length === 0) {
			showProcessingModal = false;
			toasts.error('Could not extract tasks from PRD');
			return;
		}

		pendingWorkflow = result.workflow;
		smartPrompt = result.prompt;
		await delay(300);

		processingStage = 5;

		if (result.analysis.projectName && result.analysis.projectName !== 'New Project') {
			setProjectName(result.analysis.projectName);
		}

		// Clear the pending request
		await fetch('/api/prd-bridge/pending', { method: 'DELETE' });
	}

	/**
	 * Convert PRD Analysis Result from Claude AI to workflow format
	 *
	 * Creates TASK-FOCUSED nodes where each node represents a feature/task,
	 * with skills shown as tags. This prevents duplicate skill nodes and
	 * gives a cleaner view of what's being built.
	 */
	// prdResultToWorkflow is now imported from $lib/services/prd-bridge
</script>

{#if !publicPreviewLocked}
<PRDProcessingModal
	isOpen={showProcessingModal}
	currentStage={processingStage}
	projectName={processingProjectName}
	featuresFound={processingFeaturesFound}
	tasksGenerated={processingTasksGenerated}
	clarificationMode={processingClarificationMode}
	waitingForClaude={waitingForClaude}
	prdRequestId={currentPrdRequestId}
	onComplete={handleProcessingComplete}
	onSkipToLocal={handleSkipToLocal}
/>

<div class="min-h-screen bg-bg-primary flex flex-col">
	<!-- Navbar -->
	<Navbar />

	<main class="flex-1">
	<!-- Hero — live mission demo -->
	<MissionLive />

	<!-- 001 — Pick a workspace -->
	<section class="max-w-6xl mx-auto w-full px-6 pt-24 pb-24">
		<div class="mb-12">
			<p class="font-mono text-sm text-accent-primary tracking-widest mb-4">001 — WORKSPACES</p>
			<h2 class="text-[34px] md:text-[44px] font-sans font-semibold text-text-primary tracking-tight leading-[1.1]">
				Pick how you want to <em class="text-accent-primary not-italic">work</em>.
			</h2>
		</div>

		<div class="grid md:grid-cols-2 gap-6">
			<!-- Canvas card -->
			<a
				href="/canvas"
				class="group relative block rounded-lg border border-surface-border bg-bg-secondary overflow-hidden transition-all hover:border-accent-primary/60 hover:-translate-y-1"
			>
				<div class="aspect-[16/10] bg-bg-primary border-b border-surface-border overflow-hidden relative">
					<img
						src="/landing-canvas.png"
						alt="Spawner Canvas"
						class="absolute inset-0 w-full h-full object-cover object-top opacity-90 group-hover:opacity-100 transition-opacity"
						loading="lazy"
					/>
				</div>
				<div class="p-8">
					<p class="font-mono text-xs text-accent-primary tracking-widest mb-3">CANVAS</p>
					<h3 class="text-[22px] font-sans font-semibold text-text-primary mb-3 leading-tight">
						See it like a <em class="text-accent-primary not-italic">flowchart</em>.
					</h3>
					<p class="text-base text-text-secondary leading-relaxed mb-6">
						Seeing your agent build hasn't been this fun.
					</p>
					<span class="inline-flex items-center gap-2 text-base font-medium text-accent-primary group-hover:gap-3 transition-all">
						Open canvas
						<Icon name="arrow-right" size={16} />
					</span>
				</div>
			</a>

			<!-- Kanban card -->
			<a
				href="/kanban"
				class="group relative block rounded-lg border border-surface-border bg-bg-secondary overflow-hidden transition-all hover:border-accent-primary/60 hover:-translate-y-1"
			>
				<div class="aspect-[16/10] bg-bg-primary border-b border-surface-border overflow-hidden relative">
					<img
						src="/landing-kanban.png"
						alt="Spawner Kanban"
						class="absolute inset-0 w-full h-full object-cover object-top opacity-90 group-hover:opacity-100 transition-opacity"
						loading="lazy"
					/>
				</div>
				<div class="p-8">
					<p class="font-mono text-xs text-accent-primary tracking-widest mb-3">KANBAN</p>
					<h3 class="text-[22px] font-sans font-semibold text-text-primary mb-3 leading-tight">
						Watch it like a <em class="text-accent-primary not-italic">board</em>.
					</h3>
					<p class="text-base text-text-secondary leading-relaxed mb-6">
						Every mission, To do / In progress / Done.
					</p>
					<span class="inline-flex items-center gap-2 text-base font-medium text-accent-primary group-hover:gap-3 transition-all">
						Open kanban
						<Icon name="arrow-right" size={16} />
					</span>
				</div>
			</a>
		</div>
	</section>

	<!-- 002 — See the harness work -->
	<section class="max-w-6xl mx-auto w-full px-6 pb-24 border-t border-surface-border pt-20">
		<div class="mb-12">
			<p class="font-mono text-sm text-accent-primary tracking-widest mb-4">002 — SEE IT WORK</p>
			<h2 class="text-[34px] md:text-[44px] font-sans font-semibold text-text-primary tracking-tight leading-[1.1] max-w-3xl mb-4">
				No more guessing if the agent is <em class="text-accent-primary not-italic">actually</em> doing the thing.
			</h2>
			<p class="text-base md:text-[17px] text-text-secondary max-w-2xl leading-relaxed">
				Every mission breaks into tasks. Every task pulls in a skill. You watch each one happen, in order, in real time.
			</p>
		</div>

		<JourneyDemo />
	</section>

	<!-- 003 — Skills auto-couple to tasks -->
	<section class="max-w-6xl mx-auto w-full px-6 pb-24 border-t border-surface-border pt-20">
		<div class="mb-12">
			<p class="font-mono text-sm text-accent-primary tracking-widest mb-4">003 — SKILLS</p>
			<h2 class="text-[34px] md:text-[44px] font-sans font-semibold text-text-primary tracking-tight leading-[1.1] max-w-3xl mb-4">
				Tasks <em class="text-accent-primary not-italic">attach</em> their own skills.
			</h2>
			<p class="text-base md:text-[17px] text-text-secondary max-w-3xl leading-relaxed">
				You don't pick the right skill — the task does. Free covers the basics. Pro unlocks the full library.
			</p>
		</div>

		<!-- Free vs Pro -->
		<div class="grid md:grid-cols-2 gap-6 mb-10">
			<div class="rounded-lg border border-surface-border bg-bg-secondary p-8">
				<div class="flex items-baseline justify-between mb-4">
					<p class="font-mono text-xs text-text-tertiary tracking-widest">FREE</p>
					<p class="font-mono text-sm text-text-tertiary">included</p>
				</div>
				<p class="text-5xl font-sans font-semibold text-text-primary mb-3 leading-none">
					30<span class="text-accent-primary">+</span>
				</p>
				<p class="text-base text-text-secondary leading-relaxed">
					Enough to ship landing pages, scripts, content drafts, basic audits.
				</p>
			</div>
			<div class="rounded-lg border border-accent-primary/40 bg-accent-primary/5 p-8 relative overflow-hidden">
				<div class="absolute -top-12 -right-12 w-40 h-40 rounded-full bg-accent-primary/10 blur-3xl pointer-events-none"></div>
				<div class="flex items-baseline justify-between mb-4 relative">
					<p class="font-mono text-xs text-accent-primary tracking-widest">SPARK PRO</p>
					<p class="font-mono text-sm text-accent-primary">benchmarked</p>
				</div>
				<p class="text-5xl font-sans font-semibold text-text-primary mb-3 leading-none relative">
					600<span class="text-accent-primary">+</span>
				</p>
				<p class="text-base text-text-secondary leading-relaxed relative">
					Backend, frontend, design, security, trading, ops — every domain has its expert.
				</p>
			</div>
		</div>

		<SkillCloud />
	</section>

	<!-- 004 — Telegram -->
	<section class="max-w-6xl mx-auto w-full px-6 pb-32 border-t border-surface-border pt-20">
		<div class="grid md:grid-cols-2 gap-12 items-center">
			<div>
				<p class="font-mono text-sm text-accent-primary tracking-widest mb-4">004 — FROM YOUR PHONE</p>
				<h2 class="text-[34px] md:text-[44px] font-sans font-semibold text-text-primary tracking-tight leading-[1.1] mb-5">
					Message your <em class="text-accent-primary not-italic">Telegram bot</em>. Watch it ship.
				</h2>
				<p class="text-base md:text-[17px] text-text-secondary max-w-md leading-relaxed mb-6">
					Get stuff done from anywhere. The mission gets built on canvas, the tasks land on kanban — you see it happening, in real time.
				</p>
				<ul class="space-y-3 max-w-md">
					<li class="flex items-start gap-3">
						<span class="font-mono text-xs text-accent-primary tracking-widest mt-1.5 shrink-0">01</span>
						<span class="text-base text-text-secondary leading-relaxed">Tap send. Anywhere — phone, couch, queue.</span>
					</li>
					<li class="flex items-start gap-3">
						<span class="font-mono text-xs text-accent-primary tracking-widest mt-1.5 shrink-0">02</span>
						<span class="text-base text-text-secondary leading-relaxed">Spawner builds it on canvas, skills auto-couple.</span>
					</li>
					<li class="flex items-start gap-3">
						<span class="font-mono text-xs text-accent-primary tracking-widest mt-1.5 shrink-0">03</span>
						<span class="text-base text-text-secondary leading-relaxed">Result lands back in chat with a preview link.</span>
					</li>
				</ul>
			</div>

			<TelegramPhone />
		</div>
	</section>

	</main>

	<!-- Footer -->
	<Footer />
</div>
{:else}
<PublicSpawnerPreview />
{/if}
