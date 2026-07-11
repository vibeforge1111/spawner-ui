import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServerGovernorDecisionAuthority, buildServerTurnIntentVNextAuthority } from '$lib/server/harness-authority';
import {
	completeLoopEngineeringRunEvent,
	executePrivateBenchmarkRun,
	listPersistedLoopEngineeringEvents,
	stageBenchmarkCase
} from '$lib/server/loop-engineering-control-plane';
import { POST } from './+server';

const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
let cleanupDir: string | null = null;

function event(body?: unknown) {
	return {
		params: { chipId: 'domain-chip-prd-writing-proof-loop' },
		request: new Request('http://127.0.0.1:3333/api/loop-engineering/chips/domain-chip-prd-writing-proof-loop/evaluator-review', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		url: new URL('http://127.0.0.1:3333/api/loop-engineering/chips/domain-chip-prd-writing-proof-loop/evaluator-review'),
		getClientAddress: () => '127.0.0.1'
	};
}

function governorAuthority() {
	return buildServerGovernorDecisionAuthority({
		source: 'loop-engineering-evaluator-review-test',
		reason: 'Focused Loop Engineering evaluator review regression.',
		toolName: 'spawner.loop_engineering.evaluator_review.record',
		mutationClass: 'writes_files',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

function bareVNextAuthority() {
	return buildServerTurnIntentVNextAuthority({
		source: 'loop-engineering-evaluator-review-test',
		reason: 'Focused Loop Engineering evaluator review regression.',
		toolName: 'spawner.loop_engineering.evaluator_review.record',
		mutationClass: 'writes_files',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

describe('/api/loop-engineering/chips/[chipId]/evaluator-review', () => {
	beforeEach(async () => {
		cleanupDir = await mkdtemp(path.join(os.tmpdir(), 'spawner-loop-evaluator-route-'));
		process.env.SPAWNER_STATE_DIR = cleanupDir;
	});

	async function seedSourceRun() {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD for a billing reminder workflow.',
			expectedBehavior: 'Include decision owner, users, success metric, acceptance criteria, risks, and evidence refs.'
		});
		const source = await executePrivateBenchmarkRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			benchmarkCaseIds: [staged.caseRecord.id],
			requestId: 'seed-evaluator-source'
		});
		if (!cleanupDir) throw new Error('cleanupDir missing');
		const [, , runId, fileName] = source.benchmarkRun.evaluatorVerdictRef.split(':');
		const verdictPath = path.join(cleanupDir, 'loop-engineering', 'benchmark-runs', runId, fileName);
		const packet = JSON.parse(await readFile(verdictPath, 'utf-8'));
		await writeFile(verdictPath, JSON.stringify({
			...packet,
			evaluatorSeparated: true,
			provenance: 'computed',
			evaluatorProvider: 'zai',
			evaluatorModel: 'glm-5.2',
			generatorProvider: 'codex',
			generator_provider: 'codex'
		}, null, 2), 'utf-8');
		const completed = await completeLoopEngineeringRunEvent({
			eventId: source.event.id,
			status: 'passed',
			previousScore: source.event.previousScore,
			candidateScore: source.event.candidateScore,
			evaluatorSeparated: true,
			provenance: 'computed',
			sourceRef: source.benchmarkRun.sourceRef,
			evaluatorVerdictRef: source.benchmarkRun.evaluatorVerdictRef,
			evidenceRefs: [
				source.benchmarkRun.generatorOutputRef,
				source.benchmarkRun.sourceKeyRef,
				source.benchmarkRun.evaluatorVerdictRef,
				source.benchmarkRun.sourceRef
			]
		});
		return { ...source, event: completed.event };
	}

	afterEach(async () => {
		if (originalSpawnerStateDir) process.env.SPAWNER_STATE_DIR = originalSpawnerStateDir;
		else delete process.env.SPAWNER_STATE_DIR;
		if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
		cleanupDir = null;
	});

	it('blocks evaluator review recording without native Governor authority', async () => {
		const response = await POST(event({ previousScore: 6, candidateScore: 8, evaluatorSeparated: true, evidenceRefs: ['reports/eval.json'] }) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
	});

	it('blocks bare VNext evaluator review authority', async () => {
		const response = await POST(event({
			previousScore: 6,
			candidateScore: 8,
			evaluatorSeparated: true,
			evidenceRefs: ['reports/eval.json'],
			executionAuthority: bareVNextAuthority()
		}) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
	});

	it('records only separated evaluator evidence with Governor authority', async () => {
		const source = await seedSourceRun();
		const response = await POST(event({
			sourceRunEventId: source.event.id,
			previousScore: source.event.previousScore,
			candidateScore: source.event.candidateScore,
			roundsObserved: source.event.roundsObserved,
			evaluatorSeparated: true,
			evidenceRefs: ['reports/prd-eval.json'],
			sourceSurface: 'telegram',
			executionAuthority: governorAuthority()
		}) as never);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.event).toMatchObject({
			eventType: 'evaluator_review',
			status: 'passed',
			sourceSurface: 'telegram',
			evaluatorSeparated: true,
			utilityDelta: source.event.utilityDelta
		});
		expect(body.commandResult).toMatchObject({
			action: 'evaluator_review_recorded',
			changed: true,
			launchedMission: false,
			eventId: body.event.id
		});
		expect(body.commandResult.userMessage).toContain('can support distillation review');
		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events.some((item) => item.eventType === 'evaluator_review')).toBe(true);
	});
});
