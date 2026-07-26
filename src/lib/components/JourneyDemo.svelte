<!--
	Animated journey: prompt → tasks → bound to right skill → ship.
	Cycles through 3 example missions. Each cycle renders the
	task↔skill binding in a different view (list / kanban / canvas)
	to drive home: same coupling, every view.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	type ViewKind = 'list' | 'kanban' | 'canvas';
	type Task = { title: string; skills: string[]; column?: 'todo' | 'doing' | 'done' };
	type Example = {
		prompt: string;
		view: ViewKind;
		tasks: Task[];
		result: string;
	};

	const EXAMPLES: Example[] = [
		{
			prompt: 'Build a landing page for my SaaS',
			view: 'list',
			tasks: [
				{ title: 'Design a layout',  skills: ['ui-design', 'web3-ui'] },
				{ title: 'Build the page',   skills: ['frontend', 'sveltekit'] },
				{ title: 'Wire the form',    skills: ['backend', 'api-design'] }
			],
			result: 'Mission shipped — open it on the canvas.'
		},
		{
			prompt: 'Audit my smart contract',
			view: 'kanban',
			tasks: [
				{ title: 'Static analysis',     skills: ['security-owasp', 'opengrep'], column: 'done' },
				{ title: 'Reentrancy check',    skills: ['solidity', 'web3-contracts'], column: 'doing' },
				{ title: 'Write the report',    skills: ['compliance', 'docs'],          column: 'todo' }
			],
			result: 'Tracked on kanban — every task, every skill.'
		},
		{
			prompt: 'Launch a content campaign',
			view: 'canvas',
			tasks: [
				{ title: 'Find the angle',     skills: ['marketing', 'xcontent'] },
				{ title: 'Draft 10 posts',     skills: ['copywriting', 'voice-style'] },
				{ title: 'Schedule + score',   skills: ['scheduling', 'virality'] }
			],
			result: 'Wired on canvas — flowchart you can edit.'
		}
	];

	let cycle = $state(0);
	// Start at "done" so the first paint shows the full journey populated;
	// then the loop walks back through prompt -> tasks -> skills -> done.
	let step = $state(3);
	let timer: ReturnType<typeof setInterval> | null = null;

	const current = $derived(EXAMPLES[cycle % EXAMPLES.length]);
	const viewLabel = $derived({
		list:   'BOUND IN THE LIST',
		kanban: 'BOUND ON THE KANBAN',
		canvas: 'BOUND ON THE CANVAS'
	}[current.view]);

	const kanbanColumns: { id: 'todo' | 'doing' | 'done'; label: string; dot: string }[] = [
		{ id: 'todo',  label: 'To do',       dot: 'bg-text-tertiary'   },
		{ id: 'doing', label: 'In progress', dot: 'bg-accent-primary'  },
		{ id: 'done',  label: 'Done',        dot: 'bg-status-amber'    }
	];

	onMount(() => {
		setTimeout(() => {
			cycle = 1;
			step = 0;
			const PHASE_MS = 4200;
			timer = setInterval(() => {
				step += 1;
				if (step > 3) {
					step = 0;
					cycle += 1;
				}
			}, PHASE_MS);
		}, 5000);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});
</script>

<div class="rounded-lg border border-surface-border bg-bg-secondary p-8 md:p-12 overflow-hidden">
	<!-- Phase 1: prompt -->
	<div class="mb-10">
		<p class="font-mono text-xs text-text-tertiary tracking-widest mb-3">YOU SAY</p>
		<div class="rounded-md border border-surface-border bg-bg-primary px-5 py-4 min-h-[64px] flex items-center">
			{#key cycle}
				<p class="text-xl md:text-2xl font-sans text-text-primary leading-tight prompt-typing">
					{current.prompt}
				</p>
			{/key}
		</div>
	</div>

	<!-- Phase 2: tasks materialize -->
	<div class="mb-10">
		<p class="font-mono text-xs text-text-tertiary tracking-widest mb-3">
			SPAWNER BREAKS IT DOWN
			<span class="text-accent-primary ml-2" class:opacity-0={step < 1}>↓</span>
		</p>
		<div class="grid md:grid-cols-3 gap-3">
			{#each current.tasks as task, i (cycle + '-' + i)}
				<div
					class="rounded-md border border-surface-border bg-bg-primary p-4 transition-all duration-500"
					class:task-in={step >= 1}
					class:task-pre={step < 1}
					style="--delay: {i * 120}ms"
				>
					<p class="font-mono text-[10px] text-accent-primary tracking-widest mb-2">TASK {i + 1}</p>
					<p class="text-base font-sans text-text-primary leading-snug">{task.title}</p>
				</div>
			{/each}
		</div>
	</div>

	<!-- Phase 3: bound — view changes per example -->
	<div class="mb-10">
		<p class="font-mono text-xs text-text-tertiary tracking-widest mb-3">
			{viewLabel}
			<span class="text-accent-primary ml-2" class:opacity-0={step < 2}>↓</span>
		</p>

		{#key cycle}
			{#if current.view === 'list'}
				<!-- LIST VIEW: tasks stacked, skill chips below each -->
				<div class="grid md:grid-cols-3 gap-3 view-fade">
					{#each current.tasks as task, i}
						<div class="flex flex-wrap gap-2">
							{#each task.skills as skill, j}
								<span
									class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-accent-primary/40 bg-accent-primary/10 transition-all duration-500"
									class:skill-in={step >= 2}
									class:skill-pre={step < 2}
									style="--delay: {(i * 200) + (j * 100)}ms"
								>
									<span class="w-1.5 h-1.5 rounded-full bg-accent-primary" class:pulse={step >= 2}></span>
									<span class="font-mono text-sm text-text-primary">{skill}</span>
								</span>
							{/each}
						</div>
					{/each}
				</div>

			{:else if current.view === 'kanban'}
				<!-- KANBAN VIEW: three columns, tasks distributed by .column -->
				<div class="grid md:grid-cols-3 gap-3 view-fade">
					{#each kanbanColumns as col, c}
						<div
							class="rounded-md border border-surface-border bg-bg-primary/50 p-3 transition-all duration-500"
							class:skill-in={step >= 2}
							class:skill-pre={step < 2}
							style="--delay: {c * 200}ms"
						>
							<div class="flex items-center gap-2 mb-3">
								<span class="w-2 h-2 rounded-full {col.dot}"></span>
								<span class="font-mono text-[10px] tracking-widest uppercase text-text-tertiary">{col.label}</span>
							</div>
							<div class="space-y-2">
								{#each current.tasks.filter((t) => t.column === col.id) as task}
									<div class="rounded-md border border-surface-border bg-bg-secondary p-3">
										<p class="text-sm font-sans text-text-primary leading-snug mb-2">{task.title}</p>
										<div class="flex flex-wrap gap-1.5">
											{#each task.skills as skill}
												<span class="inline-flex items-center px-2 py-0.5 rounded-full border border-accent-primary/40 bg-accent-primary/10 font-mono text-[11px] text-text-primary">
													{skill}
												</span>
											{/each}
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/each}
				</div>

			{:else}
				<!-- CANVAS VIEW: real Spark node styling — chromed header + body -->
				<div class="rounded-md border border-surface-border bg-bg-primary p-5 view-fade canvas-grid">
					<div class="flex items-stretch gap-3 flex-wrap md:flex-nowrap">
						{#each current.tasks as task, i}
							<div
								class="flex-1 min-w-[200px] canvas-node transition-all duration-500"
								class:skill-in={step >= 2}
								class:skill-pre={step < 2}
								style="--delay: {i * 200}ms"
							>
								<!-- Chrome header (mono tag + secondary label) -->
								<div class="canvas-chrome">
									<span class="chrome-tag">PROJ</span>
									<i class="chrome-sub">node {i + 1}</i>
								</div>
								<!-- Body -->
								<div class="canvas-body">
									<p class="text-[15px] font-sans font-medium text-text-primary leading-snug mb-2">
										{task.title}
									</p>
									<div class="flex flex-wrap gap-1.5">
										{#each task.skills as skill}
											<span class="inline-flex items-center px-2 py-0.5 rounded-full border border-accent-primary/40 bg-accent-primary/10 font-mono text-[11px] text-text-primary">
												{skill}
											</span>
										{/each}
									</div>
								</div>
							</div>
							{#if i < current.tasks.length - 1}
								<div class="hidden md:flex items-center">
									<span class="block w-6 border-t border-dashed border-accent-primary/60"></span>
								</div>
							{/if}
						{/each}
					</div>
				</div>
			{/if}
		{/key}
	</div>

	<!-- Phase 4: ship -->
	<div>
		<p class="font-mono text-xs text-text-tertiary tracking-widest mb-3">RESULT</p>
		<div
			class="rounded-md border bg-bg-primary px-5 py-4 transition-all duration-500"
			class:done-in={step >= 3}
			class:done-pre={step < 3}
		>
			<div class="flex items-center gap-3">
				<span class="text-accent-primary text-2xl leading-none" class:check-pop={step >= 3}>✓</span>
				<p class="text-lg font-sans text-text-primary">{current.result}</p>
			</div>
		</div>
	</div>

	<!-- Progress dots -->
	<div class="mt-10 flex items-center justify-center gap-2">
		{#each EXAMPLES as _, i}
			<button
				type="button"
				aria-label="Show example {i + 1}"
				class="relative flex items-center justify-center w-11 h-11 -mx-2 group/dot"
				onclick={() => { cycle = i; step = 0; }}
			>
				<span
					class="block h-1 rounded-full transition-all duration-300 pointer-events-none"
					class:bg-accent-primary={(cycle % EXAMPLES.length) === i}
					class:bg-surface-border={(cycle % EXAMPLES.length) !== i}
					class:w-8={(cycle % EXAMPLES.length) === i}
					class:w-3={(cycle % EXAMPLES.length) !== i}
				></span>
			</button>
		{/each}
	</div>
</div>

<style>
	.task-pre {
		opacity: 0;
		transform: translateY(8px);
	}
	.task-in {
		opacity: 1;
		transform: translateY(0);
		transition-delay: var(--delay);
		border-color: rgb(var(--accent-rgb) / 0.5);
		box-shadow: 0 0 0 1px rgb(var(--accent-rgb) / 0.1);
	}

	.skill-pre {
		opacity: 0;
		transform: scale(0.94);
	}
	.skill-in {
		opacity: 1;
		transform: scale(1);
		transition-delay: var(--delay);
	}

	.done-pre {
		opacity: 0.4;
		border-color: rgb(var(--border-rgb));
	}
	.done-in {
		opacity: 1;
		border-color: rgb(var(--accent-rgb) / 0.6);
		background: rgb(var(--accent-rgb) / 0.05);
	}

	.check-pop {
		animation: pop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	@keyframes pop {
		0% { transform: scale(0); }
		60% { transform: scale(1.3); }
		100% { transform: scale(1); }
	}

	.pulse {
		animation: pulse 2.6s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.prompt-typing {
		animation: type-in 0.8s ease-out;
	}
	@keyframes type-in {
		from { opacity: 0; transform: translateX(-8px); }
		to { opacity: 1; transform: translateX(0); }
	}

	.view-fade {
		animation: view-fade 0.6s ease-out;
	}
	@keyframes view-fade {
		from { opacity: 0; transform: translateY(6px); }
		to { opacity: 1; transform: translateY(0); }
	}

	/* Faint canvas-style grid behind nodes */
	.canvas-grid {
		background-image:
			linear-gradient(to right, rgb(var(--border-rgb) / 0.45) 1px, transparent 1px),
			linear-gradient(to bottom, rgb(var(--border-rgb) / 0.45) 1px, transparent 1px);
		background-size: 28px 28px;
	}

	/* Spark canvas node — chrome header + body, matching SkillNode.svelte */
	.canvas-node {
		background: rgb(var(--surface-raised-rgb));
		border: 1px solid rgb(var(--border-strong-rgb));
		border-radius: 8px;
		box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.35), 0 0 0 1px rgb(var(--accent-rgb) / 0.18), 0 0 28px -10px rgb(var(--accent-rgb) / 0.35);
		overflow: hidden;
	}

	.canvas-chrome {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 7px 10px;
		background: rgb(var(--bg-subtle-rgb));
		border-bottom: 1px solid rgb(var(--border-rgb));
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 10px;
		letter-spacing: 1.5px;
	}

	.canvas-chrome .chrome-tag {
		color: rgb(var(--text-rgb));
		font-weight: 500;
	}

	.canvas-chrome .chrome-sub {
		font-style: normal;
		color: rgb(var(--text-tertiary-rgb));
		letter-spacing: 1px;
	}

	.canvas-body {
		padding: 12px 14px 14px;
	}
</style>
