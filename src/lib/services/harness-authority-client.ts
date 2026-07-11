import type {
	GovernorDecisionV1,
	HarnessCoreActionMutationClass,
	TurnIntentEnvelopeVNext
} from '@spark/harness-core';

export type SparkClientMutationClass = HarnessCoreActionMutationClass;

export type SparkClientTurnIntentEnvelopeVNext = TurnIntentEnvelopeVNext;
export type SparkClientGovernorDecisionV1 = GovernorDecisionV1;

export function buildClientTurnIntentVNextAuthority(input: {
	source: string;
	reason: string;
	toolName: string;
	mutationClass: SparkClientMutationClass;
	requestId?: string | null;
	actorId?: string | null;
	target?: string | null;
	externalNetwork?: boolean;
	publishes?: boolean;
}): SparkClientTurnIntentEnvelopeVNext {
	void input;
	throw new Error('Browser clients cannot create Harness authority. Use an authorized server or Telegram action.');
}

export function buildClientGovernorDecisionAuthority(input: {
	source: string;
	reason: string;
	toolName: string;
	mutationClass: SparkClientMutationClass;
	requestId?: string | null;
	actorId?: string | null;
	target?: string | null;
	externalNetwork?: boolean;
	publishes?: boolean;
}): SparkClientGovernorDecisionV1 {
	void input;
	throw new Error('Browser clients must not mint GovernorDecisionV1 authority. Send the fresh UI action to a server Harness consumer.');
}
