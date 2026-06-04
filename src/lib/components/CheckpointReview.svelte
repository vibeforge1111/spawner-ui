<script lang="ts">
	import type { ProjectCheckpoint } from '$lib/services/checkpoint';

	interface Props {
		checkpoint: ProjectCheckpoint;
		onVerify?: () => void;
		onReject?: (reason: string) => void;
	}

	let { checkpoint, onVerify, onReject }: Props = $props();

	let rejectReason = $state('');
	let showRejectForm = $state(false);
	let rerunning = $state(false);
	let rerunResult = $state<{ build: boolean; typecheck: boolean; test: boolean; duration: number } | null>(null);
	let rerunError = $state<string | null>(null);

	async function handleRerunVerification() {
		if (!checkpoint.missionName) return;
		const projectPath = (checkpoint as { projectPath?: string }).projectPath
			|| (checkpoint as unknown as { missionId: string }).missionId;

		rerunning = true;
		rerunError = null;
		rerunResult = null;

		try {
			const resp = await fetch('/api/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'scan',
					projectPath: projectPath || '.'
				})
			});

			if (!resp.ok) {
				const err = await resp.json();
				rerunError = err.error || 'Verification failed';
				return;
			}

			const data = await resp.json();
			rerunResult = {
				build: data.build?.success ?? false,
				typecheck: data.typecheck?.success ?? false,
				test: data.test?.success ?? true,
				duration: data.duration || 0
			};

			if (checkpoint.serverVerification) {
				if (data.build) checkpoint.serverVerification.build = { success: data.build.success, output: data.build.stdout || '', duration: data.build.duration || 0 };
				if (data.typecheck) checkpoint.serverVerification.typecheck = { success: data.typecheck.success, errorCount: data.typecheck.errorCount || 0, output: data.typecheck.stdout || '', duration: data.typecheck.duration || 0 };
				if (data.test) checkpoint.serverVerification.test = { success: data.test.success, passed: data.test.passed || 0, failed: data.test.failed || 0, hasTestScript: data.test.hasTestScript ?? false, duration: data.test.duration || 0 };
			}
		} catch (err) {
			rerunError = err instanceof Error ? err.message : String(err);
		} finally {
			rerunning = false;
		}
	}

	function formatDuration(seconds: number): string {
		if (seconds < 60) return `${seconds}s`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
		const hours = Math.floor(seconds / 3600);
		const mins = Math.floor((seconds % 3600) / 60);
		return `${hours}h ${mins}m`;
	}

	function formatBoolResult(value: boolean | null): string {
		if (value === null) return '-';
		return value ? 'Passed' : 'Failed';
	}

	function boolClass(value: boolean | null): string {
		if (value === null) return 'text-text-tertiary';
		return value ? 'text-accent-primary' : 'text-status-error';
	}

	function statusClass(status: string): string {
		if (status === 'success') return 'text-accent-primary border-accent-primary/40 bg-accent-primary/10';
		if (status === 'partial') return 'text-status-warning border-status-warning/40 bg-status-warning/10';
		return 'text-status-error border-status-error/40 bg-status-error/10';
	}

	function statusAccent(status: string): string {
		if (status === 'success') return 'bg-accent-primary shadow-[0_0_24px_rgb(var(--accent-rgb)/0.35)]';
		if (status === 'partial') return 'bg-status-warning shadow-[0_0_24px_rgb(var(--status-amber-rgb)/0.25)]';
		return 'bg-status-error shadow-[0_0_24px_rgb(var(--status-red-rgb)/0.25)]';
	}

	function metricCard(label: string, value: string, tone: string = 'text-text-primary') {
		return { label, value, tone };
	}

	function handleReject() {
		if (rejectReason.trim()) {
			onReject?.(rejectReason);
		}
	}
</script>

<section class="bg-bg-secondary border border-surface-border text-text-primary shadow-2xl shadow-black/40">
	<header class="border-b border-surface-border bg-bg-tertiary/70 px-5 py-4">
		<div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
			<div class="flex items-start gap-3 min-w-0">
				<div class="mt-1 flex h-10 w-10 shrink-0 items-center justify-center border border-surface-border bg-bg-primary">
					<div class="h-3 w-3 {statusAccent(checkpoint.status)}"></div>
				</div>
				<div class="min-w-0">
					<p class="text-[10px] font-mono uppercase tracking-[0.2em] text-text-tertiary">Mission Checkpoint</p>
					<h2 class="mt-1 truncate font-mono text-xl text-text-primary">{checkpoint.missionName}</h2>
					<p class="mt-1 text-sm text-text-secondary">
						Completed {checkpoint.completedAt.toLocaleString()} | {formatDuration(checkpoint.duration)}
					</p>
				</div>
			</div>
			<div class="flex shrink-0 items-center gap-2 md:flex-col md:items-end">
				<span class="border px-3 py-1 text-xs font-mono uppercase tracking-wider {statusClass(checkpoint.status)}">
					{checkpoint.status}
				</span>
				<span class="text-xs font-mono uppercase tracking-wider {checkpoint.canShip ? 'text-accent-primary' : 'text-status-error'}">
					Ship ready: {checkpoint.canShip ? 'yes' : 'no'}
				</span>
			</div>
		</div>
	</header>

	<div class="space-y-6 p-5">
		<section>
			<h3 class="mb-3 font-mono text-sm uppercase tracking-[0.18em] text-text-tertiary">Automated Results</h3>
			<div class="grid grid-cols-2 gap-2 lg:grid-cols-4">
				{#each [
					metricCard('Tasks Completed', String(checkpoint.automated.tasksCompleted), 'text-accent-primary'),
					metricCard('Tasks Failed', String(checkpoint.automated.tasksFailed), checkpoint.automated.tasksFailed > 0 ? 'text-status-error' : 'text-text-primary'),
					metricCard('Tests Passed', `${checkpoint.automated.testsPassed}/${checkpoint.automated.testsRun}`),
					metricCard('Build', formatBoolResult(checkpoint.automated.buildSucceeded), boolClass(checkpoint.automated.buildSucceeded))
				] as metric}
					<div class="border border-surface-border bg-bg-primary p-3">
						<p class="text-xs text-text-secondary">{metric.label}</p>
						<p class="mt-2 break-words font-mono text-lg {metric.tone}">{metric.value}</p>
					</div>
				{/each}
			</div>
			<div class="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
				<div class="border border-surface-border bg-bg-primary p-3">
					<p class="text-xs text-text-secondary">Type Check</p>
					<p class="mt-2 font-mono {boolClass(checkpoint.automated.typeCheckPassed)}">{formatBoolResult(checkpoint.automated.typeCheckPassed)}</p>
				</div>
				<div class="border border-surface-border bg-bg-primary p-3">
					<p class="text-xs text-text-secondary">Lint</p>
					<p class="mt-2 font-mono {boolClass(checkpoint.automated.lintPassed)}">{formatBoolResult(checkpoint.automated.lintPassed)}</p>
				</div>
			</div>
		</section>

		{#if checkpoint.serverVerification}
			<section>
				<div class="mb-3 flex items-center justify-between gap-3">
					<h3 class="font-mono text-sm uppercase tracking-[0.18em] text-text-tertiary">Independent Verification</h3>
					<button
						class="border px-3 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors {rerunning ? 'bg-surface-primary border-surface-border text-text-tertiary cursor-wait' : 'bg-accent-primary/10 border-accent-primary/30 text-accent-primary hover:bg-accent-primary/20'}"
						onclick={handleRerunVerification}
						disabled={rerunning}
					>
						{rerunning ? 'Running' : 'Re-run'}
					</button>
				</div>
				<div class="grid grid-cols-1 gap-2 md:grid-cols-3">
					<div class="border border-surface-border bg-bg-primary p-3">
						<p class="text-xs text-text-secondary">Build</p>
						{#if checkpoint.serverVerification.build}
							<p class="mt-2 font-mono {checkpoint.serverVerification.build.success ? 'text-accent-primary' : 'text-status-error'}">
								{checkpoint.serverVerification.build.success ? 'Passed' : 'Failed'}
							</p>
							<p class="text-[10px] text-text-tertiary font-mono">{(checkpoint.serverVerification.build.duration / 1000).toFixed(1)}s</p>
						{:else}
							<p class="mt-2 font-mono text-text-tertiary">Not run</p>
						{/if}
					</div>
					<div class="border border-surface-border bg-bg-primary p-3">
						<p class="text-xs text-text-secondary">Typecheck</p>
						{#if checkpoint.serverVerification.typecheck}
							<p class="mt-2 font-mono {checkpoint.serverVerification.typecheck.success ? 'text-accent-primary' : 'text-status-error'}">
								{checkpoint.serverVerification.typecheck.success ? 'Passed' : `${checkpoint.serverVerification.typecheck.errorCount} errors`}
							</p>
							<p class="text-[10px] text-text-tertiary font-mono">{(checkpoint.serverVerification.typecheck.duration / 1000).toFixed(1)}s</p>
						{:else}
							<p class="mt-2 font-mono text-text-tertiary">Not run</p>
						{/if}
					</div>
					<div class="border border-surface-border bg-bg-primary p-3">
						<p class="text-xs text-text-secondary">Tests</p>
						{#if checkpoint.serverVerification.test}
							{#if checkpoint.serverVerification.test.hasTestScript}
								<p class="mt-2 font-mono {checkpoint.serverVerification.test.success ? 'text-accent-primary' : 'text-status-error'}">
									{checkpoint.serverVerification.test.passed} passed, {checkpoint.serverVerification.test.failed} failed
								</p>
								<p class="text-[10px] text-text-tertiary font-mono">{(checkpoint.serverVerification.test.duration / 1000).toFixed(1)}s</p>
							{:else}
								<p class="mt-2 font-mono text-text-tertiary">No test script</p>
							{/if}
						{:else}
							<p class="mt-2 font-mono text-text-tertiary">Not run</p>
						{/if}
					</div>
				</div>
				{#if rerunResult}
					<div class="mt-2 border border-accent-primary/20 bg-accent-primary/5 px-3 py-2 text-xs text-accent-primary font-mono">
						Re-run complete ({(rerunResult.duration / 1000).toFixed(1)}s): Build {rerunResult.build ? 'OK' : 'FAIL'} | Typecheck {rerunResult.typecheck ? 'OK' : 'FAIL'} | Tests {rerunResult.test ? 'OK' : 'FAIL'}
					</div>
				{/if}
				{#if rerunError}
					<div class="mt-2 border border-status-error/30 bg-status-error/10 px-3 py-2 text-xs text-status-error font-mono">
						Re-run error: {rerunError}
					</div>
				{/if}
			</section>
		{/if}

		{#if checkpoint.securityScan}
			<section>
				<h3 class="mb-3 font-mono text-sm uppercase tracking-[0.18em] text-text-tertiary">Security Scan</h3>
				<div class="mb-2 grid grid-cols-2 gap-2 md:grid-cols-4">
					<div class="border border-surface-border bg-bg-primary p-3 text-center">
						<p class="text-2xl font-mono {checkpoint.securityScan.criticalCount > 0 ? 'text-status-error' : 'text-accent-primary'}">{checkpoint.securityScan.criticalCount}</p>
						<p class="text-[10px] text-text-tertiary font-mono uppercase">Critical</p>
					</div>
					<div class="border border-surface-border bg-bg-primary p-3 text-center">
						<p class="text-2xl font-mono {checkpoint.securityScan.highCount > 0 ? 'text-status-warning' : 'text-accent-primary'}">{checkpoint.securityScan.highCount}</p>
						<p class="text-[10px] text-text-tertiary font-mono uppercase">High</p>
					</div>
					<div class="border border-surface-border bg-bg-primary p-3 text-center">
						<p class="text-2xl font-mono text-text-primary">{checkpoint.securityScan.totalFindings}</p>
						<p class="text-[10px] text-text-tertiary font-mono uppercase">Total</p>
					</div>
					<div class="border border-surface-border bg-bg-primary p-3 text-center">
						<p class="text-2xl font-mono {checkpoint.securityScan.canShip ? 'text-accent-primary' : 'text-status-error'}">{checkpoint.securityScan.canShip ? 'OK' : 'Blocked'}</p>
						<p class="text-[10px] text-text-tertiary font-mono uppercase">Ship</p>
					</div>
				</div>
				{#each checkpoint.securityScan.results as result}
					<div class="mb-1 flex items-center gap-2 border border-surface-border bg-bg-primary px-3 py-2 text-xs font-mono">
						<span class="font-bold text-text-primary uppercase">{result.scanner}</span>
						{#if !result.available}
							<span class="text-text-tertiary">not installed</span>
						{:else if result.findings.length > 0}
							<span class="text-status-warning">{result.findings.length} finding{result.findings.length !== 1 ? 's' : ''}</span>
						{:else}
							<span class="text-accent-primary">clean</span>
						{/if}
						<span class="ml-auto text-text-tertiary">{(result.duration / 1000).toFixed(1)}s</span>
					</div>
				{/each}
			</section>
		{/if}

		<section>
			<h3 class="mb-3 font-mono text-sm uppercase tracking-[0.18em] text-text-tertiary">Quality Metrics</h3>
			<div class="grid grid-cols-1 gap-2 md:grid-cols-3">
				<div class="border border-surface-border bg-bg-primary p-3">
					<p class="text-xs text-text-secondary">Skill Usage</p>
					<p class="mt-2 font-mono text-lg">{Math.round(checkpoint.quality.skillUsageRatio * 100)}%</p>
				</div>
				<div class="border border-surface-border bg-bg-primary p-3">
					<p class="text-xs text-text-secondary">Avg Task Quality</p>
					<p class="mt-2 font-mono text-lg">
						{checkpoint.quality.taskQualityCount > 0 ? `${Math.round(checkpoint.quality.averageTaskQuality)}/100` : 'Not scored'}
					</p>
				</div>
				<div class="border border-surface-border bg-bg-primary p-3">
					<p class="text-xs text-text-secondary">Completion Rate</p>
					<p class="mt-2 font-mono text-lg">{Math.round(checkpoint.quality.completionRate * 100)}%</p>
				</div>
			</div>
		</section>

		{#if checkpoint.review.knownIssues.length > 0}
			<section>
				<h3 class="mb-3 font-mono text-sm uppercase tracking-[0.18em] text-text-tertiary">Known Issues</h3>
				<div class="space-y-2">
					{#each checkpoint.review.knownIssues as issue}
						<div class="border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-sm text-status-warning">
							{issue}
						</div>
					{/each}
				</div>
			</section>
		{/if}

		{#if checkpoint.review.manualTestSuggestions.length > 0}
			<section>
				<h3 class="mb-3 font-mono text-sm uppercase tracking-[0.18em] text-text-tertiary">Manual Testing Checklist</h3>
				<div class="grid gap-4 md:grid-cols-2">
					{#each checkpoint.review.manualTestSuggestions as suggestion}
						<div class="border border-surface-border bg-bg-primary p-3">
							<h4 class="mb-2 font-mono text-accent-primary">{suggestion.category}</h4>
							<div class="space-y-1">
								{#each suggestion.tests as test}
									<label class="flex items-start gap-2 px-1 py-1 text-sm text-text-primary hover:bg-surface-primary cursor-pointer">
										<input type="checkbox" class="mt-1 h-3.5 w-3.5 shrink-0 accent-[rgb(var(--accent-rgb))]" />
										<span class="leading-5">{test}</span>
									</label>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<section class="border border-surface-border bg-bg-primary p-3">
			<h3 class="mb-2 font-mono text-xs uppercase tracking-[0.18em] text-text-tertiary">Summary</h3>
			<p class="text-sm leading-6 text-text-secondary">{checkpoint.review.summary}</p>
		</section>

		<section class="border-t border-surface-border pt-4">
			{#if !checkpoint.canShip}
				<div class="mb-3 border border-status-error/30 bg-status-error/10 px-3 py-2 text-xs text-status-error font-mono">
					Ship blocked.
					{#if checkpoint.serverVerification?.build && !checkpoint.serverVerification.build.success}
						Build failed.
					{/if}
					{#if checkpoint.serverVerification?.typecheck && !checkpoint.serverVerification.typecheck.success}
						Typecheck failed.
					{/if}
					{#if checkpoint.specAlignment && checkpoint.specAlignment.coverageRate < 0.8}
						Spec coverage below 80%.
					{/if}
					{#if checkpoint.quality.completionRate < 0.9}
						Completion rate below 90%.
					{/if}
					{#if checkpoint.status !== 'success'}
						Status: {checkpoint.status}.
					{/if}
				</div>
			{/if}
			{#if !showRejectForm}
				<div class="flex flex-col gap-2 sm:flex-row">
					<button
						class="btn-primary px-6 py-2"
						onclick={onVerify}
						disabled={!checkpoint.canShip}
					>
						Verify & Ship
					</button>
					<button
						class="btn-secondary px-6 py-2"
						onclick={() => showRejectForm = true}
					>
						Needs Work
					</button>
				</div>
			{:else}
				<div class="flex flex-col gap-2 sm:flex-row">
					<input
						type="text"
						bind:value={rejectReason}
						placeholder="What needs to be fixed?"
						onkeydown={(e) => {
							if (e.key === 'Enter' && rejectReason.trim()) {
								handleReject();
							} else if (e.key === 'Escape') {
								showRejectForm = false;
							}
						}}
						class="min-w-0 flex-1 border border-surface-border bg-bg-primary px-3 py-2 font-mono"
					/>
					<button
						class="btn-secondary px-4 py-2"
						onclick={handleReject}
						disabled={!rejectReason.trim()}
					>
						Submit
					</button>
					<button
						class="btn-ghost px-4 py-2"
						onclick={() => showRejectForm = false}
					>
						Cancel
					</button>
				</div>
			{/if}
		</section>
	</div>
</section>
