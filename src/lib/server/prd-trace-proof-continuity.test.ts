import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	appendPrdTraceWithContinuity,
	buildPrdTraceGovernorProofCapsule,
	prdTraceProofContinuityFields,
	repairPrdTraceProofContinuity
} from './prd-trace-proof-continuity';

let testDir = '';
const harnessProofCapsule = {
	schema: 'spark.harness_proof.v1',
	turnRef: 'turn:sha256:0123456789abcdef',
	route: 'spawner.build',
	owner: 'spawner-ui',
	intent: { kind: 'spawner.build', confidence: 'high', noExecution: false },
	authority: {
		decision: 'allowed',
		contract: 'spark.turn_intent.v1',
		riskTier: 'execute',
		reasonSummary: 'Telegram build dispatch was authorized by fresh Harness authority.'
	},
	governor: { decision: 'allow', verified: true },
	execution: { status: 'started', tool: 'spawner.run', mutationClass: 'launches_mission' },
	reply: { delivered: true, shape: 'natural', rawReasonsHidden: true },
	joins: {
		telegram: 'joined',
		builder: 'not_applicable',
		spawner: 'joined',
		provider: 'not_applicable',
		memory: 'not_applicable',
		voice: 'not_applicable'
	}
};

describe('PRD trace proof continuity', () => {
	beforeEach(async () => {
		testDir = await mkdtemp(path.join(tmpdir(), 'spawner-prd-trace-proof-'));
	});

	afterEach(async () => {
		if (testDir && existsSync(testDir)) {
			await rm(testDir, { recursive: true, force: true });
		}
	});

	it('preserves real Harness proof refs without adding a gap capsule', () => {
		const fields = prdTraceProofContinuityFields({
			requestId: 'tg-build-proof-real',
			event: 'request_written',
			harnessProofRef: 'turn:sha256:0123456789abcdef'
		});

		expect(fields).toEqual({ harnessProofRef: 'turn:sha256:0123456789abcdef' });
	});

	it('projects a verified Governor decision into a redacted source-bound capsule', () => {
		const capsule = buildPrdTraceGovernorProofCapsule({
			requestId: 'tg-build-proof-governed',
			traceId: 'trace:/Users/example/private/governor-turn',
			route: 'spawner.prd_bridge.write',
			tool: 'spawner.prd_bridge.write',
			mutationClass: 'writes_files',
			reasonSummary: 'Fresh Governor authority verified for /Users/example/private/project.'
		});

		expect(capsule).toMatchObject({
			schema: 'spark.harness_proof.v1',
			route: 'spawner.prd_bridge.write',
			authority: { decision: 'allowed', contract: 'governor-decision-v1', riskTier: 'write' },
			governor: { decision: 'allow', verified: true },
			execution: { status: 'started', tool: 'spawner.prd_bridge.write', mutationClass: 'writes_files' },
			joins: { telegram: 'joined', spawner: 'joined' }
		});
		expect(capsule.turnRef).toMatch(/^turn:sha256:[a-f0-9]{16}$/);
		expect(JSON.stringify(capsule)).not.toContain('/Users/example/private');
	});

	it('joins callback rows to request-scoped proof while redacting private details', async () => {
		const requestId = 'tg-build-proof-callback';
		const pendingDir = path.join(testDir, 'pending-requests');
		await mkdir(pendingDir, { recursive: true });
		await writeFile(path.join(pendingDir, `${requestId}.json`), JSON.stringify({
			requestId,
			harnessProofRef: harnessProofCapsule.turnRef,
			proofCapsule: harnessProofCapsule
		}), 'utf-8');

		await appendPrdTraceWithContinuity({
			stateDir: testDir,
			requestId,
			event: 'canonical_result_stored',
			details: {
				resultFile: '/home/example/private/result.json',
				authorization: 'Bearer private-callback-token'
			}
		});

		const row = JSON.parse((await readFile(path.join(testDir, 'prd-auto-trace.jsonl'), 'utf-8')).trim());
		expect(row).toMatchObject({
			requestId,
			event: 'canonical_result_stored',
			harnessProofRef: harnessProofCapsule.turnRef,
			proofCapsule: { turnRef: harnessProofCapsule.turnRef },
			resultFile: expect.stringMatching(/^path:sha256:[a-f0-9]{16}$/),
			authorization: '[redacted]',
			privacy: 'metadata_only'
		});
	});

	it('preserves matching redacted Harness proof capsules as real proof', () => {
		const fields = prdTraceProofContinuityFields({
			requestId: 'tg-build-proof-real',
			event: 'request_written',
			harnessProofRef: 'turn:sha256:0123456789abcdef',
			proofCapsule: {
				...harnessProofCapsule,
				authority: {
					...harnessProofCapsule.authority,
					reasonSummary: 'Authorized from /Users/example/private before redaction.'
				}
			}
		});

		expect(fields.harnessProofRef).toBe('turn:sha256:0123456789abcdef');
		expect((fields.proofCapsule as Record<string, any>).schema).toBe('spark.harness_proof.v1');
		expect((fields.proofCapsule as Record<string, any>).turnRef).toBe('turn:sha256:0123456789abcdef');
		expect(JSON.stringify(fields)).not.toContain('/Users/example/private');
		expect(fields).not.toHaveProperty('proofStatus');
		expect(fields).not.toHaveProperty('proofStorage');
	});

	it('does not store mismatched capsules for a different proof ref', () => {
		const fields = prdTraceProofContinuityFields({
			requestId: 'tg-build-proof-real',
			event: 'request_written',
			harnessProofRef: 'turn:sha256:fedcba9876543210',
			proofCapsule: harnessProofCapsule
		});

		expect(fields).toEqual({ harnessProofRef: 'turn:sha256:fedcba9876543210' });
	});

	it('builds source gap capsules for new PRD trace rows without leaking raw refs', () => {
		const fields = prdTraceProofContinuityFields({
			requestId: 'tg-build-proof-gap',
			event: 'auto_worker_dispatch',
			details: {
				traceRef: 'trace:spawner-prd:mission-proof-gap',
				provider: 'codex',
				workingDirectory: '/Users/example/private/project'
			}
		});
		const capsule = fields.proofCapsule as Record<string, any>;

		expect(fields.harnessProofRef).toMatch(/^turn:sha256:[a-f0-9]{16}$/);
		expect(fields.proofStatus).toBe('missing_harness_authority');
		expect(fields.proofStorage).toBe('source_gap_capsule');
		expect(capsule.schema).toBe('spark.harness_proof.v1');
		expect(capsule.authority).toMatchObject({
			decision: 'downgraded',
			contract: 'none',
			riskTier: 'execute'
		});
		expect(capsule.governor.verified).toBe(false);
		expect(capsule.execution).toMatchObject({
			status: 'started',
			tool: 'spawner.prd_auto_analysis',
			mutationClass: 'writes_files'
		});
		expect(capsule.joins).toMatchObject({
			telegram: 'missing',
			spawner: 'joined',
			provider: 'missing'
		});
		expect(JSON.stringify(fields)).not.toMatch(/\/Users\/example|private\/project/);
	});

	it('repairs historical PRD rows with legacy gap capsules without a raw backup by default', async () => {
		const tracePath = path.join(testDir, 'prd-auto-trace.jsonl');
		await writeFile(
			tracePath,
			[
				JSON.stringify({
					ts: '2026-06-24T00:00:00.000Z',
					requestId: 'tg-build-proof-gap',
					traceRef: 'trace:spawner-prd:mission-proof-gap',
					event: 'request_written',
					workingDirectory: '/Users/example/private/project'
				}),
				JSON.stringify({
					ts: '2026-06-24T00:00:01.000Z',
					requestId: 'tg-build-proof-real',
					traceRef: 'trace:spawner-prd:mission-proof-real',
					event: 'request_written',
					harnessProofRef: 'turn:sha256:0123456789abcdef'
				})
			].join('\n') + '\n',
			'utf-8'
		);

		const result = repairPrdTraceProofContinuity({ tracePath });
		const rows = (await readFile(tracePath, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line));
		const repaired = rows[0] as Record<string, any>;

		expect(result).toMatchObject({
			ok: true,
			rowsRead: 2,
			rowsWritten: 2,
			parseErrors: 0,
			gapCapsulesAdded: 1,
			alreadyHadProof: 1,
			changedRows: 2
		});
		expect(result.backupPath).toBeNull();
		expect(repaired.harnessProofRef).toBe(repaired.proofCapsule.turnRef);
		expect(repaired.proofStatus).toBe('missing_harness_authority');
		expect(repaired.proofStorage).toBe('legacy_gap_capsule');
		expect(repaired.proofJoinSource).toBe('spawner_prd_trace_legacy_repair');
		expect(repaired.privacy).toBe('metadata_only');
		expect(JSON.stringify(rows)).not.toContain('/Users/example');
		expect(existsSync(`${tracePath}.proof-backup`)).toBe(false);
	});

	it('leaves malformed historical JSONL untouched', async () => {
		const tracePath = path.join(testDir, 'prd-auto-trace.jsonl');
		const original = `${JSON.stringify({ requestId: 'tg-build-proof-gap', event: 'request_written' })}\n{bad json\n`;
		await writeFile(tracePath, original, 'utf-8');

		const result = repairPrdTraceProofContinuity({ tracePath });

		expect(result).toMatchObject({ ok: false, backupPath: null, rowsRead: 2, rowsWritten: 0, parseErrors: 1 });
		expect(await readFile(tracePath, 'utf-8')).toBe(original);
	});

	it('dry-run reports historical repairs without rewriting the trace file', async () => {
		const tracePath = path.join(testDir, 'prd-auto-trace.jsonl');
		await writeFile(
			tracePath,
			`${JSON.stringify({
				requestId: 'tg-build-proof-gap',
				traceRef: 'trace:spawner-prd:mission-proof-gap',
				event: 'request_written'
			})}\n`,
			'utf-8'
		);
		const before = await readFile(tracePath, 'utf-8');
		const result = repairPrdTraceProofContinuity({ tracePath, dryRun: true, backup: false });
		const after = await readFile(tracePath, 'utf-8');

		expect(result.dryRun).toBe(true);
		expect(result.gapCapsulesAdded).toBe(1);
		expect(result.changedRows).toBe(1);
		expect(after).toBe(before);
	});
});
