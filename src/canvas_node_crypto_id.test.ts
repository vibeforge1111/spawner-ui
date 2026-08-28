import { describe, it, expect, vi } from 'vitest';

function generateNodeId(counter: number): string {
	return 'node-' + counter + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

describe('canvas node ID generation', () => {
	it('matches node-<counter>-<hex8> format', () => {
		expect(generateNodeId(1)).toMatch(/^node-\d+-[0-9a-f]{8}$/);
	});
	it('produces 500 unique IDs', () => {
		expect(new Set(Array.from({ length: 500 }, (_, i) => generateNodeId(i + 1))).size).toBe(500);
	});
	it('does not call Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		generateNodeId(42);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('prefix is node-<counter>-', () => {
		expect(generateNodeId(7).startsWith('node-7-')).toBe(true);
	});
	it('suffix is 8 hex chars', () => {
		const id = generateNodeId(1);
		const suffix = id.split('-').slice(-1)[0];
		expect(suffix).toMatch(/^[0-9a-f]{8}$/);
	});
});
