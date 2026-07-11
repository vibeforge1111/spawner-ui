import { describe, expect, it, vi } from 'vitest';
import { executeOpenAICompatRequest } from './openai-compat-client';
import type { MultiLLMProviderConfig } from '$lib/services/multi-llm-orchestrator';

const provider: MultiLLMProviderConfig = {
	id: 'openai-compatible',
	label: 'OpenAI Compat',
	model: 'demo-model',
	enabled: true,
	kind: 'openai_compat',
	eventSource: 'openai-compatible',
	capabilities: ['code_analysis'],
	requiresApiKey: true,
	apiKeyEnv: 'OPENAI_COMPAT_API_KEY',
	baseUrl: 'https://provider.example.test/v1'
};

describe('executeOpenAICompatRequest', () => {
	it('redacts key-shaped material from provider error bodies', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				return new Response(
					'upstream rejected Authorization: Bearer sk-live-secret-1234567890abcdef and token 12345:abcdefghijklmnopqrstuvwxyz',
					{ status: 400 }
				);
			})
		);

		const result = await executeOpenAICompatRequest(
			{
				provider,
				apiKey: 'sk-client-secret-1234567890abcdef',
				missionId: 'mission-provider-error-redaction',
				onEvent: () => {}
			},
			[{ role: 'user', content: 'hello' }],
			false
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('OpenAI Compat API error 400');
		expect(result.error).toContain('[redacted]');
		expect(result.error).not.toContain('sk-live-secret-1234567890abcdef');
		expect(result.error).not.toContain('12345:abcdefghijklmnopqrstuvwxyz');
	});
});
