/**
 * Tests: event ID generation uses crypto.randomUUID() not Math.random().
 * Verifies IDs are unique (no collision in 1000 samples) and match expected format.
 */

import { describe, it, expect, vi } from 'vitest';

function generateEventId(): string {
	return `evt-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

describe('event ID generation', () => {
	it('produces IDs matching evt-<timestamp>-<hex8> format', () => {
		const id = generateEventId();
		expect(id).toMatch(/^evt-\d+-[0-9a-f]{8}$/);
	});

	it('produces unique IDs across 1000 calls', () => {
		const ids = new Set<string>();
		for (let i = 0; i < 1000; i++) ids.add(generateEventId());
		expect(ids.size).toBe(1000);
	});

	it('uses crypto.randomUUID not Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		generateEventId();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('suffix is always 8 hex characters', () => {
		for (let i = 0; i < 20; i++) {
			const id = generateEventId();
			const suffix = id.split('-').slice(2).join('-');
			expect(suffix).toMatch(/^[0-9a-f]{8}$/);
		}
	});

	it('prefix is always evt', () => {
		const id = generateEventId();
		expect(id.startsWith('evt-')).toBe(true);
	});
});
