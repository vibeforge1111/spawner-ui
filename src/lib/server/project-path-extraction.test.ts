import { describe, expect, it } from 'vitest';
import {
	cleanProjectPathCandidate,
	extractExplicitProjectPath,
} from './project-path-extraction';

describe('cleanProjectPathCandidate', () => {
	it('strips wrapping backticks and trailing punctuation', () => {
		expect(cleanProjectPathCandidate('`/Users/me/projects/spark`')).toBe('/Users/me/projects/spark');
		expect(cleanProjectPathCandidate('/Users/me/projects/spark,')).toBe(
			'/Users/me/projects/spark'
		);
		expect(cleanProjectPathCandidate('/Users/me/projects/spark).')).toBe(
			'/Users/me/projects/spark'
		);
	});

	it('returns null for null or empty input', () => {
		expect(cleanProjectPathCandidate(null)).toBeNull();
		expect(cleanProjectPathCandidate(undefined)).toBeNull();
		expect(cleanProjectPathCandidate('')).toBeNull();
	});

	it('trims trailing prose joiners like "as" or "with"', () => {
		expect(cleanProjectPathCandidate('/Users/me/projects/spark as a starter project')).toBe(
			'/Users/me/projects/spark'
		);
		expect(cleanProjectPathCandidate('/Users/me/projects/spark and run it')).toBe(
			'/Users/me/projects/spark'
		);
	});

	it('rejects single-segment root paths like /Users with no nested folder', () => {
		expect(cleanProjectPathCandidate('/Users')).toBeNull();
	});

	it('rejects single-slash paths that look like a sentence fragment', () => {
		// Has a space, has only one slash, and is not under a known root family.
		expect(cleanProjectPathCandidate('/myhome and the projects')).toBeNull();
	});

	it('preserves nested paths under the known root families', () => {
		expect(cleanProjectPathCandidate('/Users/me/work/spark')).toBe('/Users/me/work/spark');
		expect(cleanProjectPathCandidate('/home/me/code/spark')).toBe('/home/me/code/spark');
		expect(cleanProjectPathCandidate('/tmp/spark-runs/run-1')).toBe('/tmp/spark-runs/run-1');
	});

	it('trims at sentence boundaries when the trailing imperative follows a period', () => {
		const out = cleanProjectPathCandidate('/Users/me/projects/spark. You must include the README');
		expect(out).toBe('/Users/me/projects/spark');
	});
});

describe('extractExplicitProjectPath', () => {
	it('returns null when no path-shaped fragment is present', () => {
		expect(extractExplicitProjectPath('Build a thing and ship it.')).toBeNull();
	});

	it('matches the canonical "improve existing shipped project ... at /path" form', () => {
		const found = extractExplicitProjectPath(
			'Improve the existing shipped project "spark-os" at `/Users/me/projects/spark-os`'
		);
		expect(found).toBe('/Users/me/projects/spark-os');
	});

	it('matches the "target operating-system folder: /path" form', () => {
		const found = extractExplicitProjectPath(
			'target operating-system folder: /Users/me/projects/spark-os and continue'
		);
		expect(found).toBe('/Users/me/projects/spark-os');
	});

	it('matches the "create it at /path" prompt phrasing', () => {
		const found = extractExplicitProjectPath('Please create it at /home/me/code/spark-runs.');
		expect(found).toBe('/home/me/code/spark-runs');
	});

	it('falls back to the bare absolute-path pattern when no preamble fires', () => {
		const found = extractExplicitProjectPath('Drop the run summary in /tmp/spark-runs/run-1.');
		expect(found).toBe('/tmp/spark-runs/run-1');
	});

	it('matches a Windows-style drive path', () => {
		const found = extractExplicitProjectPath(
			'target folder: C:\\Users\\me\\spark-os and build from there'
		);
		expect(found).toBe('C:\\Users\\me\\spark-os');
	});

	it('returns null when only a single-slash sentence fragment is present', () => {
		// "/myhome" is single-slash + has a trailing space → rejected by the cleaner.
		expect(extractExplicitProjectPath('think about /myhome and choose wisely')).toBeNull();
	});
});
