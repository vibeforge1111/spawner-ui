import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLoopEngineeringChipDetail, listLoopEngineeringChips } from './loop-engineering-registry';

const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
let cleanupDirs: string[] = [];

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

beforeEach(async () => {
	const stateDir = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-registry-state-'));
	process.env.SPAWNER_STATE_DIR = stateDir;
	cleanupDirs.push(stateDir);
});
afterEach(async () => {
	if (originalSpawnerStateDir) process.env.SPAWNER_STATE_DIR = originalSpawnerStateDir;
	else delete process.env.SPAWNER_STATE_DIR;
	await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	cleanupDirs = [];
});

describe('loop-engineering-registry', () => {
	it('summarizes benchmark, loop, gate, runtime, and blocker evidence for domain chips', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-registry-'));
		const chip = path.join(root, 'domain-chip-prd-writing-proof-loop');
		await writeJson(path.join(chip, 'spark-chip.json'), {
			chip_name: 'domain-chip-prd-writing-proof-loop',
			commands: {
				'loop-round': ['python3', 'chip-runner.py', 'loop-round'],
				'long-loop-trend': ['python3', 'chip-runner.py', 'long-loop-trend']
			}
		});
		await writeJson(path.join(chip, 'reports', 'chip-benefit-ab.json'), {
			ab_status: 'pass',
			domain: 'PRD Writing Proof Loop',
			primary_metric: 'prd_quality_score',
			no_chip_score: 72,
			chip_assisted_score: 88,
			effective_utility_delta: 16,
			blind_evaluation_verified: true,
			meaningful_utility_delta: true,
			promotion_blocked: true
		});
		await writeJson(path.join(chip, 'reports', 'long-loop-trend.json'), {
			trend_status: 'pass',
			long_loop_supported: true,
			rounds_observed: 5,
			required_rounds: 5,
			score_deltas: [8, 11, 13, 15, 16]
		});
		await writeJson(path.join(chip, 'reports', 'loop-gate-check.json'), {
			private_candidate_supported: true,
			sealed_evaluation_supported: true,
			watchtower_executed: true,
			rollback_executed: true,
			consumer_transfer_passed: true,
			proof_auditor_passed: true,
			ux_readability_score: 10,
			promotion_blocked: true,
			hard_blockers: ['operator_publication_approval_missing']
		});
		await writeJson(path.join(chip, 'reports', 'watchtower-check.json'), { watchtower_status: 'passed', watchtower_executed: true });
		await writeJson(path.join(chip, 'reports', 'rollback-check.json'), { rollback_status: 'passed', rollback_executed: true });
		await writeJson(path.join(chip, 'reports', 'consumer-transfer-trial-binding.json'), { consumer_transfer_passed: true });
		await writeJson(path.join(chip, 'reports', 'proof-auditor-check.json'), { proof_auditor_passed: true });
		await writeJson(path.join(chip, 'reports', 'r30-controlled-loop', 'sealed-evaluator-report-v2.json'), { evaluation_status: 'pass' });
		await writeJson(path.join(chip, 'reports', 'r30-controlled-loop', 'final-allowed-disallowed-claims-matrix.json'), {
			allowed_claims: [{ claim: 'private pass' }],
			disallowed_claims: [{ claim: 'published' }, { claim: 'live proven' }]
		});
		await writeJson(path.join(chip, 'distilled-runtime', 'prd-writing-fast-path.json'), {
			runtime_state: 'private_candidate_supported_local_telegram_handler_passed_live_telegram_unproven',
			telegram_first: true,
			reloop_triggers: ['benchmark delta regresses'],
			runtime_modes: {
				quick_answer: { allowed_now: false },
				review_packet: { allowed_now: false },
				loop_mode: { allowed_now: true }
			},
			runtime_path: 'distilled-runtime/prd-writing-fast-path.json'
		});

		const registry = await listLoopEngineeringChips({ chipsRoot: root });
		expect(registry.summary.total).toBe(1);
		expect(registry.summary.resultEvents).toBe(7);
		expect(registry.summary.localFastPaths).toBe(1);
		expect(registry.summary.benchmarkPasses).toBe(1);
		expect(registry.summary.longLoopPasses).toBe(1);
		expect(registry.summary.liveTelegramProven).toBe(0);
		expect(registry.summary.blocked).toBe(1);

		const summary = registry.chips[0];
		expect(summary.manifestIdentity).toEqual({
			declaredChipKey: null,
			effectiveChipKey: 'domain-chip-prd-writing-proof-loop',
			inferredFromFolder: true
		});
		expect(summary.domain).toBe('PRD Writing Proof Loop');
		expect(summary.status).toBe('local_fast_path');
		expect(summary.benchmark.utilityDelta).toBe(16);
		expect(summary.loop.roundsObserved).toBe(5);
		expect(summary.gates.watchtower).toBe(true);
		expect(summary.gates.rollback).toBe(true);
		expect(summary.activation.loopModeAllowed).toBe(true);
		expect(summary.activation.liveTelegramProven).toBe(false);
		expect(summary.scheduling.supportedModes).toEqual(['round_count', 'score_plateau', 'telegram_triggered', 'triggered_reloop']);
		expect(summary.nextAction).toContain('operator_publication_approval_missing');
		expect(registry.events.map((event) => event.eventType)).toEqual([
			'activation_gate',
			'benchmark_run',
			'loop_batch',
			'evaluator_review',
			'watchtower_check',
			'rollback_check',
			'schedule_contract'
		]);
		const benchmarkEvent = registry.events.find((event) => event.eventType === 'benchmark_run');
		expect(benchmarkEvent?.status).toBe('passed');
		expect(benchmarkEvent?.previousScore).toBe(72);
		expect(benchmarkEvent?.candidateScore).toBe(88);
		expect(benchmarkEvent?.utilityDelta).toBe(16);
		expect(benchmarkEvent?.evaluatorSeparated).toBe(true);
		const activationEvent = registry.events.find((event) => event.eventType === 'activation_gate');
		expect(activationEvent?.status).toBe('blocked');
		expect(activationEvent?.nextAction).toContain('operator_publication_approval_missing');

		const detail = await getLoopEngineeringChipDetail('domain-chip-prd-writing-proof-loop', { chipsRoot: root });
		expect(detail?.readiness.status).toBe('telegram_activation_blocked');
		expect(detail?.events).toHaveLength(7);
		expect(detail?.readiness.passCount).toBe(10);
		expect(detail?.readiness.blockedCount).toBe(2);
		expect(detail?.readiness.checks.find((check) => check.id === 'manifest_identity')?.status).toBe('attention');
		expect(detail?.readiness.checks.find((check) => check.id === 'live_telegram_proof')?.status).toBe('blocked');
		expect(detail?.claims.allowed[0]?.claim).toBe('private pass');
		expect(detail?.claims.disallowed).toHaveLength(2);
		expect(detail?.runtime.distilledLessons).toEqual([]);
		expect(detail?.evidenceArtifacts.find((artifact) => artifact.ref === 'reports/chip-benefit-ab.json')?.present).toBe(true);
	});

	it('uses declared manifest chip keys when legacy inference is not needed', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-registry-keyed-'));
		const chip = path.join(root, 'domain-chip-customer-escalation-readiness-review');
		await writeJson(path.join(chip, 'spark-chip.json'), {
			chip_key: 'domain-chip-customer-escalation-readiness-review',
			chip_name: 'Customer Escalation Readiness Review'
		});

		const detail = await getLoopEngineeringChipDetail('domain-chip-customer-escalation-readiness-review', { chipsRoot: root });

		expect(detail?.summary.manifestIdentity).toEqual({
			declaredChipKey: 'domain-chip-customer-escalation-readiness-review',
			effectiveChipKey: 'domain-chip-customer-escalation-readiness-review',
			inferredFromFolder: false
		});
		expect(detail?.readiness.checks.find((check) => check.id === 'manifest_identity')?.status).toBe('passed');
	});

	it('returns an empty registry when the chip root is missing', async () => {
		const registry = await listLoopEngineeringChips({ chipsRoot: path.join(os.tmpdir(), 'missing-spark-chip-root') });
		expect(registry.summary.total).toBe(0);
		expect(registry.chips).toEqual([]);
	});

	it('imports benchmark-pack cases from an explicit chip root in detail views', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-explicit-root-'));
		const chip = path.join(root, 'domain-chip-daily-schedule-reliability-r30-persisted-context-qa');
		await writeJson(path.join(chip, 'spark-chip.json'), {
			chip_name: 'domain-chip-daily-schedule-reliability-r30-persisted-context-qa',
			domain: 'Daily Schedule Reliability'
		});
		await mkdir(path.join(chip, 'benchmark'), { recursive: true });
		await writeFile(path.join(chip, 'benchmark', 'cases.jsonl'), JSON.stringify({
			case_id: 'daily-schedule-explicit-root-001',
			lane: 'held_out',
			prompt: 'Resolve tomorrow morning across Dubai and New York calendars.',
			expected_behavior: 'Name the timezone ambiguity and ask for approval before changing reminders.'
		}), 'utf-8');

		const detail = await getLoopEngineeringChipDetail('domain-chip-daily-schedule-reliability-r30-persisted-context-qa', { chipsRoot: root });
		expect(detail?.benchmarkCases).toEqual([
			expect.objectContaining({
				id: 'artifact-case-daily-schedule-explicit-root-001',
				kind: 'held_out',
				createdBy: 'import',
				evidenceRefs: ['benchmark/cases.jsonl#daily-schedule-explicit-root-001']
			})
		]);
	});

	it('treats supported positive chip-benefit reports as meaningful even without the legacy meaningful flag', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-benefit-supported-'));
		const chip = path.join(root, 'domain-chip-project-maintenance-steward-r30-usefulness-loop');
		await writeJson(path.join(chip, 'spark-chip.json'), {
			chip_name: 'domain-chip-project-maintenance-steward-r30-usefulness-loop'
		});
		await writeJson(path.join(chip, 'reports', 'chip-benefit-ab.json'), {
			ab_status: 'pass',
			domain: 'Project Maintenance Steward',
			no_chip_score: 65.7,
			chip_assisted_score: 86.4,
			effective_utility_delta: 20.7,
			blind_evaluation_verified: true,
			chip_benefit_supported: true,
			promotion_blocked: true
		});
		await writeJson(path.join(chip, 'reports', 'long-loop-trend.json'), {
			trend_status: 'pass',
			long_loop_supported: true,
			rounds_observed: 5,
			required_rounds: 5,
			score_deltas: [10, 12, 14, 18, 20]
		});
		await writeJson(path.join(chip, 'reports', 'loop-gate-check.json'), {
			private_candidate_supported: true,
			promotion_blocked: true,
			hard_blockers: ['operator_publication_approval_missing']
		});

		const detail = await getLoopEngineeringChipDetail('domain-chip-project-maintenance-steward-r30-usefulness-loop', { chipsRoot: root });
		const benchmarkEvent = detail?.events.find((event) => event.eventType === 'benchmark_run');
		expect(detail?.summary.benchmark.meaningfulDelta).toBe(true);
		expect(detail?.readiness.checks.find((check) => check.id === 'benchmark_ab')?.status).toBe('passed');
		expect(benchmarkEvent?.status).toBe('passed');
	});

	it('orders fresh persisted Spawner results before older artifact gates', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-fresh-events-'));
		const chip = path.join(root, 'domain-chip-project-maintenance-steward-r30-usefulness-loop');
		await writeJson(path.join(chip, 'spark-chip.json'), {
			chip_name: 'domain-chip-project-maintenance-steward-r30-usefulness-loop'
		});
		await writeJson(path.join(chip, 'reports', 'chip-benefit-ab.json'), {
			ab_status: 'pass',
			domain: 'Project Maintenance Steward',
			no_chip_score: 65,
			chip_assisted_score: 86,
			effective_utility_delta: 21,
			blind_evaluation_verified: true,
			chip_benefit_supported: true
		});
		await writeJson(path.join(chip, 'reports', 'loop-gate-check.json'), {
			private_candidate_supported: true,
			promotion_blocked: true,
			hard_blockers: ['operator_publication_approval_missing']
		});
		// Artifact events are timestamped from real file mtimes; pin them older than the
		// persisted event's fixed completedAt so the ordering never depends on the wall clock.
		const artifactMtime = new Date('2026-07-01T00:00:00.000Z');
		for (const artifact of ['spark-chip.json', 'reports/chip-benefit-ab.json', 'reports/loop-gate-check.json']) {
			await utimes(path.join(chip, artifact), artifactMtime, artifactMtime);
		}
		await writeJson(path.join(process.env.SPAWNER_STATE_DIR!, 'loop-engineering', 'control-plane.json'), {
			schema_version: 'spark.loop_engineering_control_plane.v1',
			updated_at: '2026-07-02T14:28:37.057Z',
			events: [
				{
					id: 'lee-1782916117015-706534',
					chipId: 'domain-chip-project-maintenance-steward-r30-usefulness-loop',
					chipName: 'Project Maintenance Steward',
					domain: 'Project Maintenance Steward',
					eventType: 'benchmark_run',
					label: 'Private benchmark run queued',
					status: 'passed',
					sourceSurface: 'spawner',
					previousScore: 3.89,
					candidateScore: 9.77,
					utilityDelta: 5.88,
					roundsObserved: null,
					evaluatorSeparated: true,
					evidenceRefs: ['control-plane:benchmark_runs:benchrun-lee-1782916117015-706534:summary.json'],
					completedAt: '2026-07-02T14:28:37.054Z',
					nextAction: 'Review the packet before distillation.',
					updatedAt: '2026-07-02T14:28:37.057Z'
				}
			],
			benchmark_cases: [],
			schedules: [],
			activation_rules: [],
			distillations: []
		});

		const detail = await getLoopEngineeringChipDetail('domain-chip-project-maintenance-steward-r30-usefulness-loop', { chipsRoot: root });
		expect(detail?.events[0]).toEqual(expect.objectContaining({
			id: 'lee-1782916117015-706534',
			sourceSurface: 'spawner',
			eventType: 'benchmark_run'
		}));
		expect(detail?.events.findIndex((event) => event.eventType === 'activation_gate')).toBeGreaterThan(0);
	});

	it('uses fresh computed persisted events to advance readiness when artifact reports are stale or absent', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-computed-overlay-'));
		const chip = path.join(root, 'domain-chip-executive-operating-review-synthesis');
		await writeJson(path.join(chip, 'spark-chip.json'), {
			chip_key: 'domain-chip-executive-operating-review-synthesis',
			chip_name: 'Executive Operating Review Synthesis',
			commands: {
				'loop-round': ['python3', 'chip-runner.py', 'loop-round'],
				'long-loop-trend': ['python3', 'chip-runner.py', 'long-loop-trend']
			}
		});
		const artifactMtime = new Date('2026-07-01T00:00:00.000Z');
		await utimes(path.join(chip, 'spark-chip.json'), artifactMtime, artifactMtime);
		await writeJson(path.join(process.env.SPAWNER_STATE_DIR!, 'loop-engineering', 'control-plane.json'), {
			schema_version: 'spark.loop_engineering_control_plane.v1',
			updated_at: '2026-07-03T10:20:00.000Z',
			events: [
				{
					id: 'lee-computed-benchmark',
					chipId: 'domain-chip-executive-operating-review-synthesis',
					chipName: 'Executive Operating Review Synthesis',
					domain: 'Executive Operating Review Synthesis',
					eventType: 'benchmark_run',
					label: 'Private benchmark run executed',
					status: 'passed',
					sourceSurface: 'spawner',
					previousScore: 4.2,
					candidateScore: 8.9,
					utilityDelta: 4.7,
					roundsObserved: null,
					evaluatorSeparated: true,
					provenance: 'computed',
					evidenceRefs: ['control-plane:benchmark_runs:lee-computed-benchmark:summary.json'],
					completedAt: '2026-07-03T10:10:00.000Z',
					updatedAt: '2026-07-03T10:10:00.000Z'
				},
				{
					id: 'lee-computed-loop',
					chipId: 'domain-chip-executive-operating-review-synthesis',
					chipName: 'Executive Operating Review Synthesis',
					domain: 'Executive Operating Review Synthesis',
					eventType: 'loop_batch',
					label: 'Self-improvement loop passed',
					status: 'passed',
					sourceSurface: 'spawner',
					previousScore: 4.2,
					candidateScore: 9.3,
					utilityDelta: 5.1,
					roundsObserved: 5,
					evaluatorSeparated: true,
					provenance: 'computed',
					evidenceRefs: ['control-plane:loop_runs:lee-computed-loop:summary.json'],
					completedAt: '2026-07-03T10:20:00.000Z',
					updatedAt: '2026-07-03T10:20:00.000Z'
				}
			],
			benchmark_cases: [],
			schedules: [],
			activation_rules: [],
			distillations: []
		});

		const detail = await getLoopEngineeringChipDetail('domain-chip-executive-operating-review-synthesis', { chipsRoot: root });

		expect(detail?.summary.status).toBe('loop_proven_private');
		expect(detail?.summary.benchmark).toMatchObject({
			status: 'pass',
			noChipScore: 4.2,
			chipScore: 8.9,
			utilityDelta: 4.7,
			blindVerified: true,
			meaningfulDelta: true
		});
		expect(detail?.summary.loop).toMatchObject({
			status: 'passed',
			roundsObserved: 5,
			requiredRounds: 5,
			longLoopSupported: true
		});
		expect(detail?.summary.gates.sealedEvaluator).toBe(true);
		expect(detail?.summary.nextAction).not.toMatch(/same-budget blind A\/B|persisted self-improvement/i);
		expect(detail?.readiness.checks.find((check) => check.id === 'benchmark_ab')?.status).toBe('passed');
		expect(detail?.readiness.checks.find((check) => check.id === 'five_round_loop')?.status).toBe('passed');
		expect(detail?.readiness.checks.find((check) => check.id === 'sealed_evaluator')?.status).toBe('passed');
		expect(detail?.events[0]).toEqual(expect.objectContaining({
			id: 'lee-computed-loop',
			provenance: 'computed',
			evaluatorSeparated: true
		}));
	});

	it('rejects unsafe chip detail ids', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-registry-'));
		await expect(getLoopEngineeringChipDetail('../domain-chip-x', { chipsRoot: root })).resolves.toBeNull();
		await expect(getLoopEngineeringChipDetail('not-a-domain-chip', { chipsRoot: root })).resolves.toBeNull();
	});
});
