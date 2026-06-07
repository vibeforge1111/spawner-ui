import { describe, it, expect, vi } from 'vitest';

function generateEventId(): string {
	return `agent-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

describe('audit ledger event_id generation', () => {
	it('matches agent-<ts>-<hex8> format', () => {
		expect(generateEventId()).toMatch(/^agent-\d+-[0-9a-f]{8}$/);
	});
	it('produces unique IDs across 500 calls', () => {
		const ids = new Set(Array.from({ length: 500 }, generateEventId));
		expect(ids.size).toBe(500);
	});
	it('does not call Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		generateEventId();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('suffix is always 8 hex chars', () => {
		const id = generateEventId();
		expect(id.split('-').slice(2).join('-')).toMatch(/^[0-9a-f]{8}$/);
	});
	it('prefix is always agent', () => {
		expect(generateEventId().startsWith('agent-')).toBe(true);
	});
});
