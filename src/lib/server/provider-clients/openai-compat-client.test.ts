import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeOpenAICompatRequest } from './openai-compat-client';
import type { MultiLLMProviderConfig } from '$lib/services/multi-llm-orchestrator';

const provider: MultiLLMProviderConfig = {
	id: 'openai-compatible-test',
	label: 'OpenAI Compatible Test',
	model: 'test-model',
	enabled: true,
	kind: 'openai_compat',
	eventSource: 'openai-compatible-test',
	capabilities: ['reasoning'],
	requiresApiKey: true,
	apiKeyEnv: 'OPENAI_API_KEY',
	baseUrl: 'https://example.invalid/v1'
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('openai-compat-client', () => {
	it('keeps the provider response in the result without copying it into bridge events', async () => {
		const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(
					'data: {"choices":[{"delta":{"content":"private provider response"}}]}\n\ndata: [DONE]\n\n',
					{ status: 200, headers: { 'content-type': 'text/event-stream' } }
				)
			)
		);

		const result = await executeOpenAICompatRequest(
			{
				provider,
				apiKey: 'test-api-key',
				missionId: 'mission-openai-compatible-privacy',
				onEvent: (event) => events.push(event)
			},
			[{ role: 'user', content: 'Return private work' }]
		);

		expect(result).toMatchObject({ success: true, response: 'private provider response' });
		const completed = events.find((event) => event.type === 'task_completed');
		expect(completed?.data).toMatchObject({
			success: true,
			responseLength: 'private provider response'.length
		});
		expect(completed?.data).not.toHaveProperty('response');
	});

	it('releases a retry response body before the next request', async () => {
		const retryResponse = new Response('retry', {
			status: 503,
			headers: { 'retry-after': '0' }
		});
		const cancel = vi.spyOn(retryResponse.body!, 'cancel');
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(retryResponse)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						choices: [{ message: { content: 'done' } }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
			);
		vi.stubGlobal('fetch', fetchMock);

		const result = await executeOpenAICompatRequest(
			{
				provider,
				apiKey: 'test-api-key',
				missionId: 'mission-openai-compatible-retry',
				onEvent: () => undefined
			},
			[{ role: 'user', content: 'Retry safely' }],
			false
		);

		expect(result).toMatchObject({ success: true, response: 'done' });
		expect(cancel).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('preserves configured reasoning effort and service tier in compatible requests', async () => {
		vi.stubEnv('SPARK_OPENAI_REASONING_EFFORT', ' high ');
		vi.stubEnv('SPARK_OPENAI_SERVICE_TIER', ' priority ');
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body || '{}'));
			expect(body).toMatchObject({
				model: 'test-model',
				reasoning_effort: 'high',
				service_tier: 'priority'
			});
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: 'configured' } }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await executeOpenAICompatRequest(
			{
				provider,
				apiKey: 'test-api-key',
				missionId: 'mission-openai-compatible-options',
				onEvent: () => undefined
			},
			[{ role: 'user', content: 'Use configured request options' }],
			false
		);

		expect(result).toMatchObject({ success: true, response: 'configured' });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('does not add optional OpenAI fields when their environment values are blank', async () => {
		vi.stubEnv('SPARK_OPENAI_REASONING_EFFORT', ' ');
		vi.stubEnv('SPARK_OPENAI_SERVICE_TIER', '');
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body || '{}'));
			expect(body).not.toHaveProperty('reasoning_effort');
			expect(body).not.toHaveProperty('service_tier');
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: 'default' } }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await executeOpenAICompatRequest(
			{
				provider,
				apiKey: 'test-api-key',
				missionId: 'mission-openai-compatible-defaults',
				onEvent: () => undefined
			},
			[{ role: 'user', content: 'Use default request options' }],
			false
		);

		expect(result).toMatchObject({ success: true, response: 'default' });
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
