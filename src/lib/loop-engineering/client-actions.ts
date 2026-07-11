import {
	buildClientGovernorDecisionAuthority,
	type SparkClientGovernorDecisionV1
} from '$lib/services/harness-authority-client';

export const LOOP_COMPUTED_EVIDENCE_WAIT_MS = 120_000;
export const LOOP_ENGINEERING_AUTO_REFRESH_MS = 8_000;

export function buildLoopComputedEvidenceFields(input: {
	action: string;
	requestId: string;
	target: string;
	generatorProviderId?: string | null;
	evaluatorProviderId?: string | null;
}): {
	evidenceMode: 'computed';
	providerBacked: true;
	generatorProviderId?: string;
	evaluatorProviderId?: string;
	waitForCompletionMs: number;
	dispatchExecutionAuthority: SparkClientGovernorDecisionV1;
} {
	const dispatchRequestId = `${input.requestId}-provider-proof`;
	return {
		evidenceMode: 'computed',
		providerBacked: true,
		...(input.generatorProviderId ? { generatorProviderId: input.generatorProviderId } : {}),
		...(input.evaluatorProviderId ? { evaluatorProviderId: input.evaluatorProviderId } : {}),
		waitForCompletionMs: LOOP_COMPUTED_EVIDENCE_WAIT_MS,
		dispatchExecutionAuthority: buildClientGovernorDecisionAuthority({
			source: `loop-engineering.${input.action}-provider-proof`,
			reason: 'User used the Spawner Loop Engineering control plane.',
			toolName: 'spawner.dispatch',
			mutationClass: 'launches_mission',
			requestId: dispatchRequestId,
			target: `${input.target}:provider-proof`
		})
	};
}

export function shouldAutoRefreshLoopEngineering(input: {
	documentVisible?: boolean;
	refreshing?: boolean;
	actionLoading?: string | null;
	autoRefresh?: boolean;
}): boolean {
	return input.autoRefresh !== false &&
		input.documentVisible !== false &&
		input.refreshing !== true &&
		!input.actionLoading;
}
