import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { appendManualEvaluation, validateManualEvaluation } from './memory-quality-evaluations';
import type { MemoryQualityPaths } from './memory-quality';

let testDir: string;
let paths: MemoryQualityPaths;

describe('memory quality evaluations', () => {
	beforeEach(async () => {
		testDir = await mkdtemp(path.join(tmpdir(), 'memory-quality-eval-'));
		paths = {
			baseDir: testDir,
			recallEventsFile: path.join(testDir, 'recall-events.json'),
			sourceHealthFile: path.join(testDir, 'source-health.json'),
			evaluationsFile: path.join(testDir, 'evaluations.json')
		};
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it('validates required fields', () => {
		const result = validateManualEvaluation({});
		expect(result.valid).toBe(false);
		expect(result.errors.query).toContain('required');
		expect(result.errors.outcome).toContain('Choose');
	});

	it('appends a valid manual evaluation to the local file-backed dataset', async () => {
		const randomSpy = vi.spyOn(Math, 'random');
		const result = await appendManualEvaluation({
			query: 'Did recall match the source?',
			source: 'domain-chip-memory',
			outcome: 'hit',
			latencyMs: 88,
			notes: 'Looks good.'
		}, paths);

		expect(result.errors).toBeUndefined();
		expect(result.event?.manual).toBe(true);
		expect(existsSync(paths.evaluationsFile)).toBe(true);
		const stored = JSON.parse(await readFile(paths.evaluationsFile, 'utf-8'));
		expect(stored[0].query).toBe('Did recall match the source?');
		expect(result.dataset.events[0].query).toBe('Did recall match the source?');
		expect(result.event?.id).toMatch(/^manual-\d+-[0-9a-f]{8}$/);
		expect(randomSpy).not.toHaveBeenCalled();
	});

	it('returns inline errors without writing invalid submissions', async () => {
		const result = await appendManualEvaluation({ query: '', source: 'bad', outcome: 'bad', latencyMs: -1 }, paths);
		expect(result.errors?.query).toBeTruthy();
		expect(existsSync(paths.evaluationsFile)).toBe(false);
	});

	it('bounds text and latency fields before writing local evaluations', async () => {
		const result = await appendManualEvaluation({
			query: 'q'.repeat(601),
			source: 'domain-chip-memory',
			outcome: 'hit',
			latencyMs: 120_001,
			notes: 'n'.repeat(1201),
			evaluator: 'e'.repeat(81)
		}, paths);

		expect(result.errors?.query).toContain('600');
		expect(result.errors?.latencyMs).toContain('120000');
		expect(result.errors?.notes).toContain('1200');
		expect(result.errors?.evaluator).toContain('80');
		expect(existsSync(paths.evaluationsFile)).toBe(false);
	});
});
