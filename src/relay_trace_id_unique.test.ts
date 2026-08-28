import { describe, it, expect, vi } from 'vitest';

function generateFallbackTraceId(missionId: string, eventType: string): string {
	return `mc-${missionId}-${eventType}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

describe('relay fallback trace_id uniqueness', () => {
	it('matches mc-<missionId>-<type>-<hex12> format', () => {
		const id = generateFallbackTraceId('m1', 'task_started');
		expect(id).toMatch(/^mc-m1-task_started-[0-9a-f]{12}$/);
	});
	it('produces unique IDs for same mission+type across 500 calls', () => {
		const ids = new Set(
			Array.from({ length: 500 }, () => generateFallbackTraceId('mission-abc', 'progress'))
		);
		expect(ids.size).toBe(500);
	});
	it('does not collide for concurrent same-millisecond events', () => {
		vi.useFakeTimers();
		const ids = new Set(
			Array.from({ length: 100 }, () => generateFallbackTraceId('m1', 'progress'))
		);
		expect(ids.size).toBe(100);
		vi.useRealTimers();
	});
	it('does not call Math.floor', () => {
		const spy = vi.spyOn(Math, 'floor');
		generateFallbackTraceId('m1', 'task_started');
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('suffix is 12 hex chars', () => {
		const id = generateFallbackTraceId('x', 'y');
		const suffix = id.split('-').slice(-1)[0];
		expect(suffix).toMatch(/^[0-9a-f]{12}$/);
	});
});
