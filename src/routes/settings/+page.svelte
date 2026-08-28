<script lang="ts">
	import { browser } from '$app/environment';
	import Navbar from '$lib/components/Navbar.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import { pipelines } from '$lib/stores/pipelines.svelte';
	import { getGeneratedSkillsCount, clearGeneratedSkills } from '$lib/stores/skills.svelte';
	import { parseJsonResponse, responseStatusMessage } from '$lib/services/http-response';

	type AccessAction = {
		id: string;
		label: string;
		displayCommand: string;
		runPolicy: string;
		confirmation?: string;
	};
	type AccessPanelAccess = {
		recommended?: {
			id?: string;
			label?: string;
			userMessage?: string;
			runPolicy?: string;
		};
	};

	let pipelineCount = $state(0);
	let generatedSkillsCount = $state(0);
	let localStorageSize = $state('0 KB');
	let accessPanel = $state<{
		loading: boolean;
		error: string;
		runningActionId: string;
		result: string;
		actions: AccessAction[];
		access: AccessPanelAccess;
	}>({
		loading: true,
		error: '',
		runningActionId: '',
		result: '',
		actions: [],
		access: {}
	});

	function calculateLocalStorageSize(): string {
		if (!browser) return '0 KB';
		let total = 0;
		for (const key of Object.keys(localStorage)) {
			if (key.startsWith('spawner-')) {
				total += (localStorage.getItem(key)?.length || 0) * 2;
			}
		}
		if (total < 1024) return `${total} B`;
		if (total < 1024 * 1024) return `${(total / 1024).toFixed(1)} KB`;
		return `${(total / (1024 * 1024)).toFixed(2)} MB`;
	}

	function refreshStorageStats() {
		if (!browser) return;
		generatedSkillsCount = getGeneratedSkillsCount();
		localStorageSize = calculateLocalStorageSize();
	}

	function handleClearGeneratedSkills() {
		if (!confirm('Clear all generated skills? This cannot be undone.')) return;
		clearGeneratedSkills();
		refreshStorageStats();
	}

	function handleClearAllData() {
		if (!confirm('Clear ALL Spawner data from localStorage? This includes pipelines, skills, and settings. This cannot be undone.')) {
			return;
		}

		if (!browser) return;
		const keysToDelete = Object.keys(localStorage).filter((key) => key.startsWith('spawner-'));
		for (const key of keysToDelete) {
			localStorage.removeItem(key);
		}
		window.location.reload();
	}

	async function refreshAccessPanel() {
		if (!browser) return;
		accessPanel.loading = true;
		accessPanel.error = '';
		try {
			const response = await fetch('/api/access/execution-lanes');
			if (!response.ok) {
				throw new Error(await responseStatusMessage(response, 'Access lane check failed'));
			}
			const body = await parseJsonResponse<{ success?: boolean; error?: string; access?: AccessPanelAccess; actions?: AccessAction[] } | null>(response, null);
			if (!body) {
				throw new Error('Access lane check returned a non-JSON response');
			}
			if (body.success === false) {
				throw new Error(body.error || 'Access lane check failed');
			}
			accessPanel.access = body.access || {};
			accessPanel.actions = Array.isArray(body.actions) ? body.actions : [];
		} catch (error) {
			accessPanel.error = error instanceof Error ? error.message : 'Access lane check failed';
		} finally {
			accessPanel.loading = false;
		}
	}

	function accessActionVisible(action: { id: string }) {
		return ['workspace_setup', 'docker_doctor', 'docker_smoke', 'level5_enable', 'level5_disable'].includes(action.id);
	}

	async function runAccessAction(action: { id: string; label: string; runPolicy: string; confirmation?: string }) {
		const body: { actionId: string; confirmed?: boolean; explicitOptIn?: string } = { actionId: action.id };
		if (action.runPolicy === 'confirm_once') {
			if (!confirm(`${action.label}\n\n${action.confirmation || 'Confirm this access action.'}`)) return;
			body.confirmed = true;
		}
		if (action.runPolicy === 'explicit_opt_in') {
			const required = action.confirmation || 'Enable whole-computer operator mode';
			const typed = prompt(`Type this exact phrase to continue:\n\n${required}`);
			if (typed !== required) return;
			body.explicitOptIn = typed;
		}

		accessPanel.runningActionId = action.id;
		accessPanel.result = '';
		accessPanel.error = '';
		try {
			const response = await fetch('/api/access/execution-lanes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!response.ok) {
				throw new Error(await responseStatusMessage(response, 'Access action failed'));
			}
			const result = await parseJsonResponse<{ success?: boolean; error?: string; result?: { payload?: { next?: string }; stderr?: string } } | null>(response, null);
			if (!result) {
				throw new Error('Access action returned a non-JSON response');
			}
			if (result.success === false) {
				throw new Error(result.error || 'Access action failed');
			}
			const payload = result.result?.payload || {};
			const next = payload.next || result.result?.stderr || '';
			accessPanel.result = `${action.label} finished.${next ? ` Next: ${next}` : ''}`;
			await refreshAccessPanel();
		} catch (error) {
			accessPanel.error = error instanceof Error ? error.message : 'Access action failed';
		} finally {
			accessPanel.runningActionId = '';
		}
	}

	$effect(() => {
		const unsubscribe = pipelines.subscribe((items) => {
			pipelineCount = items.length;
		});
		refreshStorageStats();
		refreshAccessPanel();
		return () => unsubscribe();
	});
</script>

<div class="min-h-screen bg-bg-primary flex flex-col">
	<Navbar />

	<main class="flex-1 max-w-4xl mx-auto w-full px-6 py-12">
		<div class="mb-8">
			<h1 class="text-3xl font-serif text-text-primary mb-2">Settings</h1>
			<p class="text-text-secondary">Spawner keeps runtime data local. Provider setup and mission options live in the execution flow.</p>
		</div>

		<section class="mb-12">
			<div class="mb-6 flex items-center justify-between">
				<div>
					<h2 class="flex items-center gap-2 text-xl font-medium text-text-primary">
						Safe Access
						<span class="text-sm font-mono text-accent-secondary">Spark CLI</span>
					</h2>
					<p class="mt-1 text-sm text-text-secondary">
						Set up the workspace sandbox, check Docker, and manage Level 5 guardrails without using a terminal.
					</p>
				</div>
				<button
					onclick={refreshAccessPanel}
					class="px-3 py-1.5 text-sm font-mono text-text-secondary border border-surface-border hover:border-text-tertiary transition-all"
				>
					Refresh
				</button>
			</div>

			<div class="border border-surface-border bg-bg-secondary">
				<div class="border-b border-surface-border p-4">
					<div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
						<div>
							<p class="text-sm font-medium text-text-primary">
								{accessPanel.access.recommended?.label || 'Spark Workspace Sandbox'}
							</p>
							<p class="mt-1 text-sm text-text-secondary">
								{accessPanel.access.recommended?.userMessage || 'Spark will prefer a safe workspace before broader access.'}
							</p>
						</div>
						<span class="w-fit border border-accent-primary/30 bg-accent-primary/10 px-2 py-1 text-xs font-mono text-accent-primary">
							{accessPanel.access.recommended?.runPolicy || 'auto_safe'}
						</span>
					</div>
				</div>

				<div class="grid gap-3 p-4 md:grid-cols-2">
					{#if accessPanel.loading}
						<p class="text-sm text-text-secondary">Checking access lanes...</p>
					{:else}
						{#each accessPanel.actions.filter(accessActionVisible) as action}
							<button
								onclick={() => runAccessAction(action)}
								disabled={Boolean(accessPanel.runningActionId)}
								class="border border-surface-border bg-bg-primary p-4 text-left transition-all hover:border-accent-primary/50 disabled:cursor-wait disabled:opacity-60"
							>
								<div class="flex items-center justify-between gap-3">
									<span class="font-medium text-text-primary">{action.label}</span>
									<span class="text-xs font-mono text-text-tertiary">{action.runPolicy}</span>
								</div>
								<p class="mt-2 text-xs font-mono text-text-secondary">{action.displayCommand}</p>
								{#if action.confirmation}
									<p class="mt-2 text-xs text-status-yellow">{action.confirmation}</p>
								{/if}
							</button>
						{/each}
					{/if}
				</div>

				{#if accessPanel.error || accessPanel.result}
					<div class="border-t border-surface-border p-4">
						<p class={accessPanel.error ? 'text-sm text-red-400' : 'text-sm text-status-green'}>
							{accessPanel.error || accessPanel.result}
						</p>
					</div>
				{/if}
			</div>
		</section>

		<section class="mb-12">
			<div class="flex items-center justify-between mb-6">
				<div>
					<h2 class="text-xl font-medium text-text-primary flex items-center gap-2">
						Local Data
						<span class="text-sm font-mono text-accent-secondary">localStorage</span>
					</h2>
					<p class="text-sm text-text-secondary mt-1">
						Canvas state, generated skills, and UI defaults are stored in your browser.
					</p>
				</div>
				<span class="flex items-center gap-1.5 px-2 py-1 text-xs font-mono text-accent-primary border border-accent-primary/30 bg-accent-primary/10">
					{localStorageSize}
				</span>
			</div>

			<div class="border border-surface-border bg-bg-secondary">
				<div class="p-4 flex items-center justify-between border-b border-surface-border">
					<div class="flex items-center gap-3">
						<div class="w-10 h-10 flex items-center justify-center bg-blue-500/10 border border-blue-500/30">
							<svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"/>
							</svg>
						</div>
						<div>
							<span class="font-medium text-text-primary">Pipelines</span>
							<p class="text-sm text-text-secondary">Saved canvas workflows</p>
						</div>
					</div>
					<span class="text-lg font-mono text-text-primary">{pipelineCount}</span>
				</div>

				<div class="p-4 flex items-center justify-between border-b border-surface-border">
					<div class="flex items-center gap-3">
						<div class="w-10 h-10 flex items-center justify-center bg-purple-500/10 border border-purple-500/30">
							<svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
							</svg>
						</div>
						<div>
							<span class="font-medium text-text-primary">Generated Skills</span>
							<p class="text-sm text-text-secondary">Skills created from PRD analysis</p>
						</div>
					</div>
					<div class="flex items-center gap-3">
						<span class="text-lg font-mono text-text-primary">{generatedSkillsCount}</span>
						{#if generatedSkillsCount > 0}
							<button
								onclick={handleClearGeneratedSkills}
								class="text-xs text-text-tertiary hover:text-red-400 transition-colors"
							>
								Clear
							</button>
						{/if}
					</div>
				</div>

				<div class="p-4 flex items-center justify-between border-b border-surface-border">
					<div class="flex items-center gap-3">
						<div class="w-10 h-10 flex items-center justify-center bg-green-500/10 border border-green-500/30">
							<svg class="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
							</svg>
						</div>
						<div>
							<span class="font-medium text-text-primary">Preferences</span>
							<p class="text-sm text-text-secondary">Canvas and execution defaults</p>
						</div>
					</div>
					<span class="text-sm font-mono text-green-400">Auto-saved</span>
				</div>

				<div class="p-4">
					<div class="flex items-center justify-between">
						<p class="text-sm text-text-secondary">
							All local data uses <code class="px-1 py-0.5 bg-bg-primary border border-surface-border text-xs">spawner-*</code> keys.
						</p>
						<div class="flex items-center gap-2">
							<button
								onclick={refreshStorageStats}
								class="px-3 py-1.5 text-sm font-mono text-text-secondary border border-surface-border hover:border-text-tertiary transition-all"
							>
								Refresh
							</button>
							<button
								onclick={handleClearAllData}
								class="px-3 py-1.5 text-sm font-mono text-red-400/70 border border-red-500/30 hover:border-red-500 hover:text-red-400 transition-all"
							>
								Clear All Data
							</button>
						</div>
					</div>
				</div>
			</div>
		</section>
	</main>

	<Footer />
</div>
<!-- TODO(spark-compete-qa): Level 5 one-click access with no confirmation in Settings UI - QA 2026-06-03
  Bug 1: "Confirm Access Level 5" button enables whole-computer operator mode
  with only explicit_opt_in label — no confirmation dialog shown in UI.
  One accidental click enables Level 5 with no warning about consequences.

  Bug 2: "Clear All Data" button has no confirmation dialog.
  One click deletes all local data including pipelines and skills instantly.
  No warning about what gets deleted or that it cannot be undone.

  Before:
  - "Confirm Access Level 5" button visible with no confirmation dialog
  - "Clear All Data" button visible with no confirmation dialog
  - Both destructive actions one click away with no safety gate

  After:
  - "Confirm Access Level 5" must show confirmation dialog:
    "This enables whole-computer operator mode. Are you sure?
    spark access setup --level 5 --enable-high-agency
    This gives Spark access to your entire machine. Confirm?"
  - "Clear All Data" must show confirmation dialog:
    "This will delete all pipelines, skills, and preferences.
    This cannot be undone. Are you sure?"

  Fix needed in settings/+page.svelte:
  1. Add confirmation dialog before Level 5 activation
  2. Add confirmation dialog before Clear All Data
  3. Both dialogs must explain what gets changed and warn it may be irreversible
  4. Level 5 dialog must show the exact command that will run
  5. Return to Level 4 button should also require confirm_once
-->
