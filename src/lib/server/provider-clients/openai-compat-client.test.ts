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
	vi.restoreAllMocks();
});

describe('openai-compat-client', () => {
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
});
