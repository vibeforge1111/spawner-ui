import type { Mission } from '$lib/services/mcp-client';
import type { MCPCapability } from '$lib/types/mcp';
import { logger } from '$lib/utils/logger';

const log = logger.scope('MultiLLMOrchestrator');

export type MultiLLMProviderKind = 'terminal_cli' | 'openai_compat' | 'custom';
export type MultiLLMCapability = MCPCapability | 'reasoning' | 'planning' | 'review';

export type MultiLLMStrategy =
	| 'single'
	| 'round_robin'
	| 'parallel_consensus'
	| 'lead_reviewer';
export type MultiLLMTaskProviderPreference = 'auto' | 'all' | 'both' | string;

export interface MultiLLMProviderConfig {
	id: string;
	label: string;
	model: string;
	enabled: boolean;
	kind: MultiLLMProviderKind;
	eventSource: string;
	capabilities?: MultiLLMCapability[];
	executesFilesystem?: boolean;
	sparkExecutionBridge?: 'claude' | 'codex';
	requiresApiKey?: boolean;
	baseUrl?: string;
	apiKeyEnv?: string;
	commandTemplate?: string;
}

export interface MultiLLMOrchestratorOptions {
	enabled: boolean;
	strategy: MultiLLMStrategy;
	primaryProviderId?: string;
	autoEnableByKeys?: boolean;
	autoRouteByTask?: boolean;
	autoDispatch?: boolean;
	apiKeys?: Record<string, string>;
	keyPresence?: Record<string, boolean>;
	mcpCapabilities?: MultiLLMCapability[];
	mcpTools?: MultiLLMMCPTool[];
	taskProviderPreferences?: Record<string, MultiLLMTaskProviderPreference>;
	providers: MultiLLMProviderConfig[];
}

export interface MultiLLMMCPTool {
	instanceId: string;
	mcpName: string;
	toolName: string;
	description?: string;
	capabilities: MultiLLMCapability[];
}

export interface MultiLLMMCPToolCallPlan {
	capability: MultiLLMCapability;
	instanceId: string;
	mcpName: string;
	toolName: string;
	description?: string;
	reason: string;
	suggestedArgs: Record<string, unknown>;
}

export interface MultiLLMMCPTaskPlan {
	taskId: string;
	taskTitle: string;
	status: 'not_needed' | 'ready' | 'blocked';
	requiredCapabilities: MultiLLMCapability[];
	toolCalls: MultiLLMMCPToolCallPlan[];
	blockedCapabilities?: MultiLLMCapability[];
	blockedReason?: string;
	fallbackSuggestion?: string;
}

export interface MultiLLMTaskAssignment {
	providerId: string;
	mode: 'execute' | 'review';
	taskIds: string[];
}

export interface MultiLLMExecutionPack {
	enabled: boolean;
	strategy: MultiLLMStrategy;
	primaryProviderId: string;
	providers: MultiLLMProviderConfig[];
	assignments: Record<string, MultiLLMTaskAssignment>;
	mcpTaskPlans: Record<string, MultiLLMMCPTaskPlan>;
	blockedTaskIds: string[];
	masterPrompt: string;
	providerPrompts: Record<string, string>;
	launchCommands: Record<string, string>;
	createdAt: string;
	missionId?: string;
}

export interface MultiLLMBuildInput {
	mission: Mission;
	options: MultiLLMOrchestratorOptions;
	taskSkillMap?: Map<string, string[]>;
	baseUrl?: string;
	h70AccessTokenFile?: string | null;
}

export const DEFAULT_MULTI_LLM_PROVIDERS: MultiLLMProviderConfig[] = [
	{
		id: 'claude',
		label: 'Anthropic Claude',
		model: 'opus',
		enabled: true,
		kind: 'terminal_cli',
		eventSource: 'claude-code',
		capabilities: ['reasoning', 'planning', 'review', 'code_analysis'],
		executesFilesystem: true,
		apiKeyEnv: 'ANTHROPIC_API_KEY',
		requiresApiKey: false,
		commandTemplate: 'claude -p --model {model}'
	},
	{
		id: 'codex',
		label: 'OpenAI Codex',
		model: 'gpt-5.5',
		enabled: true,
		kind: 'terminal_cli',
		eventSource: 'codex',
		capabilities: ['reasoning', 'planning', 'code_analysis', 'code_exec', 'database', 'deployment'],
		executesFilesystem: true,
		apiKeyEnv: 'OPENAI_API_KEY',
		requiresApiKey: false,
		commandTemplate: 'codex exec --model {model}'
	},
	{
		id: 'openai',
		label: 'OpenAI',
		model: 'gpt-5.5',
		enabled: false,
		kind: 'openai_compat',
		eventSource: 'openai',
		capabilities: ['reasoning', 'planning', 'review', 'code_analysis'],
		executesFilesystem: true,
		sparkExecutionBridge: 'codex',
		apiKeyEnv: 'OPENAI_API_KEY',
		requiresApiKey: true,
		baseUrl: 'https://api.openai.com/v1'
	},
	{
		id: 'zai',
		label: 'Z.AI GLM',
		model: 'glm-5.1',
		enabled: false,
		kind: 'openai_compat',
		eventSource: 'zai',
		capabilities: ['reasoning', 'planning', 'review', 'code_analysis'],
		executesFilesystem: true,
		sparkExecutionBridge: 'codex',
		apiKeyEnv: 'ZAI_API_KEY',
		requiresApiKey: true,
		baseUrl: 'https://api.z.ai/api/coding/paas/v4'
	},
	{
		id: 'kimi',
		label: 'Kimi',
		model: 'kimi-k2.6',
		enabled: false,
		kind: 'openai_compat',
		eventSource: 'kimi',
		capabilities: ['reasoning', 'planning', 'review', 'code_analysis'],
		executesFilesystem: true,
		sparkExecutionBridge: 'codex',
		apiKeyEnv: 'KIMI_API_KEY',
		requiresApiKey: true,
		baseUrl: 'https://api.moonshot.ai/v1'
	},
	{
		id: 'minimax',
		label: 'MiniMax',
		model: 'MiniMax-M2.7',
		enabled: false,
		kind: 'openai_compat',
		eventSource: 'minimax',
		capabilities: ['reasoning', 'planning', 'review', 'code_analysis'],
		executesFilesystem: true,
		sparkExecutionBridge: 'codex',
		apiKeyEnv: 'MINIMAX_API_KEY',
		requiresApiKey: true,
		baseUrl: 'https://api.minimax.io/v1'
	},
	{
		id: 'openrouter',
		label: 'OpenRouter',
		model: 'openai/gpt-5.5',
		enabled: false,
		kind: 'openai_compat',
		eventSource: 'openrouter',
		capabilities: ['reasoning', 'planning', 'review', 'code_analysis'],
		executesFilesystem: true,
		sparkExecutionBridge: 'codex',
		apiKeyEnv: 'OPENROUTER_API_KEY',
		requiresApiKey: true,
		baseUrl: 'https://openrouter.ai/api/v1'
	},
	{
		id: 'huggingface',
		label: 'Hugging Face',
		model: 'google/gemma-4-31B-it:fastest',
		enabled: false,
		kind: 'openai_compat',
		eventSource: 'huggingface',
		capabilities: ['reasoning', 'planning', 'review', 'code_analysis'],
		executesFilesystem: true,
		sparkExecutionBridge: 'codex',
		apiKeyEnv: 'HF_TOKEN',
		requiresApiKey: true,
		baseUrl: 'https://router.huggingface.co/v1'
	},
	{
		id: 'lmstudio',
		label: 'LM Studio',
		model: 'local-model',
		enabled: false,
		kind: 'openai_compat',
		eventSource: 'lmstudio',
		capabilities: ['reasoning', 'planning', 'review', 'code_analysis'],
		executesFilesystem: true,
		sparkExecutionBridge: 'codex',
		requiresApiKey: false,
		baseUrl: 'http://localhost:1234/v1'
	},
	{
		id: 'ollama',
		label: 'Ollama',
		model: 'llama3.2:3b',
		enabled: false,
		kind: 'openai_compat',
		eventSource: 'ollama',
		capabilities: ['reasoning', 'planning', 'review', 'code_analysis'],
		executesFilesystem: true,
		sparkExecutionBridge: 'codex',
		requiresApiKey: false,
		baseUrl: 'http://localhost:11434/v1'
	}
];

export function createDefaultMultiLLMOptions(): MultiLLMOrchestratorOptions {
	return {
		enabled: true,
		strategy: 'round_robin',
		primaryProviderId: 'claude',
		autoEnableByKeys: true,
		autoRouteByTask: true,
		autoDispatch: true,
		keyPresence: {},
		mcpCapabilities: [],
		mcpTools: [],
		taskProviderPreferences: {},
		providers: DEFAULT_MULTI_LLM_PROVIDERS.map((provider) => ({ ...provider }))
	};
}

export function buildMultiLLMExecutionPack(input: MultiLLMBuildInput): MultiLLMExecutionPack {
	const baseUrl = input.baseUrl || 'http://localhost:3333';
	const mcpCapabilities = dedupeCapabilities(input.options.mcpCapabilities || []);
	const mcpTools = dedupeMcpTools(input.options.mcpTools || []);
	const providers = getActiveProviders(input.options);
	const primaryProviderId = resolvePrimaryProviderId(providers, input.options.primaryProviderId);
	const strategy = providers.length <= 1 ? 'single' : input.options.strategy;
	const assignments = assignTasks(
		input.mission,
		providers,
		strategy,
		primaryProviderId,
		input.options.autoRouteByTask !== false,
		input.taskSkillMap,
		mcpCapabilities,
		input.options.taskProviderPreferences || {}
	);
	const mcpTaskPlans = buildMcpTaskPlans(input.mission, input.taskSkillMap, mcpCapabilities, mcpTools);
	const blockedTaskIds = Object.values(mcpTaskPlans)
		.filter((plan) => plan.status === 'blocked')
		.map((plan) => plan.taskId);

	const providerPrompts: Record<string, string> = {};
	const launchCommands: Record<string, string> = {};

	for (const provider of providers) {
		const assignment = assignments[provider.id];
		providerPrompts[provider.id] = buildProviderPrompt({
			mission: input.mission,
			provider,
			assignment,
			strategy,
			primaryProviderId,
			baseUrl,
			taskSkillMap: input.taskSkillMap,
			h70AccessTokenFile: input.h70AccessTokenFile,
			mcpCapabilities,
			mcpTaskPlans
		});
		launchCommands[provider.id] = buildLaunchCommand(provider, input.mission.id);
	}

	return {
		enabled: input.options.enabled,
		strategy,
		primaryProviderId,
		providers,
		assignments,
		mcpTaskPlans,
		blockedTaskIds,
		masterPrompt: buildMasterPrompt(
			input.mission,
			providers,
			assignments,
			mcpTaskPlans,
			strategy,
			primaryProviderId,
			baseUrl,
			{
				...input.options,
				mcpCapabilities,
				mcpTools
			}
		),
		providerPrompts,
		launchCommands,
		createdAt: new Date().toISOString()
	};
}

function getActiveProviders(options: MultiLLMOrchestratorOptions): MultiLLMProviderConfig[] {
	const providers = options.providers.map((provider) => ({ ...provider }));
	if (options.autoEnableByKeys !== false) {
		const keyPresence = options.keyPresence || {};
		for (const provider of providers) {
			const hasKey = keyPresence[provider.id] || false;
			const shouldAutoEnable =
				options.strategy !== 'single' ||
				!options.primaryProviderId ||
				provider.id === options.primaryProviderId;
			if (hasKey && shouldAutoEnable && !provider.enabled) {
				provider.enabled = true;
			}
		}
	}

	const active = providers.filter((provider) => provider.enabled);
	if (options.strategy === 'single' && options.primaryProviderId) {
		const selectedProviderIds = new Set<string>([options.primaryProviderId]);
		const preferences = Object.values(options.taskProviderPreferences || {});

		for (const rawPreference of preferences) {
			const preference = rawPreference?.trim();
			if (!preference || preference === 'auto') continue;
			if (preference === 'all') {
				for (const provider of active) {
					selectedProviderIds.add(provider.id);
				}
				continue;
			}
			if (preference === 'both') {
				selectedProviderIds.add('claude');
				selectedProviderIds.add('codex');
				continue;
			}
			selectedProviderIds.add(preference);
		}

		const selectedProviders = providers
			.filter((provider) => selectedProviderIds.has(provider.id))
			.filter(
				(provider) =>
					provider.id === options.primaryProviderId ||
					provider.enabled ||
					Boolean(options.keyPresence?.[provider.id])
			)
			.map((provider) => ({ ...provider, enabled: true }));
		if (selectedProviders.length > 0) {
			return selectedProviders;
		}
	}

	if (active.length > 0) {
		return active;
	}

	const fallback = DEFAULT_MULTI_LLM_PROVIDERS.find((provider) => provider.id === 'claude');
	return [fallback ? { ...fallback } : { ...DEFAULT_MULTI_LLM_PROVIDERS[0] }];
}

function resolvePrimaryProviderId(
	providers: MultiLLMProviderConfig[],
	requestedPrimary?: string
): string {
	if (requestedPrimary && providers.some((provider) => provider.id === requestedPrimary)) {
		return requestedPrimary;
	}
	return providers[0]?.id || 'claude';
}

function assignTasks(
	mission: Mission,
	providers: MultiLLMProviderConfig[],
	strategy: MultiLLMStrategy,
	primaryProviderId: string,
	autoRouteByTask: boolean,
	taskSkillMap?: Map<string, string[]>,
	mcpCapabilities: MultiLLMCapability[] = [],
	taskProviderPreferences: Record<string, MultiLLMTaskProviderPreference> = {}
): Record<string, MultiLLMTaskAssignment> {
	const assignments: Record<string, MultiLLMTaskAssignment> = {};
	const taskIds = mission.tasks.map((task) => task.id);
	const providerById = new Map(providers.map((provider) => [provider.id, provider]));
	const primaryProvider = providers.find((provider) => provider.id === primaryProviderId) || providers[0];

	for (const provider of providers) {
		assignments[provider.id] = {
			providerId: provider.id,
			mode: 'execute',
			taskIds: []
		};
	}

	const addTaskToProvider = (providerId: string, taskId: string): boolean => {
		const assignment = assignments[providerId];
		if (!assignment) return false;
		if (!assignment.taskIds.includes(taskId)) {
			assignment.taskIds.push(taskId);
		}
		return true;
	};

	const resolveTaskPreference = (taskId: string): MultiLLMTaskProviderPreference => {
		const preference = taskProviderPreferences[taskId]?.trim();
		if (!preference || preference === 'auto') {
			return 'auto';
		}
		if (preference === 'all' || preference === 'both') {
			return preference;
		}
		if (providerById.has(preference)) {
			return preference;
		}
		return 'auto';
	};

	const unassignedTaskIds: string[] = [];
	for (const taskId of taskIds) {
		const preference = resolveTaskPreference(taskId);
		if (preference === 'all') {
			for (const provider of providers) {
				addTaskToProvider(provider.id, taskId);
			}
			continue;
		}
		if (preference === 'both') {
			const selectedProviderIds = ['claude', 'codex'].filter((providerId) => providerById.has(providerId));
			if (selectedProviderIds.length > 0) {
				for (const providerId of selectedProviderIds) {
					addTaskToProvider(providerId, taskId);
				}
				continue;
			}
		} else if (preference !== 'auto') {
			if (addTaskToProvider(preference, taskId)) {
				continue;
			}
		}

		unassignedTaskIds.push(taskId);
	}

	if (strategy === 'single') {
		for (const taskId of unassignedTaskIds) {
			addTaskToProvider(primaryProvider.id, taskId);
		}
		return assignments;
	}

	if (strategy === 'round_robin') {
		const taskById = new Map(mission.tasks.map((task) => [task.id, task]));
		unassignedTaskIds.forEach((taskId, index) => {
			const task = taskById.get(taskId);
			if (autoRouteByTask && task) {
				const taskCapabilities = inferTaskCapabilities(
					task.title,
					task.description,
					taskSkillMap?.get(task.id) || [],
					mcpCapabilities
				);
				const specificCapabilities = taskCapabilities.filter(
					(capability) =>
						capability !== 'reasoning' && capability !== 'planning' && capability !== 'review'
				);
				if (specificCapabilities.length === 0) {
					const fallbackProvider = providers[index % providers.length];
					addTaskToProvider(fallbackProvider.id, taskId);
					return;
				}

				const preferredProvider = selectBestProviderForTask(
					task,
					providers,
					taskSkillMap?.get(task.id) || [],
					mcpCapabilities
				);
				addTaskToProvider(preferredProvider.id, taskId);
				return;
			}

			const provider = providers[index % providers.length];
			addTaskToProvider(provider.id, taskId);
		});
		return assignments;
	}

	if (strategy === 'parallel_consensus') {
		for (const provider of providers) {
			for (const taskId of unassignedTaskIds) {
				addTaskToProvider(provider.id, taskId);
			}
		}
		return assignments;
	}

	// lead_reviewer
	for (const taskId of unassignedTaskIds) {
		addTaskToProvider(primaryProvider.id, taskId);
	}
	for (const provider of providers) {
		if (provider.id === primaryProviderId) continue;
		if (assignments[provider.id].taskIds.length > 0) {
			assignments[provider.id].mode = 'execute';
			continue;
		}
		assignments[provider.id].mode = 'review';
		assignments[provider.id].taskIds = [...taskIds];
	}
	return assignments;
}

function selectBestProviderForTask(
	task: Mission['tasks'][number],
	providers: MultiLLMProviderConfig[],
	taskSkills: string[],
	mcpCapabilities: MultiLLMCapability[]
): MultiLLMProviderConfig {
	const taskCapabilities = inferTaskCapabilities(task.title, task.description, taskSkills, mcpCapabilities);
	let bestProvider = providers[0];
	let bestScore = -1;

	for (const provider of providers) {
		const providerCaps = provider.capabilities || [];
		const specificCapabilities = taskCapabilities.filter(
			(capability) => capability !== 'reasoning' && capability !== 'planning' && capability !== 'review'
		);
		let directMatches = 0;
		for (const capability of specificCapabilities) {
			if (providerCaps.includes(capability)) directMatches += 1;
		}
		let score = directMatches * 4;
		if (directMatches === 0 && specificCapabilities.length === 0) {
			if (providerCaps.includes('reasoning')) score += 1;
			if (providerCaps.includes('planning')) score += 1;
		}
		if (score > bestScore) {
			bestScore = score;
			bestProvider = provider;
		}
	}

	if (bestScore <= 0) {
		log.warn(
			`selectBestProviderForTask: no provider matched task "${task.title}" — falling back to first provider "${bestProvider.id}"`,
			{ taskCapabilities, providerCount: providers.length }
		);
	}

	return bestProvider;
}

function inferTaskCapabilities(
	title: string,
	description: string,
	taskSkills: string[],
	mcpCapabilities: MultiLLMCapability[]
): MultiLLMCapability[] {
	const text = `${title} ${description} ${taskSkills.join(' ')}`.toLowerCase();
	const capabilities = new Set<MultiLLMCapability>(['reasoning']);

	if (/\b(code|api|backend|frontend|implement|refactor|fix|typescript|javascript|python)\b/.test(text)) {
		capabilities.add('code_analysis');
	}
	if (/\b(test|qa|verify|validation|regression|coverage)\b/.test(text)) {
		capabilities.add('code_analysis');
	}
	if (/\b(image|logo|illustration|thumbnail|screenshot|banner|poster|graphic)\b/.test(text)) {
		capabilities.add('image_gen');
	}
	if (/\b(video|reel|animation|clip|cinematic|trailer)\b/.test(text)) {
		capabilities.add('video_gen');
	}
	if (/\b(audio|voice|tts|podcast|music)\b/.test(text)) {
		capabilities.add('audio_gen');
	}
	if (/\b(search|research|crawl|discover|investigate)\b/.test(text)) {
		capabilities.add('web_search');
	}
	if (/\b(database|schema|migration|sql|postgres|mysql|redis)\b/.test(text)) {
		capabilities.add('database');
	}
	if (/\b(deploy|release|production|ci|pipeline|infra|infrastructure)\b|ci\/cd|ci-cd|\bcicd\b/.test(text)) {
		capabilities.add('deployment');
	}

	for (const mcpCapability of mcpCapabilities) {
		if (capabilities.has(mcpCapability)) continue;
		if (mcpCapability === 'database' && /\b(data|db|schema|migration|query)\b/.test(text)) {
			capabilities.add('database');
		}
		if (mcpCapability === 'image_gen' && /\b(image|logo|illustration|thumbnail|banner|poster|sprite|icon asset|generated asset)\b/.test(text)) {
			capabilities.add('image_gen');
		}
		if (mcpCapability === 'video_gen' && /\b(video|clip|cinematic|trailer|rendered animation|generated animation)\b/.test(text)) {
			capabilities.add('video_gen');
		}
		if (mcpCapability === 'web_search' && /\b(research|compare|trend)\b/.test(text)) {
			capabilities.add('web_search');
		}
	}

	return [...capabilities];
}

const MCP_REQUIRED_RULES: Array<{ capability: MultiLLMCapability; pattern: RegExp }> = [
	{ capability: 'web_search', pattern: /\b(search|research|crawl|discover|investigate|benchmark|compare|trend)\b/ },
	{ capability: 'database', pattern: /\b(database|schema|migration|sql|postgres|mysql|redis|query|data model)\b/ },
	{
		capability: 'deployment',
		pattern: /\b(deploy|release|production|rollout|infra|infrastructure|ci)\b|ci\/cd|ci-cd|\bcicd\b/
	},
	{
		capability: 'image_gen',
		pattern: /\b(generate|create|make|render|draw)\s+(an?\s+)?(image|logo|illustration|thumbnail|banner|poster|sprite|icon|graphic|asset)\b|\b(image generation|ai image|generated image|placeholder asset)\b/
	},
	{
		capability: 'video_gen',
		pattern: /\b(generate|create|make|render|produce)\s+(a\s+)?(video|clip|cinematic|trailer|rendered animation)\b|\b(video generation|generated video)\b/
	},
	{ capability: 'audio_gen', pattern: /\b(audio|voice|tts|podcast|music)\b/ },
	{ capability: 'payment', pattern: /\b(payment|checkout|billing|invoice|stripe|paypal)\b/ }
];

const MCP_FALLBACK_SUGGESTIONS: Record<string, string> = {
	web_search: 'Fallback: proceed with documented assumptions and flag unknowns for manual verification.',
	database: 'Fallback: design schema and queries locally; defer execution until a database MCP is connected.',
	deployment: 'Fallback: generate deployment plan/scripts only and hand off final release to operator.',
	image_gen: 'Fallback: produce text-only design spec and placeholder assets.',
	video_gen: 'Fallback: provide storyboard/script and defer rendering to a media MCP.',
	audio_gen: 'Fallback: provide transcript/script and defer synthesis to an audio MCP.',
	payment: 'Fallback: stub payment integration with mock adapters until a payment MCP is connected.'
};

function dedupeCapabilities(capabilities: MultiLLMCapability[]): MultiLLMCapability[] {
	return [...new Set(capabilities)];
}

function dedupeMcpTools(tools: MultiLLMMCPTool[]): MultiLLMMCPTool[] {
	const seen = new Set<string>();
	const deduped: MultiLLMMCPTool[] = [];
	for (const tool of tools) {
		const key = `${tool.instanceId}:${tool.toolName}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push({
			...tool,
			capabilities: dedupeCapabilities(tool.capabilities)
		});
	}
	return deduped;
}

function inferRequiredMcpCapabilities(
	title: string,
	description: string,
	taskSkills: string[]
): MultiLLMCapability[] {
	const text = `${title} ${description} ${taskSkills.join(' ')}`.toLowerCase();
	const required = new Set<MultiLLMCapability>();
	for (const rule of MCP_REQUIRED_RULES) {
		if (rule.pattern.test(text)) {
			required.add(rule.capability);
		}
	}
	return [...required];
}

function buildSuggestedArgs(capability: MultiLLMCapability, task: Mission['tasks'][number]): Record<string, unknown> {
	const title = task.title || 'task';
	if (capability === 'web_search') {
		return { query: title, limit: 5 };
	}
	if (capability === 'database') {
		return { operation: 'query', task: title };
	}
	if (capability === 'deployment') {
		return { environment: 'staging', task: title };
	}
	if (capability === 'image_gen') {
		return { prompt: task.description || title, format: 'png' };
	}
	if (capability === 'video_gen') {
		return { prompt: task.description || title, durationSeconds: 8 };
	}
	if (capability === 'audio_gen') {
		return { text: task.description || title, voice: 'default' };
	}
	if (capability === 'payment') {
		return { action: 'simulate_checkout', task: title };
	}
	return { task: title };
}

function getFallbackSuggestion(blockedCapabilities: MultiLLMCapability[]): string {
	if (blockedCapabilities.length === 0) {
		return 'Fallback: continue with standard provider reasoning flow.';
	}
	return blockedCapabilities
		.map((capability) => MCP_FALLBACK_SUGGESTIONS[capability] || `Fallback: continue without MCP capability "${capability}".`)
		.join(' ');
}

function buildMcpTaskPlans(
	mission: Mission,
	taskSkillMap: Map<string, string[]> | undefined,
	mcpCapabilities: MultiLLMCapability[],
	mcpTools: MultiLLMMCPTool[]
): Record<string, MultiLLMMCPTaskPlan> {
	const plans: Record<string, MultiLLMMCPTaskPlan> = {};
	const mcpCapabilitySet = new Set(mcpCapabilities);

	for (const task of mission.tasks) {
		const taskSkills = taskSkillMap?.get(task.id) || [];
		const requiredCapabilities = inferRequiredMcpCapabilities(task.title, task.description, taskSkills);
		if (requiredCapabilities.length === 0) {
			plans[task.id] = {
				taskId: task.id,
				taskTitle: task.title,
				status: 'not_needed',
				requiredCapabilities: [],
				toolCalls: []
			};
			continue;
		}

		const toolCalls: MultiLLMMCPToolCallPlan[] = [];
		const blockedCapabilities: MultiLLMCapability[] = [];

		for (const capability of requiredCapabilities) {
			const matchingTools = mcpTools.filter((tool) => tool.capabilities.includes(capability));
			const selectedTool = matchingTools[0];
			if (selectedTool) {
				toolCalls.push({
					capability,
					instanceId: selectedTool.instanceId,
					mcpName: selectedTool.mcpName,
					toolName: selectedTool.toolName,
					description: selectedTool.description,
					reason: `Task requires "${capability}" capability.`,
					suggestedArgs: buildSuggestedArgs(capability, task)
				});
				continue;
			}

			// Deterministic blocked classification:
			// if capability appears required and no matching MCP tool is connected, emit blocked metadata.
			if (!mcpCapabilitySet.has(capability) || matchingTools.length === 0) {
				blockedCapabilities.push(capability);
			}
		}

		if (blockedCapabilities.length > 0) {
			const blockedLabel = blockedCapabilities.join(', ');
			plans[task.id] = {
				taskId: task.id,
				taskTitle: task.title,
				status: 'blocked',
				requiredCapabilities,
				toolCalls,
				blockedCapabilities,
				blockedReason: `Optional MCP capability unavailable for "${task.title}": ${blockedLabel}.`,
				fallbackSuggestion: getFallbackSuggestion(blockedCapabilities)
			};
			continue;
		}

		plans[task.id] = {
			taskId: task.id,
			taskTitle: task.title,
			status: 'ready',
			requiredCapabilities,
			toolCalls
		};
	}

	return plans;
}

function formatTaskMcpPlan(plan: MultiLLMMCPTaskPlan | undefined): string {
	if (!plan || plan.status === 'not_needed') {
		return '\n   MCP plan: not required';
	}
	if (plan.status === 'blocked') {
		return `\n   MCP plan: optional MCP unavailable\n   - ${plan.blockedReason}\n   - ${plan.fallbackSuggestion}`;
	}
	if (plan.toolCalls.length === 0) {
		return '\n   MCP plan: ready (no explicit tool calls)';
	}

	const toolLines = plan.toolCalls.map((call) => {
		const args = JSON.stringify(call.suggestedArgs);
		return `\n   - ${call.capability}: ${call.mcpName}.${call.toolName} args=${args}`;
	});
	return `\n   MCP plan:${toolLines.join('')}`;
}

function buildMasterPrompt(
	mission: Mission,
	providers: MultiLLMProviderConfig[],
	assignments: Record<string, MultiLLMTaskAssignment>,
	mcpTaskPlans: Record<string, MultiLLMMCPTaskPlan>,
	strategy: MultiLLMStrategy,
	primaryProviderId: string,
	baseUrl: string,
	options: MultiLLMOrchestratorOptions
): string {
	const providerLines = providers.map((provider) => {
		const assignment = assignments[provider.id];
		const role = assignment.mode === 'review' ? 'reviewer' : 'executor';
		const tasks = assignment.taskIds.length;
		return `- ${provider.label} (${provider.id}, ${provider.model}) -> ${role}, ${tasks} task(s)`;
	});
	const mcpCapabilities = (options.mcpCapabilities || []).join(', ') || 'none detected';
	const keyConnectedProviders = providers
		.filter((provider) => (options.keyPresence || {})[provider.id])
		.map((provider) => provider.id)
		.join(', ') || 'none';
	const taskPlans = Object.values(mcpTaskPlans);
	const readyCount = taskPlans.filter((plan) => plan.status === 'ready').length;
	const blockedPlans = taskPlans.filter((plan) => plan.status === 'blocked');
	const unavailableLines =
		blockedPlans.length > 0
			? blockedPlans
					.map(
						(plan) =>
							`- ${plan.taskId}: ${plan.blockedReason} ${plan.fallbackSuggestion || ''}`.trim()
					)
					.join('\n')
			: '- none';

	return `# Multi-LLM Orchestrator

Mission: ${mission.name}
Mission ID: ${mission.id}
Strategy: ${strategy}
Primary provider: ${primaryProviderId}
Event endpoint: ${baseUrl}/api/events
Auto enable by keys: ${options.autoEnableByKeys !== false ? 'enabled' : 'disabled'}
Auto route by task: ${options.autoRouteByTask !== false ? 'enabled' : 'disabled'}
API-key-ready providers: ${keyConnectedProviders}
Connected MCP capabilities: ${mcpCapabilities}
MCP tool catalog size: ${(options.mcpTools || []).length}
MCP plans ready: ${readyCount}
MCP advisories unavailable: ${blockedPlans.length}

Providers and assignments:
${providerLines.join('\n')}

Unavailable MCP advisories:
${unavailableLines}

Execution rules:
1. Use each provider prompt as generated by Spawner.
2. Keep all providers on the same mission ID and task IDs.
3. Report events with the provider-specific source field.
4. For review providers, send provider_feedback events instead of task status updates.
5. Mark mission complete only after executor tasks are all done.
`;
}

interface BuildProviderPromptInput {
	mission: Mission;
	provider: MultiLLMProviderConfig;
	assignment: MultiLLMTaskAssignment;
	strategy: MultiLLMStrategy;
	primaryProviderId: string;
	baseUrl: string;
	taskSkillMap?: Map<string, string[]>;
	h70AccessTokenFile?: string | null;
	mcpCapabilities: MultiLLMCapability[];
	mcpTaskPlans: Record<string, MultiLLMMCPTaskPlan>;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildProviderPrompt(input: BuildProviderPromptInput): string {
	const {
		mission,
		provider,
		assignment,
		strategy,
		primaryProviderId,
		baseUrl,
		taskSkillMap,
		h70AccessTokenFile,
		mcpCapabilities,
		mcpTaskPlans
	} = input;
	const isPrimary = provider.id === primaryProviderId;
	const canReportTaskLifecycle =
		assignment.mode === 'execute' &&
		(strategy === 'single' ||
			strategy === 'round_robin' ||
			(strategy === 'parallel_consensus' && isPrimary) ||
			(strategy === 'lead_reviewer' && isPrimary));

	const eventSource = provider.eventSource || provider.id;
	const assignedTasks = mission.tasks.filter((task) => assignment.taskIds.includes(task.id));
	const fastDirectMission = isFastDirectMission(mission);

	const taskList = assignedTasks
		.map((task, index) => {
			const deps = task.dependsOn?.length ? ` after: ${task.dependsOn.join(', ')}` : '';
			const recommendedSkills = taskSkillMap?.get(task.id) || [];
			const skillsLine =
				recommendedSkills.length > 0 && !fastDirectMission
					? `\n   Recommended H70 skills (use when reachable): ${recommendedSkills.map((skill) => `\`${skill}\``).join(', ')}`
					: '';
			const mcpPlanLine = formatTaskMcpPlan(mcpTaskPlans[task.id]);
			return `${index + 1}. ${task.title} (id: ${task.id}${deps})\n   ${task.description}${skillsLine}${mcpPlanLine}`;
		})
		.join('\n\n');

	const eventAuthSetup = `Before POSTing lifecycle/review events:
EVENTS_AUTH_KEY="\${EVENTS_API_KEY:-$MCP_API_KEY}"
test -n "$EVENTS_AUTH_KEY" || { echo "Missing EVENTS_API_KEY or MCP_API_KEY for /api/events"; exit 1; }`;
	const reportingBlock = canReportTaskLifecycle
		? `${eventAuthSetup}

Report lifecycle events:
curl -X POST ${baseUrl}/api/events -H "Content-Type: application/json" -H "x-api-key: $EVENTS_AUTH_KEY" -d '{"type":"task_started","missionId":"${mission.id}","taskId":"TASK_ID","taskName":"TASK_NAME","source":"${eventSource}"}'
curl -X POST ${baseUrl}/api/events -H "Content-Type: application/json" -H "x-api-key: $EVENTS_AUTH_KEY" -d '{"type":"progress","missionId":"${mission.id}","taskId":"TASK_ID","progress":50,"message":"Working...","source":"${eventSource}"}'
curl -X POST ${baseUrl}/api/events -H "Content-Type: application/json" -H "x-api-key: $EVENTS_AUTH_KEY" -d '{"type":"task_completed","missionId":"${mission.id}","taskId":"TASK_ID","taskName":"TASK_NAME","data":{"success":true,"verification":{"build":true,"typecheck":true,"filesChanged":["src/file.ts"]}},"source":"${eventSource}"}'

When all assigned tasks are complete:
curl -X POST ${baseUrl}/api/events -H "Content-Type: application/json" -H "x-api-key: $EVENTS_AUTH_KEY" -d '{"type":"mission_completed","missionId":"${mission.id}","source":"${eventSource}"}'`
		: `${eventAuthSetup}

Send review feedback events only (do not emit task_started/task_completed):
curl -X POST ${baseUrl}/api/events -H "Content-Type: application/json" -H "x-api-key: $EVENTS_AUTH_KEY" -d '{"type":"provider_feedback","missionId":"${mission.id}","taskId":"TASK_ID","source":"${eventSource}","data":{"provider":"${provider.id}","summary":"feedback here","approved":true}}'`;

	const roleLine = assignment.mode === 'review' ? 'Role: Reviewer' : 'Role: Executor';
	const providerCaps = (provider.capabilities || []).join(', ') || 'reasoning';
	const mcpCapsLine = mcpCapabilities.length > 0 ? mcpCapabilities.join(', ') : 'none';
	const projectContract = buildProjectContractBlock(mission);
	const verificationBlock = buildVerificationBlock(mission);
	const h70AccessTokenFileArg = h70AccessTokenFile ? shellSingleQuote(h70AccessTokenFile) : '';
	const h70AuthLine = h70AccessTokenFile
		? `- Use the scoped mission H70 proof file only when fetching listed skills: ${h70AccessTokenFile}
- Fetch with: curl -H "Authorization: Bearer $(cat ${h70AccessTokenFileArg})" ${baseUrl}/api/h70-skills/<skill-id>
- This proof is limited to the assigned mission skills and expires automatically. Do not print, echo, copy, persist, screenshot, or include the token contents in progress events, task results, files, logs, or final answers.`
		: '- If a skill endpoint asks for Spark Pro proof and no scoped proof is provided here, treat that skill as unreachable and continue.';
	const skillLoadingBlock = fastDirectMission
		? `Fast direct skill handling:
- Treat skill labels as planning metadata only for this tiny task.
- Do not fetch /api/h70-skills, read local SKILL.md files, or emit SKILL_SOURCE progress.
- Start by creating the requested file, then run the file/content checks.`
		: `H70 skill loading (recommended, not a hard gate):
- For each assigned task with listed skills, try to fetch the recommended skills via ${baseUrl}/api/h70-skills/<skill-id> before implementation.
${h70AuthLine}
- If H70 skills are reachable, apply their anti-pattern and disaster guidance before implementation.
- If H70 skills are unreachable, continue with the task using your base expertise instead of blocking the mission.
- When H70 loading succeeds or fails, emit one progress event documenting the source state before task_started (message format: "SKILL_SOURCE:<taskId>:loaded:<skillId,...>" or "SKILL_SOURCE:<taskId>:unavailable:<reason>").
- Do not report task_completed unless implementation and verification actually ran.`;

	return `# Provider Prompt: ${provider.label}

Mission: ${mission.name}
Mission ID: ${mission.id}
Provider: ${provider.id}
Model: ${provider.model}
Provider capabilities: ${providerCaps}
${roleLine}
Strategy: ${strategy}
Connected MCP capabilities: ${mcpCapsLine}

${projectContract}

Assigned tasks:
${taskList || '- none'}

${skillLoadingBlock}

Execution expectations:
- Work only on your assigned tasks.
- In single-provider or task-pack runs, emit task_started only for the one task you are actively executing now. Do not pre-start future tasks after loading their skills.
- If you prepare or load skills for future tasks, report that as progress only. Send task_started for the next task only after the previous task is completed or blocked.
- Keep file changes focused and production-safe.
- If blocked by implementation constraints, emit a progress event with the blocker.
- If a task explicitly needs external tools (image/video/data/deploy), use matching connected MCP capabilities when connected; otherwise continue with the fallback plan.
- Treat task completion as valid only after task-level DoD checks pass (implementation + verification + tests).
- Do not leave foreground dev servers, preview servers, http servers, file watchers, or browser sessions running. If browser QA needs a server, start it in a bounded/background way, stop it before your final response, and never let the provider process wait on a long-lived server.

Project-specific verification override:
${verificationBlock}
If this conflicts with the generic verification checklist below, follow the project-specific override.

Verify Before Reporting Complete (REQUIRED per task):
1. Run the project build command (npm run build or equivalent) — report pass/fail
2. Run type checking (npx tsc --noEmit or framework equivalent) — report error count
3. List all files you created or modified for this task
Include verification results in your task_completed event data.verification field:
{"build": true/false, "typecheck": true/false, "filesChanged": ["path/to/file.ts"]}

Mission Completion Gate:
Do NOT send mission_completed until:
- ALL assigned tasks have been attempted and report success
- Final build passes with zero errors
- No TypeScript errors remain
The system will reconcile task statuses and generate a checkpoint for human review. If tasks are still pending, the mission will be marked as partial — not complete.

${reportingBlock}
`;
}

function buildProjectContractBlock(mission: Mission): string {
	const context = mission.context;
	const lines = [
		'Project contract:',
		`- Project path: ${context?.projectPath || '.'}`,
		`- Project type: ${context?.projectType || 'general'}`
	];

	if (context?.techStack?.length) {
		lines.push(`- Tech stack / constraints: ${context.techStack.join(', ')}`);
	}

	if (context?.goals?.length) {
		lines.push('- Goals and constraints:');
		for (const goal of context.goals) {
			lines.push(`  - ${goal}`);
		}
	}

	if (mission.description?.trim()) {
		lines.push('- Source request:', indentForPrompt(mission.description.trim(), '  '));
	}

	return lines.join('\n');
}

function missionContractText(mission: Mission): string {
	return [
		mission.name,
		mission.description,
		mission.context?.projectPath,
		mission.context?.projectType,
		...(mission.context?.techStack || []),
		...(mission.context?.goals || []),
		...mission.tasks.flatMap((task) => [task.title, task.description])
	].join('\n');
}

function isNoBuildVanillaMission(mission: Mission): boolean {
	const text = missionContractText(mission).toLowerCase();
	return (
		/\bno\s+build\s+step\b/.test(text) ||
		/\bvanilla[-\s]?js\b/.test(text) ||
		/\bno\s+dependencies\b/.test(text) ||
		/\bopen(?:ing)?\s+index\.html\s+directly\b/.test(text)
	);
}

function isFastDirectMission(mission: Mission): boolean {
	const text = missionContractText(mission).toLowerCase();
	const hasTinyScope =
		mission.tasks.length <= 1 &&
		(/\bone[-\s]?file\b/.test(text) ||
			/\bsingle[-\s]?file\b/.test(text) ||
			/\bstatic page\b/.test(text));
	const asksForSpeed = /\bfast\b/.test(text) || /\bsimple\b/.test(text) || /\bsmoke\b/.test(text);
	return hasTinyScope && asksForSpeed;
}

function buildVerificationBlock(mission: Mission): string {
	if (isNoBuildVanillaMission(mission)) {
		return [
			'No-build static project verification:',
			'- Do not add npm, package.json, lockfiles, TypeScript config, framework scaffold, bundler config, or dependency installation unless explicitly requested.',
			'- Confirm the requested root files exist in the project path and use direct relative browser links.',
			'- Run syntax/content checks appropriate for static files, such as node --check app.js and Select-String/Test-Path checks from the task acceptance criteria.',
			'- For fast-lane or single-file smoke tasks, do not spend more than 30 seconds discovering browser tooling. If no browser harness is immediately available, mark browser smoke as not applicable and complete with file/content evidence.',
			'- Do not launch a long-lived browser, dev server, package install, or tooling search just to verify a direct-open index.html smoke page.',
			'- List all files you created or modified for this task.'
		].join('\n');
	}

	return [
		'Standard project verification:',
		'- Run the project build command if the project defines one and report pass/fail.',
		'- Run type checking only if the project uses TypeScript or defines a typecheck script; otherwise report it as not applicable.',
		'- List all files you created or modified for this task.'
	].join('\n');
}

function indentForPrompt(text: string, prefix: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => `${prefix}${line}`)
		.join('\n');
}

function buildLaunchCommand(provider: MultiLLMProviderConfig, missionId: string): string {
	const promptFile = `configured Spawner state root/prompts/${missionId}-${provider.id}.md`;

	if (provider.kind === 'terminal_cli') {
		const command = (provider.commandTemplate || '').replace('{model}', provider.model).trim();
		return [
			`# ${provider.label} terminal launch`,
			`# 1) Save this provider prompt to ${promptFile}`,
			`# 2) Run command and paste prompt if your CLI does not accept stdin`,
			command || `# No command template configured for ${provider.id}`
		].join('\n');
	}

	if (provider.kind === 'openai_compat') {
		const baseUrl = provider.baseUrl || '<BASE_URL>';
		const apiKeyEnv = provider.apiKeyEnv || 'API_KEY';
		const authHeader = provider.requiresApiKey
			? `  -H "Authorization: Bearer $${apiKeyEnv}" \\`
			: '  # No API key required for this local OpenAI-compatible provider \\';
		return [
			`# ${provider.label} OpenAI-compatible launch`,
			`# 1) Save this provider prompt to ${promptFile}`,
			`# 2) Build a request JSON using model "${provider.model}" and prompt content`,
			`curl -sS ${baseUrl}/chat/completions \\`,
			authHeader,
			`  -H "Content-Type: application/json" \\`,
			`  -d @${provider.id}-request.json`
		].join('\n');
	}

	if (provider.kind === 'custom') {
		const customCommand = (provider.commandTemplate || '').replace('{model}', provider.model).trim();
		return [
			`# ${provider.label} custom launch`,
			`# 1) Save this provider prompt to ${promptFile}`,
			`# 2) Use your provider SDK/API with model "${provider.model}"`,
			customCommand || `# No custom command template configured for ${provider.id}`
		].join('\n');
	}

	return `# Launch required for provider "${provider.id}"`;
}
