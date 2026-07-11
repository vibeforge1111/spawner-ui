import { describe, it, expect } from 'vitest';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeNodeId(): string {
	return `node-${crypto.randomUUID()}`;
}

describe('canvas node ID generation', () => {
	it('starts with node- prefix', () => {
		expect(makeNodeId()).toMatch(/^node-/);
	});
	it('contains a valid UUID v4', () => {
		const id = makeNodeId();
		expect(UUID_RE.test(id.slice(5))).toBe(true);
	});
	it('does not use Math.random', () => {
		const src = makeNodeId.toString();
		expect(src).not.toContain('Math.random');
	});
	it('generates 1000 unique IDs', () => {
		const ids = Array.from({ length: 1000 }, () => makeNodeId());
		expect(new Set(ids).size).toBe(1000);
	});
	it('is a plain string', () => {
		expect(typeof makeNodeId()).toBe('string');
	});
});
