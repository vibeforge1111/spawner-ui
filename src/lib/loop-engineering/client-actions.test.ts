import { describe, expect, it } from 'vitest';
import {
	LOOP_ENGINEERING_AUTO_REFRESH_MS,
	shouldAutoRefreshLoopEngineering
} from './client-actions';

describe('Loop Engineering client actions', () => {
	it('keeps auto-refresh bounded to visible idle control-plane pages', () => {
		expect(LOOP_ENGINEERING_AUTO_REFRESH_MS).toBeGreaterThanOrEqual(5_000);
		expect(shouldAutoRefreshLoopEngineering({})).toBe(true);
		expect(shouldAutoRefreshLoopEngineering({ documentVisible: false })).toBe(false);
		expect(shouldAutoRefreshLoopEngineering({ refreshing: true })).toBe(false);
		expect(shouldAutoRefreshLoopEngineering({ actionLoading: 'loop-execute' })).toBe(false);
		expect(shouldAutoRefreshLoopEngineering({ autoRefresh: false })).toBe(false);
	});
});
