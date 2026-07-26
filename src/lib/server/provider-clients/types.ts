import type { BridgeEvent } from '$lib/services/event-bridge';
import type { MultiLLMProviderConfig } from '$lib/services/multi-llm-orchestrator';

export interface ProviderResult {
	success: boolean;
	response?: string;
	error?: string;
	tokenUsage?: { prompt: number; completion: number; total: number; cachedPrompt?: number };
	durationMs?: number;
}

export interface ProviderClientOptions {
	provider: MultiLLMProviderConfig;
	missionId: string;
	signal?: AbortSignal;
	onEvent: (event: BridgeEvent) => void;
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export type ProviderSessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ProviderSession {
	providerId: string;
	missionId: string;
	model?: string | null;
	/** Governed dispatch request the session is bound to (machine-origin callbacks must match it when recorded). */
	requestId?: string | null;
	traceRef?: string | null;
	pipelineId?: string | null;
	status: ProviderSessionStatus;
	abortController: AbortController;
	startedAt: Date;
	completedAt: Date | null;
	result: ProviderResult | null;
	error: string | null;
}

export function createBridgeEvent(
	type: string,
	options: ProviderClientOptions,
	extra?: Partial<BridgeEvent>
): BridgeEvent {
	return {
		type,
		missionId: options.missionId,
		source: options.provider.eventSource || options.provider.id,
		timestamp: new Date().toISOString(),
		...extra
	};
}
