import { describe, it, expect, vi } from 'vitest';

function generateMcpInstanceId(): string {
	return `mcp_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
}

describe('MCP instance ID generation', () => {
	it('matches mcp_<ts>_<hex9> format', () => {
		expect(generateMcpInstanceId()).toMatch(/^mcp_\d+_[0-9a-f]{9}$/);
	});
	it('produces 500 unique IDs', () => {
		expect(new Set(Array.from({ length: 500 }, generateMcpInstanceId)).size).toBe(500);
	});
	it('does not call Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		generateMcpInstanceId();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('prefix is mcp_', () => {
		expect(generateMcpInstanceId().startsWith('mcp_')).toBe(true);
	});
	it('suffix is 9 hex chars', () => {
		expect(generateMcpInstanceId().split('_').slice(-1)[0]).toMatch(/^[0-9a-f]{9}$/);
	});
});
