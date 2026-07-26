import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServerGovernorDecisionAuthority, buildServerTurnIntentVNextAuthority } from '$lib/server/harness-authority';
import {
	listPersistedLoopEngineeringEvents,
	listLoopSchedules,
	stageBenchmarkCase,
	stageLoopSchedule,
	type LoopScheduleLifecycleAction
} from '$lib/server/loop-engineering-control-plane';
import { POST } from './+server';

const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
let cleanupDir: string | null = null;

function event(scheduleId: string, body?: unknown) {
	return {
		params: { chipId: 'domain-chip-prd-writing-proof-loop', scheduleId },
		request: new Request(`http://127.0.0.1:3333/api/loop-engineering/chips/domain-chip-prd-writing-proof-loop/schedules/${scheduleId}/lifecycle`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		url: new URL(`http://127.0.0.1:3333/api/loop-engineering/chips/domain-chip-prd-writing-proof-loop/schedules/${scheduleId}/lifecycle`),
		getClientAddress: () => '127.0.0.1'
	};
}

function rawEvent(input: {
	chipId?: string;
	scheduleId?: string;
	rawBody?: string;
}) {
	const chipId = input.chipId ?? 'domain-chip-prd-writing-proof-loop';
	const scheduleId = input.scheduleId ?? 'loopsched-test';
	return {
		params: { chipId, scheduleId },
		request: new Request(`http://127.0.0.1:3333/api/loop-engineering/chips/${chipId}/schedules/${scheduleId}/lifecycle`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: input.rawBody
		}),
		url: new URL(`http://127.0.0.1:3333/api/loop-engineering/chips/${chipId}/schedules/${scheduleId}/lifecycle`),
		getClientAddress: () => '127.0.0.1'
	};
}

function governorAuthority(action: LoopScheduleLifecycleAction, requestId?: string) {
	return buildServerGovernorDecisionAuthority({
		source: 'loop-engineering-schedule-lifecycle-test',
		reason: 'Focused Loop Engineering schedule lifecycle regression.',
		toolName: `spawner.loop_engineering.schedule.${action}`,
		mutationClass: action === 'cancel' ? 'deletes_schedule' : 'writes_files',
		requestId,
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

function bareVNextAuthority() {
	return buildServerTurnIntentVNextAuthority({
		source: 'loop-engineering-schedule-lifecycle-test',
		reason: 'Focused Loop Engineering schedule lifecycle regression.',
		toolName: 'spawner.loop_engineering.schedule.pause',
		mutationClass: 'writes_files',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

async function stagedSchedule(): Promise<{ scheduleId: string; caseId: string }> {
	const stagedCase = await stageBenchmarkCase({
		chipKey: 'domain-chip-prd-writing-proof-loop',
		kind: 'visible',
		prompt: 'Write a PRD for a lifecycle-managed schedule.',
		expectedBehavior: 'Include owner, users, metrics, acceptance criteria, risks, rollback, and evidence refs.'
	});
	const staged = await stageLoopSchedule({
		chipKey: 'domain-chip-prd-writing-proof-loop',
		name: 'PRD Writing lifecycle loop',
		mode: 'interval',
		intervalMinutes: 60,
		roundLimit: 3,
		benchmarkCaseIds: [stagedCase.caseRecord.id]
	});
	return { scheduleId: staged.schedule.id, caseId: stagedCase.caseRecord.id };
}

describe('/api/loop-engineering/chips/[chipId]/schedules/[scheduleId]/lifecycle', () => {
	beforeEach(async () => {
		cleanupDir = await mkdtemp(path.join(os.tmpdir(), 'spawner-loop-schedule-lifecycle-route-'));
		process.env.SPAWNER_STATE_DIR = cleanupDir;
	});

	afterEach(async () => {
		if (originalSpawnerStateDir) process.env.SPAWNER_STATE_DIR = originalSpawnerStateDir;
		else delete process.env.SPAWNER_STATE_DIR;
		if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
		cleanupDir = null;
	});

	it('blocks schedule lifecycle changes without native Governor authority', async () => {
		const { scheduleId } = await stagedSchedule();
		const response = await POST(event(scheduleId, { action: 'pause' }) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
	});

	it('blocks bare VNext schedule lifecycle authority', async () => {
		const { scheduleId } = await stagedSchedule();
		const response = await POST(event(scheduleId, { action: 'pause', executionAuthority: bareVNextAuthority() }) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
	});

	it('blocks request id drift between the request and Governor authority', async () => {
		const { scheduleId } = await stagedSchedule();
		const response = await POST(event(scheduleId, {
			action: 'pause',
			requestId: 'route-request-id',
			executionAuthority: governorAuthority('pause', 'authority-request-id')
		}) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.authority.source).toBe('governor_decision');
		expect(body.authority.reasonCodes).toContain('request_id_mismatch');
	});

	it('rejects malformed lifecycle payloads before authority or state mutation', async () => {
		const { scheduleId } = await stagedSchedule();
		const beforeEvents = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');

		const invalidJson = await POST(rawEvent({ scheduleId, rawBody: '{not-json' }) as never);
		expect(invalidJson.status).toBe(400);
		expect(await invalidJson.json()).toMatchObject({ ok: false, error: 'invalid json' });

		const unsupportedAction = await POST(event(scheduleId, {
			action: 'archive',
			executionAuthority: governorAuthority('pause')
		}) as never);
		expect(unsupportedAction.status).toBe(400);
		expect(await unsupportedAction.json()).toMatchObject({
			ok: false,
			error: 'schedule lifecycle action must be pause, resume, cancel, or deactivate'
		});

		const afterEvents = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(afterEvents).toHaveLength(beforeEvents.length);
	});

	it('rejects foreign schedule ids without mutating the requested chip', async () => {
		const { scheduleId } = await stagedSchedule();
		const foreignCase = await stageBenchmarkCase({
			chipKey: 'domain-chip-foreign-lifecycle-qa',
			kind: 'visible',
			prompt: 'Write a PRD for a foreign chip schedule.',
			expectedBehavior: 'This case belongs to the foreign chip only.'
		});
		const foreign = await stageLoopSchedule({
			chipKey: 'domain-chip-foreign-lifecycle-qa',
			name: 'Foreign chip lifecycle loop',
			mode: 'round_count',
			roundLimit: 1,
			benchmarkCaseIds: [foreignCase.caseRecord.id]
		});

		const beforePrdEvents = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		const response = await POST(event(foreign.schedule.id, {
			action: 'pause',
			executionAuthority: governorAuthority('pause')
		}) as never);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false, error: 'loop schedule not found' });
		const afterPrdEvents = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		const schedules = await listLoopSchedules('domain-chip-prd-writing-proof-loop');
		expect(afterPrdEvents).toHaveLength(beforePrdEvents.length);
		expect(schedules.find((schedule) => schedule.id === scheduleId)).toMatchObject({ status: 'staged', active: false });
	});

	it('activates staged schedules, pauses active schedules, and blocks deactivation bypasses', async () => {
		const { scheduleId } = await stagedSchedule();
		const eventsAfterStage = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		const inactivePause = await POST(event(scheduleId, { action: 'pause', executionAuthority: governorAuthority('pause') }) as never);
		expect(inactivePause.status).toBe(200);
		expect(await inactivePause.json()).toMatchObject({
			event: null,
			schedule: { id: scheduleId, status: 'staged', active: false },
			commandResult: { action: 'schedule_pause', changed: false, launchedMission: false }
		});
		const eventsAfterInactivePause = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(eventsAfterInactivePause).toHaveLength(eventsAfterStage.length);

		const activate = await POST(event(scheduleId, { action: 'resume', executionAuthority: governorAuthority('resume') }) as never);
		expect(activate.status).toBe(200);
		const activateBody = await activate.json();
		expect(activateBody.schedule).toMatchObject({ id: scheduleId, status: 'staged', active: true });
		expect(activateBody.schedule.nextRunAt).toEqual(expect.any(String));

		const eventsAfterActivate = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		const duplicateActivate = await POST(event(scheduleId, { action: 'resume', executionAuthority: governorAuthority('resume') }) as never);
		expect(duplicateActivate.status).toBe(200);
		expect(await duplicateActivate.json()).toMatchObject({
			event: null,
			schedule: { id: scheduleId, status: 'staged', active: true },
			commandResult: { action: 'schedule_resume', changed: false, launchedMission: false }
		});
		const eventsAfterDuplicateActivate = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(eventsAfterDuplicateActivate).toHaveLength(eventsAfterActivate.length);

		const pause = await POST(event(scheduleId, { action: 'pause', executionAuthority: governorAuthority('pause') }) as never);
		expect(pause.status).toBe(200);
		expect(await pause.json()).toMatchObject({
			schedule: { id: scheduleId, status: 'paused', active: false },
			commandResult: { action: 'schedule_pause', changed: true, launchedMission: false }
		});

		const eventsAfterPause = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		const duplicatePause = await POST(event(scheduleId, { action: 'pause', executionAuthority: governorAuthority('pause') }) as never);
		expect(duplicatePause.status).toBe(200);
		expect(await duplicatePause.json()).toMatchObject({
			event: null,
			schedule: { id: scheduleId, status: 'paused', active: false },
			commandResult: { action: 'schedule_pause', changed: false, launchedMission: false }
		});
		const eventsAfterDuplicatePause = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(eventsAfterDuplicatePause).toHaveLength(eventsAfterPause.length);

		const resume = await POST(event(scheduleId, { action: 'resume', executionAuthority: governorAuthority('resume') }) as never);
		expect(resume.status).toBe(200);
		const resumeBody = await resume.json();
		expect(resumeBody.schedule).toMatchObject({ id: scheduleId, status: 'staged', active: true });
		expect(resumeBody.schedule.nextRunAt).toEqual(expect.any(String));

		const deactivate = await POST(event(scheduleId, { action: 'deactivate', executionAuthority: governorAuthority('deactivate') }) as never);
		expect(deactivate.status).toBe(200);
		expect(await deactivate.json()).toMatchObject({
			schedule: { id: scheduleId, status: 'deactivated', active: false, nextRunAt: null },
			commandResult: { action: 'schedule_deactivate', changed: true, launchedMission: false }
		});

		const eventsAfterDeactivate = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		const duplicateDeactivate = await POST(event(scheduleId, { action: 'deactivate', executionAuthority: governorAuthority('deactivate') }) as never);
		expect(duplicateDeactivate.status).toBe(200);
		expect(await duplicateDeactivate.json()).toMatchObject({
			event: null,
			schedule: { id: scheduleId, status: 'deactivated', active: false, nextRunAt: null },
			commandResult: { action: 'schedule_deactivate', changed: false, launchedMission: false }
		});
		const eventsAfterDuplicateDeactivate = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(eventsAfterDuplicateDeactivate).toHaveLength(eventsAfterDeactivate.length);

		const blockedResume = await POST(event(scheduleId, { action: 'resume', executionAuthority: governorAuthority('resume') }) as never);
		expect(blockedResume.status).toBe(400);
		expect(await blockedResume.json()).toMatchObject({
			ok: false,
			error: 'deactivated schedules require a new activation review before any lifecycle change'
		});
		const eventsAfterBlockedResume = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(eventsAfterBlockedResume).toHaveLength(eventsAfterDeactivate.length);

		const blockedPause = await POST(event(scheduleId, { action: 'pause', executionAuthority: governorAuthority('pause') }) as never);
		expect(blockedPause.status).toBe(400);
		expect(await blockedPause.json()).toMatchObject({
			ok: false,
			error: 'deactivated schedules require a new activation review before any lifecycle change'
		});
		const eventsAfterBlockedPause = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(eventsAfterBlockedPause).toHaveLength(eventsAfterDeactivate.length);

		const cancelAfterDeactivate = await POST(event(scheduleId, { action: 'cancel', executionAuthority: governorAuthority('cancel') }) as never);
		expect(cancelAfterDeactivate.status).toBe(200);
		expect(await cancelAfterDeactivate.json()).toMatchObject({
			schedule: { id: scheduleId, status: 'cancelled', active: false },
			commandResult: { action: 'schedule_cancel', changed: true, launchedMission: false }
		});
	});

	it('cancels schedules as terminal and prevents later lifecycle mutation', async () => {
		const { scheduleId } = await stagedSchedule();
		const cancel = await POST(event(scheduleId, { action: 'cancel', executionAuthority: governorAuthority('cancel') }) as never);
		expect(cancel.status).toBe(200);
		const cancelBody = await cancel.json();
		expect(cancelBody).toMatchObject({
			schedule: { id: scheduleId, status: 'cancelled', active: false },
			commandResult: { action: 'schedule_cancel', changed: true, launchedMission: false }
		});
		const schedules = await listLoopSchedules('domain-chip-prd-writing-proof-loop');
		expect(schedules[0]).toMatchObject({ id: scheduleId, status: 'cancelled', lastEventId: cancelBody.event.id });

		const pauseAfterCancel = await POST(event(scheduleId, { action: 'pause', executionAuthority: governorAuthority('pause') }) as never);
		expect(pauseAfterCancel.status).toBe(400);
		expect(await pauseAfterCancel.json()).toMatchObject({ ok: false, error: 'cancelled schedules cannot be changed' });

		const eventsAfterCancel = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		const duplicateCancel = await POST(event(scheduleId, { action: 'cancel', executionAuthority: governorAuthority('cancel') }) as never);
		expect(duplicateCancel.status).toBe(200);
		expect(await duplicateCancel.json()).toMatchObject({
			event: null,
			schedule: { id: scheduleId, status: 'cancelled', active: false },
			commandResult: { action: 'schedule_cancel', changed: false, launchedMission: false }
		});
		const eventsAfterDuplicateCancel = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(eventsAfterDuplicateCancel).toHaveLength(eventsAfterCancel.length);
	});
});
