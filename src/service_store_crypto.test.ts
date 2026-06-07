import { describe, it, expect, vi } from 'vitest';

function generateServiceId(): string {
	return `service-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

describe('service store ID generation', () => {
	it('matches service-<ts>-<hex8> format', () => {
		expect(generateServiceId()).toMatch(/^service-\d+-[0-9a-f]{8}$/);
	});
	it('produces 500 unique IDs', () => {
		expect(new Set(Array.from({ length: 500 }, generateServiceId)).size).toBe(500);
	});
	it('does not call Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		generateServiceId();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('prefix is service', () => {
		expect(generateServiceId().startsWith('service-')).toBe(true);
	});
	it('suffix is 8 hex chars', () => {
		expect(generateServiceId().split('-').slice(-1)[0]).toMatch(/^[0-9a-f]{8}$/);
	});
});
