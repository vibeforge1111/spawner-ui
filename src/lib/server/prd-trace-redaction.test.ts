import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactPrdAutoTraceLog, sanitizePrdTraceDetails } from './prd-trace-redaction';

let testDir = '';

describe('PRD trace redaction', () => {
	beforeEach(async () => {
		testDir = await mkdtemp(path.join(tmpdir(), 'spawner-prd-trace-redaction-'));
	});

	afterEach(async () => {
		if (testDir && existsSync(testDir)) {
			await rm(testDir, { recursive: true, force: true });
		}
	});

	it('redacts local paths while preserving proof and trace refs', () => {
		const details = sanitizePrdTraceDetails({
			traceRef: 'trace:spawner-prd:mission-test',
			harnessProofRef: 'turn:sha256:0123456789abcdef',
			stateDirectory: 'C:\\Users\\USER\\Desktop\\spark\\state',
			resultFile: '/Users/example/.spark/state/spawner-ui/results/request.json',
			linuxPath: '/home/alchemist/private/request.json',
			authorization: 'Bearer private-token-value',
			note: `provider returned Bearer private-inline-token and ${['sk', 'privateSecret123'].join('-')}`,
			nested: {
				artifact: 'file:///Users/example/private/artifact.json'
			}
		});

		expect(details.traceRef).toBe('trace:spawner-prd:mission-test');
		expect(details.harnessProofRef).toBe('turn:sha256:0123456789abcdef');
		expect(details.stateDirectory).toMatch(/^path:sha256:[a-f0-9]{16}$/);
		expect(details.resultFile).toMatch(/^path:sha256:[a-f0-9]{16}$/);
		expect(details.linuxPath).toMatch(/^path:sha256:[a-f0-9]{16}$/);
		expect(details.authorization).toBe('[redacted]');
		expect(details.note).toBe('provider returned [redacted] and [redacted]');
		expect((details.nested as Record<string, unknown>).artifact).toMatch(/^path:sha256:[a-f0-9]{16}$/);
		expect(JSON.stringify(details)).not.toMatch(/C:\\\\Users|\/Users\/example|file:\/\//);
	});

	it('repairs historical PRD trace rows with an explicit private raw backup', async () => {
		const tracePath = path.join(testDir, 'prd-auto-trace.jsonl');
		await writeFile(
			tracePath,
			[
				JSON.stringify({
					ts: '2026-06-24T00:00:00.000Z',
					requestId: 'tg-build-test',
					traceRef: 'trace:spawner-prd:mission-test',
					harnessProofRef: 'turn:sha256:0123456789abcdef',
					event: 'fallback_analysis_written',
					stateDirectory: '/Users/example/.spark/state/spawner-ui',
					resultFile: '/Users/example/.spark/state/spawner-ui/results/tg-build-test.json'
				}),
				JSON.stringify({
					ts: '2026-06-24T00:00:01.000Z',
					requestId: 'tg-build-test',
					event: 'analysis_complete',
					proofStatus: 'missing_harness_proof'
				})
			].join('\n') + '\n',
			'utf-8'
		);

		const result = await redactPrdAutoTraceLog(tracePath, { backup: true });
		const repaired = await readFile(tracePath, 'utf-8');
		const rows = repaired.trim().split('\n').map((line) => JSON.parse(line));

		expect(result).toMatchObject({
			ok: true,
			rowsRead: 2,
			rowsWritten: 2,
			parseErrors: 0
		});
		expect(result.backupPath).toBeTruthy();
		expect(rows[0].harnessProofRef).toBe('turn:sha256:0123456789abcdef');
		expect(rows[0].stateDirectory).toMatch(/^path:sha256:[a-f0-9]{16}$/);
		expect(rows[0].resultFile).toMatch(/^path:sha256:[a-f0-9]{16}$/);
		expect(rows[1].proofStatus).toBe('missing_harness_proof');
		expect(repaired).not.toContain('/Users/example');
		expect(await readFile(String(result.backupPath), 'utf-8')).toContain('/Users/example');
		expect((await stat(String(result.backupPath))).mode & 0o777).toBe(0o600);
	});

	it('defaults to no raw backup and leaves malformed JSONL untouched', async () => {
		const tracePath = path.join(testDir, 'prd-auto-trace.jsonl');
		const original = `${JSON.stringify({ event: 'request_written', resultFile: '/private/var/tmp/private-result.json' })}\n{bad json\n`;
		await writeFile(tracePath, original, 'utf-8');

		const result = await redactPrdAutoTraceLog(tracePath);

		expect(result).toMatchObject({ ok: false, backupPath: null, rowsRead: 2, rowsWritten: 0, parseErrors: 1 });
		expect(await readFile(tracePath, 'utf-8')).toBe(original);
		expect(existsSync(`${tracePath}.raw-backup`)).toBe(false);
	});

	it('dry-run reports redaction without rewriting the trace file or creating a backup', async () => {
		const tracePath = path.join(testDir, 'prd-auto-trace.jsonl');
		const original = `${JSON.stringify({ event: 'request_written', resultFile: '/Users/example/private/result.json' })}\n`;
		await writeFile(tracePath, original, 'utf-8');

		const result = await redactPrdAutoTraceLog(tracePath, { dryRun: true, backup: true });

		expect(result).toMatchObject({ ok: true, dryRun: true, backupPath: null, rowsRead: 1, rowsWritten: 1 });
		expect(await readFile(tracePath, 'utf-8')).toBe(original);
		expect(existsSync(`${tracePath}.raw-backup`)).toBe(false);
	});
});
