import { describe, expect, it } from 'vitest';
import { resolveProviderRuntimeConfiguration } from './provider-config';

const emptyEnv: Record<string, string | undefined> = {};

describe('provider-config — no more fake-configured', () => {
	it('local OpenAI-compat providers (ollama/lmstudio) are NOT marked configured without api key or CLI', () => {
		const result = resolveProviderRuntimeConfiguration({
			id: 'ollama',
			kind: 'openai_compat' as const,
			label: 'Ollama',
			apiKeyEnv: '',
		}, emptyEnv);
		expect(result.configured).toBe(false);
		expect(result.configurationMode).toBe('local');
	});

	it('local OpenAI-compat providers marked as local configuration mode', () => {
		const result = resolveProviderRuntimeConfiguration({
			id: 'lmstudio',
			kind: 'openai_compat' as const,
			label: 'LM Studio',
			apiKeyEnv: '',
		}, emptyEnv);
		expect(result.configurationMode).toBe('local');
		expect(result.configured).toBe(false);
	});

	it('providers with apiKeyEnv are still marked configured', () => {
		const result = resolveProviderRuntimeConfiguration({
			id: 'openai',
			kind: 'openai' as const,
			label: 'OpenAI',
			apiKeyEnv: 'OPENAI_API_KEY',
		}, { OPENAI_API_KEY: 'sk-test-key' });
		expect(result.configured).toBe(true);
		expect(result.configurationMode).toBe('api_key');
	});
});
