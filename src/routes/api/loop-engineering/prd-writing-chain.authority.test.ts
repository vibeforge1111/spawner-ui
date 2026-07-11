import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServerGovernorDecisionAuthority } from '$lib/server/harness-authority';
import { listActivationRules, listPersistedLoopEngineeringEvents } from '$lib/server/loop-engineering-control-plane';
import { POST as POST_CASE } from './chips/[chipId]/benchmarks/cases/+server';
import { POST as POST_BENCHMARK } from './chips/[chipId]/benchmarks/run/+server';
import { POST as POST_LOOP } from './chips/[chipId]/loops/run/+server';
import { POST as POST_EVALUATOR } from './chips/[chipId]/evaluator-review/+server';
import { POST as POST_DISTILL } from './chips/[chipId]/distill/+server';
import { POST as POST_ACTIVATION } from './chips/[chipId]/activation/+server';
import { POST as POST_COMPLETE } from './events/[eventId]/complete/+server';

const chipId = 'domain-chip-prd-writing-proof-loop';
const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
let cleanupDir: string | null = null;

function governorAuthority(input: {
	toolName: string;
	mutationClass: 'writes_files' | 'launches_mission';
	requestId: string;
	target?: string;
}) {
	return buildServerGovernorDecisionAuthority({
		source: 'loop-engineering-prd-writing-chain-test',
		reason: 'PRD Writing Loop Engineering route-chain proof.',
		toolName: input.toolName,
		mutationClass: input.mutationClass,
		requestId: input.requestId,
		target: input.target ?? chipId,
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

function chipEvent(urlPath: string, body: Record<string, unknown>) {
	return {
		params: { chipId },
		request: new Request(`http://127.0.0.1:3333${urlPath}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url: new URL(`http://127.0.0.1:3333${urlPath}`),
		getClientAddress: () => '127.0.0.1'
	};
}

function completionEvent(eventId: string, body: Record<string, unknown>) {
	return {
		params: { eventId },
		request: new Request(`http://127.0.0.1:3333/api/loop-engineering/events/${eventId}/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url: new URL(`http://127.0.0.1:3333/api/loop-engineering/events/${eventId}/complete`),
		getClientAddress: () => '127.0.0.1'
	};
}

async function markRunVerdictAsComputedSeparated(ref: string): Promise<void> {
	const stateDir = process.env.SPAWNER_STATE_DIR;
	if (!stateDir) throw new Error('SPAWNER_STATE_DIR missing');
	const [, , runId, fileName] = ref.split(':');
	const verdictPath = path.join(stateDir, 'loop-engineering', 'loop-runs', runId, fileName);
	const packet = JSON.parse(await readFile(verdictPath, 'utf-8'));
	packet.evaluatorSeparated = true;
	packet.provenance = 'computed';
	packet.evaluatorProvider = 'zai';
	packet.evaluatorModel = 'glm-5.2';
	packet.generatorProvider = 'codex';
	packet.generator_provider = 'codex';
	await writeFile(verdictPath, JSON.stringify(packet, null, 2), 'utf-8');
}

async function okJson(response: Response): Promise<Record<string, any>> {
	const body = await response.json();
	expect(response.status).toBe(200);
	expect(body.ok).toBe(true);
	expect(body.commandResult).toMatchObject({
		changed: true,
		eventId: expect.any(String),
		inspectUrl: `/loop-engineering/${chipId}`
	});
	return body;
}

describe('PRD Writing Loop Engineering route chain', () => {
	beforeEach(async () => {
		cleanupDir = await mkdtemp(path.join(os.tmpdir(), 'spawner-prd-writing-chain-'));
		process.env.SPAWNER_STATE_DIR = cleanupDir;
	});

	afterEach(async () => {
		if (originalSpawnerStateDir) process.env.SPAWNER_STATE_DIR = originalSpawnerStateDir;
		else delete process.env.SPAWNER_STATE_DIR;
		if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
		cleanupDir = null;
	});

	it('proves Telegram-shaped PRD Writing benchmark, loop, distillation, and staged activation through Spawner routes', async () => {
		const caseRequestId = 'prd-chain-case';
		const caseBody = await okJson(await POST_CASE(chipEvent(`/api/loop-engineering/chips/${chipId}/benchmarks/cases`, {
			kind: 'held_out',
			prompt: 'Draft a PRD for an internal approval workflow.',
			expectedBehavior: 'Return a scoped PRD with user, owner, success metric, risks, non-goals, and acceptance criteria.',
			evidenceRefs: ['reports/prd-writing-held-out-case.md'],
			requestId: caseRequestId,
			executionAuthority: governorAuthority({
				toolName: 'spawner.loop_engineering.benchmark_case.stage',
				mutationClass: 'writes_files',
				requestId: caseRequestId
			})
		}) as never));
		expect(caseBody.commandResult.action).toBe('benchmark_case_added');
		expect(caseBody.commandResult.launchedMission).toBe(false);

		const benchmarkRequestId = 'prd-chain-benchmark';
		const benchmarkBody = await okJson(await POST_BENCHMARK(chipEvent(`/api/loop-engineering/chips/${chipId}/benchmarks/run`, {
			sourceSurface: 'telegram',
			objective: 'Score current PRD Writing behavior against visible and held-out cases.',
			benchmarkCaseIds: [caseBody.case.id],
			executeNow: true,
			requestId: benchmarkRequestId,
			executionAuthority: governorAuthority({
				toolName: 'spawner.loop_engineering.benchmark.run',
				mutationClass: 'writes_files',
				requestId: benchmarkRequestId
			})
		}) as never));
		expect(benchmarkBody.commandResult).toMatchObject({
			action: 'benchmark_run_executed',
			launchedMission: false,
			missionId: benchmarkBody.mission.id
		});

		const loopRequestId = 'prd-chain-loop';
		const loopBody = await okJson(await POST_LOOP(chipEvent(`/api/loop-engineering/chips/${chipId}/loops/run`, {
			sourceSurface: 'telegram',
			objective: 'Improve PRD usefulness and reduce token-heavy rework.',
			roundLimit: 3,
			benchmarkCaseIds: [caseBody.case.id],
			executeNow: true,
			requestId: loopRequestId,
			executionAuthority: governorAuthority({
				toolName: 'spawner.loop_engineering.loop.run',
				mutationClass: 'writes_files',
				requestId: loopRequestId
			})
		}) as never));
		expect(loopBody.commandResult).toMatchObject({
			action: 'loop_run_executed',
			launchedMission: false,
			missionId: loopBody.mission.id
		});

		await markRunVerdictAsComputedSeparated(loopBody.loopRun.evaluatorVerdictRef);
		const completionRequestId = 'prd-chain-complete';
		const completionResponse = await POST_COMPLETE(completionEvent(loopBody.event.id, {
			status: 'passed',
			chipKey: chipId,
			previousScore: loopBody.event.previousScore,
			candidateScore: loopBody.event.candidateScore,
			roundsObserved: loopBody.event.roundsObserved,
			evaluatorSeparated: true,
			provenance: 'computed',
			sourceRef: loopBody.loopRun.sourceRef,
			evaluatorVerdictRef: loopBody.loopRun.evaluatorVerdictRef,
			evidenceRefs: [
				loopBody.loopRun.loopPlanRef,
				loopBody.loopRun.generatorOutputRef,
				loopBody.loopRun.sourceKeyRef,
				loopBody.loopRun.evaluatorVerdictRef,
				loopBody.loopRun.sourceRef
			],
			requestId: completionRequestId,
			executionAuthority: governorAuthority({
				toolName: 'spawner.loop_engineering.event.complete',
				mutationClass: 'writes_files',
				requestId: completionRequestId
			})
		}) as never);
		const completionBody = await completionResponse.json();
		expect(completionResponse.status).toBe(200);
		expect(completionBody.commandResult).toMatchObject({
			action: 'run_completion_bound',
			changed: true,
			launchedMission: false,
			eventId: loopBody.event.id
		});

		const evaluatorRequestId = 'prd-chain-evaluator';
		const evaluatorBody = await okJson(await POST_EVALUATOR(chipEvent(`/api/loop-engineering/chips/${chipId}/evaluator-review`, {
			sourceSurface: 'telegram',
			sourceRunEventId: loopBody.event.id,
			previousScore: loopBody.event.previousScore,
			candidateScore: loopBody.event.candidateScore,
			roundsObserved: loopBody.event.roundsObserved,
			evaluatorSeparated: true,
			evidenceRefs: [
				`mission-control:${benchmarkBody.mission.id}`,
				`mission-control:${loopBody.mission.id}`
			],
			requestId: evaluatorRequestId,
			executionAuthority: governorAuthority({
				toolName: 'spawner.loop_engineering.evaluator_review.record',
				mutationClass: 'writes_files',
				requestId: evaluatorRequestId
			})
		}) as never));
		expect(evaluatorBody.commandResult.action).toBe('evaluator_review_recorded');

		const distillRequestId = 'prd-chain-distill';
		const distillBody = await okJson(await POST_DISTILL(chipEvent(`/api/loop-engineering/chips/${chipId}/distill`, {
			sourceSurface: 'telegram',
			sourceEvaluatorEventId: evaluatorBody.event.id,
			lessons: ['Resolve decision owner, user, success metric, and acceptance criteria before detailed scope.'],
			runtimeNotes: 'Use this as staged PRD Writing guidance only after activation review.',
			tokenBudgetHint: 'Try the distilled PRD checklist before a full loop.',
			requestId: distillRequestId,
			executionAuthority: governorAuthority({
				toolName: 'spawner.loop_engineering.distill.stage',
				mutationClass: 'writes_files',
				requestId: distillRequestId
			})
		}) as never));
		expect(distillBody.commandResult.action).toBe('distillation_staged');

		const activationRequestId = 'prd-chain-activation';
		const activationBody = await okJson(await POST_ACTIVATION(chipEvent(`/api/loop-engineering/chips/${chipId}/activation`, {
			useCase: 'PRD Writing requests',
			surfaces: ['telegram', 'spawner'],
			mode: 'suggested',
			triggerPatterns: ['write a PRD', 'create product requirements'],
			riskPolicy: 'review_packet',
			approvalRequired: true,
			rollbackRef: 'reports/prd-writing-rollback.json',
			requestId: activationRequestId,
			executionAuthority: governorAuthority({
				toolName: 'spawner.loop_engineering.activation.stage',
				mutationClass: 'writes_files',
				requestId: activationRequestId,
				target: 'PRD Writing requests'
			})
		}) as never));
		expect(activationBody.commandResult).toMatchObject({
			action: 'activation_requested',
			launchedMission: false
		});

		const events = await listPersistedLoopEngineeringEvents(chipId);
		expect(events.map((event) => event.eventType)).toEqual([
			'benchmark_case_added',
			'benchmark_run',
			'loop_batch',
			'evaluator_review',
			'distillation',
			'activation_requested'
		]);
		expect(events.find((event) => event.id === benchmarkBody.event.id)).toMatchObject({
			status: 'passed',
			evaluatorSeparated: false,
			completedAt: expect.any(String),
			commandResult: { action: 'benchmark_run_executed' }
		});
		expect(events.find((event) => event.id === loopBody.event.id)).toMatchObject({
			status: 'passed',
			evaluatorSeparated: true,
			provenance: 'computed',
			completedAt: expect.any(String),
			commandResult: { action: 'run_completion_bound' }
		});
		expect(events.find((event) => event.eventType === 'distillation')?.evidenceRefs).toContain(`control-plane:distillations:${distillBody.distillation.id}`);
		const activations = await listActivationRules(chipId);
		expect(activations).toHaveLength(1);
		expect(activations[0]).toMatchObject({
			useCase: 'PRD Writing requests',
			status: 'staged',
			approvalRequired: true,
			rollbackRef: 'reports/prd-writing-rollback.json'
		});
	});
});
