import { describe, it, expect, vi } from 'vitest';

function generateCmdId(): string {
	return `mc-cmd-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

describe('mission control command ID', () => {
	it('matches mc-cmd-<ts>-<hex8> format', () => {
		expect(generateCmdId()).toMatch(/^mc-cmd-\d+-[0-9a-f]{8}$/);
	});
	it('produces unique IDs across 500 calls', () => {
		const ids = new Set(Array.from({ length: 500 }, generateCmdId));
		expect(ids.size).toBe(500);
	});
	it('does not call Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		generateCmdId();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('prefix is mc-cmd', () => {
		expect(generateCmdId().startsWith('mc-cmd-')).toBe(true);
	});
	it('suffix is 8 hex chars', () => {
		const id = generateCmdId();
		expect(id.split('-').slice(3).join('-')).toMatch(/^[0-9a-f]{8}$/);
	});
});
