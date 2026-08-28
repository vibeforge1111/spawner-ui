import { describe, it, expect, vi } from 'vitest';

function generateClientId(): string {
	return `spawner-ui-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

describe('sync client ID generation', () => {
	it('matches spawner-ui-<ts>-<hex8> format', () => {
		expect(generateClientId()).toMatch(/^spawner-ui-\d+-[0-9a-f]{8}$/);
	});
	it('produces 500 unique IDs', () => {
		expect(new Set(Array.from({ length: 500 }, generateClientId)).size).toBe(500);
	});
	it('does not call Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		generateClientId();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('prefix is spawner-ui-', () => {
		expect(generateClientId().startsWith('spawner-ui-')).toBe(true);
	});
	it('suffix is 8 hex chars', () => {
		expect(generateClientId().split('-').slice(-1)[0]).toMatch(/^[0-9a-f]{8}$/);
	});
});
