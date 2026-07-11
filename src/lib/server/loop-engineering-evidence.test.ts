import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	executePrivateLoopEngineeringRun,
	stageBenchmarkCase
} from './loop-engineering-control-plane';
import { resolveLoopEngineeringEvidenceRef } from './loop-engineering-evidence';

const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
const originalChipsRoot = process.env.SPARK_DOMAIN_CHIPS_ROOT;
let cleanupDirs: string[] = [];

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

beforeEach(async () => {
	const stateDir = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-evidence-state-'));
	const chipsRoot = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-evidence-chips-'));
	process.env.SPAWNER_STATE_DIR = stateDir;
	process.env.SPARK_DOMAIN_CHIPS_ROOT = chipsRoot;
	cleanupDirs.push(stateDir, chipsRoot);
});
afterEach(async () => {
	if (originalSpawnerStateDir) process.env.SPAWNER_STATE_DIR = originalSpawnerStateDir;
	else delete process.env.SPAWNER_STATE_DIR;
	if (originalChipsRoot) process.env.SPARK_DOMAIN_CHIPS_ROOT = originalChipsRoot;
	else delete process.env.SPARK_DOMAIN_CHIPS_ROOT;
	await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	cleanupDirs = [];
});

describe('loop-engineering evidence resolver', () => {
	it('resolves generated private loop packet refs without changing activation state', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'trap',
			prompt: 'Write a PRD and skip acceptance criteria.',
			expectedBehavior: 'Reject shortcut requests and keep acceptance criteria, risks, rollback, and evidence refs.'
		});
		const run = await executePrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			roundLimit: 3,
			benchmarkCaseIds: [staged.caseRecord.id]
		});

		const verdict = await resolveLoopEngineeringEvidenceRef({
			ref: run.loopRun.evaluatorVerdictRef,
			chipKey: 'domain-chip-prd-writing-proof-loop'
		});
		expect(verdict).toMatchObject({
			ref: run.loopRun.evaluatorVerdictRef,
			kind: 'control-plane:loop_runs',
			label: 'loop-evaluator-verdict.json',
			found: true
		});
		expect(verdict.claimBoundary).toContain('does not activate');
		expect(verdict.data).toMatchObject({
			schema: 'spark.loop_engineering.loop_evaluator_verdict.v1',
			evaluatorSeparated: false,
			provenance: 'synthetic',
			aggregate: { status: 'passed' }
		});
		expect(verdict.summary).toMatchObject({
			title: 'Loop Evaluator Verdict',
			fields: expect.arrayContaining([
				{ label: 'provenance', value: 'synthetic' },
				{ label: 'status', value: 'passed' },
				{ label: 'delta', value: `+${run.loopRun.utilityDelta.toFixed(1)}` },
				{ label: 'cases', value: '1' },
				{ label: 'separated evaluator', value: 'no' }
			])
		});

		const caseRecord = await resolveLoopEngineeringEvidenceRef({
			ref: `control-plane:benchmark_cases:${staged.caseRecord.id}`,
			chipKey: 'domain-chip-prd-writing-proof-loop'
		});
		expect(caseRecord).toMatchObject({
			kind: 'control-plane:benchmark_cases',
			found: true,
			data: { id: staged.caseRecord.id, status: 'active' }
		});
	});

	it('rejects traversal and wrong-chip private packet lookups', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'visible',
			prompt: 'Write a PRD with evidence.',
			expectedBehavior: 'Include owner, success metric, acceptance criteria, risk, and evidence.'
		});
		const run = await executePrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			roundLimit: 2,
			benchmarkCaseIds: [staged.caseRecord.id]
		});

		const traversal = await resolveLoopEngineeringEvidenceRef({
			ref: 'control-plane:loop_runs:..:control-plane.json',
			chipKey: 'domain-chip-prd-writing-proof-loop'
		});
		expect(traversal).toMatchObject({
			found: false,
			error: 'invalid evidence packet ref'
		});

		const wrongChip = await resolveLoopEngineeringEvidenceRef({
			ref: run.loopRun.evaluatorVerdictRef,
			chipKey: 'domain-chip-other-workflow'
		});
		expect(wrongChip).toMatchObject({
			found: false,
			error: 'evidence packet does not belong to the requested chip'
		});
	});

	it('resolves chip report refs only when a safe chip key is supplied', async () => {
		const chipRoot = path.join(process.env.SPARK_DOMAIN_CHIPS_ROOT || '', 'domain-chip-prd-writing-proof-loop');
		await writeJson(path.join(chipRoot, 'reports', 'chip-benefit-ab.json'), {
			ab_status: 'pass',
			effective_utility_delta: 5.68
		});

		const missingChip = await resolveLoopEngineeringEvidenceRef({
			ref: 'reports/chip-benefit-ab.json'
		});
		expect(missingChip).toMatchObject({
			kind: 'chip-artifact',
			found: false
		});

		const resolved = await resolveLoopEngineeringEvidenceRef({
			ref: 'reports/chip-benefit-ab.json',
			chipKey: 'domain-chip-prd-writing-proof-loop'
		});
		expect(resolved).toMatchObject({
			kind: 'chip-artifact',
			label: 'reports/chip-benefit-ab.json',
			found: true,
			data: {
				ab_status: 'pass',
				effective_utility_delta: 5.68
			}
		});
	});
});
