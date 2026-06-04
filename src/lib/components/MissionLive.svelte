<!--
	MissionLive — the hero. A wide, social-shareable view of an agent
	building right now. Tasks queue, run, succeed. Designed to be a joy
	to watch, not a thing to second-guess.

	No router state, no real backend — purely a scripted demo so it always
	plays. Slow tempo so the eye can follow each transition.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	type TaskState = 'queued' | 'running' | 'done';
	type Task = {
		id: string;
		title: string;
		skills: string[];
		state: TaskState;
		progress: number; // 0..100
	};

	const SCRIPT: Omit<Task, 'state' | 'progress'>[] = [
		{ id: 't1', title: 'Sketch the layout',          skills: ['ui-design', 'figma']        },
		{ id: 't2', title: 'Build the page',             skills: ['sveltekit', 'tailwind']     },
		{ id: 't3', title: 'Wire the signup form',       skills: ['api-design', 'backend']     },
		{ id: 't4', title: 'Add analytics + tracking',   skills: ['analytics', 'observability']},
		{ id: 't5', title: 'Ship to preview URL',        skills: ['cloudflare', 'devops']      }
	];

	// Initialize mid-flight so first paint looks like work in progress —
	// the eye lands on a running mission, not an idle queue. Task 1 is
	// already done, task 2 is partway through.
	let tasks = $state<Task[]>(
		SCRIPT.map((t, i) => {
			if (i === 0) return { ...t, state: 'done' as TaskState, progress: 100 };
			if (i === 1) return { ...t, state: 'running' as TaskState, progress: 45 };
			return { ...t, state: 'queued' as TaskState, progress: 0 };
		})
	);
	let elapsed = $state('00:42');

	let phaseTimer: ReturnType<typeof setInterval> | null = null;
	let elapsedTimer: ReturnType<typeof setInterval> | null = null;
	let phaseRestartTimer: ReturnType<typeof setTimeout> | null = null;
	let startedAt = 0;

	function fmtElapsed(ms: number): string {
		const s = Math.floor(ms / 1000);
		return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
	}

	function reset() {
		tasks = SCRIPT.map((t) => ({ ...t, state: 'queued' as TaskState, progress: 0 }));
		startedAt = Date.now();
	}

	const TICK_MS = 250;
	const PROGRESS_PER_TICK = 5; // 5% per 250ms => 100% in 5s

	function tick() {
		tasks = tasks.map((t, i, arr) => {
			if (t.state === 'done') return t;
			if (t.state === 'running') {
				const next = Math.min(100, t.progress + PROGRESS_PER_TICK);
				if (next >= 100) return { ...t, progress: 100, state: 'done' as const };
				return { ...t, progress: next };
			}
			if (i === 0 || arr[i - 1].state === 'done') {
				return { ...t, state: 'running' as const, progress: PROGRESS_PER_TICK };
			}
			return t;
		});

		if (tasks.every((t) => t.state === 'done')) {
			if (phaseTimer) {
				clearInterval(phaseTimer);
				phaseTimer = null;
			}
			phaseRestartTimer = setTimeout(() => {
				phaseRestartTimer = null;
				reset();
				phaseTimer = setInterval(tick, TICK_MS);
			}, 4500);
		}
	}

	onMount(() => {
		// Backdate the clock 42s so it picks up where the seeded "mid-flight"
		// state suggests we are. Reset() snaps it back to zero.
		startedAt = Date.now() - 42000;
		elapsedTimer = setInterval(() => {
			elapsed = fmtElapsed(Date.now() - startedAt);
		}, 500);
		phaseTimer = setInterval(tick, TICK_MS);
	});

	onDestroy(() => {
		if (phaseTimer) clearInterval(phaseTimer);
		if (elapsedTimer) clearInterval(elapsedTimer);
		if (phaseRestartTimer) clearTimeout(phaseRestartTimer);
	});

	const completed = $derived(tasks.filter((t) => t.state === 'done').length);
	const overall = $derived(Math.round(tasks.reduce((sum, t) => sum + t.progress, 0) / tasks.length));
	const runningTask = $derived(tasks.find((t) => t.state === 'running'));
</script>

<section class="border-b border-surface-border">
	<div class="max-w-6xl mx-auto px-6 pt-14 pb-16">
		<!-- Header strip -->
		<div class="flex items-end justify-between flex-wrap gap-4 mb-7">
			<div>
				<p class="font-mono text-xs text-accent-primary tracking-widest mb-3">LIVE · MISSION</p>
				<h1 class="text-4xl md:text-[52px] font-sans font-semibold text-text-primary tracking-tight leading-[1.05]">
					Watch your agent <em class="text-accent-primary not-italic">actually</em> ship.
				</h1>
				<p class="mt-4 text-base md:text-lg text-text-secondary max-w-2xl leading-relaxed">
					No second-guessing. Every task, every skill, every step — visible.
				</p>
			</div>
			<div class="text-right shrink-0 hidden sm:block">
				<p class="font-mono text-[10px] text-text-tertiary tracking-widest mb-1">ELAPSED</p>
				<p class="font-mono text-[26px] font-medium text-text-primary tabular-nums">{elapsed}</p>
			</div>
		</div>

		<!-- The live panel -->
		<div class="rounded-lg border border-surface-border bg-bg-secondary overflow-hidden">
			<!-- Top status bar -->
			<div class="flex items-center justify-between gap-4 px-6 py-4 border-b border-surface-border bg-bg-primary/40">
				<div class="flex items-center gap-3">
					<span class="relative flex h-2.5 w-2.5">
						<span class="absolute inline-flex h-full w-full rounded-full bg-accent-primary opacity-60 animate-ping-slow"></span>
						<span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-accent-primary"></span>
					</span>
					<span class="font-mono text-sm text-text-primary">
						{#if runningTask}
							running · <span class="text-text-secondary">{runningTask.title}</span>
						{:else if completed === tasks.length}
							complete · <span class="text-text-secondary">5 of 5 tasks shipped</span>
						{:else}
							queueing · <span class="text-text-secondary">5 tasks</span>
						{/if}
					</span>
				</div>
				<div class="flex items-center gap-6 font-mono text-sm text-text-tertiary">
					<span>{completed}/{tasks.length} done</span>
					<span class="hidden md:inline">overall {overall}%</span>
				</div>
			</div>

			<!-- Overall progress -->
			<div class="px-6 pt-5">
				<div class="h-1.5 rounded-full bg-surface-border overflow-hidden">
					<div
						class="h-full bg-accent-primary transition-all duration-500 ease-out"
						style="width: {overall}%"
					></div>
				</div>
			</div>

			<!-- Tasks -->
			<ol class="px-6 py-6 space-y-3">
				{#each tasks as task, i (task.id)}
					<li
						class="rounded-md border transition-all duration-700 ease-out"
						class:border-accent-primary={task.state === 'running'}
						class:bg-accent-primary={false}
						class:border-surface-border={task.state !== 'running'}
						class:bg-bg-primary={task.state === 'queued'}
						class:bg-bg-secondary={task.state !== 'queued'}
						style={task.state === 'running' ? 'box-shadow: 0 0 0 1px rgb(var(--accent-rgb) / 0.15), 0 0 28px -8px rgb(var(--accent-rgb) / 0.3);' : ''}
					>
						<div class="flex items-center gap-4 px-5 py-4">
							<!-- State indicator -->
							<div class="shrink-0 w-7 h-7 rounded-full border flex items-center justify-center transition-all duration-500"
								class:border-accent-primary={task.state !== 'queued'}
								class:bg-accent-primary={task.state === 'done'}
								class:border-surface-border={task.state === 'queued'}
							>
								{#if task.state === 'done'}
									<svg class="w-4 h-4 text-accent-fg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
								{:else if task.state === 'running'}
									<span class="w-2 h-2 rounded-full bg-accent-primary animate-pulse-slow"></span>
								{:else}
									<span class="font-mono text-xs text-text-tertiary">{i + 1}</span>
								{/if}
							</div>

							<!-- Title + skills -->
							<div class="flex-1 min-w-0">
								<p class="text-base md:text-lg font-sans text-text-primary leading-snug">
									{task.title}
								</p>
								<div class="flex flex-wrap items-center gap-2 mt-2">
									{#each task.skills as skill}
										<span class="inline-flex items-center px-2.5 py-1 rounded-full border border-surface-border bg-bg-primary/50 font-mono text-[11px] text-text-tertiary">
											{skill}
										</span>
									{/each}
								</div>
							</div>

							<!-- State label -->
							<div class="shrink-0 text-right hidden sm:block">
								{#if task.state === 'done'}
									<span class="font-mono text-xs text-accent-primary tracking-widest">DONE</span>
								{:else if task.state === 'running'}
									<span class="font-mono text-xs text-accent-primary tracking-widest">RUNNING</span>
								{:else}
									<span class="font-mono text-xs text-text-tertiary tracking-widest">QUEUED</span>
								{/if}
							</div>
						</div>
					</li>
				{/each}
			</ol>
		</div>

		<!-- Scroll cue -->
		<div class="mt-10 flex flex-col items-center gap-2 text-text-tertiary">
			<span class="font-mono text-xs tracking-widest">SCROLL TO SEE HOW</span>
			<svg class="w-4 h-4 animate-bounce-slow" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
			</svg>
		</div>
	</div>
</section>

<style>
	@keyframes ping-slow {
		0% { transform: scale(1); opacity: 0.6; }
		75%, 100% { transform: scale(2.2); opacity: 0; }
	}
	:global(.animate-ping-slow) {
		animation: ping-slow 2.4s cubic-bezier(0, 0, 0.2, 1) infinite;
	}
	@keyframes pulse-slow {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.35; }
	}
	:global(.animate-pulse-slow) {
		animation: pulse-slow 2s ease-in-out infinite;
	}
	@keyframes bounce-slow {
		0%, 100% { transform: translateY(0); opacity: 0.7; }
		50% { transform: translateY(6px); opacity: 1; }
	}
	:global(.animate-bounce-slow) {
		animation: bounce-slow 2.4s ease-in-out infinite;
	}
</style>
