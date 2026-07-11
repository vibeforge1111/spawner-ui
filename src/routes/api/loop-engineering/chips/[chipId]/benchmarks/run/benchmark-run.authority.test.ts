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
		request: new Request('http://127.0.0.1:3333/api/loop-engineering/chips/domain-chip-prd-writing-proof-loop/benchmarks/run', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		url: new URL('http://127.0.0.1:3333/api/loop-engineering/chips/domain-chip-prd-writing-proof-loop/benchmarks/run'),
		getClientAddress: () => '127.0.0.1'
	};
}

function governorAuthority(mutationClass: 'launches_mission' | 'writes_files' = 'launches_mission') {
	return buildServerGovernorDecisionAuthority({
		source: 'loop-engineering-benchmark-run-test',
		reason: 'Focused Loop Engineering benchmark run regression.',
		toolName: 'spawner.loop_engineering.benchmark.run',
		mutationClass,
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

function dispatchAuthority() {
	return buildServerGovernorDecisionAuthority({
		source: 'loop-engineering-benchmark-run-test',
		reason: 'Provider-backed Loop Engineering benchmark route regression.',
		toolName: 'spawner.dispatch',
		mutationClass: 'launches_mission',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

function bareVNextAuthority() {
	return buildServerTurnIntentVNextAuthority({
		source: 'loop-engineering-benchmark-run-test',
		reason: 'Focused Loop Engineering benchmark run regression.',
		toolName: 'spawner.loop_engineering.benchmark.run',
		mutationClass: 'launches_mission',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

describe('/api/loop-engineering/chips/[chipId]/benchmarks/run', () => {
	beforeEach(async () => {
		cleanupDir = await mkdtemp(path.join(os.tmpdir(), 'spawner-loop-benchmark-run-route-'));
		process.env.SPAWNER_STATE_DIR = cleanupDir;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalSpawnerStateDir) process.env.SPAWNER_STATE_DIR = originalSpawnerStateDir;
		else delete process.env.SPAWNER_STATE_DIR;
		if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
		cleanupDir = null;
	});

	it('blocks benchmark launches without native Governor authority', async () => {
		const response = await POST(event({ objective: 'Run a PRD benchmark.' }) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
	});

	it('blocks bare VNext benchmark launch authority', async () => {
		const response = await POST(event({
			objective: 'Run a PRD benchmark.',
			executionAuthority: bareVNextAuthority()
		}) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
	});

	it('queues a private benchmark mission and ledger event with Governor authority', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'held_out',
			prompt: 'Write a PRD for a billing reminder workflow.',
			expectedBehavior: 'Include decision owner, users, success metric, acceptance criteria, risks, and evidence refs.'
		});
		const response = await POST(event({
			objective: 'Score PRD quality against held-out cases.',
			benchmarkCaseIds: [staged.caseRecord.id],
			sourceSurface: 'telegram',
			executionAuthority: governorAuthority()
		}) as never);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.commandResult).toMatchObject({
			action: 'benchmark_run_queued',
			changed: true,
			launchedMission: true,
			missionId: body.mission.id,
			eventId: body.event.id
		});
		expect(body.event).toMatchObject({
			eventType: 'benchmark_run',
			status: 'queued',
			sourceSurface: 'telegram'
		});
		expect(body.mission.goal).toContain('Generator output must not grade itself');
		expect(body.commandResult.userMessage).not.toMatch(/approved|activated/i);

		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events.some((eventRecord) => eventRecord.missionId === body.mission.id)).toBe(true);
		expect(getMissionControlRelaySnapshot(body.mission.id).recent[0].eventType).toBe('mission_created');
	});

	it('executes staged benchmark cases when explicitly requested', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD for a billing reminder workflow.',
			expectedBehavior: 'Include decision owner, users, success metric, acceptance criteria, risks, and evidence refs.'
		});

		const response = await POST(event({
			objective: 'Run the staged PRD Writing benchmark now with separated evaluator scoring.',
			benchmarkCaseIds: [staged.caseRecord.id],
			executeNow: true,
			sourceSurface: 'telegram',
			executionAuthority: governorAuthority('writes_files')
		}) as never);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.commandResult).toMatchObject({
			action: 'benchmark_run_executed',
			changed: true,
			launchedMission: false,
			missionId: body.mission.id,
			eventId: body.event.id,
			benchmarkRunId: body.benchmarkRun.runId,
			caseCount: 1
		});
		expect(body.benchmarkRun).toMatchObject({
			status: 'passed',
			blindComparison: true,
			evaluatorSeparated: false,
			evaluatorModel: 'spark.local.separated-evaluator.v1'
		});
		expect(body.benchmarkRun.candidateScore).toBeGreaterThan(body.benchmarkRun.previousScore);
		expect(body.event).toMatchObject({
			eventType: 'benchmark_run',
			status: 'passed',
			sourceSurface: 'telegram',
			evaluatorSeparated: false,
			evaluatorVerdictRef: body.benchmarkRun.evaluatorVerdictRef,
			commandResult: { action: 'benchmark_run_executed' }
		});
		expect(body.commandResult.userMessage).not.toMatch(/activated|published|approved/i);

		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events.find((eventRecord) => eventRecord.id === body.event.id)).toMatchObject({
			status: 'passed',
			previousScore: body.benchmarkRun.previousScore,
			candidateScore: body.benchmarkRun.candidateScore,
			utilityDelta: body.benchmarkRun.utilityDelta,
			evaluatorSeparated: false
		});
		expect(getMissionControlRelaySnapshot(body.mission.id).recent[0].eventType).toBe('mission_completed');
	});

	it('executes computed provider-backed benchmark evidence with separate dispatch authority', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD for invoice export failures.',
			expectedBehavior: 'Include owner, affected users, success metric, acceptance criteria, rollout risk, rollback, and evidence refs.'
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
					]
				})
				: JSON.stringify({
					caseResults: [
						{
							caseId: staged.caseRecord.id,
							baselineScore: 4.1,
							candidateScore: 8.4,
							baselineMatchedSignals: ['owner'],
							candidateMatchedSignals: ['owner', 'affected users', 'success metric', 'acceptance criteria', 'rollback', 'evidence refs'],
							verdict: 'candidate_wins'
						}
					]
				});
			providerResults.set(missionId, [{
				providerId,
				status: 'completed',
				requestId: null,
				traceRef: null,
				response,
				error: null,
				durationMs: 31,
				tokenUsage: { promptTokens: 8, completionTokens: 11, totalTokens: 19 },
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
			objective: 'Run the staged benchmark with real provider-backed evidence.',
			benchmarkCaseIds: [staged.caseRecord.id],
			executeNow: true,
			evidenceMode: 'computed',
			generatorProviderId: 'codex',
			evaluatorProviderId: 'zai',
			dispatchExecutionAuthority: dispatchAuthority(),
			waitForCompletionMs: 1_000,
			sourceSurface: 'telegram',
			executionAuthority: governorAuthority('writes_files')
		}) as never);
		const body = await response.json();
		expect(response.status, JSON.stringify(body)).toBe(200);
		expect(dispatch).toHaveBeenCalledTimes(2);
		expect(body.benchmarkRun).toMatchObject({
			status: 'passed',
			evaluatorSeparated: true,
			provenance: 'computed',
			generatorProvider: 'codex',
			evaluatorProvider: 'zai',
			previousScore: 4.1,
			candidateScore: 8.4,
			utilityDelta: 4.3
		});
		expect(body.event).toMatchObject({
			eventType: 'benchmark_run',
			status: 'passed',
			sourceSurface: 'telegram',
			evaluatorSeparated: true,
			provenance: 'computed',
			commandResult: { action: 'benchmark_run_executed', provenance: 'computed' }
		});
		expect(body.commandResult.userMessage).toContain('Provider-backed evaluator evidence');
		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events.find((eventRecord) => eventRecord.id === body.event.id)).toMatchObject({
			status: 'passed',
			evaluatorSeparated: true,
			provenance: 'computed'
		});
	});
});
