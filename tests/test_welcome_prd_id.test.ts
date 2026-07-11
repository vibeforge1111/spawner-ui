import { describe, it, expect } from 'vitest';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makePrdRequestId(): string {
	return `prd-${crypto.randomUUID()}`;
}

describe('PRD request ID generation', () => {
	it('starts with prd- prefix', () => {
		expect(makePrdRequestId()).toMatch(/^prd-/);
	});
	it('contains a valid UUID v4', () => {
		const id = makePrdRequestId();
		expect(UUID_RE.test(id.slice(4))).toBe(true);
	});
	it('does not use Math.random', () => {
		const src = makePrdRequestId.toString();
		expect(src).not.toContain('Math.random');
	});
	it('generates 1000 unique IDs', () => {
		const ids = Array.from({ length: 1000 }, () => makePrdRequestId());
		expect(new Set(ids).size).toBe(1000);
	});
	it('is a plain string', () => {
		expect(typeof makePrdRequestId()).toBe('string');
	});
});
