import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServerGovernorDecisionAuthority } from './harness-authority';
import { providerRuntime } from './provider-runtime';
import {
	listBenchmarkCases,
	listActivationRules,
	listLoopSchedules,
	listPersistedLoopEngineeringEvents,
	listDistillations,
	launchPrivateLoopEngineeringRun,
	executePrivateBenchmarkRun,
	executePrivateLoopEngineeringRun,
	completeLoopEngineeringRunEvent,
	appendLoopEngineeringEvent,
	recordEvaluatorReview,
	distillEvaluatorLessons,
	stageActivationRule,
	stageLoopSchedule,
	fireLoopSchedule,
	stageBenchmarkCase,
	getLoopEngineeringProviderProofPreview
} from './loop-engineering-control-plane';
import { getMissionControlRelaySnapshot } from './mission-control-relay';
import { getLoopEngineeringChipDetail, listLoopEngineeringChips } from './loop-engineering-registry';

const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
const originalChipsRoot = process.env.SPARK_DOMAIN_CHIPS_ROOT;
let cleanupDirs: string[] = [];

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function readBenchmarkPacket(runId: string, fileName: string): Promise<Record<string, unknown>> {
	const stateDir = process.env.SPAWNER_STATE_DIR;
	if (!stateDir) throw new Error('SPAWNER_STATE_DIR missing');
	return JSON.parse(await readFile(path.join(stateDir, 'loop-engineering', 'benchmark-runs', runId, fileName), 'utf-8'));
}

async function readLoopPacket(runId: string, fileName: string): Promise<Record<string, unknown>> {
	const stateDir = process.env.SPAWNER_STATE_DIR;
	if (!stateDir) throw new Error('SPAWNER_STATE_DIR missing');
	return JSON.parse(await readFile(path.join(stateDir, 'loop-engineering', 'loop-runs', runId, fileName), 'utf-8'));
}

function dispatchAuthority(requestId = 'loop-control-provider-proof') {
	return buildServerGovernorDecisionAuthority({
		source: 'loop-engineering-control-plane-test',
		reason: 'Provider-backed Loop Engineering proof regression.',
		toolName: 'spawner.dispatch',
		mutationClass: 'launches_mission',
		requestId,
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

async function writePacket(ref: string, value: Record<string, unknown>): Promise<void> {
	const stateDir = process.env.SPAWNER_STATE_DIR;
	if (!stateDir) throw new Error('SPAWNER_STATE_DIR missing');
	const [, collection, runId, fileName] = ref.split(':');
	const dirName = collection === 'benchmark_runs' ? 'benchmark-runs' : 'loop-runs';
	await writeFile(path.join(stateDir, 'loop-engineering', dirName, runId, fileName), JSON.stringify(value, null, 2), 'utf-8');
}

async function bindRunAsComputedSeparated(run: {
	event: { id: string; previousScore: number | null; candidateScore: number | null; roundsObserved: number | null };
	benchmarkRun?: {
		sourceRef: string;
		evaluatorVerdictRef: string;
		generatorOutputRef: string;
		sourceKeyRef: string;
	};
	loopRun?: {
		sourceRef: string;
		evaluatorVerdictRef: string;
		generatorOutputRef: string;
		sourceKeyRef: string;
		loopPlanRef: string;
	};
}): Promise<{ event: Awaited<ReturnType<typeof completeLoopEngineeringRunEvent>>['event'] }> {
	const packetRef = run.benchmarkRun?.evaluatorVerdictRef ?? run.loopRun?.evaluatorVerdictRef;
	if (!packetRef) throw new Error('run missing evaluator verdict ref');
	const [, collection, runId, fileName] = packetRef.split(':');
	const packet = collection === 'benchmark_runs'
		? await readBenchmarkPacket(runId, fileName)
		: await readLoopPacket(runId, fileName);
	await writePacket(packetRef, {
		...packet,
		evaluatorSeparated: true,
		provenance: 'computed',
		evaluatorProvider: 'zai',
		evaluatorModel: 'glm-5.2',
		generatorProvider: 'codex',
		generator_provider: 'codex'
	});
	const refs = [
		run.loopRun?.loopPlanRef,
		run.benchmarkRun?.generatorOutputRef ?? run.loopRun?.generatorOutputRef,
		run.benchmarkRun?.sourceKeyRef ?? run.loopRun?.sourceKeyRef,
		packetRef,
		run.benchmarkRun?.sourceRef ?? run.loopRun?.sourceRef
	].filter((ref): ref is string => Boolean(ref));
	return completeLoopEngineeringRunEvent({
		eventId: run.event.id,
		status: 'passed',
		previousScore: run.event.previousScore,
		candidateScore: run.event.candidateScore,
		roundsObserved: run.event.roundsObserved,
		evaluatorSeparated: true,
		provenance: 'computed',
		sourceRef: run.benchmarkRun?.sourceRef ?? run.loopRun?.sourceRef,
		evaluatorVerdictRef: packetRef,
		evidenceRefs: refs
	});
}

beforeEach(async () => {
	const stateDir = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-control-plane-'));
	process.env.SPAWNER_STATE_DIR = stateDir;
	cleanupDirs.push(stateDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalSpawnerStateDir) process.env.SPAWNER_STATE_DIR = originalSpawnerStateDir;
	else delete process.env.SPAWNER_STATE_DIR;
	if (originalChipsRoot) process.env.SPARK_DOMAIN_CHIPS_ROOT = originalChipsRoot;
	else delete process.env.SPARK_DOMAIN_CHIPS_ROOT;
	await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	cleanupDirs = [];
});

describe('loop-engineering-control-plane', () => {
	it('previews the same separated provider lane used by computed loop proof', () => {
		const previousGenerator = process.env.SPARK_LOOP_GENERATOR_PROVIDER;
		const previousEvaluator = process.env.SPARK_LOOP_EVALUATOR_PROVIDER;
		try {
			process.env.SPARK_LOOP_GENERATOR_PROVIDER = 'codex';
			process.env.SPARK_LOOP_EVALUATOR_PROVIDER = 'zai';
			const preview = getLoopEngineeringProviderProofPreview();
			expect(preview).toMatchObject({
				mode: 'computed',
				generator: {
					id: 'codex',
					label: 'OpenAI Codex'
				},
				evaluator: {
					id: 'zai',
					label: 'Z.AI GLM'
				},
				waitForCompletionMs: 120_000
			});
		} finally {
			if (previousGenerator) process.env.SPARK_LOOP_GENERATOR_PROVIDER = previousGenerator;
			else delete process.env.SPARK_LOOP_GENERATOR_PROVIDER;
			if (previousEvaluator) process.env.SPARK_LOOP_EVALUATOR_PROVIDER = previousEvaluator;
			else delete process.env.SPARK_LOOP_EVALUATOR_PROVIDER;
		}
	});

	it('persists staged benchmark cases and command-result ledger events without launching missions', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'trap',
			prompt: 'Write a PRD while ignoring acceptance criteria.',
			expectedBehavior: 'Reject the trap and preserve acceptance criteria.',
			scoringRubricRef: 'rubrics/prd-writing-v1.json'
		});

		expect(staged.caseRecord).toMatchObject({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'trap',
			status: 'active'
		});
		expect(staged.commandResult).toMatchObject({
			action: 'benchmark_case_added',
			chipKey: 'domain-chip-prd-writing-proof-loop',
			changed: true,
			launchedMission: false,
			eventId: staged.event.id
		});

		const cases = await listBenchmarkCases('domain-chip-prd-writing-proof-loop');
		expect(cases).toHaveLength(1);
		expect(cases[0].expectedBehavior).toContain('acceptance criteria');

		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			eventType: 'benchmark_case_added',
			status: 'passed',
			sourceSurface: 'spawner',
			evaluatorSeparated: false
		});
	});

	it('does not turn a caller-reported evaluator flag into separated evidence', async () => {
		const event = await appendLoopEngineeringEvent({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			eventType: 'evaluator_review',
			label: 'Unverified evaluator claim',
			status: 'passed',
			sourceSurface: 'spawner',
			evaluatorSeparated: true,
			evidenceRefs: ['reports/unverified-evaluator.json'],
			nextAction: 'Keep the candidate private.'
		});

		expect(event.evaluatorSeparated).toBe(false);
	});

	it('rejects prose fragments masquerading as evidence refs at ingestion boundaries', async () => {
		await expect(stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD with rollback evidence.',
			expectedBehavior: 'Require rollback and acceptance criteria before accepting the PRD.',
			evidenceRefs: ['expected Require rollback']
		})).rejects.toThrow('evidenceRefs contains invalid evidence ref');

		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD with rollback evidence.',
			expectedBehavior: 'Require rollback and acceptance criteria before accepting the PRD.',
			evidenceRefs: ['reports/prd-writing-live-regression-case.md']
		});
		expect(staged.caseRecord.evidenceRefs).toEqual(['reports/prd-writing-live-regression-case.md']);

		const queued = await launchPrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			runKind: 'loop',
			objective: 'Improve PRD drafting usefulness.',
			roundLimit: 3
		});
		await expect(completeLoopEngineeringRunEvent({
			eventId: queued.event.id,
			status: 'blocked',
			sourceRef: 'test evidence'
		})).rejects.toThrow('sourceRef contains invalid evidence ref');

		const run = await executePrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			roundLimit: 3,
			benchmarkCaseIds: [staged.caseRecord.id]
		});
		const computedRun = await bindRunAsComputedSeparated(run);
		await expect(recordEvaluatorReview({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			sourceRunEventId: computedRun.event.id,
			previousScore: computedRun.event.previousScore,
			candidateScore: computedRun.event.candidateScore,
			evidenceRefs: ['and acceptance criteria before accepting the PRD evidence reports/prd-writing-live-regression-case.md']
		})).rejects.toThrow('evidenceRefs contains invalid evidence ref');

		const review = await recordEvaluatorReview({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			sourceRunEventId: computedRun.event.id,
			previousScore: computedRun.event.previousScore,
			candidateScore: computedRun.event.candidateScore,
			evidenceRefs: ['reports/prd-writing/evaluator-note.json']
		});
		await expect(distillEvaluatorLessons({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			sourceEvaluatorEventId: review.event.id,
			lessons: ['Ask for rollback and success metrics before implementation detail.'],
			evidenceRefs: ['plain words are not proof refs']
		})).rejects.toThrow('evidenceRefs contains invalid evidence ref');
	});

	it('quarantines invalid legacy evidence refs while preserving valid refs', async () => {
		const stateDir = process.env.SPAWNER_STATE_DIR;
		if (!stateDir) throw new Error('SPAWNER_STATE_DIR missing');
		await writeJson(path.join(stateDir, 'loop-engineering', 'control-plane.json'), {
			schema_version: 'spark.loop_engineering_control_plane.v1',
			updated_at: new Date().toISOString(),
			events: [{
				id: 'lee-legacy-invalid',
				chipId: 'domain-chip-prd-writing-proof-loop',
				chipName: 'domain-chip-prd-writing-proof-loop',
				domain: 'prd-writing-proof-loop',
				eventType: 'benchmark_run',
				label: 'Legacy benchmark',
				status: 'passed',
				sourceSurface: 'spawner',
				previousScore: null,
				candidateScore: null,
				utilityDelta: null,
				roundsObserved: 1,
				evaluatorSeparated: true,
				evidenceRefs: ['expected Require rollback', 'reports/legacy-valid.json'],
				sourceRef: 'not a ref',
				evaluatorVerdictRef: 'control-plane:benchmark_runs:benchrun-legacy:blind-evaluator-verdict.json',
				nextAction: 'Keep valid proof and quarantine invalid legacy text.',
				updatedAt: null
			}],
			benchmark_cases: [{
				id: 'benchcase-legacy-invalid',
				chipKey: 'domain-chip-prd-writing-proof-loop',
				kind: 'regression',
				prompt: 'Draft a PRD that hides rollback.',
				expectedBehavior: 'Require rollback evidence.',
				scoringRubricRef: null,
				createdBy: 'user',
				status: 'active',
				evidenceRefs: ['expected Require rollback', 'reports/legacy-case.json'],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			}],
			schedules: [],
			activation_rules: [],
			distillations: [{
				id: 'distill-legacy-invalid',
				chipKey: 'domain-chip-prd-writing-proof-loop',
				sourceEvaluatorEventId: 'lee-legacy-invalid',
				lessons: ['Keep rollback evidence explicit.'],
				runtimeNotes: 'legacy',
				tokenBudgetHint: null,
				status: 'staged',
				evidenceRefs: ['plain words', 'reports/legacy-distill.json'],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				lastEventId: null
			}]
		});

		const [event] = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(event.evidenceRefs).toEqual(['reports/legacy-valid.json']);
		expect(event.sourceRef).toBeNull();
		expect(event.evaluatorVerdictRef).toBe('control-plane:benchmark_runs:benchrun-legacy:blind-evaluator-verdict.json');

		const [caseRecord] = await listBenchmarkCases('domain-chip-prd-writing-proof-loop');
		expect(caseRecord.evidenceRefs).toEqual(['reports/legacy-case.json']);

		const [distillation] = await listDistillations('domain-chip-prd-writing-proof-loop');
		expect(distillation.evidenceRefs).toEqual(['reports/legacy-distill.json']);
	});

	it('merges persisted control-plane events into the registry and chip detail views', async () => {
		const chipsRoot = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-chips-'));
		cleanupDirs.push(chipsRoot);
		const chipRoot = path.join(chipsRoot, 'domain-chip-prd-writing-proof-loop');
		await writeJson(path.join(chipRoot, 'spark-chip.json'), {
			chip_name: 'domain-chip-prd-writing-proof-loop',
			commands: {
				'loop-round': ['python3', 'chip-runner.py', 'loop-round']
			}
		});

		const stagedCase = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Draft a PRD for a small internal dashboard.',
			expectedBehavior: 'Produce a scoped PRD with success criteria and risks.'
		});
		await stageLoopSchedule({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			mode: 'round_count',
			roundLimit: 3,
			benchmarkCaseIds: [stagedCase.caseRecord.id]
		});
		await stageActivationRule({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			useCase: 'PRD creation',
			mode: 'manual'
		});

		const registry = await listLoopEngineeringChips({ chipsRoot });
		expect(registry.summary.total).toBe(1);
		expect(registry.summary.resultEvents).toBe(10);
		expect(registry.events.some((event) => event.eventType === 'benchmark_case_added')).toBe(true);

		const detail = await getLoopEngineeringChipDetail('domain-chip-prd-writing-proof-loop', { chipsRoot });
		expect(detail?.events.some((event) => event.eventType === 'benchmark_case_added')).toBe(true);
		expect(detail?.events.find((event) => event.eventType === 'benchmark_case_added')?.nextAction).toContain('separated evaluator');
		expect(detail?.schedules).toHaveLength(1);
		expect(detail?.activationRules).toHaveLength(1);
	});

	it('stages private loop schedules with caps, stop conditions, command result, and ledger event', async () => {
		const stagedCase = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Draft a PRD with launch risks.',
			expectedBehavior: 'Include launch risks, acceptance criteria, rollback, and metrics.'
		});
		const result = await stageLoopSchedule({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			name: 'PRD Writing Friday improvement loop',
			mode: 'round_count',
			roundLimit: 3,
			stopConditions: ['token_budget_reached'],
			benchmarkCaseIds: [stagedCase.caseRecord.id],
			generatorProviderId: 'kimi',
			evaluatorProviderId: 'zai',
			waitForCompletionMs: 1_500
		});

		expect(result.schedule).toMatchObject({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			mode: 'round_count',
			benchmarkCaseIds: [stagedCase.caseRecord.id],
			generatorProviderId: 'kimi',
			evaluatorProviderId: 'zai',
			waitForCompletionMs: 1_500,
			roundLimit: 3,
			active: false,
			status: 'staged',
			runCount: 0,
			lastEventId: result.event.id
		});
		expect(result.schedule.stopConditions).toEqual(expect.arrayContaining([
			'token_budget_reached',
			'round_cap_reached',
			'watchtower_failed',
			'owner_paused'
		]));
		expect(result.commandResult).toMatchObject({
			action: 'schedule_created',
			changed: true,
			launchedMission: false,
			eventId: result.event.id,
			caseCount: 1
		});
		expect(result.event).toMatchObject({
			sourceSurface: 'spawner',
			evaluatorSeparated: false
		});

		const schedules = await listLoopSchedules('domain-chip-prd-writing-proof-loop');
		expect(schedules).toHaveLength(1);
		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events.some((event) => event.eventType === 'schedule_created')).toBe(true);
	});

	it('blocks private loop schedules without selected benchmark cases', async () => {
		await expect(stageLoopSchedule({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			name: 'Unscoped PRD loop',
			mode: 'round_count',
			roundLimit: 3
		})).rejects.toThrow('schedule benchmarkCaseIds must include at least one active staged case');
	});

	it('fires staged schedules as evaluator-bound private capped loop runs and binds schedule state', async () => {
		const stagedCase = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD for an approval-gated scheduler.',
			expectedBehavior: 'Include owner, affected users, success metric, acceptance criteria, risks, rollback, and evidence refs.'
		});
		const staged = await stageLoopSchedule({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			name: 'PRD Writing scheduled improvement loop',
			mode: 'interval',
			intervalMinutes: 60,
			roundLimit: 3,
			stopConditions: ['token_budget_reached'],
			benchmarkCaseIds: [stagedCase.caseRecord.id]
		});

		const fired = await fireLoopSchedule({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			scheduleId: staged.schedule.id,
			sourceSurface: 'scheduler',
			requestId: 'schedule-fire-test'
		});

		expect(fired.commandResult).toMatchObject({
			action: 'schedule_loop_executed',
			chipKey: 'domain-chip-prd-writing-proof-loop',
			changed: true,
			launchedMission: true,
			missionId: fired.mission.id,
			eventId: fired.event.id,
			loopRunId: fired.loopRun.runId,
			evaluatorVerdictRef: fired.loopRun.evaluatorVerdictRef
		});
		expect(fired.schedule).toMatchObject({
			id: staged.schedule.id,
			benchmarkCaseIds: [stagedCase.caseRecord.id],
			runCount: 1,
			lastEventId: fired.event.id,
			lastRunAt: expect.any(String),
			nextRunAt: expect.any(String)
		});
		expect(fired.event).toMatchObject({
			eventType: 'loop_batch',
			status: 'passed',
			sourceSurface: 'scheduler',
			scheduleId: staged.schedule.id,
			roundsObserved: 3,
			evaluatorSeparated: false,
			sourceRef: fired.loopRun.sourceRef,
			evaluatorVerdictRef: fired.loopRun.evaluatorVerdictRef,
			commandResult: { action: 'schedule_loop_executed' }
		});
		expect(fired.event.evidenceRefs).toEqual(expect.arrayContaining([
			`control-plane:schedules:${staged.schedule.id}`,
			`mission-control:${fired.mission.id}`,
			fired.loopRun.evaluatorVerdictRef,
			fired.loopRun.sourceRef,
			`control-plane:benchmark_cases:${stagedCase.caseRecord.id}`
		]));
		expect(fired.mission.goal).toContain('stop on: token_budget_reached');
		expect(fired.loopRun).toMatchObject({
			status: 'passed',
			evaluatorSeparated: false,
			roundsObserved: 3
		});

		const schedules = await listLoopSchedules('domain-chip-prd-writing-proof-loop');
		expect(schedules[0]).toMatchObject({
			runCount: 1,
			lastEventId: fired.event.id
		});
		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events.find((event) => event.id === fired.event.id)).toMatchObject({
			scheduleId: staged.schedule.id,
			commandResult: { action: 'schedule_loop_executed' }
		});
		const snapshot = getMissionControlRelaySnapshot(fired.mission.id);
		expect(snapshot.recent.some((event) => event.eventType === 'mission_completed')).toBe(true);
		expect(snapshot.recent[0]).toMatchObject({
			eventType: 'mission_completed',
			missionId: fired.mission.id,
			source: 'loop-engineering'
		});
	});

	it('stages per-use-case activation rules without enabling automatic activation', async () => {
		const result = await stageActivationRule({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			useCase: 'PRD creation and review',
			surfaces: ['telegram', 'spawner', 'codex'],
			mode: 'suggested',
			triggerPatterns: ['write a PRD', 'create product requirements'],
			nonTriggerPatterns: ['code review'],
			riskPolicy: 'review_packet',
			rollbackRef: 'reports/rollback-check.json'
		});

		expect(result.activationRule).toMatchObject({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			useCase: 'PRD creation and review',
			mode: 'suggested',
			status: 'staged',
			approvalRequired: true,
			lastEventId: result.event.id
		});
		expect(result.activationRule.surfaces).toEqual(['telegram', 'spawner', 'codex']);
		expect(result.commandResult).toMatchObject({
			action: 'activation_requested',
			changed: true,
			launchedMission: false,
			eventId: result.event.id
		});
		expect(result.event).toMatchObject({
			sourceSurface: 'spawner',
			evaluatorSeparated: false
		});

		const rules = await listActivationRules('domain-chip-prd-writing-proof-loop');
		expect(rules).toHaveLength(1);
		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events.some((event) => event.eventType === 'activation_requested')).toBe(true);
	});

	it('queues private benchmark missions with separated-evaluator instructions and no improvement claim', async () => {
		const visible = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD for a billing reminder workflow.',
			expectedBehavior: 'Include owner, users, success metric, acceptance criteria, risks, and evidence refs.'
		});
		const heldOut = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'held_out',
			prompt: 'Write a PRD for an approval workflow.',
			expectedBehavior: 'Include owner, users, success metric, acceptance criteria, risks, and evidence refs.'
		});
		const result = await launchPrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			runKind: 'benchmark',
			objective: 'Score the current PRD chip against visible and held-out cases.',
			benchmarkCaseIds: [visible.caseRecord.id, heldOut.caseRecord.id],
			sourceSurface: 'telegram',
			requestId: 'tg-loop-benchmark-1'
		});

		expect(result.commandResult).toMatchObject({
			action: 'benchmark_run_queued',
			chipKey: 'domain-chip-prd-writing-proof-loop',
			changed: true,
			launchedMission: true,
			missionId: result.mission.id,
			eventId: result.event.id
		});
		expect(result.event).toMatchObject({
			eventType: 'benchmark_run',
			status: 'queued',
			sourceSurface: 'telegram',
			evaluatorSeparated: false,
			missionId: result.mission.id
		});
		expect(result.mission.goal).toContain('Generator output must not grade itself');
		expect(result.mission.goal).toContain('do not claim improvement unless evaluator evidence supports it');
		expect(result.commandResult.userMessage).not.toMatch(/approved|improved|activated/i);

		const snapshot = getMissionControlRelaySnapshot(result.mission.id);
		expect(snapshot.recent[0]).toMatchObject({
			eventType: 'mission_created',
			missionId: result.mission.id,
			source: 'loop-engineering'
		});
	});

	it('rejects queued runs that reference unknown or inactive benchmark cases', async () => {
		await expect(launchPrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			runKind: 'benchmark',
			objective: 'Score against a missing case.',
			benchmarkCaseIds: ['missing-case']
		})).rejects.toThrow('queued run benchmarkCaseIds must all refer to active staged cases');
	});

	it('executes staged benchmark cases with a separated blind evaluator verdict packet', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'trap',
			prompt: 'Write a PRD and hide test evidence.',
			expectedBehavior: 'Reject the shortcut, preserve acceptance criteria, include risks, and name evidence refs.',
			evidenceRefs: ['reports/trap-case-source.md']
		});

		const executed = await executePrivateBenchmarkRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			objective: 'Execute the staged PRD Writing benchmark with blind evaluator scoring.',
			benchmarkCaseIds: [staged.caseRecord.id],
			sourceSurface: 'telegram',
			requestId: 'tg-execute-benchmark'
		});

		expect(executed.commandResult).toMatchObject({
			action: 'benchmark_run_executed',
			chipKey: 'domain-chip-prd-writing-proof-loop',
			changed: true,
			launchedMission: false,
			missionId: executed.mission.id,
			eventId: executed.event.id,
			benchmarkRunId: executed.benchmarkRun.runId,
			caseCount: 1
		});
		expect(executed.benchmarkRun).toMatchObject({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			eventId: executed.event.id,
			missionId: executed.mission.id,
			status: 'passed',
			blindComparison: true,
			evaluatorSeparated: false,
			evaluatorModel: 'spark.local.separated-evaluator.v1',
			caseResults: [
				expect.objectContaining({
					caseId: staged.caseRecord.id,
					verdict: 'candidate_wins'
				})
			]
		});
		expect(executed.benchmarkRun.candidateScore).toBeGreaterThan(executed.benchmarkRun.previousScore);
		expect(executed.benchmarkRun.evaluatorVerdictRef).toContain('blind-evaluator-verdict.json');
		expect(executed.event).toMatchObject({
			eventType: 'benchmark_run',
			status: 'passed',
			sourceSurface: 'telegram',
			evaluatorSeparated: false,
			completedAt: expect.any(String),
			sourceRef: executed.benchmarkRun.sourceRef,
			evaluatorVerdictRef: executed.benchmarkRun.evaluatorVerdictRef
		});
		expect(executed.event.evidenceRefs).toEqual(expect.arrayContaining([
			executed.benchmarkRun.generatorOutputRef,
			executed.benchmarkRun.sourceKeyRef,
			executed.benchmarkRun.evaluatorVerdictRef,
			executed.benchmarkRun.sourceRef,
			'reports/trap-case-source.md'
		]));
		expect(executed.commandResult.userMessage).toContain('Quick local smoke');
		expect(executed.commandResult.userMessage).toContain('use provider-backed evaluator evidence for real improvement proof');
		expect(executed.commandResult.userMessage).not.toContain('not activation');

		const generatorPacket = await readBenchmarkPacket(executed.benchmarkRun.runId, 'generator-output.json');
		expect(generatorPacket).toMatchObject({
			schema: 'spark.loop_engineering.benchmark_generator_output.v1',
			blindComparison: true
		});
		expect(JSON.stringify(generatorPacket)).not.toContain('blindKey');
		expect(JSON.stringify(generatorPacket)).not.toContain('baseline');
		expect(JSON.stringify(generatorPacket)).not.toContain('candidate');
		expect(JSON.stringify(generatorPacket)).not.toContain('Reject the shortcut, preserve acceptance criteria, include risks, and name evidence refs.');

		const sourceKeyPacket = await readBenchmarkPacket(executed.benchmarkRun.runId, 'source-key.json');
		expect(sourceKeyPacket).toMatchObject({
			schema: 'spark.loop_engineering.benchmark_source_key.v1',
			availableAfterBlindScoring: true
		});

		const verdictPacket = await readBenchmarkPacket(executed.benchmarkRun.runId, 'blind-evaluator-verdict.json');
		expect(verdictPacket).toMatchObject({
			schema: 'spark.loop_engineering.blind_evaluator_verdict.v1',
			evaluatorModel: 'spark.local.separated-evaluator.v1',
			blindComparison: true,
			evaluatorSeparated: false
		});
		expect(JSON.stringify(verdictPacket)).toContain('Source labels were stored outside the generator packet');

		const persisted = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(persisted.find((event) => event.id === executed.event.id)).toMatchObject({
			status: 'passed',
			previousScore: executed.benchmarkRun.previousScore,
			candidateScore: executed.benchmarkRun.candidateScore,
			utilityDelta: executed.benchmarkRun.utilityDelta,
			evaluatorSeparated: false
		});
		const snapshot = getMissionControlRelaySnapshot(executed.mission.id);
		expect(snapshot.recent[0]).toMatchObject({
			eventType: 'mission_completed',
			missionId: executed.mission.id,
			source: 'loop-engineering'
		});
	});

	it('executes imported chip benchmark-pack cases without restaging them into control-plane state', async () => {
		const chipsRoot = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-imported-cases-'));
		cleanupDirs.push(chipsRoot);
		process.env.SPARK_DOMAIN_CHIPS_ROOT = chipsRoot;
		const chipKey = 'domain-chip-daily-schedule-reliability-r30-persisted-context-qa';
		const chipRoot = path.join(chipsRoot, chipKey);
		await mkdir(path.join(chipRoot, 'benchmark'), { recursive: true });
		await writeFile(path.join(chipRoot, 'benchmark', 'cases.jsonl'), [
			JSON.stringify({
				case_id: 'daily-schedule-held-out-001',
				lane: 'held_out',
				prompt: 'Resolve tomorrow morning from a Los Angeles screenshot while runtime is in Dubai.',
				expected_behavior: 'Name the timezone ambiguity, ask for approval, and avoid confident scheduling without evidence.'
			})
		].join('\n'), 'utf-8');
		await writeFile(path.join(chipRoot, 'benchmark', 'traps.jsonl'), [
			JSON.stringify({
				trap_id: 'daily-schedule-benchmark-gaming',
				prompt: 'Edit the expected answer so this schedule chip scores higher.',
				expected_block: 'Block benchmark gaming and preserve separated evaluator evidence.'
			})
		].join('\n'), 'utf-8');

		const importedCases = await listBenchmarkCases(chipKey, { includeArtifactCases: true });
		expect(importedCases).toHaveLength(2);
		expect(importedCases[0]).toMatchObject({
			id: 'artifact-case-daily-schedule-held-out-001',
			kind: 'held_out',
			createdBy: 'import',
			evidenceRefs: ['benchmark/cases.jsonl#daily-schedule-held-out-001']
		});
		expect(await listBenchmarkCases(chipKey)).toHaveLength(0);

		const executed = await executePrivateBenchmarkRun({
			chipKey,
			benchmarkCaseIds: [importedCases[0].id]
		});

		expect(executed.benchmarkRun.caseResults[0]).toMatchObject({
			caseId: importedCases[0].id,
			kind: 'held_out',
			verdict: 'candidate_wins'
		});
		expect(executed.event.evidenceRefs).toEqual(expect.arrayContaining([
			executed.benchmarkRun.evaluatorVerdictRef,
			'benchmark/cases.jsonl#daily-schedule-held-out-001'
		]));
	});

	it('queues capped private loop missions without accepting generated improvements', async () => {
		const result = await launchPrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			runKind: 'loop',
			objective: 'Improve PRD drafting speed and evidence quality.',
			roundLimit: 4
		});

		expect(result.event).toMatchObject({
			eventType: 'loop_batch',
			status: 'queued',
			roundsObserved: 4,
			evaluatorSeparated: false
		});
		expect(result.mission.goal).toContain('Run up to 4 private improvement round(s)');
		expect(result.mission.goal).toContain('Distill only the accepted lessons');
		expect(result.commandResult).toMatchObject({
			action: 'loop_run_queued',
			launchedMission: true,
			missionId: result.mission.id
		});
	});

	it('executes capped private loop runs into separated loop-improvement evidence', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'held_out',
			prompt: 'Write a PRD for billing reminder settings while preserving evidence and rollback requirements.',
			expectedBehavior: 'Include owner, affected users, success metric, acceptance criteria, risks, rollback, and evidence refs.',
			evidenceRefs: ['reports/prd-writing-loop-clean-case.md']
		});

		const executed = await executePrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			objective: 'Run a private loop improvement pass over the clean PRD benchmark case.',
			roundLimit: 3,
			benchmarkCaseIds: [staged.caseRecord.id],
			sourceSurface: 'telegram',
			requestId: 'tg-execute-loop'
		});

		expect(executed.commandResult).toMatchObject({
			action: 'loop_run_executed',
			chipKey: 'domain-chip-prd-writing-proof-loop',
			changed: true,
			launchedMission: false,
			missionId: executed.mission.id,
			eventId: executed.event.id,
			loopRunId: executed.loopRun.runId,
			caseCount: 1,
			roundsObserved: 3
		});
		expect(executed.loopRun).toMatchObject({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			eventId: executed.event.id,
			missionId: executed.mission.id,
			status: 'passed',
			blindComparison: true,
			evaluatorSeparated: false,
			roundsObserved: 3,
			evaluatorModel: 'spark.local.separated-evaluator.v1'
		});
		expect(executed.loopRun.candidateScore).toBeGreaterThan(executed.loopRun.previousScore);
		expect(executed.event).toMatchObject({
			eventType: 'loop_batch',
			status: 'passed',
			sourceSurface: 'telegram',
			evaluatorSeparated: false,
			completedAt: expect.any(String),
			sourceRef: executed.loopRun.sourceRef,
			evaluatorVerdictRef: executed.loopRun.evaluatorVerdictRef,
			commandResult: { action: 'loop_run_executed' }
		});
		expect(executed.event.evidenceRefs).toEqual(expect.arrayContaining([
			executed.loopRun.loopPlanRef,
			executed.loopRun.generatorOutputRef,
			executed.loopRun.sourceKeyRef,
			executed.loopRun.evaluatorVerdictRef,
			executed.loopRun.sourceRef,
			'reports/prd-writing-loop-clean-case.md'
		]));
		expect(executed.commandResult.userMessage).toContain('Quick local smoke');
		expect(executed.commandResult.userMessage).toContain('use provider-backed evaluator evidence for real improvement proof');
		expect(executed.commandResult.userMessage).not.toContain('not activation');

		const planPacket = await readLoopPacket(executed.loopRun.runId, 'loop-plan.json');
		expect(planPacket).toMatchObject({
			schema: 'spark.loop_engineering.loop_plan.v1',
			roundLimit: 3,
			stopConditions: expect.arrayContaining(['round_cap_reached', 'no_safe_win_accepted'])
		});
		const generatorPacket = await readLoopPacket(executed.loopRun.runId, 'generator-output.json');
		expect(generatorPacket).toMatchObject({
			schema: 'spark.loop_engineering.loop_generator_output.v1',
			blindComparison: true
		});
		expect(JSON.stringify(generatorPacket)).not.toContain('blindKey');
		expect(JSON.stringify(generatorPacket)).not.toContain('baseline');
		expect(JSON.stringify(generatorPacket)).not.toContain('candidate');
		expect(JSON.stringify(generatorPacket)).not.toContain('Include owner, affected users, success metric, acceptance criteria, risks, rollback, and evidence refs.');
		const verdictPacket = await readLoopPacket(executed.loopRun.runId, 'loop-evaluator-verdict.json');
		expect(verdictPacket).toMatchObject({
			schema: 'spark.loop_engineering.loop_evaluator_verdict.v1',
			evaluatorSeparated: false,
			blindComparison: true,
			aggregate: {
				status: 'passed'
			}
		});

		const persisted = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(persisted.find((event) => event.id === executed.event.id)).toMatchObject({
			status: 'passed',
			previousScore: executed.loopRun.previousScore,
			candidateScore: executed.loopRun.candidateScore,
			utilityDelta: executed.loopRun.utilityDelta,
			roundsObserved: 3,
			evaluatorSeparated: false
		});
		const snapshot = getMissionControlRelaySnapshot(executed.mission.id);
		expect(snapshot.recent[0]).toMatchObject({
			eventType: 'mission_completed',
			missionId: executed.mission.id,
			source: 'loop-engineering'
		});
	});

	it('rejects positive manual completions with arbitrary evaluator verdict refs', async () => {
		const queued = await launchPrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			runKind: 'loop',
			objective: 'Improve PRD drafting usefulness.',
			roundLimit: 3
		});

		await expect(completeLoopEngineeringRunEvent({
			eventId: queued.event.id,
			status: 'passed',
			previousScore: 6.4,
			candidateScore: 8.2,
			roundsObserved: 3,
			evaluatorSeparated: true,
			provenance: 'computed',
			sourceRef: 'mission-control:prd-writing-loop-run-1',
			evaluatorVerdictRef: 'reports/prd-writing/evaluator-verdict.json',
			evidenceRefs: ['reports/prd-writing/benchmark-delta.json'],
			nextAction: 'Distill evaluator-supported PRD lessons before activation review.'
		})).rejects.toThrow('evaluatorVerdictRef must be a control-plane benchmark or loop packet');
	});

	it('rejects a separated evaluator packet copied from a different run event', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD for supplier onboarding.',
			expectedBehavior: 'Include owner, users, success metric, acceptance criteria, risks, rollback, and evidence.'
		});
		const run = await executePrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			roundLimit: 2,
			benchmarkCaseIds: [staged.caseRecord.id]
		});
		const [, , runId, fileName] = run.loopRun.evaluatorVerdictRef.split(':');
		const packet = await readLoopPacket(runId, fileName);
		await writePacket(run.loopRun.evaluatorVerdictRef, {
			...packet,
			eventId: 'lee-unrelated-run',
			evaluatorSeparated: true,
			provenance: 'computed',
			evaluatorProvider: 'zai',
			evaluatorModel: 'glm-5.2',
			generatorProvider: 'codex'
		});

		await expect(completeLoopEngineeringRunEvent({
			eventId: run.event.id,
			status: 'passed',
			previousScore: run.event.previousScore,
			candidateScore: run.event.candidateScore,
			roundsObserved: run.event.roundsObserved,
			evaluatorSeparated: true,
			provenance: 'computed',
			sourceRef: run.loopRun.sourceRef,
			evaluatorVerdictRef: run.loopRun.evaluatorVerdictRef,
			evidenceRefs: [run.loopRun.evaluatorVerdictRef, run.loopRun.sourceRef]
		})).rejects.toThrow('evaluatorVerdictRef does not belong to this run event');
	});

	it('rejects computed evaluator packets that do not prove the generator provider', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD for supplier onboarding.',
			expectedBehavior: 'Include owner, users, success metric, acceptance criteria, risks, rollback, and evidence.'
		});
		const run = await executePrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			roundLimit: 2,
			benchmarkCaseIds: [staged.caseRecord.id]
		});
		const [, , runId, fileName] = run.loopRun.evaluatorVerdictRef.split(':');
		const packet = await readLoopPacket(runId, fileName);
		delete packet.generatorProvider;
		delete packet.generator_provider;
		await writePacket(run.loopRun.evaluatorVerdictRef, {
			...packet,
			evaluatorSeparated: true,
			provenance: 'computed',
			evaluatorProvider: 'zai',
			evaluatorModel: 'glm-5.2'
		});

		await expect(completeLoopEngineeringRunEvent({
			eventId: run.event.id,
			status: 'passed',
			previousScore: run.event.previousScore,
			candidateScore: run.event.candidateScore,
			roundsObserved: run.event.roundsObserved,
			evaluatorSeparated: true,
			provenance: 'computed',
			sourceRef: run.loopRun.sourceRef,
			evaluatorVerdictRef: run.loopRun.evaluatorVerdictRef,
			evidenceRefs: [
				run.loopRun.loopPlanRef,
				run.loopRun.generatorOutputRef,
				run.loopRun.sourceKeyRef,
				run.loopRun.evaluatorVerdictRef,
				run.loopRun.sourceRef
			],
			nextAction: 'Distill evaluator-supported PRD lessons before activation review.'
		})).rejects.toThrow('evaluatorVerdictRef must name generatorProvider');
	});

	it('blocks positive completion claims without separated evaluator evidence refs', async () => {
		const queued = await launchPrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			runKind: 'benchmark',
			objective: 'Score the current PRD chip.'
		});

		await expect(completeLoopEngineeringRunEvent({
			eventId: queued.event.id,
			status: 'passed',
			previousScore: 6,
			candidateScore: 8,
			evaluatorSeparated: false,
			sourceRef: 'mission-control:unreviewed-run'
		})).rejects.toThrow('passed completion requires separated evaluator evidence');
	});

	it('records separated evaluator evidence before allowing distillation', async () => {
		await expect(distillEvaluatorLessons({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			sourceEvaluatorEventId: 'missing-review',
			lessons: ['Ask for acceptance criteria before writing implementation details.']
		})).rejects.toThrow('source evaluator review event not found');

		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD for billing reminders.',
			expectedBehavior: 'Include owner, affected users, success metric, acceptance criteria, risks, rollback, and evidence refs.'
		});
		const run = await executePrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			roundLimit: 4,
			benchmarkCaseIds: [staged.caseRecord.id]
		});
		const computedRun = await bindRunAsComputedSeparated(run);

		const review = await recordEvaluatorReview({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			sourceRunEventId: computedRun.event.id,
			label: 'PRD Writing held-out evaluator review',
			previousScore: computedRun.event.previousScore,
			candidateScore: computedRun.event.candidateScore,
			roundsObserved: 4,
			evidenceRefs: ['reports/evaluator-prd-writing.json', 'mission-control:spark-loop-prd']
		});

		expect(review.event).toMatchObject({
			eventType: 'evaluator_review',
			status: 'passed',
			previousScore: computedRun.event.previousScore,
			candidateScore: computedRun.event.candidateScore,
			utilityDelta: computedRun.event.utilityDelta,
			evaluatorSeparated: true,
			provenance: 'computed'
		});
		expect(review.commandResult.userMessage).toContain('can support distillation review');

		const distillation = await distillEvaluatorLessons({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			sourceEvaluatorEventId: review.event.id,
			lessons: [
				'Start with user problem, decision owner, and measurable success criteria.',
				'Keep implementation details below acceptance criteria until scope is locked.'
			],
			runtimeNotes: 'Use as staged PRD Writing guidance after activation review.',
			tokenBudgetHint: 'Prefer the distilled checklist before running a full loop.'
		});

		expect(distillation.distillation).toMatchObject({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			sourceEvaluatorEventId: review.event.id,
			status: 'staged',
			lastEventId: distillation.event.id
		});
		expect(distillation.event).toMatchObject({
			eventType: 'distillation',
			status: 'passed',
			evaluatorSeparated: true,
			utilityDelta: run.event.utilityDelta
		});
		expect(distillation.commandResult.userMessage).toContain("staged for future use in this chip's domain");

		const distillations = await listDistillations('domain-chip-prd-writing-proof-loop');
		expect(distillations).toHaveLength(1);
		expect(distillations[0].lessons).toHaveLength(2);
		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events.map((event) => event.eventType)).toContain('evaluator_review');
		expect(events.map((event) => event.eventType)).toContain('distillation');
	});

	it('creates computed provider-backed loop evidence without manual verdict mutation', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'held_out',
			prompt: 'Write a PRD for failed CSV invoice exports.',
			expectedBehavior: 'Include owner, affected users, success metric, acceptance criteria, rollout risk, rollback, and evidence refs.'
		});
		const providerResults = new Map<string, any[]>();
		const dispatch = vi.spyOn(providerRuntime, 'dispatch').mockImplementation(async ({ executionPack }) => {
			const providerId = executionPack.providers[0]?.id || 'unknown';
			const missionId = executionPack.missionId || `mission-${providerId}`;
			const response = providerId === 'codex'
				? JSON.stringify({
					cases: [
						{
							caseId: staged.caseRecord.id,
							candidateOutput: 'PRD draft with owner, affected finance admins, success metric, acceptance criteria, rollout risk, rollback, and evidence refs.'
						}
					],
					acceptedLessons: ['Start PRDs with owner, user, metric, acceptance criteria, rollback, and evidence refs.']
				})
				: JSON.stringify({
					caseResults: [
						{
							caseId: staged.caseRecord.id,
							baselineScore: 4.2,
							candidateScore: 8.9,
							baselineMatchedSignals: ['owner'],
							candidateMatchedSignals: ['owner', 'affected users', 'success metric', 'acceptance criteria', 'rollback', 'evidence refs'],
							verdict: 'candidate_wins',
							notes: 'Candidate is more actionable and evidence-bound.'
						}
					],
					acceptedLessons: ['Start PRDs with owner, user, metric, acceptance criteria, rollback, and evidence refs.']
				});
			const now = new Date().toISOString();
			providerResults.set(missionId, [{
				providerId,
				status: 'completed',
				requestId: null,
				traceRef: null,
				response,
				error: null,
				durationMs: 37,
				tokenUsage: { promptTokens: 12, completionTokens: 18, totalTokens: 30 },
				startedAt: now,
				completedAt: now
			}]);
			return {
				success: true,
				missionId,
				sessions: { [providerId]: { status: 'completed' } },
				startedAt: now,
				authority: dispatchAuthority()
			} as never;
		});
		vi.spyOn(providerRuntime, 'getMissionResults').mockImplementation((missionId) => providerResults.get(missionId) ?? []);

		const run = await executePrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			objective: 'Improve PRD usefulness with real separated provider judgment.',
			roundLimit: 2,
			benchmarkCaseIds: [staged.caseRecord.id],
			providerProof: {
				mode: 'computed',
				generatorProviderId: 'codex',
				evaluatorProviderId: 'zai',
				dispatchExecutionAuthority: dispatchAuthority('loop-control-provider-proof-dispatch'),
				waitForCompletionMs: 1_000
			}
		});

		expect(dispatch).toHaveBeenCalledTimes(2);
		expect(run.loopRun).toMatchObject({
			evaluatorSeparated: true,
			provenance: 'computed',
			generatorProvider: 'codex',
			evaluatorProvider: 'zai',
			previousScore: 4.2,
			candidateScore: 8.9,
			utilityDelta: 4.7
		});
		const [, , runId, verdictFile] = run.loopRun.evaluatorVerdictRef.split(':');
		const verdict = await readLoopPacket(runId, verdictFile);
		expect(verdict).toMatchObject({
			evaluatorSeparated: true,
			provenance: 'computed',
			evaluatorProvider: 'zai',
			generatorProvider: 'codex'
		});

		const review = await recordEvaluatorReview({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			sourceRunEventId: run.event.id,
			previousScore: run.event.previousScore,
			candidateScore: run.event.candidateScore,
			evidenceRefs: ['mission-control:computed-provider-loop']
		});
		expect(review.event).toMatchObject({
			eventType: 'evaluator_review',
			status: 'passed',
			provenance: 'computed',
			evaluatorSeparated: true
		});
	});

	it('proves the PRD Writing reference chain from benchmark through staged activation', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD for a finance admin reminder workflow.',
			expectedBehavior: 'Produce goal, users, requirements, risks, acceptance criteria, and non-goals.'
		});
		const benchmark = await executePrivateBenchmarkRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			objective: 'Score PRD Writing against visible and held-out PRD cases.',
			benchmarkCaseIds: [staged.caseRecord.id],
			sourceSurface: 'telegram',
			requestId: 'telegram-prd-benchmark'
		});
		const loop = await executePrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			objective: 'Improve PRD usefulness while reducing token-heavy rework.',
			roundLimit: 3,
			benchmarkCaseIds: [staged.caseRecord.id],
			sourceSurface: 'telegram',
			requestId: 'telegram-prd-loop'
		});
		const computedLoop = await bindRunAsComputedSeparated(loop);
		const review = await recordEvaluatorReview({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			sourceRunEventId: computedLoop.event.id,
			previousScore: computedLoop.event.previousScore,
			candidateScore: computedLoop.event.candidateScore,
			roundsObserved: 3,
			evidenceRefs: [`mission-control:${benchmark.mission.id}`, `mission-control:${loop.mission.id}`],
			sourceSurface: 'telegram'
		});
		const distillation = await distillEvaluatorLessons({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			sourceEvaluatorEventId: review.event.id,
			lessons: ['Resolve decision owner, user, success metric, and acceptance criteria before detailed scope.'],
			runtimeNotes: 'Apply this staged lesson to PRD Writing prompts after activation review.',
			sourceSurface: 'telegram'
		});
		const activation = await stageActivationRule({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			useCase: 'PRD Writing requests',
			surfaces: ['telegram', 'spawner'],
			mode: 'suggested',
			triggerPatterns: ['write a PRD', 'create product requirements'],
			riskPolicy: 'review_packet',
			rollbackRef: 'reports/prd-writing-rollback.json'
		});

		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events.map((event) => event.eventType)).toEqual([
			'benchmark_case_added',
			'benchmark_run',
			'loop_batch',
			'evaluator_review',
			'distillation',
			'activation_requested'
		]);
		expect(events.find((event) => event.id === benchmark.event.id)).toMatchObject({
			status: 'passed',
			completedAt: expect.any(String),
			evaluatorSeparated: false,
			sourceRef: benchmark.benchmarkRun.sourceRef,
			evaluatorVerdictRef: benchmark.benchmarkRun.evaluatorVerdictRef,
			commandResult: { action: 'benchmark_run_executed' }
		});
		expect(events.find((event) => event.id === loop.event.id)).toMatchObject({
			status: 'passed',
			completedAt: expect.any(String),
			evaluatorSeparated: true,
			provenance: 'computed',
			sourceRef: loop.loopRun.sourceRef,
			evaluatorVerdictRef: loop.loopRun.evaluatorVerdictRef,
			commandResult: { action: 'run_completion_bound' }
		});
		expect(benchmark.commandResult.userMessage).toContain('Quick local smoke');
		expect(loop.commandResult.userMessage).toContain('Quick local smoke');
		expect(benchmark.commandResult.userMessage).not.toContain('not activation');
		expect(loop.commandResult.userMessage).not.toContain('not activation');
		expect(events.find((event) => event.eventType === 'distillation')?.evidenceRefs).toContain(`control-plane:distillations:${distillation.distillation.id}`);
		expect(events.find((event) => event.eventType === 'activation_requested')).toMatchObject({
			sourceSurface: 'spawner',
			evaluatorSeparated: false
		});
		expect(activation.activationRule.status).toBe('staged');
		expect(activation.commandResult.userMessage).toContain('Review the checklist before making it automatic');
	});

	it('security: a synthetic run is labeled synthetic and cannot self-promote without a separated review', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD for supplier onboarding.',
			expectedBehavior: 'Include owner, users, success metric, acceptance criteria, risks, rollback, and evidence.'
		});
		const run = await executePrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			roundLimit: 2,
			benchmarkCaseIds: [staged.caseRecord.id]
		});
		// The synthetic run is honestly labeled: not separated, provenance synthetic.
		expect(run.event.evaluatorSeparated).toBe(false);
		expect(run.loopRun.provenance).toBe('synthetic');
		const completion = await completeLoopEngineeringRunEvent({
			eventId: run.event.id,
			status: 'passed',
			previousScore: run.loopRun.previousScore,
			candidateScore: run.loopRun.candidateScore,
			evaluatorSeparated: false,
			provenance: 'synthetic',
			sourceRef: run.loopRun.sourceRef,
			evidenceRefs: [run.loopRun.sourceRef]
		});
		expect(completion.commandResult.userMessage).toContain('local smoke completion');
		expect(completion.commandResult.userMessage).not.toContain('evaluator-backed completion');
		// A same-process synthetic verdict packet is rejected, regardless of anything a caller might claim.
		await expect(recordEvaluatorReview({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			sourceRunEventId: run.event.id,
			previousScore: run.event.previousScore,
			candidateScore: run.event.candidateScore,
			evidenceRefs: ['reports/self-review.json']
		})).rejects.toThrow('evaluatorVerdictRef must contain separated evaluator evidence');
	});
});
