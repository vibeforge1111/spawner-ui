import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from './atomic-write';

const cleanupPaths: string[] = [];

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe('writeFileAtomic', () => {
	it('replaces a leaf symlink without following it to the external file', async () => {
		const root = mkdtempSync(join(tmpdir(), 'spark-atomic-root-'));
		const externalRoot = mkdtempSync(join(tmpdir(), 'spark-atomic-external-'));
		cleanupPaths.push(root, externalRoot);
		const externalFile = join(externalRoot, 'outside.html');
		const targetFile = join(root, 'index.html');
		writeFileSync(externalFile, 'external stays unchanged', 'utf-8');
		try {
			symlinkSync(externalFile, targetFile, 'file');
		} catch {
			return;
		}

		await writeFileAtomic(targetFile, 'safe replacement');

		expect(readFileSync(externalFile, 'utf-8')).toBe('external stays unchanged');
		expect(readFileSync(targetFile, 'utf-8')).toBe('safe replacement');
		expect(lstatSync(targetFile).isSymbolicLink()).toBe(false);
	});
});
