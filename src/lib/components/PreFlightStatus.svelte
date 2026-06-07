<script lang="ts">
	import type { PreFlightResult, PreFlightCheck } from '$lib/services/preflight';

	interface Props {
		result: PreFlightResult | null;
		onProceed?: () => void;
		onCancel?: () => void;
	}

	let { result, onProceed, onCancel }: Props = $props();

	function getCheckIcon(check: PreFlightCheck): string {
		if (check.passed) return '✅';
		return check.severity === 'error' ? '❌' : '⚠️';
	}

	function getCheckClass(check: PreFlightCheck): string {
		if (check.passed) return 'text-green-400';
		return check.severity === 'error' ? 'text-red-400' : 'text-yellow-400';
	}
</script>

<div class="bg-surface-secondary border border-surface-border p-4" aria-label="Pre-flight checks">
	<h3 class="text-lg font-mono mb-4">Pre-Flight Checks</h3>

	{#if !result}
		<p class="text-text-secondary" role="status" aria-live="polite">Running checks...</p>
	{:else}
		<!-- Status Header -->
		<div class="flex items-center gap-2 mb-4" role="status" aria-live="polite">
			<span class="text-2xl">{result.passed ? '✅' : '❌'}</span>
			<span class="font-mono text-lg {result.passed ? 'text-green-400' : 'text-red-400'}" aria-label={result.passed ? 'Pre-flight checks passed' : 'Pre-flight checks failed'}>
				{result.passed ? 'PASSED' : 'FAILED'}
			</span>
		</div>

		<!-- Summary -->
		<p class="text-text-secondary mb-4">{result.summary}</p>

		<!-- Checks List -->
		<div class="space-y-2 mb-4">
			{#each result.checks as check}
				<div class="flex items-start gap-2 p-2 bg-surface-primary border border-surface-border">
					<span>{getCheckIcon(check)}</span>
					<div class="flex-1">
						<span class="font-mono {getCheckClass(check)}">{check.name}</span>
						{#if check.message}
							<p class="text-sm text-text-secondary">{check.message}</p>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		<!-- Actions -->
		<div class="flex gap-2">
			{#if result.canProceed}
				<button
					class="btn-primary px-4 py-2"
					onclick={onProceed}
				>
					Proceed
				</button>
			{/if}
			<button
				class="btn-secondary px-4 py-2"
				onclick={onCancel}
			>
				Cancel
			</button>
		</div>

		{#if !result.canProceed}
			<p class="mt-4 text-red-400 text-sm font-mono" role="alert">
				⛔ Cannot proceed - fix errors above before executing mission
			</p>
		{/if}
	{/if}
</div>
