import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	appendLoopEngineeringEvent,
	listPersistedLoopEngineeringEvents,
	safeLoopEngineeringChipKey
} from '$lib/server/loop-engineering-control-plane';
import {
	HarnessAuthorityError,
	assertNativeGovernorHarnessAuthority,
	resolveExecutionAuthority
} from '$lib/server/harness-authority';
import type { LoopEngineeringEventStatus, LoopEngineeringEventType } from '$lib/server/loop-engineering-registry';

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export const GET: RequestHandler = async ({ url }) => {
	const chipKey = url.searchParams.get('chipKey') || undefined;
	const events = await listPersistedLoopEngineeringEvents(chipKey);
	return json({ ok: true, events });
};

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = asRecord(await request.json());
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}

	const chipKey = safeLoopEngineeringChipKey(String(body.chipKey || ''));
	if (!chipKey) return json({ ok: false, error: 'valid domain-chip key required' }, { status: 400 });

	try {
		assertNativeGovernorHarnessAuthority({
			authority: resolveExecutionAuthority(body.executionAuthority),
			toolName: 'spawner.loop_engineering.event.append',
			ownerSystem: 'spawner-ui',
			mutationClass: 'writes_files',
			requestId: String(body.requestId || '').trim() || null
		});
		const event = await appendLoopEngineeringEvent({
			chipKey,
			chipName: typeof body.chipName === 'string' ? body.chipName : undefined,
			domain: typeof body.domain === 'string' ? body.domain : undefined,
			eventType: String(body.eventType || '') as LoopEngineeringEventType,
			label: String(body.label || ''),
			status: String(body.status || 'missing') as LoopEngineeringEventStatus,
			sourceSurface: 'spawner',
			previousScore: typeof body.previousScore === 'number' ? body.previousScore : null,
			candidateScore: typeof body.candidateScore === 'number' ? body.candidateScore : null,
			utilityDelta: typeof body.utilityDelta === 'number' ? body.utilityDelta : null,
			roundsObserved: typeof body.roundsObserved === 'number' ? body.roundsObserved : null,
			evaluatorSeparated: body.evaluatorSeparated === true,
			evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs.filter((item): item is string => typeof item === 'string') : [],
			nextAction: String(body.nextAction || '')
		});
		return json({
			ok: true,
			event,
			commandResult: {
				action: event.eventType,
				chipKey,
				changed: true,
				launchedMission: false,
				eventId: event.id,
				inspectUrl: `/loop-engineering/${encodeURIComponent(chipKey)}`,
				userMessage: `Recorded ${event.label} for ${chipKey}. No mission, schedule, or activation started.`
			}
		});
	} catch (error: unknown) {
		if (error instanceof HarnessAuthorityError) {
			return json({ ok: false, error: error.message, code: error.code, authority: error.verdict }, { status: error.status });
		}
		return json({ ok: false, error: errorMessage(error, 'event append failed') }, { status: 400 });
	}
};
