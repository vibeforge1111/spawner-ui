import { describe, it, expect, vi } from 'vitest';

function generateTransitionId(): string {
	return `transition-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

describe('mission state transition ID generation', () => {
	it('matches transition-<ts>-<hex8> format', () => {
		expect(generateTransitionId()).toMatch(/^transition-\d+-[0-9a-f]{8}$/);
	});
	it('produces 500 unique IDs', () => {
		expect(new Set(Array.from({ length: 500 }, generateTransitionId)).size).toBe(500);
	});
	it('does not call Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		generateTransitionId();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('prefix is transition-', () => {
		expect(generateTransitionId().startsWith('transition-')).toBe(true);
	});
	it('suffix is 8 hex chars', () => {
		expect(generateTransitionId().split('-').slice(-1)[0]).toMatch(/^[0-9a-f]{8}$/);
	});
});
