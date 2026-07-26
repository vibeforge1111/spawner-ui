import { describe, it, expect, vi } from 'vitest';

function generateEvalId(): string {
	return `manual-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

describe('memory quality evaluation ID generation', () => {
	it('matches manual-<ts>-<hex8> format', () => {
		expect(generateEvalId()).toMatch(/^manual-\d+-[0-9a-f]{8}$/);
	});
	it('produces 500 unique IDs', () => {
		expect(new Set(Array.from({ length: 500 }, generateEvalId)).size).toBe(500);
	});
	it('does not call Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		generateEvalId();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('prefix is manual-', () => {
		expect(generateEvalId().startsWith('manual-')).toBe(true);
	});
	it('suffix is 8 hex chars', () => {
		expect(generateEvalId().split('-').slice(-1)[0]).toMatch(/^[0-9a-f]{8}$/);
	});
});
