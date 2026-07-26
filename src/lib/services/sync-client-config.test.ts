import { describe, expect, it } from 'vitest';
import { syncReconnectInterval } from './sync-client';

describe('sync reconnect configuration', () => {
	it('accepts a clean positive millisecond override', () => {
		expect(syncReconnectInterval('4500')).toBe(4500);
	});

	it('falls back for missing, unit-suffixed, non-finite, or zero values', () => {
		for (const value of [undefined, '', '3s', 'Infinity', '0', '-1']) {
			expect(syncReconnectInterval(value)).toBe(3000);
		}
	});
});
