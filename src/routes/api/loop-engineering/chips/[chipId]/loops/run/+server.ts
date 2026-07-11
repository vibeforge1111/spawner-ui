import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	executePrivateLoopEngineeringRun,
	launchPrivateLoopEngineeringRun,
	publicLoopEngineeringErrorMessage,
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

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
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
		const executeNow = body.executeNow === true || body.mode === 'execute';
		assertNativeGovernorHarnessAuthority({
			authority: resolveExecutionAuthority(body.executionAuthority),
			toolName: 'spawner.loop_engineering.loop.run',
			ownerSystem: 'spawner-ui',
			mutationClass: executeNow ? 'writes_files' : 'launches_mission',
			requestId: String(body.requestId || '').trim() || null
		});
		const result = executeNow
			? await executePrivateLoopEngineeringRun({
				chipKey,
				objective: typeof body.objective === 'string' ? body.objective : undefined,
				roundLimit: typeof body.roundLimit === 'number' ? body.roundLimit : null,
				benchmarkCaseIds: stringArray(body.benchmarkCaseIds || body.benchmark_case_ids),
				sourceSurface: body.sourceSurface === 'telegram' ? 'telegram' : 'spawner',
				requestId: typeof body.requestId === 'string' ? body.requestId : null,
				providerProof: body.evidenceMode === 'computed' || body.evidence_mode === 'computed' || body.providerBacked === true
					? {
						mode: 'computed',
						generatorProviderId: typeof body.generatorProviderId === 'string' ? body.generatorProviderId : typeof body.generator_provider_id === 'string' ? body.generator_provider_id : null,
						evaluatorProviderId: typeof body.evaluatorProviderId === 'string' ? body.evaluatorProviderId : typeof body.evaluator_provider_id === 'string' ? body.evaluator_provider_id : null,
						dispatchExecutionAuthority: body.dispatchExecutionAuthority,
						waitForCompletionMs: typeof body.waitForCompletionMs === 'number' ? body.waitForCompletionMs : null
					}
					: { mode: 'synthetic' }
			})
			: await launchPrivateLoopEngineeringRun({
				chipKey,
				runKind: 'loop',
				objective: typeof body.objective === 'string' ? body.objective : undefined,
				roundLimit: typeof body.roundLimit === 'number' ? body.roundLimit : null,
				benchmarkCaseIds: stringArray(body.benchmarkCaseIds || body.benchmark_case_ids),
				sourceSurface: body.sourceSurface === 'telegram' ? 'telegram' : 'spawner',
				requestId: typeof body.requestId === 'string' ? body.requestId : null
			});
		return json({
			ok: true,
			event: result.event,
			mission: result.mission,
			...('loopRun' in result ? { loopRun: result.loopRun } : {}),
			commandResult: result.commandResult
		});
	} catch (error: unknown) {
		if (error instanceof HarnessAuthorityError) {
			return json({ ok: false, error: error.message, code: error.code, authority: error.verdict }, { status: error.status });
		}
		return json({ ok: false, error: publicLoopEngineeringErrorMessage(error, errorMessage(error, 'loop run launch failed')) }, { status: 400 });
	}
};
