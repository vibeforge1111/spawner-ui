import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from './atomic-write';

let workDir: string;

beforeEach(async () => {
	workDir = await mkdtemp(path.join(tmpdir(), 'atomic-write-test-'));
});

afterEach(async () => {
	await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('writeFileAtomic', () => {
	it('writes new content to the target file', async () => {
		const target = path.join(workDir, 'state.json');
		await writeFileAtomic(target, '{"hello":"world"}');
		const observed = await readFile(target, 'utf-8');
		expect(observed).toBe('{"hello":"world"}');
	});

	it('overwrites an existing file atomically', async () => {
		const target = path.join(workDir, 'state.json');
		await writeFile(target, 'old-content', 'utf-8');
		await writeFileAtomic(target, 'new-content');
		const observed = await readFile(target, 'utf-8');
		expect(observed).toBe('new-content');
	});

	it('leaves no .tmp leftovers in the target directory after a successful write', async () => {
		const target = path.join(workDir, 'state.json');
		await writeFileAtomic(target, 'payload');
		const entries = await readdir(workDir);
		expect(entries).toEqual(['state.json']);
	});

	it('preserves whitespace, newlines, and unicode payloads byte-for-byte', async () => {
		const target = path.join(workDir, 'state.json');
		const payload = '  line one\n  line two\n  emoji 🤖\n  tabbed\there\n';
		await writeFileAtomic(target, payload);
		const observed = await readFile(target, 'utf-8');
		expect(observed).toBe(payload);
	});

	it('throws and cleans up the temp file when the rename target is invalid', async () => {
		// A path that cannot be renamed into (parent missing) surfaces ENOENT
		// from rename. The helper should remove its tmp file and re-throw.
		const bogusTarget = path.join(workDir, 'nested', 'does-not-exist', 'state.json');
		await expect(writeFileAtomic(bogusTarget, 'payload')).rejects.toThrow();
		const entries = await readdir(workDir);
		// No `.tmp` siblings should remain inside the workdir.
		const stray = entries.filter((name) => name.endsWith('.tmp'));
		expect(stray).toEqual([]);
	});

	it('produces unique temp paths so two concurrent writes do not collide', async () => {
		const targetA = path.join(workDir, 'state-a.json');
		const targetB = path.join(workDir, 'state-b.json');
		await Promise.all([
			writeFileAtomic(targetA, 'payload-a'),
			writeFileAtomic(targetB, 'payload-b'),
		]);
		expect(await readFile(targetA, 'utf-8')).toBe('payload-a');
		expect(await readFile(targetB, 'utf-8')).toBe('payload-b');
	});
});
