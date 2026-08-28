import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { requireControlAuth } from '$lib/server/mcp-auth';
import { DEFAULT_MULTI_LLM_PROVIDERS } from '$lib/services/multi-llm-orchestrator';
import { applyProviderEnvOverrides, resolveProviderRuntimeConfiguration } from '$lib/server/provider-config';

function providerAuthPayload(event: Parameters<typeof requireControlAuth>[0]) {
	const openRead = requireControlAuth(event, {
		surface: 'Providers',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: true,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
	if (openRead) return { openRead, hasControlAuth: false };

	const strictRead = requireControlAuth(event, {
		surface: 'Providers',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});

	return { openRead: null, hasControlAuth: strictRead === null };
}

function normalizeProviderId(value: string | undefined): string | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return null;
	return DEFAULT_MULTI_LLM_PROVIDERS.some((provider) => provider.id === normalized)
		? normalized
		: null;
}

export const GET: RequestHandler = async (event) => {
	const { openRead, hasControlAuth } = providerAuthPayload(event);
	if (openRead) return openRead;

	const envRecord = env as Record<string, string | undefined>;
	const sparkDefaultProvider =
		normalizeProviderId(envRecord.DEFAULT_MISSION_PROVIDER) ||
		normalizeProviderId(envRecord.SPARK_MISSION_LLM_BOT_PROVIDER) ||
		normalizeProviderId(envRecord.SPARK_MISSION_LLM_PROVIDER) ||
		normalizeProviderId(envRecord.SPARK_BOT_DEFAULT_PROVIDER) ||
		normalizeProviderId(envRecord.SPARK_LLM_PROVIDER) ||
		normalizeProviderId(envRecord.SPARK_SPARK_LLM_PROVIDER);

	return json({
		sparkDefaultProvider,
		...(hasControlAuth
			? {}
			: {
					authorityBoundary: {
						payload: 'status_only',
						commandTemplate: 'requires_control_auth',
						sparkExecutionBridge: 'requires_control_auth',
						apiKeyEnv: 'requires_control_auth',
						cliPath: 'requires_control_auth',
						baseUrl: 'requires_control_auth',
						executesFilesystem: 'requires_control_auth'
					}
				}),
		providers: DEFAULT_MULTI_LLM_PROVIDERS.map((defaultProvider) => {
			const provider = applyProviderEnvOverrides(defaultProvider, envRecord, {
				missionDefaultProviderId: sparkDefaultProvider
			});
			const runtimeConfig = resolveProviderRuntimeConfiguration(provider, envRecord);

			const basePayload = {
				id: provider.id,
				label: provider.label,
				kind: provider.kind,
				model: provider.model,
				requiresApiKey: provider.requiresApiKey === true,
				envKeyConfigured: runtimeConfig.envKeyConfigured,
				cliConfigured: runtimeConfig.cliConfigured,
				configured: runtimeConfig.configured,
				configurationMode: runtimeConfig.configurationMode,
				sparkSelected: sparkDefaultProvider === provider.id
			};

			if (!hasControlAuth) return basePayload;

			return {
				...basePayload,
				baseUrl: provider.baseUrl || null,
				commandTemplate: provider.commandTemplate || null,
				sparkExecutionBridge: provider.sparkExecutionBridge || null,
				executesFilesystem: provider.executesFilesystem === true,
				apiKeyEnv: provider.apiKeyEnv || null,
				cliPath: runtimeConfig.cliPath
			};
		})
	});
};
