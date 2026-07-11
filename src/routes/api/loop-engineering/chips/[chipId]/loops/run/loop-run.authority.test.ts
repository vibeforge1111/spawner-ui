import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServerGovernorDecisionAuthority, buildServerTurnIntentVNextAuthority } from '$lib/server/harness-authority';
import { listPersistedLoopEngineeringEvents, stageBenchmarkCase } from '$lib/server/loop-engineering-control-plane';
import { getMissionControlRelaySnapshot } from '$lib/server/mission-control-relay';
import { providerRuntime } from '$lib/server/provider-runtime';
import { POST } from './+server';

const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
let cleanupDir: string | null = null;

function event(body?: unknown) {
	return {
		params: { chipId: 'domain-chip-prd-writing-proof-loop' },
		request: new Request('http://127.0.0.1:3333/api/loop-engineering/chips/domain-chip-prd-writing-proof-loop/loops/run', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		url: new URL('http://127.0.0.1:3333/api/loop-engineering/chips/domain-chip-prd-writing-proof-loop/loops/run'),
		getClientAddress: () => '127.0.0.1'
	};
}

function governorAuthority(mutationClass: 'launches_mission' | 'writes_files' = 'launches_mission') {
	return buildServerGovernorDecisionAuthority({
		source: 'loop-engineering-loop-run-test',
		reason: 'Focused Loop Engineering loop run regression.',
		toolName: 'spawner.loop_engineering.loop.run',
		mutationClass,
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

function dispatchAuthority() {
	return buildServerGovernorDecisionAuthority({
		source: 'loop-engineering-loop-run-test',
		reason: 'Provider-backed Loop Engineering route regression.',
		toolName: 'spawner.dispatch',
		mutationClass: 'launches_mission',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

function bareVNextAuthority() {
	return buildServerTurnIntentVNextAuthority({
		source: 'loop-engineering-loop-run-test',
		reason: 'Focused Loop Engineering loop run regression.',
		toolName: 'spawner.loop_engineering.loop.run',
		mutationClass: 'launches_mission',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

describe('/api/loop-engineering/chips/[chipId]/loops/run', () => {
	beforeEach(async () => {
		cleanupDir = await mkdtemp(path.join(os.tmpdir(), 'spawner-loop-run-route-'));
		process.env.SPAWNER_STATE_DIR = cleanupDir;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalSpawnerStateDir) process.env.SPAWNER_STATE_DIR = originalSpawnerStateDir;
		else delete process.env.SPAWNER_STATE_DIR;
		if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
		cleanupDir = null;
	});

	it('blocks loop launches without native Governor authority', async () => {
		const response = await POST(event({ objective: 'Improve PRD writing.', roundLimit: 3 }) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
	});

	it('blocks bare VNext loop launch authority', async () => {
		const response = await POST(event({
			objective: 'Improve PRD writing.',
			roundLimit: 3,
			executionAuthority: bareVNextAuthority()
		}) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
	});

	it('queues a capped private loop mission and does not accept generator improvements', async () => {
		const response = await POST(event({
			objective: 'Improve PRD drafting speed and evidence quality.',
			roundLimit: 3,
			executionAuthority: governorAuthority()
		}) as never);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.commandResult).toMatchObject({
			action: 'loop_run_queued',
			changed: true,
			launchedMission: true,
			missionId: body.mission.id,
			eventId: body.event.id
		});
		expect(body.event).toMatchObject({
			eventType: 'loop_batch',
			status: 'queued',
			roundsObserved: 3,
			evaluatorSeparated: false
		});
		expect(body.mission.goal).toContain('Run up to 3 private improvement round(s)');
		expect(body.mission.goal).toContain('A separated evaluator must score the work');
		expect(body.commandResult.userMessage).not.toMatch(/approved|activated/i);

		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events.some((eventRecord) => eventRecord.missionId === body.mission.id)).toBe(true);
		expect(getMissionControlRelaySnapshot(body.mission.id).recent[0].eventType).toBe('mission_created');
	});

	it('executes selected benchmark cases into a private loop verdict when requested', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'held_out',
			prompt: 'Write a PRD for a billing reminder workflow.',
			expectedBehavior: 'Include owner, affected users, success metric, acceptance criteria, risks, rollback, and evidence refs.',
			evidenceRefs: ['reports/loop-route-case.md']
		});

		const response = await POST(event({
			objective: 'Execute a private loop improvement over the clean case.',
			roundLimit: 3,
			executeNow: true,
			benchmarkCaseIds: [staged.caseRecord.id],
			sourceSurface: 'telegram',
			executionAuthority: governorAuthority('writes_files')
		}) as never);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.commandResult).toMatchObject({
			action: 'loop_run_executed',
			changed: true,
			launchedMission: false,
			missionId: body.mission.id,
			eventId: body.event.id,
			loopRunId: body.loopRun.runId,
			caseCount: 1,
			roundsObserved: 3
		});
		expect(body.loopRun).toMatchObject({
			status: 'passed',
			blindComparison: true,
			evaluatorSeparated: false,
			roundsObserved: 3,
			evaluatorModel: 'spark.local.separated-evaluator.v1'
		});
		expect(body.loopRun.candidateScore).toBeGreaterThan(body.loopRun.previousScore);
		expect(body.event).toMatchObject({
			eventType: 'loop_batch',
			status: 'passed',
			sourceSurface: 'telegram',
			evaluatorSeparated: false,
			evaluatorVerdictRef: body.loopRun.evaluatorVerdictRef,
			commandResult: { action: 'loop_run_executed' }
		});
		expect(body.commandResult.userMessage).not.toMatch(/activated|published|approved/i);

		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events.find((eventRecord) => eventRecord.id === body.event.id)).toMatchObject({
			status: 'passed',
			previousScore: body.loopRun.previousScore,
			candidateScore: body.loopRun.candidateScore,
			utilityDelta: body.loopRun.utilityDelta,
			roundsObserved: 3,
			evaluatorSeparated: false
		});
		expect(getMissionControlRelaySnapshot(body.mission.id).recent[0].eventType).toBe('mission_completed');
	});

	it('executes computed provider-backed loop evidence with separate dispatch authority', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'held_out',
			prompt: 'Write a PRD for invoice export failures.',
			expectedBehavior: 'Include owner, affected users, success metric, acceptance criteria, rollout risk, rollback, and evidence refs.',
			evidenceRefs: ['reports/loop-route-computed-case.md']
		});
		const providerResults = new Map<string, any[]>();
		const dispatch = vi.spyOn(providerRuntime, 'dispatch').mockImplementation(async ({ executionPack, executionAuthority }) => {
			const providerId = executionPack.providers[0]?.id || 'unknown';
			const missionId = executionPack.missionId || `mission-${providerId}`;
			const now = new Date().toISOString();
			const response = providerId === 'codex'
				? JSON.stringify({
					cases: [
						{
							caseId: staged.caseRecord.id,
							candidateOutput: 'PRD with owner, affected finance admins, success metric, acceptance criteria, rollout risk, rollback, and evidence refs.'
						}
					],
					acceptedLessons: ['Start with owner, user, success metric, acceptance criteria, rollback, and evidence refs.']
				})
				: JSON.stringify({
					caseResults: [
						{
							caseId: staged.caseRecord.id,
							baselineScore: 4,
							candidateScore: 8.5,
							baselineMatchedSignals: ['owner'],
							candidateMatchedSignals: ['owner', 'affected users', 'success metric', 'acceptance criteria', 'rollback', 'evidence refs'],
							verdict: 'candidate_wins'
						}
					],
					acceptedLessons: ['Start with owner, user, success metric, acceptance criteria, rollback, and evidence refs.']
				});
			providerResults.set(missionId, [{
				providerId,
				status: 'completed',
				requestId: null,
				traceRef: null,
				response,
				error: null,
				durationMs: 42,
				tokenUsage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 },
				startedAt: now,
				completedAt: now
			}]);
			expect(executionAuthority).toBeTruthy();
			return {
				success: true,
				missionId,
				sessions: { [providerId]: { status: 'completed' } },
				startedAt: now,
				authority: dispatchAuthority()
			} as never;
		});
		vi.spyOn(providerRuntime, 'getMissionResults').mockImplementation((missionId) => providerResults.get(missionId) ?? []);

		const response = await POST(event({
			objective: 'Execute a real provider-backed loop over the clean case.',
			roundLimit: 2,
			executeNow: true,
			evidenceMode: 'computed',
			generatorProviderId: 'codex',
			evaluatorProviderId: 'zai',
			dispatchExecutionAuthority: dispatchAuthority(),
			waitForCompletionMs: 1_000,
			benchmarkCaseIds: [staged.caseRecord.id],
			sourceSurface: 'telegram',
			executionAuthority: governorAuthority('writes_files')
		}) as never);
		const body = await response.json();
		expect(response.status, JSON.stringify(body)).toBe(200);
		expect(dispatch).toHaveBeenCalledTimes(2);
		expect(body.loopRun).toMatchObject({
			status: 'passed',
			evaluatorSeparated: true,
			provenance: 'computed',
			generatorProvider: 'codex',
			evaluatorProvider: 'zai',
			previousScore: 4,
			candidateScore: 8.5,
			utilityDelta: 4.5
		});
		expect(body.event).toMatchObject({
			eventType: 'loop_batch',
			status: 'passed',
			sourceSurface: 'telegram',
			evaluatorSeparated: true,
			provenance: 'computed',
			commandResult: { action: 'loop_run_executed', provenance: 'computed' }
		});
		expect(body.commandResult.userMessage).toContain('Provider-backed evaluator evidence');
		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events.find((eventRecord) => eventRecord.id === body.event.id)).toMatchObject({
			status: 'passed',
			evaluatorSeparated: true,
			provenance: 'computed'
		});
	});

	it('blocks computed loop attempts cleanly when provider proof output is unusable', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'held_out',
			prompt: 'Write a PRD for invoice export failures.',
			expectedBehavior: 'Include owner, affected users, success metric, acceptance criteria, rollout risk, rollback, and evidence refs.',
			evidenceRefs: ['reports/loop-route-computed-case.md']
		});
		const providerResults = new Map<string, any[]>();
		vi.spyOn(providerRuntime, 'dispatch').mockImplementation(async ({ executionPack }) => {
			const providerId = executionPack.providers[0]?.id || 'codex';
			const missionId = executionPack.missionId || `mission-${providerId}`;
			const now = new Date().toISOString();
			providerResults.set(missionId, [{
				providerId,
				status: 'failed',
				requestId: null,
				traceRef: null,
				response: null,
				error: 'Reading prompt from stdin... OpenAI Codex v0.142.5 -------- workdir: /private/tmp/spark provider: openai session id: raw-session',
				durationMs: 42,
				tokenUsage: null,
				startedAt: now,
				completedAt: now
			}]);
			return {
				success: true,
				missionId,
				sessions: { [providerId]: { status: 'failed', error: 'raw provider failure' } },
				startedAt: now,
				authority: dispatchAuthority()
			} as never;
		});
		vi.spyOn(providerRuntime, 'getMissionResults').mockImplementation((missionId) => providerResults.get(missionId) ?? []);

		const response = await POST(event({
			objective: 'Execute a real provider-backed loop over the clean case.',
			roundLimit: 12,
			executeNow: true,
			evidenceMode: 'computed',
			generatorProviderId: 'codex',
			evaluatorProviderId: 'zai',
			dispatchExecutionAuthority: dispatchAuthority(),
			waitForCompletionMs: 1_000,
			benchmarkCaseIds: [staged.caseRecord.id],
			sourceSurface: 'telegram',
			executionAuthority: governorAuthority('writes_files')
		}) as never);
		const body = await response.json();
		expect(response.status).toBe(400);
		expect(body.error).toBe('Computed evidence failed because codex did not return a usable proof packet.');
		expect(body.error).not.toContain('OpenAI Codex');
		expect(body.error).not.toContain('workdir:');

		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		const blocked = events.find((eventRecord) => eventRecord.eventType === 'loop_batch' && eventRecord.status === 'blocked');
		expect(blocked).toMatchObject({
			status: 'blocked',
			sourceSurface: 'telegram',
			roundsObserved: 12
		});
		expect(blocked?.label).toBe('Computed evidence failed because codex did not return a usable proof packet.');
		expect(JSON.stringify(blocked)).not.toContain('OpenAI Codex');
	});
});
