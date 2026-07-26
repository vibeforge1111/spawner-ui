import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	listBenchmarkCases,
	safeLoopEngineeringChipKey,
	stageBenchmarkCase,
	type BenchmarkCaseKind
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
	const cases = await listBenchmarkCases(chipKey, { includeArtifactCases: true });
	return json({ ok: true, cases });
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
			toolName: 'spawner.loop_engineering.benchmark_case.stage',
			ownerSystem: 'spawner-ui',
			mutationClass: 'writes_files',
			requestId: String(body.requestId || '').trim() || null
		});
		const result = await stageBenchmarkCase({
			chipKey,
			kind: String(body.kind || 'visible') as BenchmarkCaseKind,
			prompt: String(body.prompt || ''),
			expectedBehavior: String(body.expectedBehavior || body.expected_behavior || ''),
			scoringRubricRef: typeof body.scoringRubricRef === 'string' ? body.scoringRubricRef : null,
			createdBy: body.createdBy === 'reviewer' || body.createdBy === 'evaluator' || body.createdBy === 'import'
				? body.createdBy
				: 'user',
			evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs.filter((item): item is string => typeof item === 'string') : [],
			sourceSurface: body.sourceSurface === 'telegram' ? 'telegram' : 'spawner'
		});
		return json({
			ok: true,
			case: result.caseRecord,
			event: result.event,
			commandResult: result.commandResult
		});
	} catch (error: unknown) {
		if (error instanceof HarnessAuthorityError) {
			return json({ ok: false, error: error.message, code: error.code, authority: error.verdict }, { status: error.status });
		}
		return json({ ok: false, error: errorMessage(error, 'benchmark case staging failed') }, { status: 400 });
	}
};
