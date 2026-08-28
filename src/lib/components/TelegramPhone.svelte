<!--
	TelegramPhone — animated phone mockup showing a chat with the bot.
	User types a goal -> bot replies with a status -> mini canvas + kanban
	thumbnails fade in. Slow tempo to match the rest of the page.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	type Step = 'typing' | 'sent' | 'reply' | 'building' | 'done';

	let step = $state<Step>('done');
	let timer: ReturnType<typeof setInterval> | null = null;
	let startupDelay: ReturnType<typeof setTimeout> | null = null;

	const SCRIPT: Step[] = ['typing', 'sent', 'reply', 'building', 'done'];

	onMount(() => {
		// Show fully populated chat for 4s, then loop the typing animation
		startupDelay = setTimeout(() => {
			startupDelay = null;
			let i = 0;
			step = SCRIPT[0];
			timer = setInterval(() => {
				i = (i + 1) % SCRIPT.length;
				step = SCRIPT[i];
			}, 3500);
		}, 4000);
	});

	onDestroy(() => {
		if (startupDelay) clearTimeout(startupDelay);
		if (timer) clearInterval(timer);
	});

	const showSent = $derived(step === 'sent' || step === 'reply' || step === 'building' || step === 'done');
	const showReply = $derived(step === 'reply' || step === 'building' || step === 'done');
	const showThumbs = $derived(step === 'building' || step === 'done');
	const showDone = $derived(step === 'done');
</script>

<div class="relative mx-auto w-full max-w-[360px]">
	<!-- Phone frame -->
	<div class="rounded-[36px] border border-surface-border bg-bg-secondary p-3 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.6)]">
		<!-- Notch / status bar -->
		<div class="flex items-center justify-between px-5 pt-1.5 pb-2">
			<span class="font-mono text-[10px] text-text-tertiary tabular-nums">9:41</span>
			<div class="flex items-center gap-1">
				<span class="w-3 h-1.5 rounded-sm border border-text-tertiary"></span>
				<span class="w-3 h-3 rounded-full border border-text-tertiary"></span>
			</div>
		</div>

		<!-- Chat surface -->
		<div class="rounded-[24px] bg-bg-primary p-4 min-h-[420px] flex flex-col">
			<!-- Bot header -->
			<div class="flex items-center gap-3 pb-3 mb-3 border-b border-surface-border">
				<div class="w-9 h-9 rounded-full bg-accent-primary/15 border border-accent-primary/40 flex items-center justify-center">
					<span class="text-accent-primary font-sans font-semibold text-sm">∞</span>
				</div>
				<div class="flex-1 min-w-0">
					<p class="font-sans text-sm font-semibold text-text-primary truncate">Your Spark bot</p>
					<p class="font-mono text-[10px] text-accent-primary tracking-widest">ONLINE</p>
				</div>
			</div>

			<!-- Messages -->
			<div class="flex-1 flex flex-col gap-3 justify-end overflow-hidden">
				<!-- User message -->
				{#if showSent}
					<div class="flex justify-end fade-in">
						<div class="max-w-[78%] px-3 py-2 rounded-2xl rounded-br-md bg-accent-primary text-accent-fg">
							<p class="text-sm leading-snug">build me a landing page for my saas</p>
						</div>
					</div>
				{/if}

				<!-- Typing indicator (between user-sent and bot-reply) -->
				{#if step === 'sent'}
					<div class="flex justify-start fade-in">
						<div class="px-3 py-2.5 rounded-2xl rounded-bl-md bg-bg-secondary border border-surface-border">
							<div class="flex gap-1.5">
								<span class="w-1.5 h-1.5 rounded-full bg-text-tertiary type-dot" style="animation-delay: 0ms"></span>
								<span class="w-1.5 h-1.5 rounded-full bg-text-tertiary type-dot" style="animation-delay: 200ms"></span>
								<span class="w-1.5 h-1.5 rounded-full bg-text-tertiary type-dot" style="animation-delay: 400ms"></span>
							</div>
						</div>
					</div>
				{/if}

				<!-- Bot reply -->
				{#if showReply}
					<div class="flex justify-start fade-in">
						<div class="max-w-[85%] px-3 py-2 rounded-2xl rounded-bl-md bg-bg-secondary border border-surface-border">
							<p class="text-sm text-text-primary leading-snug">on it. spinning up 5 tasks now.</p>
						</div>
					</div>
				{/if}

				<!-- Mini mission live (matches hero aesthetic) -->
				{#if showThumbs}
					<div class="flex justify-start fade-in" style="animation-delay: 200ms">
						<div class="max-w-[94%] w-full p-3 rounded-2xl rounded-bl-md bg-bg-secondary border border-surface-border">
							<!-- Top status -->
							<div class="flex items-center justify-between mb-2.5">
								<div class="flex items-center gap-1.5">
									<span class="relative flex h-1.5 w-1.5">
										<span class="absolute inline-flex h-full w-full rounded-full bg-accent-primary opacity-60 animate-ping-slow"></span>
										<span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent-primary"></span>
									</span>
									<span class="font-mono text-[10px] text-text-primary">running · 5 tasks</span>
								</div>
								<span class="font-mono text-[10px] text-text-tertiary tabular-nums">2/5</span>
							</div>

							<!-- Overall progress -->
							<div class="h-1 rounded-full bg-bg-primary overflow-hidden mb-3">
								<div class="h-full rounded-full bg-accent-primary" style="width: 45%"></div>
							</div>

							<!-- Mini task rows -->
							<ul class="space-y-1.5">
								{#each [
									{ title: 'sketch the layout', state: 'done' },
									{ title: 'build the page', state: 'running' },
									{ title: 'wire the signup form', state: 'queued' },
									{ title: 'add analytics + tracking', state: 'queued' },
									{ title: 'ship to preview URL', state: 'queued' }
								] as task, i}
									<li
										class="flex items-center gap-2 px-2 py-1.5 rounded-md border"
										class:border-accent-primary={task.state === 'running'}
										class:border-surface-border={task.state !== 'running'}
										class:bg-bg-primary={task.state !== 'running'}
										class:bg-accent-primary={false}
										style={task.state === 'running' ? 'background: rgb(var(--accent-rgb) / 0.06); box-shadow: 0 0 0 1px rgb(var(--accent-rgb) / 0.15);' : ''}
									>
										<span class="shrink-0 w-3.5 h-3.5 rounded-full border flex items-center justify-center"
											class:border-accent-primary={task.state !== 'queued'}
											class:bg-accent-primary={task.state === 'done'}
											class:border-surface-border={task.state === 'queued'}
										>
											{#if task.state === 'done'}
												<svg class="w-2 h-2 text-accent-fg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
											{:else if task.state === 'running'}
												<span class="w-1 h-1 rounded-full bg-accent-primary animate-pulse-slow"></span>
											{:else}
												<span class="font-mono text-[7px] text-text-tertiary leading-none">{i + 1}</span>
											{/if}
										</span>
										<span class="flex-1 text-[11px] font-sans text-text-primary leading-tight truncate">{task.title}</span>
										{#if task.state === 'done'}
											<span class="font-mono text-[8px] text-accent-primary tracking-widest shrink-0">DONE</span>
										{:else if task.state === 'running'}
											<span class="font-mono text-[8px] text-accent-primary tracking-widest tabular-nums shrink-0">45%</span>
										{/if}
									</li>
								{/each}
							</ul>
						</div>
					</div>
				{/if}

				<!-- Done -->
				{#if showDone}
					<div class="flex justify-start fade-in" style="animation-delay: 400ms">
						<div class="max-w-[78%] px-3 py-2 rounded-2xl rounded-bl-md bg-accent-primary/10 border border-accent-primary/40">
							<div class="flex items-center gap-2">
								<svg class="w-3.5 h-3.5 text-accent-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
								<p class="text-sm text-text-primary leading-snug">shipped — preview link sent</p>
							</div>
						</div>
					</div>
				{/if}
			</div>

			<!-- Input bar -->
			<div class="mt-3 pt-3 border-t border-surface-border">
				<div class="flex items-center gap-2 px-3 py-2 rounded-full border border-surface-border bg-bg-secondary">
					{#if step === 'typing'}
						<span class="text-sm text-text-primary type-cursor">build me a landing page for my saas</span>
					{:else}
						<span class="text-sm text-text-tertiary">message your bot</span>
					{/if}
				</div>
			</div>
		</div>
	</div>

	<!-- Soft halo behind phone -->
	<div class="absolute -z-10 -inset-10 bg-accent-primary/5 blur-3xl rounded-full pointer-events-none"></div>
</div>

<style>
	.fade-in {
		animation: fade 0.7s ease-out backwards;
	}
	@keyframes fade {
		from { opacity: 0; transform: translateY(6px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.type-dot {
		animation: bob 1.2s ease-in-out infinite;
	}
	@keyframes bob {
		0%, 100% { transform: translateY(0); opacity: 0.4; }
		50% { transform: translateY(-3px); opacity: 1; }
	}

	.type-cursor::after {
		content: '|';
		margin-left: 2px;
		color: var(--accent-primary);
		animation: blink 0.9s steps(2) infinite;
	}
	@keyframes blink {
		50% { opacity: 0; }
	}
</style>
