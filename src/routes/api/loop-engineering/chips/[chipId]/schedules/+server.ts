import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	listLoopSchedules,
	safeLoopEngineeringChipKey,
	stageLoopSchedule,
	type LoopScheduleMode
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

export const GET: RequestHandler = async ({ params }) => {
	const chipKey = safeLoopEngineeringChipKey(params.chipId);
	if (!chipKey) return json({ ok: false, error: 'valid domain-chip key required' }, { status: 400 });
	const schedules = await listLoopSchedules(chipKey);
	return json({ ok: true, schedules });
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
			toolName: 'spawner.loop_engineering.schedule.stage',
			ownerSystem: 'spawner-ui',
			mutationClass: 'creates_schedule',
			requestId: String(body.requestId || '').trim() || null
		});
		const result = await stageLoopSchedule({
			chipKey,
			name: typeof body.name === 'string' ? body.name : undefined,
			mode: String(body.mode || 'round_count') as LoopScheduleMode,
			benchmarkCaseIds: Array.isArray(body.benchmarkCaseIds) ? body.benchmarkCaseIds.filter((item): item is string => typeof item === 'string') : [],
			generatorProviderId: typeof body.generatorProviderId === 'string' ? body.generatorProviderId : typeof body.generator_provider_id === 'string' ? body.generator_provider_id : null,
			evaluatorProviderId: typeof body.evaluatorProviderId === 'string' ? body.evaluatorProviderId : typeof body.evaluator_provider_id === 'string' ? body.evaluator_provider_id : null,
			waitForCompletionMs: typeof body.waitForCompletionMs === 'number' ? body.waitForCompletionMs : null,
			intervalMinutes: typeof body.intervalMinutes === 'number' ? body.intervalMinutes : null,
			fixedLocalTime: typeof body.fixedLocalTime === 'string' ? body.fixedLocalTime : null,
			timezone: typeof body.timezone === 'string' ? body.timezone : null,
			roundLimit: typeof body.roundLimit === 'number' ? body.roundLimit : null,
			stopConditions: Array.isArray(body.stopConditions) ? body.stopConditions.filter((item): item is string => typeof item === 'string') : [],
			sourceSurface: body.sourceSurface === 'telegram' ? 'telegram' : 'spawner'
		});
		return json({
			ok: true,
			schedule: result.schedule,
			event: result.event,
			commandResult: result.commandResult
		});
	} catch (error: unknown) {
		if (error instanceof HarnessAuthorityError) {
			return json({ ok: false, error: error.message, code: error.code, authority: error.verdict }, { status: error.status });
		}
		return json({ ok: false, error: errorMessage(error, 'schedule staging failed') }, { status: 400 });
	}
};
