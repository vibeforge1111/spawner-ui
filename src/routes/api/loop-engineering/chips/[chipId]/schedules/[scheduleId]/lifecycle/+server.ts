import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	safeLoopEngineeringChipKey,
	updateLoopScheduleLifecycle,
	type LoopScheduleLifecycleAction
} from '$lib/server/loop-engineering-control-plane';
import {
	HarnessAuthorityError,
	assertNativeGovernorHarnessAuthority,
	resolveExecutionAuthority,
	type SparkMutationClass
} from '$lib/server/harness-authority';

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

function lifecycleAction(value: unknown): LoopScheduleLifecycleAction | null {
	if (value === 'pause' || value === 'resume' || value === 'cancel' || value === 'deactivate') return value;
	return null;
}

const MUTATION_CLASS_BY_ACTION: Record<LoopScheduleLifecycleAction, SparkMutationClass> = {
	pause: 'writes_files',
	resume: 'writes_files',
	cancel: 'deletes_schedule',
	deactivate: 'writes_files'
};

export const POST: RequestHandler = async ({ params, request }) => {
	const chipKey = safeLoopEngineeringChipKey(params.chipId);
	if (!chipKey) return json({ ok: false, error: 'valid domain-chip key required' }, { status: 400 });
	const scheduleId = typeof params.scheduleId === 'string' ? params.scheduleId.trim() : '';
	if (!scheduleId) return json({ ok: false, error: 'scheduleId required' }, { status: 400 });

	let body: Record<string, unknown>;
	try {
		body = asRecord(await request.json());
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}
	const action = lifecycleAction(body.action);
	if (!action) return json({ ok: false, error: 'schedule lifecycle action must be pause, resume, cancel, or deactivate' }, { status: 400 });

	try {
		assertNativeGovernorHarnessAuthority({
			authority: resolveExecutionAuthority(body.executionAuthority),
			toolName: `spawner.loop_engineering.schedule.${action}`,
			ownerSystem: 'spawner-ui',
			mutationClass: MUTATION_CLASS_BY_ACTION[action],
			requestId: String(body.requestId || '').trim() || null
		});
		const result = await updateLoopScheduleLifecycle({
			chipKey,
			scheduleId,
			action,
			sourceSurface: body.sourceSurface === 'telegram' ? 'telegram' : body.sourceSurface === 'scheduler' ? 'scheduler' : 'spawner'
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
		return json({ ok: false, error: errorMessage(error, 'schedule lifecycle update failed') }, { status: 400 });
	}
};
