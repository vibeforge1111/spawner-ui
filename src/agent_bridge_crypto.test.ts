import { describe, it, expect, vi } from 'vitest';

function createId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

describe('spark agent bridge ID generation', () => {
	it('matches <prefix>-<base36ts>-<hex8> format', () => {
		expect(createId('session')).toMatch(/^session-[0-9a-z]+-[0-9a-f]{8}$/);
	});
	it('produces unique IDs across 500 calls', () => {
		const ids = new Set(Array.from({ length: 500 }, () => createId('sess')));
		expect(ids.size).toBe(500);
	});
	it('does not call Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		createId('x');
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('prefix preserved', () => {
		expect(createId('spark-bridge').startsWith('spark-bridge-')).toBe(true);
	});
	it('suffix is 8 hex chars', () => {
		const id = createId('p');
		expect(id.split('-').slice(-1)[0]).toMatch(/^[0-9a-f]{8}$/);
	});
});
