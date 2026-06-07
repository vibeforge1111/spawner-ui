import { describe, it, expect, vi } from 'vitest';

function generateCheckId(): string {
	return `check-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

describe('health check ID generation', () => {
	it('matches check-<ts>-<hex8> format', () => {
		expect(generateCheckId()).toMatch(/^check-\d+-[0-9a-f]{8}$/);
	});
	it('produces unique IDs across 500 calls', () => {
		const ids = new Set(Array.from({ length: 500 }, generateCheckId));
		expect(ids.size).toBe(500);
	});
	it('does not call Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		generateCheckId();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('prefix is check', () => {
		expect(generateCheckId().startsWith('check-')).toBe(true);
	});
	it('suffix is 8 hex chars', () => {
		const id = generateCheckId();
		expect(id.split('-').slice(-1)[0]).toMatch(/^[0-9a-f]{8}$/);
	});
});
