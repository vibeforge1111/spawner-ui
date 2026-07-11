import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	recordEvaluatorReview,
	safeLoopEngineeringChipKey
} from '$lib/server/loop-engineering-control-plane';
import {
	HarnessAuthorityError,
	assertNativeGovernorHarnessAuthority,
	resolveExecutionAuthority
} from '$lib/server/harness-authority';

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export const POST: RequestHandler = async ({ params, request }) => {
	const chipKey = safeLoopEngineeringChipKey(params.chipId);
	if (!chipKey) return json({ ok: false, error: 'valid domain-chip key required' }, { status: 400 });

	let body: Record<string, unknown>;
	try {
		body = asRecord(await request.json());
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}

	try {
		assertNativeGovernorHarnessAuthority({
			authority: resolveExecutionAuthority(body.executionAuthority),
			toolName: 'spawner.loop_engineering.evaluator_review.record',
			ownerSystem: 'spawner-ui',
			mutationClass: 'writes_files',
			requestId: String(body.requestId || '').trim() || null
		});
		const result = await recordEvaluatorReview({
			chipKey,
			sourceRunEventId: typeof body.sourceRunEventId === 'string'
				? body.sourceRunEventId
				: typeof body.source_run_event_id === 'string'
					? body.source_run_event_id
					: null,
			label: typeof body.label === 'string' ? body.label : undefined,
			previousScore: typeof body.previousScore === 'number' ? body.previousScore : typeof body.previous_score === 'number' ? body.previous_score : null,
			candidateScore: typeof body.candidateScore === 'number' ? body.candidateScore : typeof body.candidate_score === 'number' ? body.candidate_score : null,
			roundsObserved: typeof body.roundsObserved === 'number' ? body.roundsObserved : typeof body.rounds_observed === 'number' ? body.rounds_observed : null,
			evaluatorSeparated: body.evaluatorSeparated === true || body.evaluator_separated === true,
			evidenceRefs: stringArray(body.evidenceRefs || body.evidence_refs),
			sourceSurface: body.sourceSurface === 'telegram' ? 'telegram' : 'spawner',
			nextAction: typeof body.nextAction === 'string' ? body.nextAction : typeof body.next_action === 'string' ? body.next_action : undefined
		});
		return json({
			ok: true,
			event: result.event,
			commandResult: result.commandResult
		});
	} catch (error: unknown) {
		if (error instanceof HarnessAuthorityError) {
			return json({ ok: false, error: error.message, code: error.code, authority: error.verdict }, { status: error.status });
		}
		return json({ ok: false, error: errorMessage(error, 'evaluator review recording failed') }, { status: 400 });
	}
};
