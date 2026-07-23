import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAnthropicRequest } from './anthropic-client';
import type { BridgeEvent } from '$lib/services/event-bridge';
import type { MultiLLMProviderConfig } from '$lib/services/multi-llm-orchestrator';

const provider: MultiLLMProviderConfig = {
	id: 'anthropic',
	label: 'Anthropic',
	model: 'claude-test',
	enabled: true,
	kind: 'openai_compat',
	eventSource: 'anthropic',
	capabilities: ['reasoning'],
	requiresApiKey: true,
	apiKeyEnv: 'ANTHROPIC_API_KEY'
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function streamResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			}
		}),
		{ status: 200 }
	);
}

describe('anthropic-client', () => {
	it('reuses one idempotency key across retry attempts', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('retry', { status: 500, headers: { 'retry-after': '0' } }))
			.mockResolvedValueOnce(
				streamResponse([
					'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
					'data: {"type":"content_block_delta","delta":{"text":"done"}}\n\n'
				])
			);
		vi.stubGlobal('fetch', fetchMock);

		const result = await executeAnthropicRequest(
			{
				provider,
				apiKey: 'test-api-key',
				missionId: 'mission-anthropic-retry',
				onEvent: () => undefined
			},
			'Retry safely'
		);

		const firstHeaders = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
		const secondHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
		expect(result.success).toBe(true);
		expect(firstHeaders['Idempotency-Key']).toBeTruthy();
		expect(secondHeaders['Idempotency-Key']).toBe(firstHeaders['Idempotency-Key']);
	});

	it('preserves prompt tokens when message_delta only reports output tokens', async () => {
		const events: BridgeEvent[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				streamResponse([
					'data: {"type":"message_start","message":{"usage":{"input_tokens":42,"output_tokens":0}}}\n\n',
					'data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n',
					'data: {"type":"message_delta","usage":{"output_tokens":7}}\n\n'
				])
			)
		);

		const result = await executeAnthropicRequest(
			{
				provider,
				apiKey: 'test-api-key',
				missionId: 'mission-anthropic-stream',
				onEvent: (event) => events.push(event)
			},
			'Write a greeting'
		);

		expect(result.success).toBe(true);
		expect(result.response).toBe('hello');
		expect(result.tokenUsage).toEqual({ prompt: 42, completion: 7, total: 49 });
		expect(events.some((event) => event.type === 'task_completed')).toBe(true);
	});
});
