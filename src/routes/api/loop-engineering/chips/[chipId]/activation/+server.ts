import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	listActivationRules,
	safeLoopEngineeringChipKey,
	stageActivationRule,
	type ActivationMode,
	type LoopEngineeringActivationRule
} from '$lib/server/loop-engineering-control-plane';
import {
	HarnessAuthorityError,
	assertNativeGovernorHarnessAuthority,
	resolveExecutionAuthority
} from '$lib/server/harness-authority';

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

export const GET: RequestHandler = async ({ params }) => {
	const chipKey = safeLoopEngineeringChipKey(params.chipId);
	if (!chipKey) return json({ ok: false, error: 'valid domain-chip key required' }, { status: 400 });
	const activationRules = await listActivationRules(chipKey);
	return json({ ok: true, activationRules });
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
			toolName: 'spawner.loop_engineering.activation.stage',
			ownerSystem: 'spawner-ui',
			mutationClass: 'writes_files',
			requestId: String(body.requestId || '').trim() || null
		});
		const result = await stageActivationRule({
			chipKey,
			useCase: String(body.useCase || body.use_case || ''),
			surfaces: stringArray(body.surfaces),
			mode: String(body.mode || 'manual') as ActivationMode,
			triggerPatterns: stringArray(body.triggerPatterns || body.trigger_patterns),
			nonTriggerPatterns: stringArray(body.nonTriggerPatterns || body.non_trigger_patterns),
			riskPolicy: String(body.riskPolicy || body.risk_policy || 'review_packet') as LoopEngineeringActivationRule['riskPolicy'],
			approvalRequired: body.approvalRequired !== false && body.approval_required !== false,
			rollbackRef: typeof body.rollbackRef === 'string' ? body.rollbackRef : typeof body.rollback_ref === 'string' ? body.rollback_ref : null,
			sourceSurface: body.sourceSurface === 'telegram' ? 'telegram' : 'spawner'
		});
		return json({
			ok: true,
			activationRule: result.activationRule,
			event: result.event,
			commandResult: result.commandResult
		});
	} catch (error: unknown) {
		if (error instanceof HarnessAuthorityError) {
			return json({ ok: false, error: error.message, code: error.code, authority: error.verdict }, { status: error.status });
		}
		return json({ ok: false, error: errorMessage(error, 'activation staging failed') }, { status: 400 });
	}
};
