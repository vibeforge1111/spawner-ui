import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServerGovernorDecisionAuthority, buildServerTurnIntentVNextAuthority } from '$lib/server/harness-authority';
import { listLoopSchedules, stageBenchmarkCase } from '$lib/server/loop-engineering-control-plane';
import { POST } from './+server';

const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
let cleanupDir: string | null = null;

function event(body?: unknown) {
	return {
		params: { chipId: 'domain-chip-prd-writing-proof-loop' },
		request: new Request('http://127.0.0.1:3333/api/loop-engineering/chips/domain-chip-prd-writing-proof-loop/schedules', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		url: new URL('http://127.0.0.1:3333/api/loop-engineering/chips/domain-chip-prd-writing-proof-loop/schedules'),
		getClientAddress: () => '127.0.0.1'
	};
}

function governorAuthority() {
	return buildServerGovernorDecisionAuthority({
		source: 'loop-engineering-schedule-test',
		reason: 'Focused Loop Engineering schedule staging regression.',
		toolName: 'spawner.loop_engineering.schedule.stage',
		mutationClass: 'creates_schedule',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

function bareVNextAuthority() {
	return buildServerTurnIntentVNextAuthority({
		source: 'loop-engineering-schedule-test',
		reason: 'Focused Loop Engineering schedule staging regression.',
		toolName: 'spawner.loop_engineering.schedule.stage',
		mutationClass: 'creates_schedule',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

describe('/api/loop-engineering/chips/[chipId]/schedules', () => {
	beforeEach(async () => {
		cleanupDir = await mkdtemp(path.join(os.tmpdir(), 'spawner-loop-schedule-route-'));
		process.env.SPAWNER_STATE_DIR = cleanupDir;
	});

	afterEach(async () => {
		if (originalSpawnerStateDir) process.env.SPAWNER_STATE_DIR = originalSpawnerStateDir;
		else delete process.env.SPAWNER_STATE_DIR;
		if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
		cleanupDir = null;
	});

	it('blocks schedule staging without native Governor authority', async () => {
		const response = await POST(event({ mode: 'round_count', roundLimit: 3 }) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
	});

	it('blocks bare VNext schedule authority', async () => {
		const response = await POST(event({ mode: 'round_count', roundLimit: 3, executionAuthority: bareVNextAuthority() }) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
	});

	it('stages capped private schedules without launching a loop', async () => {
		const stagedCase = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD for a scoped schedule.',
			expectedBehavior: 'Include owner, users, metrics, acceptance criteria, risks, rollback, and evidence refs.'
		});
		const response = await POST(event({
			name: 'PRD Writing Friday loop',
			mode: 'round_count',
			roundLimit: 3,
			benchmarkCaseIds: [stagedCase.caseRecord.id],
			stopConditions: ['token_budget_reached'],
			sourceSurface: 'telegram',
			executionAuthority: governorAuthority()
		}) as never);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.commandResult).toMatchObject({
			action: 'schedule_created',
			changed: true,
			launchedMission: false,
			eventId: body.event.id,
			caseCount: 1
		});
		expect(body.event).toMatchObject({
			sourceSurface: 'telegram',
			evaluatorSeparated: false
		});
		expect(body.schedule).toMatchObject({ active: false, roundLimit: 3, status: 'staged', benchmarkCaseIds: [stagedCase.caseRecord.id] });
		const schedules = await listLoopSchedules('domain-chip-prd-writing-proof-loop');
		expect(schedules).toHaveLength(1);
		expect(schedules[0].stopConditions).toContain('round_cap_reached');
	});
});
