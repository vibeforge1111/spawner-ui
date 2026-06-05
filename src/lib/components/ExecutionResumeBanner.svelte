<script lang="ts">
	import type { ExecutionStatus } from '$lib/services/mission-executor';

	interface ResumableMission {
		id: string;
		name: string;
		progress: number;
		status: ExecutionStatus;
	}

	interface Props {
		mission: ResumableMission;
		onContinue: () => void;
		onDismiss: () => void;
	}

	let { mission, onContinue, onDismiss }: Props = $props();
</script>

<div class="p-3 bg-blue-500/10 border-b border-blue-500/30" role="status" aria-label="Resumable mission found">
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-3">
			<div class="w-8 h-8 bg-blue-500/20 border border-blue-500/30 flex items-center justify-center" aria-hidden="true">
				<svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="square" stroke-linejoin="miter" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
				</svg>
			</div>
			<div>
				<p class="text-sm font-medium text-text-primary">Previous Mission Found</p>
				<p class="text-xs text-text-secondary">
					<span class="font-mono text-blue-400">{mission.name}</span>
					 - {mission.progress}% complete
					{#if mission.status === 'paused'}
						<span class="ml-1 text-blue-400">(Paused)</span>
					{:else if mission.status === 'running'}
						<span class="ml-1 text-status-warning">(Interrupted)</span>
					{/if}
				</p>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<button
				onclick={onContinue}
				class="px-3 py-1.5 text-xs font-mono bg-blue-500 text-white hover:bg-blue-600 transition-all"
			>
				Continue
			</button>
			<button
				onclick={onDismiss}
				class="px-3 py-1.5 text-xs font-mono text-text-secondary border border-surface-border hover:border-text-tertiary rounded-md transition-all"
			>
				Dismiss
			</button>
		</div>
	</div>
</div>
