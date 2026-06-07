import { describe, it, expect, vi } from 'vitest';

function generateId(): string {
	return `pipe-${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

describe('pipeline store ID generation', () => {
	it('matches pipe-<base36>-<hex8> format', () => {
		expect(generateId()).toMatch(/^pipe-[0-9a-z]+-[0-9a-f]{8}$/);
	});
	it('produces 500 unique IDs', () => {
		expect(new Set(Array.from({ length: 500 }, generateId)).size).toBe(500);
	});
	it('does not call Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		generateId();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('prefix is pipe', () => {
		expect(generateId().startsWith('pipe-')).toBe(true);
	});
	it('suffix is 8 hex chars', () => {
		expect(generateId().split('-').slice(-1)[0]).toMatch(/^[0-9a-f]{8}$/);
	});
});
