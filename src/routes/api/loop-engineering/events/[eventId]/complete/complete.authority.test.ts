import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServerGovernorDecisionAuthority, buildServerTurnIntentVNextAuthority } from '$lib/server/harness-authority';
import {
	appendLoopEngineeringEvent,
	executePrivateLoopEngineeringRun,
	launchPrivateLoopEngineeringRun,
	listPersistedLoopEngineeringEvents,
	stageBenchmarkCase
} from '$lib/server/loop-engineering-control-plane';
import { POST } from './+server';

const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
let cleanupDir: string | null = null;

function event(eventId: string, body?: unknown) {
	return {
		params: { eventId },
		request: new Request(`http://127.0.0.1:3333/api/loop-engineering/events/${eventId}/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		url: new URL(`http://127.0.0.1:3333/api/loop-engineering/events/${eventId}/complete`),
		getClientAddress: () => '127.0.0.1'
	};
}

function governorAuthority() {
	return buildServerGovernorDecisionAuthority({
		source: 'loop-engineering-completion-test',
		reason: 'Focused Loop Engineering completion binding regression.',
		toolName: 'spawner.loop_engineering.event.complete',
		mutationClass: 'writes_files',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

function bareVNextAuthority() {
	return buildServerTurnIntentVNextAuthority({
		source: 'loop-engineering-completion-test',
		reason: 'Focused Loop Engineering completion binding regression.',
		toolName: 'spawner.loop_engineering.event.complete',
		mutationClass: 'writes_files',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

async function createEvaluatorBackedLoopEvidence() {
	const staged = await stageBenchmarkCase({
		chipKey: 'domain-chip-prd-writing-proof-loop',
		kind: 'held_out',
		prompt: 'Write a PRD for invite reminders while preserving owner, metrics, risks, rollout, and evidence.',
		expectedBehavior: 'Include owner, affected users, success metric, acceptance criteria, risks, rollout, rollback, and evidence refs.',
		evidenceRefs: ['reports/route-completion-case.md']
	});
	const run = await executePrivateLoopEngineeringRun({
		chipKey: 'domain-chip-prd-writing-proof-loop',
		objective: 'Create real separated evaluator evidence for completion route binding.',
		roundLimit: 2,
		benchmarkCaseIds: [staged.caseRecord.id],
		sourceSurface: 'spawner',
		requestId: 'route-completion-evidence'
	});
	// The private run produces a SYNTHETIC candidate + verdict (provenance:'synthetic', evaluatorSeparated:false).
	// To exercise the completion route's evaluator-backed (separated) binding, upgrade its verdict packet to a
	// genuine separated judge verdict — this fixture stands in for item 1.4's real different-provider judge
	// reviewing the candidate. The route requires packet.evaluatorSeparated===true (readEvaluatorVerdictPacket).
	const stateDir = process.env.SPAWNER_STATE_DIR;
	if (!stateDir) throw new Error('SPAWNER_STATE_DIR missing');
	const [, , runId, fileName] = run.loopRun.evaluatorVerdictRef.split(':');
	const verdictPath = path.join(stateDir, 'loop-engineering', 'loop-runs', runId, fileName);
	const packet = JSON.parse(await readFile(verdictPath, 'utf-8'));
	packet.evaluatorSeparated = true;
	packet.provenance = 'computed';
	packet.evaluatorProvider = 'zai';
	packet.evaluatorModel = 'glm-5.2';
	packet.generatorProvider = 'codex';
	packet.generator_provider = 'codex';
	await writeFile(verdictPath, JSON.stringify(packet, null, 2), 'utf-8');
	return run;
}

describe('/api/loop-engineering/events/[eventId]/complete', () => {
	beforeEach(async () => {
		cleanupDir = await mkdtemp(path.join(os.tmpdir(), 'spawner-loop-complete-route-'));
		process.env.SPAWNER_STATE_DIR = cleanupDir;
	});

	afterEach(async () => {
		if (originalSpawnerStateDir) process.env.SPAWNER_STATE_DIR = originalSpawnerStateDir;
		else delete process.env.SPAWNER_STATE_DIR;
		if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
		cleanupDir = null;
	});

	it('blocks completion binding without native Governor authority', async () => {
		const queued = await launchPrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			runKind: 'loop',
			roundLimit: 2
		});
		const response = await POST(event(queued.event.id, {
			status: 'passed',
			sourceRef: 'mission-control:test'
		}) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
	});

	it('blocks bare VNext completion authority', async () => {
		const queued = await launchPrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			runKind: 'loop',
			roundLimit: 2
		});
		const response = await POST(event(queued.event.id, {
			status: 'passed',
			evaluatorSeparated: true,
			sourceRef: 'mission-control:test',
			evidenceRefs: ['reports/evaluator.json'],
			executionAuthority: bareVNextAuthority()
		}) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
	});

	it('blocks passed completion without separated evaluator evidence at the route boundary', async () => {
		const queued = await launchPrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			runKind: 'loop',
			roundLimit: 2
		});
		const response = await POST(event(queued.event.id, {
			status: 'passed',
			chipKey: 'domain-chip-prd-writing-proof-loop',
			previousScore: 6,
			candidateScore: 8,
			sourceRef: 'mission-control:generator-only',
			executionAuthority: governorAuthority()
		}) as never);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: false,
			error: 'passed completion requires separated evaluator evidence'
		});
		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		const persisted = events.find((item) => item.id === queued.event.id);
		expect(persisted).toMatchObject({ status: 'queued' });
		expect(persisted).not.toHaveProperty('completedAt');
	});

	it('blocks separated evaluator completion without evaluator verdict ref at the route boundary', async () => {
		const queued = await appendLoopEngineeringEvent({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			eventType: 'benchmark_run',
			label: 'Bare benchmark run without evaluator verdict',
			status: 'queued',
			sourceSurface: 'telegram',
			evidenceRefs: [],
			nextAction: 'Bind evaluator verdict before claiming improvement.'
		});
		const response = await POST(event(queued.id, {
			status: 'passed',
			chipKey: 'domain-chip-prd-writing-proof-loop',
			previousScore: 6,
			candidateScore: 8,
			evaluatorSeparated: true,
			sourceRef: 'mission-control:evaluator-summary-without-refs',
			executionAuthority: governorAuthority()
		}) as never);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: false,
			error: 'separated evaluator completion requires evaluatorVerdictRef'
		});
		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		const persisted = events.find((item) => item.id === queued.id);
		expect(persisted).toMatchObject({ status: 'queued' });
		expect(persisted).not.toHaveProperty('completedAt');
	});

	it('blocks positive improvement claims without evaluator evidence refs at the route boundary', async () => {
		const proof = await createEvaluatorBackedLoopEvidence();
		const response = await POST(event(proof.event.id, {
			status: 'passed',
			chipKey: 'domain-chip-prd-writing-proof-loop',
			previousScore: proof.event.previousScore,
			candidateScore: proof.event.candidateScore,
			evaluatorSeparated: true,
			provenance: 'computed',
			sourceRef: proof.loopRun.sourceRef,
			evaluatorVerdictRef: proof.loopRun.evaluatorVerdictRef,
			executionAuthority: governorAuthority()
		}) as never);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: false,
			error: 'positive improvement claims require separated evaluator evidence refs'
		});
		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		const persisted = events.find((item) => item.id === proof.event.id);
		expect(persisted).toMatchObject({ status: proof.event.status });
		expect(persisted?.completedAt).toBe(proof.event.completedAt);
	});

	it('binds evaluator-backed completion when Governor authority is present', async () => {
		const proof = await createEvaluatorBackedLoopEvidence();
		const response = await POST(event(proof.event.id, {
			status: 'passed',
			chipKey: 'domain-chip-prd-writing-proof-loop',
			previousScore: proof.event.previousScore,
			candidateScore: proof.event.candidateScore,
			roundsObserved: 2,
			evaluatorSeparated: true,
			provenance: 'computed',
			sourceRef: proof.loopRun.sourceRef,
			evaluatorVerdictRef: proof.loopRun.evaluatorVerdictRef,
			evidenceRefs: [
				proof.loopRun.loopPlanRef,
				proof.loopRun.generatorOutputRef,
				proof.loopRun.sourceKeyRef,
				proof.loopRun.evaluatorVerdictRef,
				proof.loopRun.sourceRef
			],
			executionAuthority: governorAuthority()
		}) as never);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.commandResult).toMatchObject({
			action: 'run_completion_bound',
			changed: true,
			launchedMission: false,
			eventId: proof.event.id
		});
		expect(body.event).toMatchObject({
			status: 'passed',
			completedAt: expect.any(String),
			evaluatorSeparated: true,
			provenance: 'computed',
			evaluatorVerdictRef: proof.loopRun.evaluatorVerdictRef
		});
		const events = await listPersistedLoopEngineeringEvents('domain-chip-prd-writing-proof-loop');
		expect(events.find((item) => item.id === proof.event.id)).toMatchObject({
			status: 'passed',
			commandResult: { action: 'run_completion_bound' }
		});
	});
});
