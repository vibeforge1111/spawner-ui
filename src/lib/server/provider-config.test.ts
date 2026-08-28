import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyProviderEnvOverrides, resolveProviderRuntimeConfiguration } from './provider-config';

const originalCodexPath = process.env.CODEX_PATH;
const originalSparkCodexPath = process.env.SPARK_CODEX_PATH;
const originalSpawnerCodexPath = process.env.SPAWNER_CODEX_PATH;
const cleanupPaths: string[] = [];

afterEach(() => {
	process.env.CODEX_PATH = originalCodexPath;
	process.env.SPARK_CODEX_PATH = originalSparkCodexPath;
	process.env.SPAWNER_CODEX_PATH = originalSpawnerCodexPath;
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe('resolveProviderRuntimeConfiguration', () => {
	it('treats a resolvable terminal CLI provider as configured without an API key', () => {
		const root = mkdtempSync(join(tmpdir(), 'spark-provider-config-'));
		const fakeCodex = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
		writeFileSync(fakeCodex, '', 'utf-8');
		cleanupPaths.push(root);
		process.env.CODEX_PATH = fakeCodex;
		delete process.env.SPARK_CODEX_PATH;
		delete process.env.SPAWNER_CODEX_PATH;

		const result = resolveProviderRuntimeConfiguration(
			{ id: 'codex', kind: 'terminal_cli', apiKeyEnv: 'OPENAI_API_KEY' },
			{}
		);

		expect(result).toMatchObject({
			envKeyConfigured: false,
			cliConfigured: true,
			cliPath: fakeCodex,
			configured: true,
			configurationMode: 'cli'
		});
	});

	it('does not count placeholder API keys as configured', () => {
		const result = resolveProviderRuntimeConfiguration(
			{ id: 'zai', kind: 'openai_compat', apiKeyEnv: 'ZAI_API_KEY' },
			{ ZAI_API_KEY: 'your_zai_api_key' }
		);

		expect(result).toMatchObject({
			envKeyConfigured: false,
			cliConfigured: false,
			cliPath: null,
			configured: false,
			configurationMode: 'none'
		});
	});

	it('reports API-key providers as configured when a real key is present', () => {
		const result = resolveProviderRuntimeConfiguration(
			{ id: 'zai', kind: 'openai_compat', apiKeyEnv: 'ZAI_API_KEY' },
			{ ZAI_API_KEY: 'zai-real-key' }
		);

		expect(result).toMatchObject({
			envKeyConfigured: true,
			cliConfigured: false,
			configured: true,
			configurationMode: 'api_key'
		});
	});

	it('reports LM Studio as a local provider without requiring an API key', () => {
		const result = resolveProviderRuntimeConfiguration(
			{ id: 'lmstudio', kind: 'openai_compat', apiKeyEnv: undefined },
			{}
		);

		expect(result).toMatchObject({
			envKeyConfigured: false,
			cliConfigured: false,
			configured: true,
			configurationMode: 'local'
		});
	});

	it('reports Ollama as a local provider without requiring an API key', () => {
		const result = resolveProviderRuntimeConfiguration(
			{ id: 'ollama', kind: 'openai_compat', apiKeyEnv: undefined },
			{}
		);

		expect(result).toMatchObject({
			envKeyConfigured: false,
			cliConfigured: false,
			configured: true,
			configurationMode: 'local'
		});
	});

	it('applies mission-scoped model and base-url overrides only to the selected provider', () => {
		const provider = {
			id: 'lmstudio',
			label: 'LM Studio',
			model: 'local-model',
			enabled: false,
			kind: 'openai_compat' as const,
			eventSource: 'lmstudio',
			baseUrl: 'http://localhost:1234/v1'
		};

		const selected = applyProviderEnvOverrides(
			provider,
			{
				SPARK_MISSION_LLM_MODEL: 'loaded-local-model',
				SPARK_MISSION_LLM_BASE_URL: 'http://127.0.0.1:1234/v1'
			},
			{ missionDefaultProviderId: 'lmstudio' }
		);
		const unselected = applyProviderEnvOverrides(
			provider,
			{
				SPARK_MISSION_LLM_MODEL: 'other-model',
				SPARK_MISSION_LLM_BASE_URL: 'http://127.0.0.1:9999/v1'
			},
			{ missionDefaultProviderId: 'codex' }
		);

		expect(selected.model).toBe('loaded-local-model');
		expect(selected.baseUrl).toBe('http://127.0.0.1:1234/v1');
		expect(unselected.model).toBe('local-model');
		expect(unselected.baseUrl).toBe('http://localhost:1234/v1');
	});

	it('normalizes local OpenAI-compatible base-url overrides to /v1 for Ollama', () => {
		const provider = {
			id: 'ollama',
			label: 'Ollama',
			model: 'local-model',
			enabled: false,
			kind: 'openai_compat' as const,
			eventSource: 'ollama',
			baseUrl: 'http://127.0.0.1:11434/v1'
		};

		const explicit = applyProviderEnvOverrides(
			provider,
			{ SPARK_OLLAMA_BASE_URL: 'http://127.0.0.1:11434' },
			{}
		);
		expect(explicit.baseUrl).toBe('http://127.0.0.1:11434/v1');

		const trailingSlash = applyProviderEnvOverrides(
			provider,
			{ SPARK_OLLAMA_BASE_URL: 'http://127.0.0.1:11434/' },
			{}
		);
		expect(trailingSlash.baseUrl).toBe('http://127.0.0.1:11434/v1');

		const alreadyV1 = applyProviderEnvOverrides(
			provider,
			{ SPARK_OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1' },
			{}
		);
		expect(alreadyV1.baseUrl).toBe('http://127.0.0.1:11434/v1');
	});

	it('does not normalize base URLs for non-localhost hosts', () => {
		const provider = {
			id: 'ollama',
			label: 'Ollama',
			model: 'local-model',
			enabled: false,
			kind: 'openai_compat' as const,
			eventSource: 'ollama',
			baseUrl: 'http://192.168.1.100:11434/v1'
		};

		const override = applyProviderEnvOverrides(
			provider,
			{ SPARK_OLLAMA_BASE_URL: 'http://192.168.1.100:11434' },
			{}
		);
		expect(override.baseUrl).toBe('http://192.168.1.100:11434');
	});

	it('normalizes LM Studio base-url overrides to /v1', () => {
		const provider = {
			id: 'lmstudio',
			label: 'LM Studio',
			model: 'local-model',
			enabled: false,
			kind: 'openai_compat' as const,
			eventSource: 'lmstudio',
			baseUrl: 'http://localhost:1234/v1'
		};

		const override = applyProviderEnvOverrides(
			provider,
			{ SPARK_LMSTUDIO_BASE_URL: 'http://localhost:1234' },
			{}
		);
		expect(override.baseUrl).toBe('http://localhost:1234/v1');
	});
});
