import { describe, expect, it, vi } from 'vitest';
import type { Mission } from '$lib/services/mcp-client';
import {
	buildMultiLLMExecutionPack,
	createDefaultMultiLLMOptions
} from './multi-llm-orchestrator';

function createMission(taskCount = 3): Mission {
	return {
		id: 'mission-test',
		user_id: 'local',
		name: 'Test Mission',
		description: 'Mission for orchestrator tests',
		mode: 'claude-code',
		status: 'ready',
		agents: [],
		tasks: Array.from({ length: taskCount }, (_, index) => ({
			id: `task-${index + 1}`,
			title: `Task ${index + 1}`,
			description: `Description for task ${index + 1}`,
			assignedTo: 'agent-1',
			status: 'pending',
			handoffType: 'sequential' as const
		})),
		context: {
			projectPath: '.',
			projectType: 'tool',
			goals: ['Ship the feature']
		},
		current_task_id: null,
		outputs: {},
		error: null,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		started_at: null,
		completed_at: null
	};
}

function createFastDirectMission(): Mission {
	return {
		...createMission(1),
		name: 'One Step Fast Smoke',
		description:
			'Build a tiny one-file static page. It should show ONE_STEP_FAST_OK and have one button that changes the label. Keep it fast and simple.',
		tasks: [
			{
				id: 'task-fast-static',
				title: 'Build and check the single-file static page',
				description:
					'Create only index.html with embedded CSS/JS, then verify the marker text and button script are present.',
				assignedTo: 'agent-1',
				status: 'pending',
				handoffType: 'sequential' as const
			}
		]
	};
}

describe('multi-llm-orchestrator', () => {
	it('creates default options with local CLI providers plus disabled API providers', () => {
		const options = createDefaultMultiLLMOptions();
		expect(options.enabled).toBe(true);
		expect(options.strategy).toBe('round_robin');
		expect(options.providers.map((provider) => provider.id)).toEqual([
			'claude',
			'codex',
			'openai',
			'zai',
			'kimi',
			'minimax',
			'openrouter',
			'huggingface',
			'lmstudio',
			'ollama'
		]);
		expect(options.providers.find((provider) => provider.id === 'claude')?.model).toBe('opus');
		expect(options.providers.find((provider) => provider.id === 'claude')?.commandTemplate).toBe(
			'claude -p --model {model}'
		);
		expect(options.providers.find((provider) => provider.id === 'lmstudio')?.baseUrl).toBe(
			'http://localhost:1234/v1'
		);
		expect(options.providers.find((provider) => provider.id === 'ollama')?.baseUrl).toBe(
			'http://localhost:11434/v1'
		);
		expect(options.providers.find((provider) => provider.id === 'openai')?.enabled).toBe(false);
		expect(options.providers.find((provider) => provider.id === 'zai')?.enabled).toBe(false);
		expect(options.providers.find((provider) => provider.id === 'kimi')?.enabled).toBe(false);
		expect(options.providers.find((provider) => provider.id === 'kimi')?.baseUrl).toBe(
			'https://api.moonshot.ai/v1'
		);
		expect(options.providers.find((provider) => provider.id === 'minimax')?.enabled).toBe(false);
		expect(options.providers.find((provider) => provider.id === 'openrouter')?.enabled).toBe(false);
		expect(options.providers.find((provider) => provider.id === 'huggingface')?.enabled).toBe(false);
		expect(options.providers.find((provider) => provider.id === 'lmstudio')?.enabled).toBe(false);
		expect(options.providers.find((provider) => provider.id === 'ollama')?.enabled).toBe(false);
	});

	it('assigns tasks round-robin across enabled providers', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'round_robin';
		options.autoRouteByTask = false;
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'claude' || provider.id === 'codex'
		}));

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(4),
			options,
			baseUrl: 'http://localhost:3333'
		});

		expect(pack.strategy).toBe('round_robin');
		expect(pack.providers.map((provider) => provider.id)).toEqual(['claude', 'codex']);
		expect(pack.assignments.claude.taskIds).toEqual(['task-1', 'task-3']);
		expect(pack.assignments.codex.taskIds).toEqual(['task-2', 'task-4']);
		expect(pack.providerPrompts.claude).toContain('Assigned tasks:');
		expect(pack.providerPrompts.codex).toContain('Assigned tasks:');
	});

	it('requires authenticated event bridge reporting in provider prompts', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'codex';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex'
		}));

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(1),
			options,
			baseUrl: 'http://127.0.0.1:3333'
		});

		expect(pack.providerPrompts.codex).toContain('EVENTS_AUTH_KEY="${EVENTS_API_KEY:-$MCP_API_KEY}"');
		expect(pack.providerPrompts.codex).toContain('-H "x-api-key: $EVENTS_AUTH_KEY"');
		expect(pack.providerPrompts.codex).toContain('Missing EVENTS_API_KEY or MCP_API_KEY for /api/events');
	});

	it('keeps generic tasks balanced when auto-route is enabled', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'round_robin';
		options.autoRouteByTask = true;
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'claude' || provider.id === 'codex'
		}));

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(4),
			options
		});

		expect(pack.assignments.claude.taskIds).toEqual(['task-1', 'task-3']);
		expect(pack.assignments.codex.taskIds).toEqual(['task-2', 'task-4']);
	});

	it('falls back to claude when no providers are enabled', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.providers = options.providers.map((provider) => ({ ...provider, enabled: false }));

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(2),
			options
		});

		expect(pack.providers).toHaveLength(1);
		expect(pack.providers[0].id).toBe('claude');
		expect(pack.strategy).toBe('single');
		expect(pack.assignments.claude.taskIds).toEqual(['task-1', 'task-2']);
	});

	it('uses lead-reviewer mode for non-primary providers', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'lead_reviewer';
		options.primaryProviderId = 'codex';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'claude' || provider.id === 'codex'
		}));

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(2),
			options
		});

		expect(pack.primaryProviderId).toBe('codex');
		expect(pack.assignments.codex.mode).toBe('execute');
		expect(pack.assignments.codex.taskIds).toEqual(['task-1', 'task-2']);
		expect(pack.assignments.claude.mode).toBe('review');
		expect(pack.providerPrompts.claude).toContain('provider_feedback');
	});

	it('generates terminal launch command for codex', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'codex';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex'
		}));

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(1),
			options
		});

		expect(pack.providers[0].id).toBe('codex');
		expect(pack.launchCommands.codex).toContain('codex exec --model gpt-5.5');
	});

	it('tells terminal providers not to leave long-lived QA servers running', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'codex';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex'
		}));

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(1),
			options
		});

		expect(pack.providerPrompts.codex).toContain('Do not leave foreground dev servers');
		expect(pack.providerPrompts.codex).toContain('stop it before your final response');
	});

	it('keeps no-build static verification bounded for fast smoke tasks', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'codex';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex'
		}));

		const mission = createMission(2);
		mission.name = 'Fast Lane Size Smoke';
		mission.description =
			'Build lane: fast_direct\nBuild a tiny one-file static page. Keep it fast and simple.';
		mission.context = {
			projectPath: '.',
			projectType: 'single-file-static-web-app',
			techStack: ['Single-file static HTML', 'No build step'],
			goals: [
				'Only index.html is required for the runnable deliverable.',
				'Open index.html directly in a browser.'
			]
		};
		mission.tasks[0].title = 'Build the single-file static page';
		mission.tasks[0].description = 'Create only index.html with embedded CSS and JavaScript.';
		mission.tasks[1].title = 'Check the quick smoke path';
		mission.tasks[1].description =
			'Confirm the marker is present, the interaction is wired, and the file scope stayed tiny.';

		const pack = buildMultiLLMExecutionPack({
			mission,
			options
		});

		expect(pack.providerPrompts.codex).toContain('No-build static project verification');
		expect(pack.providerPrompts.codex).toContain('do not spend more than 30 seconds discovering browser tooling');
		expect(pack.providerPrompts.codex).toContain('complete with file/content evidence');
		expect(pack.providerPrompts.codex).toContain('Do not launch a long-lived browser');
	});

	it('tells single providers not to pre-start every task in a task pack', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'codex';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex'
		}));

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(3),
			options
		});

		expect(pack.providerPrompts.codex).toContain('emit task_started only for the one task you are actively executing now');
		expect(pack.providerPrompts.codex).toContain('Do not pre-start future tasks after loading their skills');
	});

	it('does not make H70 skill loading a hard gate for normal provider execution', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'codex';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex'
		}));

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(1),
			options
		});
		const prompt = pack.providerPrompts.codex;

		expect(prompt).toContain('H70 skill loading (recommended, not a hard gate)');
		expect(prompt).toContain('If H70 skills are unreachable, continue with the task using your base expertise instead of blocking the mission.');
		expect(prompt).toContain('no scoped proof is provided here');
		expect(prompt).toContain('Do not report task_completed unless implementation and verification actually ran.');
		expect(prompt).not.toContain('Authorization: Bearer spark-h70-');
		expect(prompt).not.toContain('H70 skill loading (mandatory)');
		expect(prompt).not.toContain('Do not start task execution until required task skills are loaded');
		expect(prompt).not.toContain('Required H70 skills (load BEFORE task_started)');
	});

	it('passes scoped H70 proof to providers for pro mission skills without making it a completion gate', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'codex';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex'
		}));

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(1),
			options,
			baseUrl: 'http://127.0.0.1:3333',
			h70AccessTokenFile: '/tmp/spark-h70-proof.token',
			taskSkillMap: new Map([['task-1', ['threejs-3d-graphics']]])
		});
		const prompt = pack.providerPrompts.codex;

		expect(prompt).toContain('Recommended H70 skills (use when reachable): `threejs-3d-graphics`');
		expect(prompt).toContain('Use the scoped mission H70 proof file only');
		expect(prompt).toContain('/tmp/spark-h70-proof.token');
		expect(prompt).toContain('Authorization: Bearer $(cat');
		expect(prompt).not.toContain('spark-h70-test-token');
		expect(prompt).toContain('Do not print, echo, copy, persist, screenshot, or include the token contents');
		expect(prompt).toContain('If H70 skills are unreachable, continue with the task using your base expertise instead of blocking the mission.');
	});

	it('skips H70 loading entirely for tiny fast direct missions', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'codex';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex'
		}));

		const pack = buildMultiLLMExecutionPack({
			mission: createFastDirectMission(),
			options,
			taskSkillMap: new Map([['task-fast-static', ['frontend-engineer', 'accessibility']]])
		});
		const prompt = pack.providerPrompts.codex;

		expect(prompt).toContain('Fast direct skill handling');
		expect(prompt).toContain('Do not fetch /api/h70-skills');
		expect(prompt).toContain('Do not fetch /api/h70-skills, read local SKILL.md files, or emit SKILL_SOURCE progress.');
		expect(prompt).not.toContain('Recommended H70 skills');
		expect(prompt).not.toContain('H70 skill loading (recommended, not a hard gate)');
		expect(prompt).not.toContain('SKILL_SOURCE:<taskId>');
	});

	it('auto-enables providers when matching API keys are present', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.autoEnableByKeys = true;
		options.keyPresence = { codex: true };
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: false
		}));
		options.primaryProviderId = 'codex';

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(1),
			options
		});

		expect(pack.providers.map((provider) => provider.id)).toContain('codex');
		expect(pack.primaryProviderId).toBe('codex');
	});

	it('auto-enables API-backed providers when matching keys are present', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.autoEnableByKeys = true;
		options.keyPresence = { zai: true };
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: false
		}));
		options.primaryProviderId = 'zai';

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(1),
			options
		});

		expect(pack.providers.map((provider) => provider.id)).toEqual(['zai']);
		expect(pack.primaryProviderId).toBe('zai');
		expect(pack.launchCommands.zai).toContain('https://api.z.ai/api/coding/paas/v4/chat/completions');
	});

	it('supports LM Studio as an explicit mission provider without an API key', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.autoEnableByKeys = false;
		options.primaryProviderId = 'lmstudio';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'lmstudio',
			model: provider.id === 'lmstudio' ? 'loaded-local-model' : provider.model
		}));

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(1),
			options
		});

		expect(pack.providers.map((provider) => provider.id)).toEqual(['lmstudio']);
		expect(pack.primaryProviderId).toBe('lmstudio');
		expect(pack.providers[0].requiresApiKey).toBe(false);
		expect(pack.providers[0].sparkExecutionBridge).toBe('codex');
		expect(pack.launchCommands.lmstudio).toContain('http://localhost:1234/v1/chat/completions');
		expect(pack.launchCommands.lmstudio).not.toContain('Authorization: Bearer');
	});

	it('supports every setup provider family as an explicit mission provider', () => {
		const options = createDefaultMultiLLMOptions();
		const missionProviderIds = options.providers.map((provider) => provider.id);

		expect(missionProviderIds).toEqual(
			expect.arrayContaining([
				'claude',
				'codex',
				'openai',
				'zai',
				'kimi',
				'minimax',
				'openrouter',
				'huggingface',
				'lmstudio',
				'ollama'
			])
		);
	});

	it('keeps single-provider runs on the selected provider even when other keys are present', () => {
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.autoEnableByKeys = true;
		options.primaryProviderId = 'zai';
		options.keyPresence = { zai: true, minimax: true, codex: true };
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: false
		}));

		const pack = buildMultiLLMExecutionPack({
			mission: createMission(3),
			options
		});

		expect(pack.strategy).toBe('single');
		expect(pack.providers.map((provider) => provider.id)).toEqual(['zai']);
		expect(pack.assignments.zai.taskIds).toEqual(['task-1', 'task-2', 'task-3']);
	});

	it('routes deployment-heavy tasks to codex when auto-route is enabled', () => {
		const mission = createMission(2);
		mission.tasks[0].title = 'Deploy backend service';
		mission.tasks[0].description = 'Release to production and verify deployment pipeline';
		mission.tasks[1].title = 'Write release notes';
		mission.tasks[1].description = 'Summarize changes and rollout guidance';

		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'round_robin';
		options.autoRouteByTask = true;
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex' || provider.id === 'claude'
		}));
		options.primaryProviderId = 'codex';

		const pack = buildMultiLLMExecutionPack({
			mission,
			options
		});

		expect(pack.assignments.codex.taskIds).toContain('task-1');
	});

	it('warns when auto-routing must fall back without a capability match', () => {
		const mission = createMission(1);
		mission.tasks[0].title = 'Create image banner';
		mission.tasks[0].description = 'Generate a visual asset';
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'round_robin';
		options.autoRouteByTask = true;
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex',
			capabilities: ['reasoning']
		}));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		buildMultiLLMExecutionPack({ mission, options });

		expect(warn).toHaveBeenCalledWith(
			'[WARN ][MultiLLMOrchestrator]',
			expect.stringContaining('falling back to first provider'),
			expect.objectContaining({ providerCount: 1 })
		);
		warn.mockRestore();
	});

	it('builds explicit MCP tool plans for matching tasks', () => {
		const mission = createMission(1);
		mission.tasks[0].title = 'Research competitor pricing';
		mission.tasks[0].description = 'Search recent market updates and benchmark pricing trends';

		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'claude';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'claude'
		}));
		options.mcpCapabilities = ['web_search'];
		options.mcpTools = [
			{
				instanceId: 'search-instance',
				mcpName: 'search-mcp',
				toolName: 'web.search',
				capabilities: ['web_search']
			}
		];

		const pack = buildMultiLLMExecutionPack({ mission, options });
		const plan = pack.mcpTaskPlans['task-1'];

		expect(plan.status).toBe('ready');
		expect(plan.toolCalls[0]?.toolName).toBe('web.search');
		expect(plan.toolCalls[0]?.capability).toBe('web_search');
		expect(pack.providerPrompts.claude).toContain('MCP plan');
		expect(pack.providerPrompts.claude).toContain('search-mcp.web.search');
	});

	it('treats unavailable MCP capabilities as advisory fallback guidance', () => {
		const mission = createMission(1);
		mission.tasks[0].title = 'Deploy to production';
		mission.tasks[0].description = 'Release this service to production infrastructure';

		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'codex';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex'
		}));
		options.mcpCapabilities = [];
		options.mcpTools = [];

		const pack = buildMultiLLMExecutionPack({ mission, options });
		const plan = pack.mcpTaskPlans['task-1'];

		expect(plan.status).toBe('blocked');
		expect(plan.blockedReason).toContain('deployment');
		expect(plan.fallbackSuggestion).toContain('Fallback');
		expect(pack.blockedTaskIds).toContain('task-1');
		expect(pack.providerPrompts.codex).toContain('MCP plan: optional MCP unavailable');
		expect(pack.providerPrompts.codex).not.toContain('MCP plan: BLOCKED');
		expect(pack.masterPrompt).toContain('MCP advisories unavailable: 1');
		expect(pack.masterPrompt).not.toContain('MCP plans blocked');
	});

	it('does not infer media MCPs from normal UI animation language', () => {
		const mission = createMission(2);
		mission.tasks[0].title = 'Build orbiting clock UI';
		mission.tasks[0].description = 'Create an animated orbiting clock interface with styled hands and labels';
		mission.tasks[1].title = 'Add three speed controls';
		mission.tasks[1].description = 'Wire slow, normal, and fast buttons to change the UI animation speed';

		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'codex';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex'
		}));
		options.mcpCapabilities = [];
		options.mcpTools = [];

		const pack = buildMultiLLMExecutionPack({ mission, options });

		expect(pack.mcpTaskPlans['task-1'].status).toBe('not_needed');
		expect(pack.mcpTaskPlans['task-2'].status).toBe('not_needed');
		expect(pack.blockedTaskIds).toEqual([]);
		expect(pack.providerPrompts.codex).not.toContain('image_gen');
		expect(pack.providerPrompts.codex).not.toContain('video_gen');
	});

	it('honors a forced single-provider task preference', () => {
		const mission = createMission(2);
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'codex';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex' || provider.id === 'claude'
		}));
		options.taskProviderPreferences = { 'task-1': 'claude' };

		const pack = buildMultiLLMExecutionPack({ mission, options });

		expect(pack.assignments.claude.taskIds).toContain('task-1');
		expect(pack.assignments.codex.taskIds).not.toContain('task-1');
		expect(pack.assignments.codex.taskIds).toContain('task-2');
	});

	it('honors a forced both-provider task preference', () => {
		const mission = createMission(2);
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'claude';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex' || provider.id === 'claude'
		}));
		options.taskProviderPreferences = { 'task-1': 'both' };

		const pack = buildMultiLLMExecutionPack({ mission, options });

		expect(pack.assignments.claude.taskIds).toContain('task-1');
		expect(pack.assignments.codex.taskIds).toContain('task-1');
		expect(pack.assignments.claude.taskIds).toContain('task-2');
	});

	it('honors a forced arbitrary provider task preference', () => {
		const mission = createMission(2);
		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'claude';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'claude' || provider.id === 'zai'
		}));
		options.taskProviderPreferences = { 'task-1': 'zai' };

		const pack = buildMultiLLMExecutionPack({ mission, options });

		expect(pack.assignments.zai.taskIds).toContain('task-1');
		expect(pack.assignments.claude.taskIds).not.toContain('task-1');
		expect(pack.assignments.claude.taskIds).toContain('task-2');
	});

	it('does not treat shell cd preflight commands as deployment requirements', () => {
		const mission = createMission(1);
		mission.tasks[0].title = 'CB-030 Nightly review';
		mission.tasks[0].description =
			'Preflight: cd C:\\Users\\USER\\Desktop\\repo | git rev-parse --show-toplevel';

		const options = createDefaultMultiLLMOptions();
		options.enabled = true;
		options.strategy = 'single';
		options.primaryProviderId = 'codex';
		options.providers = options.providers.map((provider) => ({
			...provider,
			enabled: provider.id === 'codex'
		}));
		options.mcpCapabilities = [];
		options.mcpTools = [];

		const pack = buildMultiLLMExecutionPack({ mission, options });
		const plan = pack.mcpTaskPlans['task-1'];

		expect(plan.status).toBe('not_needed');
		expect(plan.requiredCapabilities).not.toContain('deployment');
		expect(pack.providerPrompts.codex).not.toContain('requires MCP capabilities not currently available');
	});
});
