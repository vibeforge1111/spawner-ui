import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	distillEvaluatorLessons,
	listDistillations,
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

export const GET: RequestHandler = async ({ params }) => {
	const chipKey = safeLoopEngineeringChipKey(params.chipId);
	if (!chipKey) return json({ ok: false, error: 'valid domain-chip key required' }, { status: 400 });
	return json({ ok: true, distillations: await listDistillations(chipKey) });
};

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
			toolName: 'spawner.loop_engineering.distill.stage',
			ownerSystem: 'spawner-ui',
			mutationClass: 'writes_files',
			requestId: String(body.requestId || '').trim() || null
		});
		const result = await distillEvaluatorLessons({
			chipKey,
			sourceEvaluatorEventId: String(body.sourceEvaluatorEventId || body.source_evaluator_event_id || ''),
			lessons: stringArray(body.lessons),
			runtimeNotes: typeof body.runtimeNotes === 'string' ? body.runtimeNotes : typeof body.runtime_notes === 'string' ? body.runtime_notes : undefined,
			tokenBudgetHint: typeof body.tokenBudgetHint === 'string' ? body.tokenBudgetHint : typeof body.token_budget_hint === 'string' ? body.token_budget_hint : null,
			evidenceRefs: stringArray(body.evidenceRefs || body.evidence_refs),
			sourceSurface: body.sourceSurface === 'telegram' ? 'telegram' : 'spawner'
		});
		return json({
			ok: true,
			distillation: result.distillation,
			event: result.event,
			commandResult: result.commandResult
		});
	} catch (error: unknown) {
		if (error instanceof HarnessAuthorityError) {
			return json({ ok: false, error: error.message, code: error.code, authority: error.verdict }, { status: error.status });
		}
		return json({ ok: false, error: errorMessage(error, 'distillation staging failed') }, { status: 400 });
	}
};
