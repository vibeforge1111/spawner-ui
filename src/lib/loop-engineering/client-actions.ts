export const LOOP_ENGINEERING_AUTO_REFRESH_MS = 8_000;

export function shouldAutoRefreshLoopEngineering(input: {
	documentVisible?: boolean;
	refreshing?: boolean;
	actionLoading?: string | null;
	autoRefresh?: boolean;
}): boolean {
	return input.autoRefresh !== false &&
		input.documentVisible !== false &&
		input.refreshing !== true &&
		!input.actionLoading;
}
