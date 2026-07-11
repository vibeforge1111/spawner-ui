import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	completeLoopEngineeringRunEvent,
	safeLoopEngineeringChipKey,
	type LoopEngineeringCompletionStatus
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

function completionStatus(value: unknown): LoopEngineeringCompletionStatus | null {
	if (value === 'passed' || value === 'failed' || value === 'blocked') return value;
	return null;
}

export const POST: RequestHandler = async ({ params, request }) => {
	const eventId = typeof params.eventId === 'string' ? params.eventId.trim() : '';
	if (!eventId) return json({ ok: false, error: 'eventId required' }, { status: 400 });

	let body: Record<string, unknown>;
	try {
		body = asRecord(await request.json());
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}

	const status = completionStatus(body.status);
	if (!status) return json({ ok: false, error: 'status must be passed, failed, or blocked' }, { status: 400 });
	const chipKey = typeof body.chipKey === 'string' ? safeLoopEngineeringChipKey(body.chipKey) : null;
	if (typeof body.chipKey === 'string' && !chipKey) {
		return json({ ok: false, error: 'valid domain-chip key required' }, { status: 400 });
	}

	try {
		assertNativeGovernorHarnessAuthority({
			authority: resolveExecutionAuthority(body.executionAuthority),
			toolName: 'spawner.loop_engineering.event.complete',
			ownerSystem: 'spawner-ui',
			mutationClass: 'writes_files',
			requestId: String(body.requestId || '').trim() || null
		});
		const result = await completeLoopEngineeringRunEvent({
			eventId,
			missionId: typeof body.missionId === 'string' ? body.missionId : typeof body.mission_id === 'string' ? body.mission_id : null,
			chipKey,
			status,
			label: typeof body.label === 'string' ? body.label : undefined,
			previousScore: typeof body.previousScore === 'number' ? body.previousScore : typeof body.previous_score === 'number' ? body.previous_score : undefined,
			candidateScore: typeof body.candidateScore === 'number' ? body.candidateScore : typeof body.candidate_score === 'number' ? body.candidate_score : undefined,
			utilityDelta: typeof body.utilityDelta === 'number' ? body.utilityDelta : typeof body.utility_delta === 'number' ? body.utility_delta : undefined,
			roundsObserved: typeof body.roundsObserved === 'number' ? body.roundsObserved : typeof body.rounds_observed === 'number' ? body.rounds_observed : undefined,
			evaluatorSeparated: body.evaluatorSeparated === true || body.evaluator_separated === true,
			provenance: body.provenance === 'computed' || body.provenance === 'synthetic' || body.provenance === 'seeded' ? body.provenance : undefined,
			evidenceRefs: stringArray(body.evidenceRefs || body.evidence_refs),
			sourceRef: typeof body.sourceRef === 'string' ? body.sourceRef : typeof body.source_ref === 'string' ? body.source_ref : null,
			evaluatorVerdictRef: typeof body.evaluatorVerdictRef === 'string' ? body.evaluatorVerdictRef : typeof body.evaluator_verdict_ref === 'string' ? body.evaluator_verdict_ref : null,
			scheduleId: typeof body.scheduleId === 'string' ? body.scheduleId : typeof body.schedule_id === 'string' ? body.schedule_id : null,
			nextAction: typeof body.nextAction === 'string' ? body.nextAction : typeof body.next_action === 'string' ? body.next_action : undefined,
			completedAt: typeof body.completedAt === 'string' ? body.completedAt : typeof body.completed_at === 'string' ? body.completed_at : null
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
		return json({ ok: false, error: errorMessage(error, 'loop event completion failed') }, { status: 400 });
	}
};
