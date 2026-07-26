<script lang="ts">
	import { Badge } from '$lib/components/ui';
	import { formatLoopEngineeringToken } from '$lib/loop-engineering/display';

	type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

	interface Props {
		status: string | null | undefined;
		label?: string;
		size?: 'sm' | 'md';
		class?: string;
	}

	let { status, label, size = 'sm', class: className = '' }: Props = $props();

	function toneForStatus(value: string | null | undefined): Tone {
		const clean = String(value || '').toLowerCase();
		if (['passed', 'pass', 'active', 'local_fast_path', 'local_fast_path_supported'].includes(clean)) return 'success';
		if (['queued', 'running', 'staged', 'paused', 'private_candidate', 'private_candidate_supported', 'attention'].includes(clean)) return 'warning';
		if (['failed', 'blocked', 'missing', 'cancelled', 'telegram_activation_blocked'].includes(clean)) return 'error';
		if (['info', 'scaffolded', 'loop_proven_private', 'needs_loop_evidence'].includes(clean)) return 'info';
		if (['deactivated'].includes(clean)) return 'neutral';
		return 'neutral';
	}
</script>

<Badge variant={toneForStatus(status)} {size} class={className}>
	{label || formatLoopEngineeringToken(status)}
</Badge>
