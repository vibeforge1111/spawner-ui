import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getMissionLogs: vi.fn(),
	getMission: vi.fn()
}));

vi.mock('$lib/services/mcp-client', () => ({
	mcpClient: {
		getMissionLogs: mocks.getMissionLogs,
		getMission: mocks.getMission
	}
}));

import { startLogPolling, stopLogPolling } from './missions.svelte';
import { mcpState } from './mcp.svelte';

describe('mission log polling', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mocks.getMissionLogs.mockReset();
		mocks.getMission.mockReset();
		mcpState.update((state) => ({ ...state, status: 'connected' }));
	});

	afterEach(() => {
		stopLogPolling();
		mcpState.update((state) => ({ ...state, status: 'disconnected' }));
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('contains rejected initial loads and keeps later polling ticks alive', async () => {
		mocks.getMissionLogs
			.mockRejectedValueOnce(new Error('initial disconnect'))
			.mockRejectedValueOnce(new Error('transient tick'))
			.mockResolvedValue({ success: true, data: { logs: [] } });
		mocks.getMission.mockResolvedValue({ success: false });
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		startLogPolling('mission-polling-recovery', 10);
		await vi.advanceTimersByTimeAsync(25);

		expect(mocks.getMissionLogs).toHaveBeenCalledTimes(3);
		expect(warning).toHaveBeenCalledWith(
			'[MissionLogPolling] initial load failed:',
			expect.any(Error)
		);
		expect(warning).toHaveBeenCalledWith(
			'[MissionLogPolling] tick failed:',
			expect.any(Error)
		);
	});
});
