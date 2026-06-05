<script lang="ts">
	import {
		missionExecutor,
		type AgentRuntimeStatus,
		type ExecutionProgress,
		type ExecutionStatus,
		type LoadedSkillInfo,
		type TaskTransitionEvent
	} from '$lib/services/mission-executor';
	import type { MissionLog, Mission } from '$lib/services/mcp-client';
	import { nodes, connections, canvasState, updateNodeStatus, resetAllNodeStatus, addConnection } from '$lib/stores/canvas.svelte';
	import type { CanvasNode, Connection } from '$lib/stores/canvas.svelte';
	import { isConnected } from '$lib/stores/mcp.svelte';
	import { mcpRuntime } from '$lib/services/mcp-runtime';
	import type { MultiLLMCapability, MultiLLMMCPTool } from '$lib/services/multi-llm-orchestrator';
	import { toasts } from '$lib/stores/toast.svelte';
	import { validateForMission } from '$lib/services/mission-builder';
	import {
		DEFAULT_MULTI_LLM_PROVIDERS,
		createDefaultMultiLLMOptions,
		type MultiLLMOrchestratorOptions,
		type MultiLLMProviderConfig,
		type MultiLLMStrategy
	} from '$lib/services/multi-llm-orchestrator';
	import { resolveRelayMissionProvider } from '$lib/services/relay-mission-provider';
	import { getEventsAuthHeaders } from '$lib/services/events-auth-client';
	import CheckpointReview from './CheckpointReview.svelte';
	import ExecutionFooter from './ExecutionFooter.svelte';
	import ExecutionLogList from './ExecutionLogList.svelte';
	import ExecutionProgressHeader from './ExecutionProgressHeader.svelte';
	import ExecutionResumeBanner from './ExecutionResumeBanner.svelte';
	import OrphanNodeWarningModal from './OrphanNodeWarningModal.svelte';
	import ExecutionTaskStatusList from './ExecutionTaskStatusList.svelte';
	import type { ProjectCheckpoint } from '$lib/services/checkpoint';
	import { saveCurrentPipeline } from '$lib/stores/pipelines.svelte';
	import type { MissionControlBoardEntry } from '$lib/types/mission-control';
	import {
		buildMissionControlHydrationSnapshot,
		type MissionControlHistoryEvent
	} from '$lib/services/mission-control-hydration';
	import {
		MISSION_CONTROL_LIVE_SYNC_INTERVAL_MS,
		shouldLiveSyncMissionControl,
		shouldSkipMissionControlHydration
	} from '$lib/services/mission-control-live-sync';
	import {
		buildCanvasMissionStatusUpdates,
		taskMatchesCanvasNode
	} from '$lib/services/canvas-mission-status';
	import { buildExecutionTaskRows, summarizeTaskRows } from '$lib/services/execution-task-rows';
	import {
		formatExecutionDuration,
		getAgentStatusColor,
		getStatusColor,
		getTransitionBadge
	} from '$lib/services/execution-panel-formatting';
	import { canShowMissionBoardProjectActions } from '$lib/services/mission-board-cards';
	import { polishMissionTitleForDisplay } from '$lib/services/mission-title';
	import { browser } from '$app/environment';
	import { get } from 'svelte/store';

	interface Props {
		onClose: () => void;
		minimized?: boolean;
		onToggleMinimize?: () => void;
		autoRunToken?: number;
		relay?: {
			missionId?: string;
			chatId?: string;
			userId?: string;
			requestId?: string;
			goal?: string;
			telegramRelay?: {
				port?: number;
				profile?: string;
				url?: string;
			};
			autoRun?: boolean;
			buildMode?: 'direct' | 'advanced_prd';
			buildModeReason?: string;
		};
		executionAuthority?: unknown;
	}

	let { onClose, minimized = false, onToggleMinimize, autoRunToken, relay, executionAuthority }: Props = $props();

	let currentNodes = $state<CanvasNode[]>([]);
	let currentConnections = $state<Connection[]>([]);
	let executionProgress = $state<ExecutionProgress | null>(null);
	let logs = $state<MissionLog[]>([]);
	let mcpConnected = $state(false);

	// Checkpoint review state
	let showCheckpointReview = $state(false);
	let missionCheckpoint = $state<ProjectCheckpoint | null>(null);

	// Orphan node warning state
	let showOrphanWarning = $state(false);
	let orphanedNodes = $state<CanvasNode[]>([]);

	// Task tracking for completion summary
	let completedTasks = $state<string[]>([]);
	let failedTasks = $state<string[]>([]);
	let pendingTasks = $state<string[]>([]);
	let reworkTasks = $state<Map<string, { name: string; retry: number; maxRetries: number }>>(new Map());

	// Resumable mission state
	let resumableMission = $state<{
		id: string;
		name: string;
		progress: number;
		status: ExecutionStatus;
	} | null>(null);
	let showResumeBanner = $state(false);

	// Copy prompt collapsed state - default to collapsed to save space
	let copyPromptCollapsed = $state(true);
	let mcpDetailOpen = $state(false);

	// H70 skills collapsed state - show active skill in header when collapsed
	let h70SkillsCollapsed = $state(true);

	// Mission settings (persisted locally)
	const MISSION_DEFAULTS_KEY = 'spawner-mission-defaults';
	let showMissionSettings = $state(false);
	let missionName = $state('Spark Intelligence Launch Readiness');
	let missionDescription = $state('Prepare Spark Intelligence to go live with safety, reliability, docs, and launch comms.');
	let projectPath = $state('C:/Users/USER/Desktop/vibeship-spark-intelligence');
	let projectType = $state('tool');
	let goalsText = $state(
		[
			'All launch gates green (health, security, docs, observability, support readiness)',
			'Clear launch story + distribution plan',
			'Rollback plan + incident readiness'
		].join('\\n')
	);
	let defaultsLoaded = $state(false);
	const defaultMultiLLMOptions = createDefaultMultiLLMOptions();
	const MULTI_LLM_KEYS_STORAGE = 'spawner-multi-llm-api-keys';
	let multiLLMEnabled = $state(defaultMultiLLMOptions.enabled);
	let multiLLMStrategy = $state<MultiLLMStrategy>(defaultMultiLLMOptions.strategy);
	let multiLLMPrimaryProviderId = $state(defaultMultiLLMOptions.primaryProviderId || 'claude');
	let multiLLMAutoEnableByKeys = $state(defaultMultiLLMOptions.autoEnableByKeys ?? true);
	let multiLLMAutoRouteByTask = $state(defaultMultiLLMOptions.autoRouteByTask ?? true);
	let multiLLMAutoDispatch = $state(true);
	let multiLLMApiKeys = $state<Record<string, string>>({});
	let serverProviderKeyPresence = $state<Record<string, boolean>>({});
	let connectedMcpCapabilities = $state<MultiLLMCapability[]>([]);
	let connectedMcpTools = $state<MultiLLMMCPTool[]>([]);
	let connectedMcpToolCount = $state(0);
	let showAdvancedMultiLLM = $state(false);
	let multiLLMProviders = $state<MultiLLMProviderConfig[]>(
		defaultMultiLLMOptions.providers.map((provider) => ({ ...provider }))
	);

	// Guard to ensure mount-only effects run once
	let hasCheckedResumable = $state(false);
	let lastHandledAutoRunToken = $state<number | null>(null);
	let autoRunInFlightToken = $state<number | null>(null);
	let lastAppliedRelayRequestId = $state<string | null>(null);
	let lastHydratedMissionId = $state<string | null>(null);
	let hydrationInFlightMissionId = $state<string | null>(null);
	let projectLineage = $state<MissionControlBoardEntry['projectLineage'] | null>(null);
	let missionHistoryLoading = $state(false);
	let autoRunRetryTimer: ReturnType<typeof setTimeout> | null = null;
	let durationTick = $state(Date.now());

	// Derived states
	let isRunning = $derived(executionProgress?.status === 'running' || executionProgress?.status === 'creating');
	let isPaused = $derived(executionProgress?.status === 'paused');
	let isTerminal = $derived(
		executionProgress?.status === 'completed' ||
			executionProgress?.status === 'failed' ||
			executionProgress?.status === 'cancelled'
	);
	let canPause = $derived(executionProgress?.status === 'running');
	let canResume = $derived(executionProgress?.status === 'paused');
	let canCancel = $derived(isRunning || isPaused);
	let canImproveProject = $derived(
		canShowMissionBoardProjectActions({
			status: executionProgress?.status,
			projectLineage
		})
	);
	let isMissionHistoryMode = $derived(Boolean(relay?.missionId));
	// Note: MCP not required anymore - we build missions locally and run directly by default (copy prompt is fallback)
	let canRun = $derived(!isMissionHistoryMode && !isRunning && !isPaused && !isTerminal && currentNodes.length > 0);

	function concisePanelSubtitle(progress: ExecutionProgress | null): string | null {
		if (!progress) return null;
		if (progress.currentTaskName) return progress.currentTaskName;
		if (progress.status === 'completed') return 'Run finished.';
		if (progress.status === 'failed') return progress.error || 'Mission needs attention.';
		if (progress.status === 'cancelled') return 'Mission cancelled.';
		if (progress.status === 'paused') return 'Mission paused.';
		if (progress.status === 'running' || progress.status === 'creating') return 'Preparing next task...';
		const message = progress.currentTaskMessage?.trim();
		if (!message) return null;
		if (/^Codex:\s*/i.test(message) && message.length > 90) return 'Provider summary is available in the execution log.';
		return message;
	}

	let relayMissionTitle = $derived(relay?.goal?.trim() || null);
	let panelTitle = $derived(
		polishMissionTitleForDisplay(
			executionProgress?.mission?.name ||
				(isMissionHistoryMode ? relayMissionTitle : null) ||
				missionName ||
				relayMissionTitle ||
				(currentNodes.length > 0 ? 'Canvas workflow' : 'Execution panel')
		)
	);
	let panelSubtitle = $derived(
		concisePanelSubtitle(executionProgress) ||
			(currentNodes.length > 0
				? `${currentNodes.length} node${currentNodes.length === 1 ? '' : 's'} ready`
				: 'Build a canvas to run')
	);
	let activeMissionId = $derived(executionProgress?.missionId || relay?.missionId || '');
	let runtimeAgents = $derived.by(() => {
		if (!executionProgress?.agentRuntime) return [] as AgentRuntimeStatus[];
		const updatedMs = (value: string | null | undefined): number => {
			const parsed = Date.parse(value || '');
			return Number.isFinite(parsed) ? parsed : 0;
		};
		return Array.from(executionProgress.agentRuntime.values()).sort(
			(a, b) => updatedMs(b.updatedAt) - updatedMs(a.updatedAt)
		);
	});
	let recentTaskTransitions = $derived.by(() => {
		if (!executionProgress?.taskTransitions) return [] as TaskTransitionEvent[];
		return executionProgress.taskTransitions.slice(-12).reverse();
	});
	let taskRows = $derived.by(() => buildExecutionTaskRows(executionProgress, currentNodes));
	let currentExecutionTaskLabel = $derived.by(() => {
		const runningTasks = taskRows.filter((task) => task.status === 'running');
		return runningTasks[runningTasks.length - 1]?.title || executionProgress?.currentTaskName || null;
	});
	let minimizedTaskSummary = $derived.by(() => {
		const summary = summarizeTaskRows(taskRows);
		const total = taskRows.length || executionProgress?.mission?.tasks?.length || currentNodes.length || 0;
		const completed = summary.completed || executionProgress?.mission?.tasks?.filter((task) => task.status === 'completed').length || 0;
		return {
			total,
			completed
		};
	});

	function statusBadgeShellClass(status: ExecutionStatus): string {
		if (status === 'running' || status === 'creating') {
			return 'border-vibe-teal/40 bg-vibe-teal/10';
		}
		return 'border-surface-border bg-bg-primary';
	}

	$effect(() => {
		if (!browser) return;
		if (!executionProgress?.startTime || executionProgress.endTime) return;
		const timer = setInterval(() => {
			durationTick = Date.now();
		}, 1000);
		return () => clearInterval(timer);
	});

	function taskMatchesNode(node: CanvasNode, taskId: string, taskName?: string): boolean {
		return taskMatchesCanvasNode(node, taskId, taskName);
	}

	function findNodeForTask(taskId: string, taskName?: string): CanvasNode | undefined {
		return currentNodes.find((node) => taskMatchesNode(node, taskId, taskName));
	}

	function persistCanvasStatusSnapshot() {
		const state = get(canvasState);
		saveCurrentPipeline({
			nodes: state.nodes,
			connections: state.connections,
			zoom: state.zoom,
			pan: state.pan
		});
	}

	function applyMissionTaskStatuses(mission: Mission) {
		for (const task of mission.tasks || []) {
			const node = findNodeForTask(task.id, task.title);
			if (!node) continue;
			if (task.status === 'completed') {
				updateNodeStatus(node.id, 'success');
			} else if (task.status === 'failed') {
				updateNodeStatus(node.id, 'error');
			} else if (task.status === 'in_progress') {
				updateNodeStatus(node.id, 'running');
			} else {
				updateNodeStatus(node.id, 'queued');
			}
		}
		persistCanvasStatusSnapshot();
	}

	function syncMissionTaskStatusesFromExecutor() {
		const mission = missionExecutor.getProgress().mission;
		if (mission?.tasks?.length) {
			applyMissionTaskStatuses(mission);
		}
	}

	function applyMultiLLMOptions(options?: MultiLLMOrchestratorOptions) {
		const defaults = createDefaultMultiLLMOptions();
		const incoming = options || defaults;
		const incomingProviders = incoming.providers || [];

		const mergedProviders = defaults.providers.map((defaultProvider) => {
			const savedProvider = incomingProviders.find((provider) => provider.id === defaultProvider.id);
			if (!savedProvider) {
				return { ...defaultProvider };
			}
			return {
				...defaultProvider,
				enabled: typeof savedProvider.enabled === 'boolean' ? savedProvider.enabled : defaultProvider.enabled,
				model:
					typeof savedProvider.model === 'string' && savedProvider.model.trim()
						? savedProvider.model
						: defaultProvider.model
			};
		});

		multiLLMEnabled = incoming.enabled ?? defaults.enabled;
		multiLLMStrategy = incoming.strategy ?? defaults.strategy;
		multiLLMPrimaryProviderId = incoming.primaryProviderId ?? defaults.primaryProviderId ?? 'claude';
		multiLLMAutoEnableByKeys = incoming.autoEnableByKeys ?? defaults.autoEnableByKeys ?? true;
		multiLLMAutoRouteByTask = incoming.autoRouteByTask ?? defaults.autoRouteByTask ?? true;
		multiLLMAutoDispatch = incoming.autoDispatch ?? true;
		multiLLMProviders = mergedProviders;
	}

	function applyBoardTaskStatuses(tasks: MissionControlBoardEntry['tasks']) {
		for (const update of buildCanvasMissionStatusUpdates(currentNodes, tasks)) {
			updateNodeStatus(update.nodeId, update.status);
		}
		persistCanvasStatusSnapshot();
	}

	async function loadMissionControlBoardEntry(missionId: string): Promise<MissionControlBoardEntry | null> {
		const response = await fetch('/api/mission-control/board');
		if (!response.ok) return null;
		const data = await response.json();
		const board = data?.board as Record<string, MissionControlBoardEntry[]> | undefined;
		if (!board) return null;
		for (const entries of Object.values(board)) {
			const match = entries.find((entry) => entry.missionId === missionId);
			if (match) return match;
		}
		return null;
	}

	async function hydrateMissionControlHistory(missionId: string, options: { force?: boolean } = {}) {
		if (!browser || !missionId) return;
		if (
			shouldSkipMissionControlHydration({
				missionId,
				inFlightMissionId: hydrationInFlightMissionId,
				lastHydratedMissionId,
				currentMissionId: executionProgress?.missionId,
				force: options.force
			})
		) return;

		hydrationInFlightMissionId = missionId;
		missionHistoryLoading = true;
		try {
			const [statusResponse, boardEntry] = await Promise.all([
				fetch(`/api/mission-control/status?missionId=${encodeURIComponent(missionId)}`),
				loadMissionControlBoardEntry(missionId)
			]);
			if (!statusResponse.ok || !boardEntry) return;
			projectLineage = boardEntry.projectLineage ?? projectLineage;

			const statusData = await statusResponse.json();
			const recent = ((statusData?.snapshot?.recent || []) as MissionControlHistoryEvent[])
				.filter((entry) => entry.missionId === missionId)
				.slice()
				.reverse();
			const snapshot = buildMissionControlHydrationSnapshot({
				missionId,
				boardEntry,
				recentEvents: recent,
				missionName,
				projectPath,
				projectType,
				goals: parseGoals(goalsText || ''),
				multiLLMOptions: getMultiLLMOptions()
			});

			executionProgress = snapshot.executionProgress;
			logs = snapshot.logs;
			completedTasks = snapshot.completedTasks;
			failedTasks = snapshot.failedTasks;
			pendingTasks = snapshot.pendingTasks;
			applyBoardTaskStatuses(boardEntry.tasks);
			lastHydratedMissionId = missionId;
		} catch (error) {
			console.warn('[ExecutionPanel] Failed to hydrate mission-control history:', error);
		} finally {
			if (hydrationInFlightMissionId === missionId) {
				hydrationInFlightMissionId = null;
			}
			missionHistoryLoading = false;
		}
	}

	function getMultiLLMOptions(): MultiLLMOrchestratorOptions {
		const keyPresence = Object.fromEntries(
			multiLLMProviders.map((provider) => [
				provider.id,
				Boolean((multiLLMApiKeys[provider.id] || '').trim()) || Boolean(serverProviderKeyPresence[provider.id])
			])
		);
		return {
			enabled: multiLLMEnabled,
			strategy: multiLLMStrategy,
			primaryProviderId: multiLLMPrimaryProviderId,
			autoEnableByKeys: multiLLMAutoEnableByKeys,
			autoRouteByTask: multiLLMAutoRouteByTask,
			autoDispatch: multiLLMAutoDispatch,
			apiKeys: multiLLMApiKeys,
			keyPresence,
			mcpCapabilities: connectedMcpCapabilities,
			mcpTools: connectedMcpTools,
			providers: multiLLMProviders.map((provider) => ({ ...provider }))
		};
	}

	function loadMultiLLMApiKeys() {
		if (!browser) return;
		try {
			const raw = localStorage.getItem(MULTI_LLM_KEYS_STORAGE);
			if (!raw) return;
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') {
				multiLLMApiKeys = parsed as Record<string, string>;
			}
		} catch {
			// ignore
		}
	}

	function persistMultiLLMApiKeys() {
		if (!browser) return;
		try {
			localStorage.setItem(MULTI_LLM_KEYS_STORAGE, JSON.stringify(multiLLMApiKeys));
		} catch {
			// ignore
		}
	}

	function updateMultiLLMApiKey(providerId: string, apiKey: string) {
		multiLLMApiKeys = {
			...multiLLMApiKeys,
			[providerId]: apiKey
		};
	}

	interface ServerProviderInfo {
		id: string;
		envKeyConfigured?: boolean;
		cliConfigured?: boolean;
		configured?: boolean;
		model?: string;
		baseUrl?: string | null;
	}

	function applySparkSingleProviderSelection(
		providers: ServerProviderInfo[],
		sparkDefaultProvider?: string | null
	) {
		multiLLMProviders = multiLLMProviders.map((provider) => {
			const serverProvider = providers.find((entry) => entry.id === provider.id);
			return {
				...provider,
				enabled: Boolean(sparkDefaultProvider && provider.id === sparkDefaultProvider),
				model:
					typeof serverProvider?.model === 'string' && serverProvider.model.trim()
						? serverProvider.model
						: provider.model,
				baseUrl:
					typeof serverProvider?.baseUrl === 'string' && serverProvider.baseUrl.trim()
						? serverProvider.baseUrl
						: provider.baseUrl
			};
		});

		if (!sparkDefaultProvider) return;

		multiLLMEnabled = true;
		multiLLMStrategy = 'single';
		multiLLMPrimaryProviderId = sparkDefaultProvider;
		multiLLMAutoEnableByKeys = true;
		multiLLMAutoRouteByTask = false;
		multiLLMAutoDispatch = true;
	}

	function applyServerProviderKeyPresence(
		presence: Record<string, boolean>,
		providers: ServerProviderInfo[] = [],
		sparkDefaultProvider?: string | null
	) {
		serverProviderKeyPresence = presence;
		applySparkSingleProviderSelection(providers, sparkDefaultProvider);
		if (sparkDefaultProvider) return;
		if (!multiLLMAutoEnableByKeys) return;

		multiLLMProviders = multiLLMProviders.map((provider) =>
			presence[provider.id] && !provider.enabled ? { ...provider, enabled: true } : provider
		);

		const enabledProviderIds = multiLLMProviders
			.filter((provider) => provider.enabled)
			.map((provider) => provider.id);
		if (enabledProviderIds.length > 0 && !enabledProviderIds.includes(multiLLMPrimaryProviderId)) {
			multiLLMPrimaryProviderId = enabledProviderIds[0];
		}
	}

	async function loadServerProviderKeyPresence() {
		if (!browser) return;
		try {
			const response = await fetch('/api/providers', { headers: getEventsAuthHeaders() });
			if (!response.ok) return;
			const result = await response.json();
			if (!Array.isArray(result?.providers)) return;

			const presence = Object.fromEntries(
				result.providers.map((provider: ServerProviderInfo) => [
					provider.id,
					Boolean(provider.configured ?? provider.cliConfigured ?? provider.envKeyConfigured)
				])
			);
			applyServerProviderKeyPresence(
				presence,
				result.providers as ServerProviderInfo[],
				typeof result?.sparkDefaultProvider === 'string' ? result.sparkDefaultProvider : null
			);
		} catch {
			// ignore
		}
	}

	function toggleMultiLLMProvider(providerId: string) {
		multiLLMProviders = multiLLMProviders.map((provider) =>
			provider.id === providerId ? { ...provider, enabled: !provider.enabled } : provider
		);

		const enabledProviderIds = multiLLMProviders
			.filter((provider) => provider.enabled)
			.map((provider) => provider.id);
		if (enabledProviderIds.length > 0 && !enabledProviderIds.includes(multiLLMPrimaryProviderId)) {
			multiLLMPrimaryProviderId = enabledProviderIds[0];
		}
	}

	function updateMultiLLMProviderModel(providerId: string, model: string) {
		multiLLMProviders = multiLLMProviders.map((provider) =>
			provider.id === providerId ? { ...provider, model } : provider
		);
	}

	type ExecutionMode = 'single' | 'multi';

	function getExecutionMode(): ExecutionMode {
		if (!multiLLMEnabled) return 'single';
		return multiLLMStrategy === 'single' ? 'single' : 'multi';
	}

	function setSingleProvider(providerId: string) {
		multiLLMPrimaryProviderId = providerId;
		multiLLMProviders = multiLLMProviders.map((provider) => {
			if (provider.id === providerId) {
				return { ...provider, enabled: true };
			}
			return { ...provider, enabled: false };
		});
	}

	function setExecutionMode(mode: ExecutionMode) {
		multiLLMEnabled = true;
		if (mode === 'single') {
			multiLLMStrategy = 'single';
			multiLLMAutoRouteByTask = false;
			const selectedProvider =
				multiLLMProviders.find((provider) => provider.id === multiLLMPrimaryProviderId) ||
				multiLLMProviders.find((provider) => provider.id === 'claude') ||
				multiLLMProviders[0];
			if (selectedProvider) {
				setSingleProvider(selectedProvider.id);
			}
			return;
		}

		if (multiLLMStrategy === 'single') {
			multiLLMStrategy = 'round_robin';
		}
		multiLLMAutoRouteByTask = true;
		multiLLMProviders = multiLLMProviders.map((provider) =>
			provider.id === 'claude' ||
			provider.id === 'codex' ||
			hasProviderApiKey(provider.id)
				? { ...provider, enabled: true }
				: provider
		);
	}

	function hasProviderApiKey(providerId: string): boolean {
		return Boolean((multiLLMApiKeys[providerId] || '').trim()) || Boolean(serverProviderKeyPresence[providerId]);
	}

	function hasDualProviderKeys(): boolean {
		return hasProviderApiKey('claude') && hasProviderApiKey('codex');
	}

	function prepareDualProviderRunIfReady() {
		if (getExecutionMode() !== 'multi') return;
		if (!hasDualProviderKeys()) return;

		multiLLMEnabled = true;
		multiLLMStrategy = 'parallel_consensus';
		multiLLMAutoDispatch = true;
		multiLLMPrimaryProviderId = 'claude';
		multiLLMProviders = multiLLMProviders.map((provider) =>
			provider.id === 'claude' || provider.id === 'codex'
				? { ...provider, enabled: true }
				: provider
		);
	}

	function copyToClipboard(text: string, successMessage: string) {
		navigator.clipboard.writeText(text);
		toasts.success(successMessage);
	}

	// Svelte 5: Use $effect with store subscriptions - run once and cleanup
	$effect(() => {
		const unsub1 = nodes.subscribe((n) => (currentNodes = n));
		const unsub2 = connections.subscribe((c) => (currentConnections = c));
		const unsub3 = isConnected.subscribe((connected) => (mcpConnected = connected));
		const unsub4 = mcpRuntime.subscribe((runtime) => {
			connectedMcpCapabilities = runtime.capabilities as MultiLLMCapability[];
			connectedMcpTools = runtime.tools.map((tool) => ({
				instanceId: tool.instanceId,
				mcpName: tool.mcpName,
				toolName: tool.toolName,
				description: tool.description,
				capabilities: tool.capabilities as MultiLLMCapability[]
			}));
			connectedMcpToolCount = runtime.tools.length;
		});
		return () => {
			unsub1();
			unsub2();
			unsub3();
			unsub4();
		};
	});

	// Check for resumable mission on mount - RUN ONLY ONCE
	// Using guard to prevent infinite loop (getResumableMissionInfo returns new object each call)
	$effect(() => {
		if (hasCheckedResumable) return; // Guard against re-runs
		hasCheckedResumable = true;

		const missionInfo = missionExecutor.getResumableMissionInfo();
		if (missionInfo) {
			resumableMission = missionInfo;
			// Restore the full execution progress
			const progress = missionExecutor.getProgress();
			executionProgress = progress;
			if (progress?.multiLLMOptions) {
				applyMultiLLMOptions(progress.multiLLMOptions);
			}
			logs = progress?.logs || [];

			// Restore task tracking state from mission
			if (progress?.mission?.tasks) {
				const tasks = progress.mission.tasks;
				completedTasks = tasks.filter(t => t.status === 'completed').map(t => t.title);
				failedTasks = tasks.filter(t => t.status === 'failed').map(t => t.title);
				pendingTasks = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').map(t => t.title);
			}

			// Only show resume banner if paused, otherwise auto-continue display
			if (missionInfo.status === 'paused') {
				showResumeBanner = true;
			} else if (missionInfo.status === 'running' || missionInfo.status === 'creating') {
				// Still running/creating - just show the current state without banner
				showResumeBanner = false;
			}
		}
	});

	$effect(() => {
		const missionId = relay?.missionId;
		if (!browser || !missionId) return;
		if (isRunning || isPaused) return;
		void hydrateMissionControlHistory(missionId);
	});

	$effect(() => {
		const missionId = relay?.missionId;
		if (!browser || !missionId) return;

		const poll = () => {
			if (!shouldLiveSyncMissionControl(executionProgress?.status)) return;
			void hydrateMissionControlHistory(missionId, { force: true });
		};

		const initialLiveSyncTimer = setTimeout(poll, 0);
		const liveSyncTimer = setInterval(poll, MISSION_CONTROL_LIVE_SYNC_INTERVAL_MS);
		return () => {
			clearTimeout(initialLiveSyncTimer);
			clearInterval(liveSyncTimer);
		};
	});

	// Load persisted mission defaults once (browser only)
	$effect(() => {
		if (defaultsLoaded) return;
		defaultsLoaded = true;
		if (!browser) return;
		loadMultiLLMApiKeys();
		void loadServerProviderKeyPresence();
		try {
			const raw = localStorage.getItem(MISSION_DEFAULTS_KEY);
			if (!raw) return;
			const parsed = JSON.parse(raw);
			if (typeof parsed?.missionName === 'string' && parsed.missionName.trim()) missionName = parsed.missionName;
			if (typeof parsed?.missionDescription === 'string') missionDescription = parsed.missionDescription;
			if (typeof parsed?.projectPath === 'string' && parsed.projectPath.trim()) projectPath = parsed.projectPath;
			if (typeof parsed?.projectType === 'string' && parsed.projectType.trim()) projectType = parsed.projectType;
			if (typeof parsed?.goalsText === 'string') goalsText = parsed.goalsText;
			if (
				typeof parsed?.multiLLMEnabled === 'boolean' ||
				typeof parsed?.multiLLMStrategy === 'string' ||
				Array.isArray(parsed?.multiLLMProviders)
			) {
				applyMultiLLMOptions({
					enabled:
						typeof parsed?.multiLLMEnabled === 'boolean'
							? parsed.multiLLMEnabled
							: defaultMultiLLMOptions.enabled,
					strategy:
						typeof parsed?.multiLLMStrategy === 'string'
							? (parsed.multiLLMStrategy as MultiLLMStrategy)
							: defaultMultiLLMOptions.strategy,
					primaryProviderId:
						typeof parsed?.multiLLMPrimaryProviderId === 'string'
							? parsed.multiLLMPrimaryProviderId
							: defaultMultiLLMOptions.primaryProviderId,
					autoEnableByKeys:
						typeof parsed?.multiLLMAutoEnableByKeys === 'boolean'
							? parsed.multiLLMAutoEnableByKeys
							: defaultMultiLLMOptions.autoEnableByKeys,
					autoRouteByTask:
						typeof parsed?.multiLLMAutoRouteByTask === 'boolean'
							? parsed.multiLLMAutoRouteByTask
							: defaultMultiLLMOptions.autoRouteByTask,
					autoDispatch:
						typeof parsed?.multiLLMAutoDispatch === 'boolean'
							? parsed.multiLLMAutoDispatch
							: false,
					providers: Array.isArray(parsed?.multiLLMProviders)
						? (parsed.multiLLMProviders as MultiLLMProviderConfig[])
						: defaultMultiLLMOptions.providers
				});
			}
		} catch {
			// ignore
		}
	});

	function persistDefaults() {
		if (!browser) return;
		try {
			localStorage.setItem(
				MISSION_DEFAULTS_KEY,
				JSON.stringify({
					missionName,
					missionDescription,
					projectPath,
					projectType,
					goalsText,
					multiLLMEnabled,
					multiLLMStrategy,
					multiLLMPrimaryProviderId,
					multiLLMAutoEnableByKeys,
					multiLLMAutoRouteByTask,
					multiLLMAutoDispatch,
					multiLLMProviders
				})
			);
			persistMultiLLMApiKeys();
		} catch {
			// ignore
		}
	}

	function parseGoals(text: string): string[] {
		return text
			.split('\\n')
			.map((l) => l.trim())
			.filter(Boolean);
	}

	function extractTargetWorkspaceFromText(text?: string): string | null {
		if (!text) return null;
		const match = text.match(/Target workspace:\s*`([^`]+)`/i) || text.match(/Target workspace:\s*([^\r\n]+)/i);
		return match?.[1]?.trim().replace(/[.,;]+$/, '') || null;
	}

	function extractMissionTitleFromRelay(text?: string): string | null {
		if (!text) return null;
		const heading = text.match(/^\s*#\s+(.+)$/m);
		if (heading?.[1]?.trim()) return heading[1].trim();
		const project = text.match(/Project:\s*([^\r\n]+)/i);
		return project?.[1]?.trim() || null;
	}

	function forceRelayMissionProvider(providerId = 'codex') {
		const selectedProvider = resolveRelayMissionProvider(DEFAULT_MULTI_LLM_PROVIDERS, providerId);
		if (!selectedProvider) return;

		const providers = DEFAULT_MULTI_LLM_PROVIDERS.map((provider) => ({
			...provider,
			enabled: provider.id === selectedProvider.id
		}));

		multiLLMEnabled = true;
		multiLLMStrategy = 'single';
		multiLLMPrimaryProviderId = selectedProvider.id;
		multiLLMAutoEnableByKeys = true;
		multiLLMAutoRouteByTask = false;
		multiLLMAutoDispatch = true;
		multiLLMProviders = providers;
	}

	function applyRelayMissionDefaults() {
		if (!relay?.requestId || relay.requestId === lastAppliedRelayRequestId) return;
		lastAppliedRelayRequestId = relay.requestId;

		const buildMode = relay.buildMode || 'direct';
		missionName = extractMissionTitleFromRelay(relay.goal) || `Telegram Build ${relay.requestId}`;
		const targetWorkspace = extractTargetWorkspaceFromText(relay.goal);
		if (targetWorkspace) projectPath = targetWorkspace;
		forceRelayMissionProvider();
		missionDescription = [
			`Build mode: ${buildMode}`,
			relay.buildModeReason ? `Reason: ${relay.buildModeReason}` : null,
			relay.goal || ''
		]
			.filter((line): line is string => Boolean(line && line.trim()))
			.join('\n\n');
		goalsText =
			buildMode === 'advanced_prd'
				? [
						'Create or follow a compact PRD before implementation.',
						'Execute the TAS-style task plan with acceptance criteria.',
						'Verify the completed project in the target workspace.'
					].join('\n')
				: ['Complete the requested files exactly.', 'Verify the result in the target workspace.'].join('\n');
	}

	$effect(() => {
		applyRelayMissionDefaults();
	});

	function getCurrentTaskSkills(progress: ExecutionProgress | null): LoadedSkillInfo[] {
		if (!isRunning || !progress?.loadedSkills || !progress.currentTaskId) {
			return [];
		}
		const currentTaskId = progress.currentTaskId;
		return progress.loadedSkills.filter((skill) => skill.taskIds.includes(currentTaskId));
	}

	/**
	 * Dismiss the resume banner and clear the saved mission state
	 */
	function dismissResumeBanner() {
		showResumeBanner = false;
		resumableMission = null;
		missionExecutor.stop();  // This clears the persisted state
		executionProgress = null;
		logs = [];
		toasts.info('Previous mission dismissed');
	}

	/**
	 * Continue with the resumed mission
	 */
	function continueResumableMission() {
		showResumeBanner = false;
		// Mission is already restored, just continue
		if (resumableMission?.status === 'paused') {
			handleResume();
		} else if (resumableMission?.status === 'partial') {
			handleResumePartial();
		}
		toasts.success(`Continuing mission: ${resumableMission?.name}`);
	}

	/**
	 * Find orphaned nodes (nodes not connected to any other node)
	 */
	function findOrphanedNodes(): CanvasNode[] {
		if (currentNodes.length <= 1) return []; // Single node is fine

		const connectedNodes = new Set<string>();
		for (const conn of currentConnections) {
			connectedNodes.add(conn.sourceNodeId);
			connectedNodes.add(conn.targetNodeId);
		}

		return currentNodes.filter((n) => !connectedNodes.has(n.id));
	}

	/**
	 * Auto-connect orphaned nodes to the workflow
	 * Strategy: Connect each orphan to the last connected node in a chain
	 */
	function autoConnectOrphans() {
		const orphans = findOrphanedNodes();
		if (orphans.length === 0) return;

		// Find nodes that are already connected
		const connectedNodes = new Set<string>();
		for (const conn of currentConnections) {
			connectedNodes.add(conn.sourceNodeId);
			connectedNodes.add(conn.targetNodeId);
		}

		// Find terminal nodes (nodes with no outgoing connections)
		const hasOutgoing = new Set<string>();
		for (const conn of currentConnections) {
			hasOutgoing.add(conn.sourceNodeId);
		}

		// Get nodes that have no outgoing connections (terminal nodes)
		let terminalNodes = currentNodes.filter(
			(n) => connectedNodes.has(n.id) && !hasOutgoing.has(n.id)
		);

		// If no terminal nodes, use all connected nodes
		if (terminalNodes.length === 0) {
			terminalNodes = currentNodes.filter((n) => connectedNodes.has(n.id));
		}

		// If still no nodes (all are orphans), connect them in sequence
		if (terminalNodes.length === 0 && orphans.length > 0) {
			// Connect orphans in a chain
			for (let i = 0; i < orphans.length - 1; i++) {
				addConnection(orphans[i].id, 'output', orphans[i + 1].id, 'input');
			}
			toasts.success(`Auto-connected ${orphans.length} orphaned nodes`);
			showOrphanWarning = false;
			return;
		}

		// Connect each orphan to a terminal node, chaining them
		let lastTerminal = terminalNodes[0];
		for (const orphan of orphans) {
			addConnection(lastTerminal.id, 'output', orphan.id, 'input');
			lastTerminal = orphan; // Chain the orphans
		}

		toasts.success(`Auto-connected ${orphans.length} orphaned node${orphans.length > 1 ? 's' : ''}`);
		showOrphanWarning = false;
	}

	/**
	 * Handle "View on Canvas" - close panel so user can fix manually
	 */
	function handleViewOnCanvas() {
		showOrphanWarning = false;
		onClose();
		// Optionally highlight the orphaned nodes
		toasts.info(`${orphanedNodes.length} orphaned node${orphanedNodes.length > 1 ? 's' : ''} need connection`);
	}

	/**
	 * Pre-run validation to check for orphans and errors
	 */
	function checkWorkflowBeforeRun(options: { autoRun?: boolean } = {}): boolean {
		const validation = validateForMission(currentNodes, currentConnections);

		// Check for blocking errors first (circular deps, empty canvas)
		if (validation.errors.length > 0) {
			toasts.error(`Validation failed: ${validation.errors.join(', ')}`);
			return false;
		}

		// Check for orphan warnings - show prompt but allow proceeding
		const orphans = findOrphanedNodes();
		if (orphans.length > 0) {
			if (options.autoRun) {
				return false;
			}
			orphanedNodes = orphans;
			showOrphanWarning = true;
			return false; // Don't run yet, show warning first
		}

		return true;
	}

	/**
	 * Proceed with workflow after orphan warning dismissed
	 */
	function proceedWithOrphans() {
		showOrphanWarning = false;
		executeWorkflow();
	}

	/**
	 * Entry point for running workflow - validates first
	 */
	function runWorkflow(options: { autoRun?: boolean } = {}): boolean {
		if (isTerminal && executionProgress?.missionId) {
			toasts.info(`Mission ${executionProgress.missionId} is already ${executionProgress.status}. Open the logs here or start a fresh mission from Telegram/Kanban.`);
			return false;
		}
		if (!checkWorkflowBeforeRun(options)) {
			return false; // Validation failed, warning shown
		}
		void executeWorkflow();
		return true;
	}

	$effect(() => {
		if (!autoRunToken) return;
		if (autoRunToken === lastHandledAutoRunToken) return;
		if (autoRunToken === autoRunInFlightToken) return;
		if (isTerminal) return;
		if (isRunning || isPaused || currentNodes.length === 0) return;
		if (autoRunRetryTimer) clearTimeout(autoRunRetryTimer);

		const token = autoRunToken;
		const tryAutoRun = (attempt = 0) => {
			if (token !== autoRunToken || token === lastHandledAutoRunToken) return;
			if (token === autoRunInFlightToken) return;
			if (isTerminal) return;
			if (isRunning || isPaused) return;
			if (currentNodes.length === 0) {
				if (attempt < 20) {
					autoRunRetryTimer = setTimeout(() => tryAutoRun(attempt + 1), 250);
				}
				return;
			}

			autoRunInFlightToken = token;
			const started = runWorkflow({ autoRun: true });
			if (started) {
				lastHandledAutoRunToken = token;
				return;
			}
			autoRunInFlightToken = null;

			if (attempt < 20) {
				autoRunRetryTimer = setTimeout(() => tryAutoRun(attempt + 1), 250);
			}
		};

		autoRunRetryTimer = setTimeout(() => tryAutoRun(), 250);
		return () => {
			if (autoRunRetryTimer) clearTimeout(autoRunRetryTimer);
		};
	});

	/**
	 * Actually execute the workflow (called after validation passes)
	 */
	async function executeWorkflow() {
		logs = [];
		resetAllNodeStatus();
		for (const node of currentNodes) {
			updateNodeStatus(node.id, 'queued');
		}
		persistCanvasStatusSnapshot();

		// Reset task tracking
		completedTasks = [];
		failedTasks = [];
		pendingTasks = currentNodes.map(n => n.skill.name);
		reworkTasks = new Map();

		// Set up callbacks
		missionExecutor.setCallbacks({
			onStatusChange: () => {
				executionProgress = missionExecutor.getProgress();
				syncMissionTaskStatusesFromExecutor();
			},
			onProgress: () => {
				executionProgress = missionExecutor.getProgress();
				syncMissionTaskStatusesFromExecutor();
			},
			onTaskProgress: () => {
				executionProgress = missionExecutor.getProgress();
				syncMissionTaskStatusesFromExecutor();
			},
			onLog: (log) => {
				const existingIndex = logs.findIndex((entry) => entry.id === log.id);
				if (existingIndex >= 0) {
					logs = logs.map((entry, index) => index === existingIndex ? log : entry);
				} else {
					logs = [...logs, log];
				}
				executionProgress = missionExecutor.getProgress();
			},
			onTaskStart: (taskId, taskName) => {
				// Find the node matching this task and update its status
				const node = findNodeForTask(taskId, taskName);
				if (node) {
					updateNodeStatus(node.id, 'running');
					persistCanvasStatusSnapshot();

					// Remove from pending, update UI
					pendingTasks = pendingTasks.filter(t => t !== taskName && t !== taskId);
				}

				// Update executionProgress to reflect new current task name
				executionProgress = missionExecutor.getProgress();
			},
			onTaskComplete: (taskId, success) => {
				// Find the node and update its status
				const node = findNodeForTask(taskId);
				const taskName = node?.skill.name || taskId;
				if (node) {
					updateNodeStatus(node.id, success ? 'success' : 'error');
					persistCanvasStatusSnapshot();
				}

				// Clear rework state if task is now truly done
				reworkTasks.delete(taskId);
				reworkTasks = new Map(reworkTasks);

				// Update tracking
				if (success) {
					completedTasks = [...new Set([...completedTasks, taskName])];
				} else {
					failedTasks = [...new Set([...failedTasks, taskName])];
				}
				pendingTasks = pendingTasks.filter(t => t !== taskName && t !== taskId);

				// Update executionProgress to reflect task completion
				executionProgress = missionExecutor.getProgress();
			},
			onTaskRework: (taskId, taskName, retryNumber, maxRetries) => {
				// Track rework state for UI badges
				const node = findNodeForTask(taskId, taskName);
				if (node) {
					updateNodeStatus(node.id, 'idle'); // Reset to idle — task is back to pending
					persistCanvasStatusSnapshot();
				}
				reworkTasks.set(taskId, { name: taskName, retry: retryNumber, maxRetries });
				reworkTasks = new Map(reworkTasks);
				executionProgress = missionExecutor.getProgress();
			},
			onComplete: async (mission) => {
				executionProgress = missionExecutor.getProgress();

				// Clear pending tasks
				pendingTasks = [];

				// Update node statuses based on actual mission task state and persist them.
				applyMissionTaskStatuses(mission);

				// Show checkpoint review if available
				if (executionProgress?.checkpoint) {
					missionCheckpoint = executionProgress.checkpoint;
					showCheckpointReview = true;
				}

				toasts.success('Workflow completed successfully');
			},
			onError: async (error) => {
				executionProgress = missionExecutor.getProgress();

				toasts.error(`Execution failed: ${error}`, {
					label: 'Retry',
					onClick: () => runWorkflow()
				});
			}
		});

		// Execute with claude-code mode
		const name = (missionName || '').trim() || `Workflow Execution ${new Date().toLocaleString()}`;
		const description = (missionDescription || '').trim();
		const path = (projectPath || '').trim() || '.';
		const goals = parseGoals(goalsText || '');

		persistDefaults();

		executionProgress = await missionExecutor.execute(currentNodes, currentConnections, {
			mode: multiLLMEnabled ? 'multi-llm-orchestrator' : 'claude-code',
			name,
			description: description || undefined,
			projectPath: path,
			projectType: (projectType || '').trim() || 'general',
			goals: goals.length ? goals : undefined,
			missionId: relay?.missionId,
			relay,
			executionAuthority,
			orchestratorOptions: getMultiLLMOptions()
		});
	}

	async function handlePause() {
		await missionExecutor.pause();
		executionProgress = missionExecutor.getProgress();
	}

	async function handleResume() {
		await missionExecutor.resume();
		executionProgress = missionExecutor.getProgress();
	}

	async function handleCancel() {
		await missionExecutor.cancel();
		executionProgress = missionExecutor.getProgress();
	}

	async function handleResumePartial() {
		try {
			await missionExecutor.resumePartial();
			executionProgress = missionExecutor.getProgress();
			toasts.success('Resuming pending tasks...');
		} catch (err) {
			toasts.error(`Failed to resume: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	function handleDismissPartial() {
		missionExecutor.stop();
		executionProgress = null;
		logs = [];
		toasts.info('Partial mission dismissed');
	}

	function formatTime(dateStr: string | Date): string {
		const date = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function getExecutionDuration(): string {
		durationTick;
		return formatExecutionDuration(executionProgress?.startTime, executionProgress?.endTime);
	}

	function handleClose() {
		if (!isRunning) {
			missionExecutor.stop();
			persistCanvasStatusSnapshot();
			onClose();
		}
	}

	function canvasImproveHref(): string {
		const params = new URLSearchParams();
		if (projectLineage?.projectPath) params.set('improveProjectPath', projectLineage.projectPath);
		params.set('parentMissionId', executionProgress?.missionId || relay?.missionId || '');
		if (projectLineage?.projectId) params.set('projectId', projectLineage.projectId);
		if (projectLineage?.previewUrl) params.set('previewUrl', projectLineage.previewUrl);
		if (projectLineage?.iterationNumber) params.set('iterationNumber', String(projectLineage.iterationNumber));
		if (projectLineage?.improvementFeedback) params.set('improvementFeedback', projectLineage.improvementFeedback);
		return `/kanban?${params.toString()}`;
	}

	function failureEvidenceText(): string {
		const failedTaskList = failedTasks.length ? `Failed tasks: ${failedTasks.join(', ')}` : '';
		const transition = recentTaskTransitions.find((event) => event.state === 'failed');
		const transitionText = transition
			? `Latest failure: ${transition.taskName || transition.taskId || 'task'}`
			: '';
		return [
			`Mission: ${panelTitle}`,
			executionProgress?.error ? `Error: ${executionProgress.error}` : '',
			failedTaskList,
			transitionText,
			activeMissionId ? `Mission ID: ${activeMissionId}` : ''
		].filter(Boolean).join('\n');
	}

	function copyFailureEvidence() {
		copyToClipboard(failureEvidenceText(), 'Copied failure evidence');
	}
</script>

<!-- Minimized floating widget -->
{#if minimized && (isRunning || isPaused)}
	<button
		onclick={onToggleMinimize}
		class="fixed left-1/2 top-[4.25rem] z-50 w-[min(calc(100vw-2rem),40rem)] -translate-x-1/2 rounded-lg border border-accent-primary/55 bg-bg-secondary/95 px-4 py-3 text-left shadow-[0_18px_70px_rgba(0,0,0,0.38)] backdrop-blur transition-all hover:-translate-y-0.5 hover:border-accent-primary hover:shadow-[0_22px_80px_rgba(0,196,154,0.16)] md:left-[calc(50%+8rem)] group"
		aria-label="Open workflow execution details"
	>
		<div class="flex items-center gap-3">
			<div class="relative flex h-12 min-w-20 shrink-0 items-center justify-center rounded-md border border-surface-border bg-bg-primary px-3 text-right">
				<span class="text-2xl font-semibold leading-none tabular-nums text-text-primary">
					{executionProgress?.progress || 0}<span class="ml-0.5 text-sm font-medium text-text-tertiary">%</span>
				</span>
			</div>
			<div class="min-w-0 flex-1">
				<div class="flex items-center justify-between gap-3">
					<div class="flex min-w-0 items-center gap-2">
						<span class="relative flex h-2.5 w-2.5 shrink-0">
							{#if isRunning}
								<span class="absolute inline-flex h-full w-full rounded-full bg-vibe-teal opacity-60 animate-ping-slow"></span>
								<span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-vibe-teal shadow-[0_0_16px_rgba(0,196,154,0.55)]"></span>
							{:else if isPaused}
								<span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-status-warning"></span>
							{/if}
						</span>
						<p class="font-mono text-[10px] uppercase tracking-[0.14em] text-accent-primary">
							{isPaused ? 'Paused' : 'Live'}
						</p>
						{#if minimizedTaskSummary.total > 0}
							<span class="hidden font-mono text-xs font-semibold text-text-secondary tabular-nums sm:inline">
								{minimizedTaskSummary.completed}/{minimizedTaskSummary.total} tasks
							</span>
						{/if}
					</div>
					<span class="hidden rounded-md border border-accent-primary/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-accent-primary transition-colors group-hover:bg-accent-primary/10 group-hover:text-text-primary sm:inline">
						Execution panel
					</span>
				</div>
				<p class="mt-1 truncate text-sm font-medium text-text-primary">
					{currentExecutionTaskLabel || 'Running workflow'}
				</p>
				<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-primary">
					<div
						class="minimized-execution-progress-fill h-full rounded-full bg-accent-primary transition-all duration-500"
						style="width: {executionProgress?.progress || 0}%"
					></div>
				</div>
			</div>
			<svg class="h-4 w-4 shrink-0 text-text-tertiary transition-colors group-hover:text-accent-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14m-6-6 6 6-6 6" />
			</svg>
		</div>
	</button>
{:else}
<div
	class={`fixed right-0 bottom-0 z-50 transition-all duration-300 ease-out ${minimized ? 'top-0 w-96' : 'top-14 w-[min(38rem,calc(100vw-1rem))]'}`}
	role="dialog"
	aria-modal={!minimized ? 'true' : undefined}
>
	<div
		class="relative bg-bg-secondary border-l border-surface-border flex flex-col overscroll-contain shadow-[0_24px_90px_rgba(0,0,0,0.45)]"
		class:h-full={minimized}
		class:h-[calc(100vh-3.5rem)]={!minimized}
		class:max-w-full={!minimized}
		class:overflow-y-auto={!minimized}
		class:overflow-x-hidden={!minimized}
		class:border-y={!minimized}
	>
		<!-- Header -->
		<div class="flex items-center justify-between gap-4 px-6 py-5 border-b border-surface-border bg-bg-secondary">
			<div class="min-w-0 flex items-center gap-3">
				{#if isRunning}
					<span class="relative flex h-2.5 w-2.5 shrink-0">
						<span class="absolute inline-flex h-full w-full rounded-full bg-accent-primary opacity-60 animate-ping-slow"></span>
						<span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent-primary"></span>
					</span>
				{/if}
				<div class="min-w-0">
					<div class="flex min-w-0 flex-wrap items-center gap-2">
						<h2 class="truncate text-lg font-semibold leading-tight text-text-primary">{panelTitle}</h2>
						{#if executionProgress}
							<span
								class="rounded-md border px-2 py-1 text-[10px] font-mono uppercase tracking-[0.14em] {getStatusColor(executionProgress.status)} {statusBadgeShellClass(executionProgress.status)}"
							>
								{executionProgress.status}
							</span>
						{/if}
					</div>
					<div class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-mono text-text-tertiary">
						<span class="min-w-0 truncate">{panelSubtitle}</span>
						{#if executionProgress?.endTime}
							<span class="hidden text-text-faint sm:inline">·</span>
							<span class="shrink-0">Finished at {formatTime(executionProgress.endTime)}</span>
						{:else if executionProgress?.startTime}
							<span class="hidden text-text-faint sm:inline">·</span>
							<span class="shrink-0">Started at {formatTime(executionProgress.startTime)}</span>
						{/if}
						{#if activeMissionId}
							<span class="hidden text-text-faint sm:inline">·</span>
							<span class="inline-flex min-w-0 items-center gap-1 rounded border border-surface-border bg-bg-primary/70 px-1.5 py-0.5">
								<span class="shrink-0 text-text-faint">ID</span>
								<code class="min-w-0 truncate font-mono text-accent-primary select-all">{activeMissionId}</code>
							</span>
						{/if}
					</div>
				</div>
			</div>
			<div class="flex items-center gap-1">
				{#if (isRunning || isPaused) && onToggleMinimize}
					<button
						onclick={onToggleMinimize}
						class="p-2 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface transition-all"
						title="Minimize to see canvas"
						aria-label="Minimize execution panel"
					>
						<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
						</svg>
					</button>
				{/if}
				<button onclick={handleClose} class="p-2 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface transition-all" disabled={isRunning} aria-label="Close execution panel">
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
		</div>


		<!-- Resume Banner (shown when there's a saved mission) -->
		{#if showResumeBanner && resumableMission}
			<ExecutionResumeBanner
				mission={resumableMission}
				onContinue={continueResumableMission}
				onDismiss={dismissResumeBanner}
			/>
		{/if}
		<!-- Progress -->
		{#if executionProgress}
			<div class="px-6 py-5 border-b border-surface-border">
				<ExecutionProgressHeader
					{executionProgress}
					nodeCount={currentNodes.length}
					executionDuration={getExecutionDuration()}
					mcpConnectedCount={$mcpRuntime.connectedCount}
					mcpTools={$mcpRuntime.tools}
					{runtimeAgents}
					currentTaskSkills={getCurrentTaskSkills(executionProgress)}
					{taskRows}
					bind:mcpDetailOpen
					bind:copyPromptCollapsed
					{copyToClipboard}
				/>

				<ExecutionTaskStatusList
					taskRows={taskRows}
					reworkTasks={reworkTasks}
					status={executionProgress.status}
					isRunning={isRunning}
					reconciliation={executionProgress.reconciliation}
					error={executionProgress.error}
					nodeCount={currentNodes.length}
					executionDuration={getExecutionDuration()}
					showTaskList={false}
					onResumePartial={handleResumePartial}
					onDismissPartial={handleDismissPartial}
				/>

				{#if executionProgress.status === 'failed'}
					<div class="mt-4 rounded-lg border border-status-error/35 bg-status-error/10 p-3">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div class="min-w-0">
								<p class="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-status-error">
									Failure recovery
								</p>
								<p class="mt-1 text-xs leading-relaxed text-text-secondary">
									Open the trace, inspect logs, or retry only the failed work from here.
								</p>
							</div>
							<div class="flex flex-wrap items-center gap-2">
								<button
									type="button"
									onclick={handleResumePartial}
									class="inline-flex items-center rounded-md border border-status-error/40 px-2.5 py-1.5 font-mono text-[10px] font-semibold text-status-error transition-all hover:bg-status-error hover:text-bg-primary"
								>
									Rerun failed
								</button>
								<a
									href={activeMissionId ? `/trace?missionId=${encodeURIComponent(activeMissionId)}` : '/trace'}
									class="inline-flex items-center rounded-md border border-surface-border px-2.5 py-1.5 font-mono text-[10px] text-text-secondary transition-all hover:border-accent-primary/50 hover:text-accent-primary"
								>
									Open trace
								</a>
								<button
									type="button"
									onclick={copyFailureEvidence}
									class="inline-flex items-center rounded-md border border-surface-border px-2.5 py-1.5 font-mono text-[10px] text-text-secondary transition-all hover:border-accent-primary/50 hover:text-accent-primary"
								>
									Copy error
								</button>
							</div>
						</div>
					</div>
				{/if}
			</div>
		{/if}

		<ExecutionLogList
			{logs}
			{isRunning}
			historyMode={isMissionHistoryMode}
			historyLoading={missionHistoryLoading && !executionProgress}
			status={executionProgress?.status}
			transitions={recentTaskTransitions}
			{formatTime}
			{getTransitionBadge}
		/>

		{#if projectLineage}
			<div class="border-t border-surface-border bg-bg-tertiary px-4 py-3">
				<div class="space-y-2">
					{#if projectLineage}
						<div class="rounded-md border border-accent-primary/25 bg-bg-secondary/80 px-3 py-2 font-mono text-xs text-text-secondary">
							<div class="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
								<div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
									<span class="font-semibold text-accent-primary">
										{canImproveProject ? `Iteration${projectLineage.iterationNumber ? ` ${projectLineage.iterationNumber}` : ''}` : 'Target project'}
									</span>
									{#if projectLineage.projectPath}
										<span class="min-w-0 max-w-full truncate text-text-secondary">Project: {projectLineage.projectPath}</span>
									{/if}
									{#if projectLineage.parentMissionId}
										<span class="truncate text-text-tertiary">Parent: {projectLineage.parentMissionId}</span>
									{/if}
								</div>
								{#if canImproveProject && projectLineage.projectPath}
									<a
										href={canvasImproveHref()}
										class="inline-flex justify-self-start items-center justify-center rounded px-2 py-1 text-[10px] text-accent-primary border border-accent-primary/30 hover:bg-accent-primary hover:text-bg-primary transition-all sm:justify-self-end"
									>
										Improve this
									</a>
								{/if}
							</div>
							{#if projectLineage.improvementFeedback}
								<div class="mt-1 truncate text-text-tertiary">Feedback: {projectLineage.improvementFeedback}</div>
							{/if}
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<ExecutionFooter
			{executionProgress}
			{isRunning}
			{isPaused}
			{isTerminal}
			{canCancel}
			{canPause}
			{canResume}
			{canRun}
			historyMode={isMissionHistoryMode}
			currentNodeCount={currentNodes.length}
			{formatTime}
			onCancel={handleCancel}
			onPause={handlePause}
			onResume={handleResume}
			onClose={handleClose}
			onRun={runWorkflow}
		/>
	</div>
</div>
{/if}
<style>
	.minimized-execution-progress-fill {
		background-image: linear-gradient(
			135deg,
			rgb(255 255 255 / 0.32) 0 18%,
			transparent 18% 50%,
			rgb(255 255 255 / 0.2) 50% 68%,
			transparent 68% 100%
		);
		background-size: 20px 20px;
	}
</style>
<!-- Orphan Node Warning Modal -->
{#if showOrphanWarning && orphanedNodes.length > 0}
	<OrphanNodeWarningModal
		{orphanedNodes}
		onDismiss={() => (showOrphanWarning = false)}
		onAutoConnect={autoConnectOrphans}
		onViewOnCanvas={handleViewOnCanvas}
		onProceed={proceedWithOrphans}
	/>
{/if}

<!-- Checkpoint Review Modal -->
{#if showCheckpointReview && missionCheckpoint}
	<div class="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
		<div class="w-full max-w-5xl max-h-[calc(100vh-4rem)] overflow-y-auto overscroll-contain mx-4 border border-surface-border">
			<CheckpointReview
				checkpoint={missionCheckpoint}
				onVerify={() => {
					showCheckpointReview = false;
					toasts.success('Checkpoint verified — mission approved');
				}}
				onReject={() => {
					showCheckpointReview = false;
					toasts.warning('Checkpoint rejected — review needed');
				}}
			/>
		</div>
	</div>
{/if}
