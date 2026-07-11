import { describe, it, expect, vi } from 'vitest';

function generatePrdRequestId(): string {
	return `prd-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

describe('PRD request ID generation', () => {
	it('matches prd-<ts>-<hex8> format', () => {
		expect(generatePrdRequestId()).toMatch(/^prd-\d+-[0-9a-f]{8}$/);
	});
	it('produces unique IDs across 500 calls', () => {
		const ids = new Set(Array.from({ length: 500 }, generatePrdRequestId));
		expect(ids.size).toBe(500);
	});
	it('does not call Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		generatePrdRequestId();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('prefix is prd', () => {
		expect(generatePrdRequestId().startsWith('prd-')).toBe(true);
	});
	it('suffix is 8 hex chars', () => {
		const id = generatePrdRequestId();
		const parts = id.split('-');
		expect(parts[parts.length - 1]).toMatch(/^[0-9a-f]{8}$/);
	});
});
