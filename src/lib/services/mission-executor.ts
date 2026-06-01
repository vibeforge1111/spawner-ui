/**
 * Mission Executor Service
 *
 * Unified execution system that:
 * 1. Converts canvas to mission
 * 2. Creates mission in MCP
 * 3. Starts execution
 * 4. Uses WebSocket for real-time updates (falls back to polling)
 * 5. Supports pause/resume/cancel
 * 6. Broadcasts events for bidirectional sync with Claude Code
 */

import type { CanvasNode, Connection } from '$lib/stores/canvas.svelte';
import type { Mission, MissionLog, MissionTask } from '$lib/services/mcp-client';
import { mcpClient } from '$lib/services/mcp-client';
import { logger } from '$lib/utils/logger';

const log = logger.scope('MissionExecutor');
import { buildMissionFromCanvas, validateForMission, generateExecutionPrompt, generateResumeExecutionPrompt, type MissionBuildOptions, type ExecutionPromptOptions } from './mission-builder';
import type { H70SkillContent } from './h70-skills';
import {
	buildMultiLLMExecutionPack,
	createDefaultMultiLLMOptions,
	type MultiLLMExecutionPack,
	type MultiLLMOrchestratorOptions,
	type MultiLLMCapability
} from './multi-llm-orchestrator';
import { getMcpRuntimeSnapshot } from './mcp-runtime';
import { getPipelineOptions } from '$lib/stores/project-goal.svelte';
import { calculateCompletionQuality, isLowQualityCompletion, buildReworkInstruction, MAX_TASK_RETRIES, type TaskCompletionQuality, type ReworkInstruction } from './completion-gates';
import { parseFilesFromLogs } from './artifacts';
import { generateCheckpoint, type ProjectCheckpoint } from './checkpoint';
import { syncClient, broadcastMissionEvent, broadcastTaskEvent, isConnected, type SyncEvent } from './sync-client';
import { clientEventBridge, type BridgeEvent } from './event-bridge';
import { browser } from '$app/environment';
import { getEventsAuthHeaders } from '$lib/services/events-auth-client';
import { get } from 'svelte/store';
import {
	saveMissionState,
	getActiveMissionState,
	clearMissionState,
	addToMissionHistory,
	type PersistedMissionState
} from './persistence';
import {
	calculateGranularMissionProgress,
	calculateTaskCompletionProgress,
	distributeProviderProgressAcrossTasks,
	reconcileMissionTasks
} from './mission-execution-progress';

export type ExecutionMode = 'preview' | 'live';
export type ExecutionStatus = 'idle' | 'creating' | 'running' | 'paused' | 'completed' | 'partial' | 'failed' | 'cancelled';
const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set(['completed', 'failed', 'cancelled']);

export interface TaskProgress {
	taskId: string;
	taskName: string;
	progress: number;        // 0-100 within this task
	message?: string;        // Current activity
	startedAt: number;
}

// H70 Skill info for UI display
export interface LoadedSkillInfo {
	id: string;
	name: string;
	description?: string;
	taskIds: string[];  // Which tasks use this skill
}

export interface AgentRuntimeStatus {
	agentId: string;
	label: string;
	status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
	currentTaskId?: string;
	currentTaskName?: string;
	progress: number;
	message?: string;
	updatedAt: string;
}

export interface TaskTransitionEvent {
	id: string;
	timestamp: string;
	state: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled' | 'handoff' | 'info';
	taskId?: string;
	taskName?: string;
	agentId?: string;
	agentLabel?: string;
	message: string;
	progress?: number;
}

export interface ReconciliationResult {
	totalTasks: number;
	completedTasks: number;
	failedTasks: number;
	pendingTasks: Array<{ id: string; title: string; status: string }>;
	verdict: 'complete' | 'mostly_done' | 'incomplete';
}

export interface ExecutionProgress {
	status: ExecutionStatus;
	missionId: string | null;
	mission: Mission | null;
	executionPrompt: string | null;  // Copy-pasteable prompt for Claude Code
	multiLLMOptions: MultiLLMOrchestratorOptions;
	multiLLMExecution: MultiLLMExecutionPack | null;
	progress: number;              // Overall mission progress 0-100
	currentTaskId: string | null;
	currentTaskName: string | null;
	currentTaskProgress: number;   // Progress within current task 0-100
	currentTaskMessage: string | null;  // Current activity description
	taskProgressMap: Map<string, TaskProgress>;  // Track all task progress
	logs: MissionLog[];
	startTime: Date | null;
	endTime: Date | null;
	error: string | null;
	// H70 Skills
	loadedSkills: LoadedSkillInfo[];  // Skills loaded for this mission
	taskSkillMap: Map<string, string[]>;  // taskId -> skillIds
	// Live runtime visibility
	agentRuntime: Map<string, AgentRuntimeStatus>;  // provider/agent runtime statuses
	taskTransitions: TaskTransitionEvent[];  // chronological task/event transitions
	// Post-completion verification
	reconciliation: ReconciliationResult | null;
	checkpoint: ProjectCheckpoint | null;
}

export interface ExecutionRunOptions extends MissionBuildOptions {
	orchestratorOptions?: MultiLLMOrchestratorOptions;
	executionAuthority?: unknown;
	relay?: {
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
}

export interface ExecutionCallbacks {
	onStatusChange?: (status: ExecutionStatus) => void;
	onProgress?: (progress: number) => void;
	onTaskProgress?: (taskId: string, progress: number, message?: string) => void;  // NEW
	onLog?: (log: MissionLog) => void;
	onTaskStart?: (taskId: string, taskName: string) => void;
	onTaskComplete?: (taskId: string, success: boolean) => void;
	onTaskRework?: (taskId: string, taskName: string, retryNumber: number, maxRetries: number) => void;
	onComplete?: (mission: Mission) => void;
	onError?: (error: string) => void;
}

function normalizeMultiLLMOptions(
	options?: MultiLLMOrchestratorOptions
): MultiLLMOrchestratorOptions {
	const defaults = createDefaultMultiLLMOptions();
	if (!options) {
		return defaults;
	}

	const providers =
		options.providers && options.providers.length > 0
			? options.providers
			: defaults.providers;

	return {
		enabled: options.enabled ?? defaults.enabled,
		strategy: options.strategy ?? defaults.strategy,
		primaryProviderId: options.primaryProviderId ?? defaults.primaryProviderId,
		autoEnableByKeys: options.autoEnableByKeys ?? defaults.autoEnableByKeys,
		autoRouteByTask: options.autoRouteByTask ?? defaults.autoRouteByTask,
		autoDispatch: options.autoDispatch ?? defaults.autoDispatch,
		keyPresence: options.keyPresence ?? {},
		mcpCapabilities: options.mcpCapabilities ?? [],
		mcpTools: options.mcpTools ?? [],
		taskProviderPreferences: options.taskProviderPreferences ?? {},
		providers: providers.map((provider) => ({ ...provider }))
	};
}

function normalizeFlowMessage(message: string | undefined): string {
	return (message || '')
		.replace(/\(\d+(?:m \d+s|m|s) elapsed,\s*(?:about )?\d+(?:m \d+s|m|s) left\)/gi, '(time estimate)')
		.replace(/\(\d+(?:m \d+s|m|s) elapsed,\s*wrapping up\)/gi, '(time estimate)')
		.replace(/\(\d+(?:m \d+s|m|s) elapsed;\s*estimate adjusting\)/gi, '(time estimate)')
		.replace(/\(\d+(?:m \d+s|m|s) elapsed\)/gi, '(time estimate)')
		.replace(/\b\d+%\b/g, '#%')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

class MissionExecutor {
	private pollingInterval: ReturnType<typeof setInterval> | null = null;
	private progress: ExecutionProgress;
	private callbacks: ExecutionCallbacks = {};
	private lastLogId: string | null = null;
	private syncUnsubscribe: (() => void) | null = null;
	private eventBridgeUnsubscribe: (() => void) | null = null;
	private useWebSocket = false;

	// Execution quality tracking
	private taskQualities: Map<string, TaskCompletionQuality> = new Map();
	private taskRetryCount: Map<string, number> = new Map();

	// Health monitoring
	private lastProgressTime: number = Date.now();
	private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
	private providerHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private readonly STALL_WARNING_MINUTES = 3;
	private readonly STALL_CRITICAL_MINUTES = 8;

	// File sync for Claude Code resume capability
	private fileSyncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly FILE_SYNC_DEBOUNCE_MS = 500;

	constructor() {
		this.progress = this.createInitialProgress();
		this.setupSyncSubscription();
		this.setupEventBridgeSubscription();
		// Try to restore from saved state on initialization
		this.tryRestoreState();
	}

	// ============================================
	// Persistence Methods
	// ============================================

	/**
	 * Serialize current progress to persistable format
	 */
	private serializeProgress(): PersistedMissionState {
		return {
			status: this.progress.status,
			missionId: this.progress.missionId,
			mission: this.progress.mission,
			executionPrompt: this.progress.executionPrompt,
			multiLLMOptions: normalizeMultiLLMOptions(this.progress.multiLLMOptions),
			multiLLMExecution: this.progress.multiLLMExecution,
			progress: this.progress.progress,
			currentTaskId: this.progress.currentTaskId,
			currentTaskName: this.progress.currentTaskName,
			currentTaskProgress: this.progress.currentTaskProgress,
			currentTaskMessage: this.progress.currentTaskMessage,
			// Convert Map to Object for JSON serialization
			taskProgressMap: Object.fromEntries(this.progress.taskProgressMap),
			logs: this.progress.logs,
			startTime: this.progress.startTime?.toISOString() || null,
			endTime: this.progress.endTime?.toISOString() || null,
			error: this.progress.error,
			// H70 Skills
			loadedSkills: this.progress.loadedSkills,
			taskSkillMap: Object.fromEntries(this.progress.taskSkillMap),
			// Post-completion verification
			reconciliation: this.progress.reconciliation,
			checkpoint: this.progress.checkpoint,
			savedAt: new Date().toISOString(),
			version: 3
		};
	}

	/**
	 * Restore progress from persisted state
	 */
	private deserializeProgress(saved: PersistedMissionState): void {
		this.progress.status = saved.status;
		this.progress.missionId = saved.missionId;
		this.progress.mission = saved.mission;
		this.progress.executionPrompt = saved.executionPrompt;
		this.progress.multiLLMOptions = normalizeMultiLLMOptions(saved.multiLLMOptions);
		this.progress.multiLLMExecution = saved.multiLLMExecution || null;
		this.progress.progress = saved.progress;
		this.progress.currentTaskId = saved.currentTaskId;
		this.progress.currentTaskName = saved.currentTaskName;
		this.progress.currentTaskProgress = saved.currentTaskProgress;
		this.progress.currentTaskMessage = saved.currentTaskMessage;
		// Convert Object back to Map
		this.progress.taskProgressMap = new Map(Object.entries(saved.taskProgressMap || {}));
		this.progress.logs = saved.logs || [];
		this.progress.startTime = saved.startTime ? new Date(saved.startTime) : null;
		this.progress.endTime = saved.endTime ? new Date(saved.endTime) : null;
		this.progress.error = saved.error;
		// H70 Skills
		this.progress.loadedSkills = saved.loadedSkills || [];
		this.progress.taskSkillMap = new Map(Object.entries(saved.taskSkillMap || {}));
		// Post-completion verification
		this.progress.reconciliation = saved.reconciliation || null;
		this.progress.checkpoint = (saved.checkpoint as ProjectCheckpoint) || null;
		// Live runtime visibility (not persisted currently)
		this.progress.agentRuntime = new Map();
		this.progress.taskTransitions = [];
	}

	/**
	 * Persist current state to localStorage
	 */
	private persistState(): void {
		if (!browser) return;

		// Only persist active missions
		if (this.progress.status === 'idle') {
			clearMissionState();
			this.clearFileSyncState();
			return;
		}

		const serialized = this.serializeProgress();
		const success = saveMissionState(serialized);

		if (success) {
			log.debug('State persisted', {
				status: this.progress.status,
				missionId: this.progress.missionId,
				progress: this.progress.progress
			});
		}

		// If completed/failed/cancelled, move to history and clear file
		if (this.progress.status === 'completed' || this.progress.status === 'failed' || this.progress.status === 'cancelled') {
			addToMissionHistory(serialized);
			clearMissionState();
			this.clearFileSyncState();
			return;
		}

		// Sync to file for Claude Code resume capability (debounced)
		this.syncStateToFile();
	}

	/**
	 * Sync state to file API for Claude Code resume capability
	 * This allows Claude Code to resume missions after interruptions
	 */
	private syncStateToFile(): void {
		if (!browser) return;

		// Debounce rapid updates
		if (this.fileSyncDebounceTimer) {
			clearTimeout(this.fileSyncDebounceTimer);
		}

		this.fileSyncDebounceTimer = setTimeout(async () => {
			try {
				if (this.progress.status === 'completed' || this.progress.status === 'failed' || this.progress.status === 'cancelled') {
					return;
				}
				const mission = this.progress.mission;
				if (!mission || !this.progress.missionId) return;

				// Build task list with status
				const tasks = mission.tasks.map(task => ({
					id: task.id,
					title: task.title,
					status: task.status,
					skills: this.progress.taskSkillMap.get(task.id) || []
				}));

				const completedTasks = mission.tasks
					.filter(t => t.status === 'completed')
					.map(t => t.id);

				const failedTasks = mission.tasks
					.filter(t => t.status === 'failed')
					.map(t => t.id);

				const response = await fetch('/api/mission/active', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', ...getEventsAuthHeaders() },
					body: JSON.stringify({
						missionId: this.progress.missionId,
						missionName: mission.name,
						status: this.progress.status,
						progress: this.progress.progress,
						currentTaskId: this.progress.currentTaskId,
						currentTaskName: this.progress.currentTaskName,
						executionPrompt:
							this.progress.multiLLMExecution?.masterPrompt || this.progress.executionPrompt,
						multiLLMExecution: this.progress.multiLLMExecution,
						tasks,
						completedTasks,
						failedTasks
					})
				});

				if (!response.ok) {
					log.warn('Failed to sync state to file:', await response.text());
				} else {
					log.debug('State synced to file for Claude Code resume');
				}

				// Cancel propagation guard: while the POST was in-flight the operator
				// may have clicked Cancel (or the mission failed/completed). The
				// debounced status check at the top of this callback ran before the
				// network round-trip, so a now-terminal mission would have just been
				// re-persisted as "running" — Claude Code would pick that up and
				// resume work the operator explicitly stopped. Re-check the live
				// status and clear the stale active-mission record if so.
				if (response.ok && TERMINAL_EXECUTION_STATUSES.has(this.progress.status)) {
					await fetch('/api/mission/active', { method: 'DELETE', headers: getEventsAuthHeaders() }).catch((err) => {
						log.warn('Failed to clear stale active-mission after terminal status:', err);
					});
				}
			} catch (error) {
				log.warn('Failed to sync state to file:', error);
			}
		}, this.FILE_SYNC_DEBOUNCE_MS);
	}

	/**
	 * Clear file sync state when mission ends
	 */
	private async clearFileSyncState(): Promise<void> {
		if (!browser) return;

		try {
			if (this.fileSyncDebounceTimer) {
				clearTimeout(this.fileSyncDebounceTimer);
				this.fileSyncDebounceTimer = null;
			}
			await fetch('/api/mission/active', { method: 'DELETE', headers: getEventsAuthHeaders() });
			log.debug('File sync state cleared');
		} catch (error) {
			log.warn('Failed to clear file sync state:', error);
		}
	}

	/**
	 * Try to restore state from localStorage on startup
	 */
	private tryRestoreState(): void {
		if (!browser) return;

		const saved = getActiveMissionState();
		if (!saved) return;

		log.debug('Restoring mission state', {
			missionId: saved.missionId,
			status: saved.status,
			progress: saved.progress
		});

		this.deserializeProgress(saved);

		// If mission was running, add a log about recovery
		if (saved.status === 'running' || saved.status === 'paused') {
			this.addLocalLog('info', `Mission restored from previous session (${saved.progress}% complete)`);

			// If was running, resume polling
			if (saved.status === 'running') {
				this.startProviderHeartbeat();
				this.startPolling();
			}
		}
	}

	/**
	 * Check if there's a resumable mission
	 */
	hasResumableMission(): boolean {
		return this.progress.status !== 'idle' && this.progress.missionId !== null;
	}

	/**
	 * Get info about the current/resumable mission
	 */
	getResumableMissionInfo(): { id: string; name: string; progress: number; status: ExecutionStatus } | null {
		if (!this.hasResumableMission()) return null;

		return {
			id: this.progress.missionId || '',
			name: this.progress.mission?.name || 'Unknown Mission',
			progress: this.progress.progress,
			status: this.progress.status
		};
	}

	/**
	 * Setup WebSocket subscription for real-time updates
	 */
	private setupSyncSubscription(): void {
		// Subscribe to mission events from other clients (e.g., Claude Code)
		this.syncUnsubscribe = syncClient.subscribeAll((event: SyncEvent) => {
			// Only process events for our current mission
			if (event.missionId !== this.progress.missionId) return;

			// Skip UI-originated events, but accept server dispatch lifecycle events.
			if (event.source === 'spawner-ui' && !this.isServerDispatchEvent(event)) return;

			log.debug('Received sync event:', event.type);

			switch (event.type) {
				case 'mission_updated':
					// Another client updated the mission - refresh our state
					this.handleRemoteUpdate(event.data as Partial<Mission>);
					break;

				case 'mission_started':
					if (this.progress.status !== 'running' && !TERMINAL_EXECUTION_STATUSES.has(this.progress.status)) {
						this.progress.status = 'running';
						this.callbacks.onStatusChange?.('running');
					}
					break;

				case 'mission_completed': {
					this.progress.endTime = new Date();
					const syncMission = (event.data.mission as Mission) || this.progress.mission;
					if (syncMission) {
						this.progress.mission = syncMission;
						const providerCompletionEvent = this.withProviderCompletionData(event as BridgeEvent);
						this.applyProviderMissionCompletionFallback(providerCompletionEvent, syncMission);
						const isFullyComplete = this.reconcileMissionCompletion(syncMission);
						if (isFullyComplete) {
							this.progress.status = 'completed';
							this.callbacks.onStatusChange?.('completed');
						}
						this.stopProviderHeartbeat();
						this.stopPolling();
						this.generateMissionCheckpoint(syncMission);
						this.callbacks.onComplete?.(syncMission);
					} else {
						this.progress.status = 'completed';
						this.callbacks.onStatusChange?.('completed');
						this.stopProviderHeartbeat();
						this.stopPolling();
					}
					this.persistState();
					break;
				}

				case 'mission_failed':
					this.progress.status = 'failed';
					this.progress.error = (event.data.error as string) || 'Mission failed';
					this.progress.endTime = new Date();
					this.stopProviderHeartbeat();
					this.stopPolling();
					this.callbacks.onStatusChange?.('failed');
					this.callbacks.onError?.(this.progress.error);
					this.persistState();  // Persist failed state
					break;

				case 'mission_cancelled':
					this.markCancelled((event.data?.error as string) || 'Mission cancelled');
					break;

				case 'mission_paused':
					// Remote client paused the mission
					if (this.progress.status === 'running') {
						this.progress.status = 'paused';
						this.stopPolling();
						this.callbacks.onStatusChange?.('paused');
						this.addLocalLog('info', 'Mission paused (remote)');
						this.persistState();  // Persist paused state
					}
					break;

				case 'mission_resumed':
					// Remote client resumed the mission
					if (this.progress.status === 'paused') {
						this.progress.status = 'running';
						this.startPolling();
						this.callbacks.onStatusChange?.('running');
						this.addLocalLog('info', 'Mission resumed (remote)');
						this.persistState();  // Persist resumed state
					}
					break;

				case 'task_started':
					// Real-time task start notification
					const startData = event.data as { taskId: string; taskName: string };
					if (startData.taskId !== this.progress.currentTaskId) {
						this.progress.currentTaskId = startData.taskId;
						this.progress.currentTaskName = startData.taskName;
						this.callbacks.onTaskStart?.(startData.taskId, startData.taskName);
					}
					break;

				case 'task_progress':
					// Real-time task progress update
					const progressData = event.data as { taskId: string; progress: number; message?: string };
					this.handleTaskProgress(progressData.taskId, progressData.progress, progressData.message);
					break;

				case 'task_completed':
					// Real-time task completion
					const completeData = event.data as { taskId: string; success: boolean };
					this.callbacks.onTaskComplete?.(completeData.taskId, completeData.success);
					break;

				case 'mission_log':
					const log = event.data.log as MissionLog;
					if (log && !this.progress.logs.find(l => l.id === log.id)) {
						this.progress.logs.push(log);
						this.callbacks.onLog?.(log);
					}
					break;

				case 'agent_handoff':
					this.addLocalLog('info', `Agent handoff: ${event.data.from} → ${event.data.to}`);
					break;
			}
		});
	}

	private appendTaskTransition(event: Omit<TaskTransitionEvent, 'id' | 'timestamp'>): void {
		const transition: TaskTransitionEvent = {
			id: `transition-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			timestamp: new Date().toISOString(),
			...event
		};
		if (event.state === 'progress' || event.state === 'started' || event.state === 'info') {
			const normalizedMessage = normalizeFlowMessage(event.message);
			let existingIndex = -1;
			for (let index = this.progress.taskTransitions.length - 1; index >= 0; index -= 1) {
				const item = this.progress.taskTransitions[index];
				if (
					item.state === event.state &&
					item.taskId === event.taskId &&
					item.agentId === event.agentId &&
					normalizeFlowMessage(item.message) === normalizedMessage
				) {
					existingIndex = index;
					break;
				}
			}
			if (existingIndex >= 0) {
				const nextTransitions = [...this.progress.taskTransitions];
				nextTransitions[existingIndex] = { ...nextTransitions[existingIndex], ...transition };
				this.progress.taskTransitions = nextTransitions.slice(-120);
				return;
			}
		}
		this.progress.taskTransitions = [...this.progress.taskTransitions, transition].slice(-120);
	}

	private resolveAgentFromBridgeEvent(event: BridgeEvent): { agentId: string; agentLabel: string } | null {
		const providerId = event.data?.providerId as string | undefined;
		const explicitSource = event.source && event.source !== 'spawner-ui' ? event.source : undefined;
		const agentId = providerId || explicitSource;
		if (!agentId || agentId === 'claude-code' || agentId === 'sparkAgent') {
			return null;
		}
		const agentLabel = agentId === 'codex'
			? 'Codex'
			: agentId === 'claude'
				? 'Claude'
				: agentId;
		return { agentId, agentLabel };
	}

	private shouldQueueTaskStartFromSameProvider(taskId: string, agentId?: string): boolean {
		const mission = this.progress.mission;
		const execution = this.progress.multiLLMExecution;
		if (!mission?.tasks?.length) return false;

		const runningTasks = mission.tasks.filter((task) => task.status === 'in_progress');
		if (runningTasks.length === 0 || runningTasks.some((task) => task.id === taskId)) return false;

		const activeAgents = [...this.progress.agentRuntime.values()].filter(
			(agent) => agent.status === 'running' && agent.currentTaskId
		);
		if (agentId && activeAgents.some((agent) => agent.agentId !== agentId)) {
			return false;
		}

		const isSingleProviderPack =
			!execution?.enabled ||
			execution.strategy === 'single' ||
			execution.providers.length <= 1 ||
			activeAgents.length <= 1;
		if (!isSingleProviderPack) return false;

		if (!agentId) return true;
		const activeAgent = this.progress.agentRuntime.get(agentId);
		return !activeAgent || activeAgent.status === 'running';
	}

	private isServerDispatchEvent(event: BridgeEvent): boolean {
		if (event.source !== 'spawner-ui') return false;
		if (!this.progress.multiLLMExecution?.enabled) return false;
		if (event.missionId && event.missionId !== this.progress.missionId) return false;

		return ['dispatch_started', 'mission_completed', 'mission_failed'].includes(event.type);
	}

	private hasProviderCompletionData(event: BridgeEvent): boolean {
		const providers = event.data?.providers;
		return Boolean(providers && typeof providers === 'object');
	}

	private withProviderCompletionData(event: BridgeEvent): BridgeEvent {
		if (event.type !== 'mission_completed') return event;
		if (this.hasProviderCompletionData(event)) return event;

		const enabledProviders = this.progress.multiLLMExecution?.providers?.filter((provider) => provider.enabled) || [];
		if (enabledProviders.length === 0) return event;

		return {
			...event,
			data: {
				...(event.data || {}),
				providers: Object.fromEntries(
					enabledProviders.map((provider) => [provider.id, { status: 'completed' }])
				)
			}
		};
	}

	private ensureProviderFallbackTaskStarted(
		event: BridgeEvent,
		message = 'Provider is working',
		initialProgress = 8
	): MissionTask | null {
		if (!this.progress.multiLLMExecution?.enabled) return null;
		const mission = this.progress.mission;
		if (!mission?.tasks?.length) return null;

		const currentTask = mission.tasks.find((task) => task.id === this.progress.currentTaskId);
		if (currentTask && currentTask.status === 'in_progress') return currentTask;

		const task = mission.tasks.find((entry) => entry.status === 'in_progress')
			|| mission.tasks.find((entry) => entry.status === 'pending');
		if (!task) return null;

		task.status = 'in_progress';
		mission.current_task_id = task.id;
		this.progress.currentTaskId = task.id;
		this.progress.currentTaskName = task.title;
		this.progress.currentTaskProgress = initialProgress;
		this.progress.currentTaskMessage = message;
		this.progress.taskProgressMap.set(task.id, {
			taskId: task.id,
			taskName: task.title,
			progress: initialProgress,
			message,
			startedAt: Date.now()
		});

		const runtimeAgent = this.resolveAgentFromBridgeEvent(event);
		this.callbacks.onTaskStart?.(task.id, task.title);
		this.callbacks.onTaskProgress?.(task.id, initialProgress, message);
		this.addLocalLog('info', `Provider started: ${task.title}`);
		if (runtimeAgent) {
			this.updateAgentRuntime(runtimeAgent.agentId, runtimeAgent.agentLabel, {
				status: 'running',
				currentTaskId: task.id,
				currentTaskName: task.title,
				progress: initialProgress,
				message
			});
		}
		this.appendTaskTransition({
			state: 'started',
			taskId: task.id,
			taskName: task.title,
			agentId: runtimeAgent?.agentId,
			agentLabel: runtimeAgent?.agentLabel,
			message,
			progress: initialProgress
		});
		this.recalculateOverallProgress();
		this.persistState();

		return task;
	}

	private applyProviderMissionCompletionFallback(event: BridgeEvent, mission: Mission): number {
		if (!this.progress.multiLLMExecution?.enabled) return 0;
		if (event.type !== 'mission_completed') return 0;
		if (!this.hasProviderCompletionData(event)) return 0;

		const unresolvedTasks = mission.tasks.filter(
			(task) => task.status === 'pending' || task.status === 'in_progress'
		);
		if (unresolvedTasks.length === 0) return 0;

		const runtimeAgent = this.resolveAgentFromBridgeEvent(event);
		const completedAt = Date.now();
		for (const task of unresolvedTasks) {
			const existingProgress = this.progress.taskProgressMap.get(task.id);
			task.status = 'completed';
			this.progress.taskProgressMap.set(task.id, {
				taskId: task.id,
				taskName: task.title,
				progress: 100,
				message: 'Completed by provider mission result',
				startedAt: existingProgress?.startedAt || completedAt
			});
			this.callbacks.onTaskComplete?.(task.id, true);
			this.appendTaskTransition({
				state: 'completed',
				taskId: task.id,
				taskName: task.title,
				agentId: runtimeAgent?.agentId,
				agentLabel: runtimeAgent?.agentLabel,
				message: `Completed ${task.title}`,
				progress: 100
			});
		}

		mission.current_task_id = null;
		mission.status = 'completed';
		this.progress.currentTaskId = null;
		this.progress.currentTaskName = null;
		this.progress.currentTaskProgress = 100;
		this.progress.currentTaskMessage = 'Provider completed the mission';
		this.progress.progress = 100;
		this.callbacks.onProgress?.(100);
		this.addLocalLog('info', `Provider completion reconciled ${unresolvedTasks.length} canvas task(s).`);

		return unresolvedTasks.length;
	}

	private updateAgentRuntime(
		agentId: string,
		agentLabel: string,
		partial: Partial<AgentRuntimeStatus>
	): void {
		const existing = this.progress.agentRuntime.get(agentId);
		this.progress.agentRuntime.set(agentId, {
			agentId,
			label: agentLabel,
			status: partial.status || existing?.status || 'idle',
			currentTaskId: partial.currentTaskId ?? existing?.currentTaskId,
			currentTaskName: partial.currentTaskName ?? existing?.currentTaskName,
			progress:
				typeof partial.progress === 'number'
					? partial.progress
					: typeof existing?.progress === 'number'
						? existing.progress
						: 0,
			message: partial.message ?? existing?.message,
			updatedAt: partial.updatedAt || new Date().toISOString()
		});
	}

	private registerLoadedSkills(taskId: string | null | undefined, skillIds: string[]): void {
		if (!taskId || skillIds.length === 0) return;

		for (const rawSkillId of skillIds) {
			const skillId = rawSkillId.trim();
			if (!skillId) continue;
			const existing = this.progress.loadedSkills.find((entry) => entry.id === skillId);
			if (existing) {
				if (!existing.taskIds.includes(taskId)) {
					existing.taskIds = [...existing.taskIds, taskId];
				}
				continue;
			}

			this.progress.loadedSkills.push({
				id: skillId,
				name: skillId,
				taskIds: [taskId]
			});
		}
	}

	private parseSkillLoadedSignal(message?: string, fallbackTaskId?: string | null): { taskId: string | null; skillIds: string[] } | null {
		if (!message) return null;
		if (!message.startsWith('SKILL_LOADED:')) return null;

		const parts = message.split(':');
		if (parts.length < 3) return null;
		const taskId = parts[1]?.trim() || fallbackTaskId || null;
		const skillIds = parts
			.slice(2)
			.join(':')
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean);

		return { taskId, skillIds };
	}

	private getRequiredSkillsForTask(taskId: string): string[] {
		return this.progress.taskSkillMap.get(taskId) || [];
	}

	private getLoadedSkillIdsForTask(taskId: string): string[] {
		return this.progress.loadedSkills
			.filter((entry) => entry.taskIds.includes(taskId))
			.map((entry) => entry.id);
	}

	private getMissingSkillsForTask(taskId: string): string[] {
		const required = this.getRequiredSkillsForTask(taskId);
		if (required.length === 0) return [];
		const loaded = new Set(this.getLoadedSkillIdsForTask(taskId));
		return required.filter((skillId) => !loaded.has(skillId));
	}

	private markCancelled(message = 'Execution cancelled'): void {
		this.progress.status = 'cancelled';
		this.progress.error = message;
		this.progress.endTime = new Date();
		for (const [agentId, agent] of this.progress.agentRuntime.entries()) {
			if (agent.status === 'running') {
				this.progress.agentRuntime.set(agentId, { ...agent, status: 'cancelled', updatedAt: new Date().toISOString() });
			}
		}
		this.stopProviderHeartbeat();
		this.stopPolling();
		this.callbacks.onStatusChange?.('cancelled');
		this.addLocalLog('info', message);
		this.persistState();
	}

	/**
	 * Setup Event Bridge subscription for real-time updates from Claude Code
	 * This is the primary mechanism for receiving events via HTTP POST
	 */
	private setupEventBridgeSubscription(): void {
		if (!browser || !clientEventBridge) return;

		this.eventBridgeUnsubscribe = clientEventBridge.subscribe((event: BridgeEvent) => {
			// Only process events for our current mission (or events without missionId)
			if (event.missionId && event.missionId !== this.progress.missionId) return;

			// Skip events we sent ourselves
			if (event.source === 'spawner-ui') return;

			log.debug('Received event bridge event:', event.type, event);
			const runtimeAgent = this.resolveAgentFromBridgeEvent(event);

			switch (event.type) {
				case 'task_started':
					// Claude Code started a task
					this.updateLastProgress();  // Health monitoring
					const taskId = event.taskId || event.data?.taskId as string;
					const taskName = event.taskName || event.data?.taskName as string;
					if (taskId && this.shouldQueueTaskStartFromSameProvider(taskId, runtimeAgent?.agentId)) {
						break;
					}
					if (taskId && taskId !== this.progress.currentTaskId) {
						this.progress.currentTaskId = taskId;
						this.progress.currentTaskName = taskName || taskId;
						this.progress.currentTaskProgress = 0;
						this.progress.currentTaskMessage = event.message || null;

						// Store in progress map so completion handling can find it later
						this.progress.taskProgressMap.set(taskId, {
							taskId,
							taskName: taskName || taskId,
							progress: 8,
							message: event.message,
							startedAt: Date.now()
						});

						// Update task status in mission to 'in_progress'
						if (this.progress.mission?.tasks) {
							const task = this.progress.mission.tasks.find(t => t.id === taskId);
							if (task) {
								task.status = 'in_progress';
							}
						}

						this.callbacks.onTaskStart?.(taskId, taskName || taskId);
						this.callbacks.onTaskProgress?.(taskId, 8, event.message || 'Task started');
						this.addLocalLog('info', `Started: ${taskName || taskId}`);
						if (runtimeAgent) {
							this.updateAgentRuntime(runtimeAgent.agentId, runtimeAgent.agentLabel, {
								status: 'running',
								currentTaskId: taskId,
								currentTaskName: taskName || taskId,
								progress: 0,
								message: event.message || `Started ${taskName || taskId}`
							});
						}
						this.appendTaskTransition({
							state: 'started',
							taskId,
							taskName: taskName || taskId,
							agentId: runtimeAgent?.agentId,
							agentLabel: runtimeAgent?.agentLabel,
							message: event.message || `Started ${taskName || taskId}`,
							progress: 0
						});

						// Persist the updated state
						this.persistState();
					}
					break;

				case 'task_progress':
				case 'progress':
					// Progress update within a task
					const isProviderHeartbeat = event.data?.kind === 'provider_heartbeat';
					const fallbackTask = event.taskId ? null : this.ensureProviderFallbackTaskStarted(
						event,
						event.message || event.data?.message as string || 'Provider is working',
						Math.max(8, event.progress ?? (event.data?.percent as number) ?? 0)
					);
					const progressTaskId = event.taskId || this.progress.currentTaskId || fallbackTask?.id;
					const progressValue = event.progress ?? (event.data?.percent as number) ?? 0;
					const progressMessage = event.message || event.data?.message as string;
					const skillSignal = this.parseSkillLoadedSignal(progressMessage, progressTaskId);
					const displayProgressMessage = skillSignal
						? `Skills loaded: ${skillSignal.skillIds.join(', ')}`
						: progressMessage;
					if (skillSignal) {
						this.registerLoadedSkills(skillSignal.taskId, skillSignal.skillIds);
						this.addLocalLog('info', `Skills loaded for ${skillSignal.taskId || 'current task'}: ${skillSignal.skillIds.join(', ')}`);
						this.persistState();
					}
					if (progressTaskId) {
						if (!isProviderHeartbeat) {
							this.handleTaskProgress(progressTaskId, progressValue, displayProgressMessage);
							this.applyAssignedTaskPackProgress(
								event.data?.assignedTaskIds,
								progressValue,
								displayProgressMessage
							);
						} else {
							this.progress.currentTaskMessage = displayProgressMessage || null;
						}
						if (runtimeAgent) {
							this.updateAgentRuntime(runtimeAgent.agentId, runtimeAgent.agentLabel, {
								status: 'running',
								currentTaskId: progressTaskId,
								currentTaskName: this.progress.currentTaskName || progressTaskId,
								progress: progressValue,
								message: displayProgressMessage
							});
						}
						if (displayProgressMessage && !skillSignal && !isProviderHeartbeat) {
							this.addLocalLog('info', displayProgressMessage);
						}
						if (!isProviderHeartbeat && (displayProgressMessage || progressValue % 25 === 0)) {
							this.appendTaskTransition({
								state: 'progress',
								taskId: progressTaskId,
								taskName: this.progress.currentTaskName || progressTaskId,
								agentId: runtimeAgent?.agentId,
								agentLabel: runtimeAgent?.agentLabel,
								message: displayProgressMessage || `Progress ${progressValue}%`,
								progress: progressValue
							});
						}
					}
					break;

				case 'task_completed':
				case 'task_failed':
				case 'task_cancelled': {
					// Provider runtime reported terminal task state
					this.updateLastProgress();  // Health monitoring
					const completedTaskId = event.taskId || event.data?.taskId as string;
					const completedTaskName = event.taskName || event.data?.taskName as string || completedTaskId;
					let success = event.type === 'task_completed' && event.data?.success !== false;
					if (completedTaskId && success) {
						const missingSkills = this.getMissingSkillsForTask(completedTaskId);
						if (missingSkills.length > 0) {
							success = false;
							this.addLocalLog('info', `DoD gate: task ${completedTaskId} blocked - missing required skill loads: ${missingSkills.join(', ')}`);
						}
					}

					// Quality gate: calculate task completion quality
					if (completedTaskId) {
						const hasErrors = event.type === 'task_failed' || event.data?.success === false;
						const verification = event.data?.verification as Record<string, unknown> | undefined;
						const filesChanged = (verification?.filesChanged as string[]) || [];
						const taskLogs = this.progress.logs.filter(l => l.task_id === completedTaskId);
						const parsedFiles = parseFilesFromLogs(taskLogs);
						const artifactsCreated = filesChanged.length > 0 || parsedFiles.length > 0;
						const skillsLoaded = !this.getMissingSkillsForTask(completedTaskId).length;
						const gatesPassed = verification?.build !== false && verification?.typecheck !== false;

						const quality = calculateCompletionQuality(
							completedTaskId,
							completedTaskName,
							{ skillsLoaded, artifactsCreated, noErrors: !hasErrors, gatesPassed }
						);
						this.taskQualities.set(completedTaskId, quality);

						// Find task for threshold calculation
						const missionTask = this.progress.mission?.tasks?.find(t => t.id === completedTaskId);
						if (success && isLowQualityCompletion(quality, missionTask)) {
							const retries = this.taskRetryCount.get(completedTaskId) || 0;
							const rework = buildReworkInstruction(quality, missionTask);

							if (retries < MAX_TASK_RETRIES) {
								// REWORK: Set task back to pending for retry
								this.taskRetryCount.set(completedTaskId, retries + 1);
								success = false;
								this.addLocalLog('info', `Quality gate REWORK: task ${completedTaskId} scored ${rework.score}/${rework.threshold} — retry ${retries + 1}/${MAX_TASK_RETRIES}. Fix: ${rework.failedFactors.join(', ')}`);
								broadcastTaskEvent('task_progress', this.progress.mission?.id || '', {
									taskId: completedTaskId,
									taskName: completedTaskName,
									message: `REWORK: scored ${rework.score}/${rework.threshold} — retry ${retries + 1}/${MAX_TASK_RETRIES}`,
									rework,
									retriesRemaining: MAX_TASK_RETRIES - retries - 1
								});
								// Set task back to pending so agent can retry
								if (missionTask) {
									missionTask.status = 'pending';
								}
								this.callbacks.onTaskRework?.(completedTaskId, completedTaskName, retries + 1, MAX_TASK_RETRIES);
								// Skip the rest of the completion flow — task is not done yet
								break;
							} else {
								// BLOCKED: Max retries exhausted, mark as failed
								success = false;
								this.addLocalLog('info', `Quality gate BLOCKED: task ${completedTaskId} scored ${rework.score}/${rework.threshold} — max retries (${MAX_TASK_RETRIES}) exhausted. (${rework.failedFactors.join(', ')})`);
							}
						}

						// Active verification: check if reported files actually exist on disk
						if (filesChanged.length > 0 && this.progress.mission?.context?.projectPath) {
							this.verifyFilesOnDisk(completedTaskId, filesChanged, this.progress.mission.context.projectPath);
						}
					}

					if (completedTaskId) {
						const existingProgress = this.progress.taskProgressMap.get(completedTaskId);
						this.progress.taskProgressMap.set(completedTaskId, {
							taskId: completedTaskId,
							taskName: completedTaskName,
							progress: 100,
							message: success ? 'Completed' : event.type === 'task_cancelled' ? 'Cancelled' : 'Failed',
							startedAt: existingProgress?.startedAt || Date.now()
						});

						if (this.progress.mission?.tasks) {
							const task = this.progress.mission.tasks.find(t => t.id === completedTaskId);
							if (task) {
								task.status = success ? 'completed' : 'failed';
							}
							if (this.progress.currentTaskId === completedTaskId) {
								const nextRunningTask = this.progress.mission.tasks.find(t => t.status === 'in_progress');
								this.progress.currentTaskId = nextRunningTask?.id || null;
								this.progress.currentTaskName = nextRunningTask?.title || null;
								this.progress.currentTaskProgress = nextRunningTask ? this.progress.currentTaskProgress : 0;
								this.progress.currentTaskMessage = nextRunningTask ? this.progress.currentTaskMessage : null;
							}
						}
						this.recalculateOverallProgress();
						this.callbacks.onTaskComplete?.(completedTaskId, success);
						const terminalState = success ? 'completed' : event.type === 'task_cancelled' ? 'cancelled' : 'failed';
						this.addLocalLog(
							'info',
							`${success ? 'Completed' : event.type === 'task_cancelled' ? 'Cancelled' : 'Failed'}: ${completedTaskName}`
						);
						if (runtimeAgent) {
							this.updateAgentRuntime(runtimeAgent.agentId, runtimeAgent.agentLabel, {
								status: terminalState,
								currentTaskId: completedTaskId,
								currentTaskName: completedTaskName,
								progress: 100,
								message:
									terminalState === 'completed'
										? 'Task completed'
										: terminalState === 'cancelled'
											? 'Task cancelled'
											: 'Task failed'
							});
						}
						this.appendTaskTransition({
							state: terminalState,
							taskId: completedTaskId,
							taskName: completedTaskName,
							agentId: runtimeAgent?.agentId,
							agentLabel: runtimeAgent?.agentLabel,
							message: `${terminalState === 'completed' ? 'Completed' : terminalState === 'cancelled' ? 'Cancelled' : 'Failed'} ${completedTaskName}`,
							progress: 100
						});
						this.persistState();
					}
					break;
				}

				case 'handoff':
					// Agent handoff between tasks
					const from = event.data?.from as string || 'previous task';
					const to = event.data?.to as string || 'next task';
					this.addLocalLog('info', `Handoff: ${from} → ${to}`);
					this.appendTaskTransition({
						state: 'handoff',
						agentId: runtimeAgent?.agentId,
						agentLabel: runtimeAgent?.agentLabel,
						message: `Handoff: ${from} → ${to}`
					});
					break;

				case 'skill_loaded':
					// Track which skills have been loaded during execution
					const loadedSkillId = event.data?.skillId as string;
					const loadedSkillName = event.data?.skillName as string || loadedSkillId;
					const skillTaskId = (event.data?.taskId as string) || this.progress.currentTaskId;
					if (loadedSkillId) {
						this.registerLoadedSkills(skillTaskId, [loadedSkillId]);
						const skillEntry = this.progress.loadedSkills.find((entry) => entry.id === loadedSkillId);
						if (skillEntry) {
							skillEntry.name = loadedSkillName;
						}
						this.addLocalLog('info', `Skill loaded: ${loadedSkillId}`);
						this.persistState();

						// Check if current task has required skills loaded
						if (skillTaskId) {
							const missing = this.getMissingSkillsForTask(skillTaskId);
							if (missing.length === 0 && this.getRequiredSkillsForTask(skillTaskId).length > 0) {
								this.addLocalLog('info', `All required skills loaded for task ${skillTaskId}`);
							}
						}
					}
					break;

				case 'mission_completed': {
					this.progress.endTime = new Date();
					const bridgeMission = this.progress.mission;
					if (bridgeMission) {
						const providerCompletionEvent = this.withProviderCompletionData(event);
						this.applyProviderMissionCompletionFallback(providerCompletionEvent, bridgeMission);
						const isFullyComplete = this.reconcileMissionCompletion(bridgeMission);
						if (isFullyComplete) {
							this.progress.status = 'completed';
							this.callbacks.onStatusChange?.('completed');
							this.addLocalLog('info', 'Mission completed successfully');
						}
						this.generateMissionCheckpoint(bridgeMission);
						this.callbacks.onComplete?.(bridgeMission);
					} else {
						this.progress.status = 'completed';
						this.callbacks.onStatusChange?.('completed');
						this.addLocalLog('info', 'Mission completed successfully');
					}
					for (const [agentId, agent] of this.progress.agentRuntime.entries()) {
						if (agent.status === 'running') {
							this.progress.agentRuntime.set(agentId, { ...agent, status: 'completed', progress: 100, updatedAt: new Date().toISOString() });
						}
					}
					this.stopProviderHeartbeat();
					this.persistState();
					break;
				}

				case 'mission_failed':
				case 'error': {
					const errorMsg = event.message || event.data?.error as string || 'Mission failed';
					this.progress.status = 'failed';
					this.progress.error = errorMsg;
					this.progress.endTime = new Date();
					this.callbacks.onStatusChange?.('failed');
					this.callbacks.onError?.(errorMsg);
					for (const [agentId, agent] of this.progress.agentRuntime.entries()) {
						if (agent.status === 'running') {
							this.progress.agentRuntime.set(agentId, { ...agent, status: 'failed', updatedAt: new Date().toISOString() });
						}
					}
					this.stopProviderHeartbeat();
					this.addLocalLog('info', `Error: ${errorMsg}`);
					this.persistState();  // Persist failed state
					break;
				}

				case 'mission_cancelled': {
					const cancelMsg = event.message || event.data?.error as string || 'Mission cancelled';
					this.markCancelled(cancelMsg);
					break;
				}

				case 'log':
					// Generic log message
					const logMessage = event.message || event.data?.message as string;
					if (logMessage) {
						this.addLocalLog('info', logMessage);
					}
					break;

				case 'provider_feedback':
					const feedbackProvider =
						(event.data?.provider as string) ||
						(event.data?.providerId as string) ||
						(event.source as string) ||
						'provider';
					const feedbackSummary =
						(event.data?.summary as string) ||
						(event.message as string) ||
						'Feedback received';
					this.addLocalLog('info', `[${feedbackProvider}] ${feedbackSummary}`);
					if (runtimeAgent) {
						this.updateAgentRuntime(runtimeAgent.agentId, runtimeAgent.agentLabel, {
							status: 'running',
							message: feedbackSummary
						});
					}
					this.appendTaskTransition({
						state: 'info',
						agentId: runtimeAgent?.agentId,
						agentLabel: runtimeAgent?.agentLabel,
						message: `[${feedbackProvider}] ${feedbackSummary}`
					});
					break;

				case 'dispatch_started':
					if (Array.isArray(event.data?.providers)) {
						for (const provider of event.data.providers as string[]) {
							this.updateAgentRuntime(provider, provider.toUpperCase(), {
								status: 'running',
								progress: 0,
								message: 'Dispatched'
							});
						}
					}
					this.ensureProviderFallbackTaskStarted(event, event.message || 'Provider dispatched', 8);
					this.appendTaskTransition({
						state: 'info',
						message: event.message || 'Dispatch started'
					});
					break;

				default:
					// Log unknown event types for debugging
					log.debug('Unknown event type:', event.type);
			}
		});
	}

	/**
	 * Handle remote mission update
	 */
	private handleRemoteUpdate(missionData: Partial<Mission>): void {
		if (missionData.current_task_id && missionData.current_task_id !== this.progress.currentTaskId) {
			this.progress.currentTaskId = missionData.current_task_id;
			// Find task name from tasks array
			const task = missionData.tasks?.find(t => t.id === missionData.current_task_id);
			if (task) {
				this.progress.currentTaskName = task.title;
				this.progress.currentTaskProgress = 0;  // Reset task progress
				this.progress.currentTaskMessage = null;
				this.callbacks.onTaskStart?.(task.id, task.title);
			}
		}

		// Update progress based on completed tasks
		if (missionData.tasks) {
			this.updateOverallProgress(missionData.tasks);
		}
	}

	/**
	 * Handle task progress update (for granular progress within a task)
	 */
	private handleTaskProgress(taskId: string, progress: number, message?: string): void {
		const existing = this.progress.taskProgressMap.get(taskId);
		const meaningfulProgress =
			progress > (existing?.progress ?? -1) ||
			normalizeFlowMessage(message) !== normalizeFlowMessage(existing?.message);
		if (meaningfulProgress) {
			this.updateLastProgress();
		}

		// Update task progress map
		this.progress.taskProgressMap.set(taskId, {
			taskId,
			taskName: existing?.taskName || this.progress.currentTaskName || taskId,
			progress,
			message,
			startedAt: existing?.startedAt || Date.now()
		});

		// Update current task progress if this is the active task
		if (taskId === this.progress.currentTaskId) {
			this.progress.currentTaskProgress = progress;
			this.progress.currentTaskMessage = message || null;
		}

		// Recalculate overall progress with task-level granularity
		this.recalculateOverallProgress();

		// Notify callback
		this.callbacks.onTaskProgress?.(taskId, progress, message);
	}

	private applyAssignedTaskPackProgress(
		assignedTaskIds: unknown,
		providerProgress: number,
		message?: string
	): void {
		if (!this.progress.mission?.tasks?.length || !Array.isArray(assignedTaskIds)) return;

		const taskIds = assignedTaskIds.filter((taskId): taskId is string => typeof taskId === 'string');
		const distributed = distributeProviderProgressAcrossTasks(taskIds, providerProgress);
		if (distributed.size === 0) return;
		const activeTaskId = this.progress.currentTaskId && taskIds.includes(this.progress.currentTaskId)
			? this.progress.currentTaskId
			: taskIds[0];

		let changed = false;
		for (const [taskId, taskProgress] of distributed) {
			if (taskId !== activeTaskId) continue;
			const missionTask = this.progress.mission.tasks.find((task) => task.id === taskId);
			if (!missionTask || missionTask.status === 'completed' || missionTask.status === 'failed') continue;

			const existing = this.progress.taskProgressMap.get(taskId);
			const nextProgress = Math.max(existing?.progress ?? 0, taskProgress);
			if (existing && existing.progress >= nextProgress && existing.message === message) continue;

			this.progress.taskProgressMap.set(taskId, {
				taskId,
				taskName: missionTask.title,
				progress: nextProgress,
				message,
				startedAt: existing?.startedAt || Date.now()
			});
			changed = true;
		}

		if (changed) {
			this.recalculateOverallProgress();
			this.persistState();
		}
	}

	/**
	 * Update overall progress based on task completion ratio
	 */
	private updateOverallProgress(tasks: Array<{ status: string }>): void {
		this.progress.progress = calculateTaskCompletionProgress(tasks);
		this.callbacks.onProgress?.(this.progress.progress);
	}

	/**
	 * Recalculate overall progress with task-level granularity
	 * This provides smoother progress updates by including partial task progress
	 */
	private recalculateOverallProgress(): void {
		const mission = this.progress.mission;
		if (!mission || !mission.tasks || mission.tasks.length === 0) return;

		const newProgress = calculateGranularMissionProgress(mission.tasks, this.progress.taskProgressMap);
		if (newProgress !== this.progress.progress) {
			this.progress.progress = newProgress;
			this.callbacks.onProgress?.(this.progress.progress);
			// Persist progress updates (throttled by the debounced nature of task progress)
			this.persistState();
		}
	}

	private createInitialProgress(): ExecutionProgress {
		return {
			status: 'idle',
			missionId: null,
			mission: null,
			executionPrompt: null,
			multiLLMOptions: createDefaultMultiLLMOptions(),
			multiLLMExecution: null,
			progress: 0,
			currentTaskId: null,
			currentTaskName: null,
			currentTaskProgress: 0,
			currentTaskMessage: null,
			taskProgressMap: new Map(),
			logs: [],
			startTime: null,
			endTime: null,
			error: null,
			loadedSkills: [],
			taskSkillMap: new Map(),
			agentRuntime: new Map(),
			taskTransitions: [],
			reconciliation: null,
			checkpoint: null
		};
	}

	private composeOrchestratorOptionsWithRuntime(): MultiLLMOrchestratorOptions {
		const current = normalizeMultiLLMOptions(this.progress.multiLLMOptions);
		const runtime = getMcpRuntimeSnapshot();
		const runtimeCapabilities = runtime.capabilities as MultiLLMCapability[];
		const runtimeTools = runtime.tools.map((tool) => ({
			instanceId: tool.instanceId,
			mcpName: tool.mcpName,
			toolName: tool.toolName,
			description: tool.description,
			capabilities: tool.capabilities as MultiLLMCapability[]
		}));

		return normalizeMultiLLMOptions({
			...current,
			mcpCapabilities: [...new Set([...(current.mcpCapabilities || []), ...runtimeCapabilities])],
			mcpTools: [...(current.mcpTools || []), ...runtimeTools]
		});
	}

	private emitMcpPlanningLogs(execution: MultiLLMExecutionPack): void {
		const plans = Object.values(execution.mcpTaskPlans || {});
		if (plans.length === 0 || !this.progress.missionId) return;

		const readyPlans = plans.filter((plan) => plan.status === 'ready');
		const blockedPlans = plans.filter((plan) => plan.status === 'blocked');
		this.addLocalLog(
			'info',
			`MCP planning: ${readyPlans.length} task(s) ready, ${blockedPlans.length} optional advisory unavailable`
		);
		broadcastMissionEvent('mission_log', this.progress.missionId, {
			category: 'mcp_planning',
			readyTaskCount: readyPlans.length,
			unavailableTaskCount: blockedPlans.length
		});

		for (const plan of readyPlans) {
			if (plan.toolCalls.length === 0) continue;
			const toolSummary = plan.toolCalls.map((call) => `${call.mcpName}.${call.toolName}`).join(', ');
			this.addLocalLog('info', `MCP plan ready for ${plan.taskTitle}: ${toolSummary}`);
		}

		for (const plan of blockedPlans) {
			this.addLocalLog('info', `Optional MCP unavailable for ${plan.taskTitle}: ${plan.blockedReason} Continuing with fallback.`);
			broadcastMissionEvent('mission_log', this.progress.missionId, {
				category: 'mcp_advisory_unavailable',
				taskId: plan.taskId,
				taskTitle: plan.taskTitle,
				blockedReason: plan.blockedReason,
				fallbackSuggestion: plan.fallbackSuggestion
			});
		}
	}

	/**
	 * Get current execution progress
	 */
	getProgress(): ExecutionProgress {
		return { ...this.progress };
	}

	/**
	 * Set callbacks for execution events
	 */
	setCallbacks(callbacks: ExecutionCallbacks): void {
		this.callbacks = callbacks;
	}

	/**
	 * Validate canvas before execution
	 */
	validate(nodes: CanvasNode[], connections: Connection[]): { valid: boolean; issues: string[] } {
		return validateForMission(nodes, connections);
	}

	/**
	 * Execute workflow by creating and starting a mission
	 * NOTE: Since spawner_mission MCP tool doesn't exist, this builds locally
	 * and generates a copy-pasteable prompt for Claude Code
	 */
	async execute(
		nodes: CanvasNode[],
		connections: Connection[],
		options: ExecutionRunOptions
	): Promise<ExecutionProgress> {
		// Reset state
		this.progress = this.createInitialProgress();
		this.progress.status = 'creating';
		this.progress.startTime = new Date();
		this.progress.multiLLMOptions = normalizeMultiLLMOptions(options.orchestratorOptions);
		this.callbacks.onStatusChange?.('creating');

		// Reset execution tracking for new execution
		this.resetLearningTracking();

		try {
			// Step 1: Validate
			const validation = this.validate(nodes, connections);
			if (!validation.valid) {
				throw new Error(`Validation failed: ${validation.issues.join(', ')}`);
			}

			// Step 2: Build mission from canvas (locally, no MCP call)
			this.addLocalLog('info', 'Creating mission from workflow...');
			const pipelineConfig = getPipelineOptions();
			const normalizedMissionBuildOptions: MissionBuildOptions = {
				...options,
				mode: this.progress.multiLLMOptions.enabled ? 'multi-llm-orchestrator' : options.mode,
				loadH70Skills: pipelineConfig.includeSkills
			};
			const buildResult = await buildMissionFromCanvas(nodes, connections, normalizedMissionBuildOptions);

			if (!buildResult.success || !buildResult.mission) {
				throw new Error(buildResult.error || 'Failed to create mission');
			}

			this.progress.missionId = buildResult.mission.id;
			this.progress.mission = buildResult.mission;
			this.addLocalLog('info', `Mission created: ${buildResult.mission.id}`);

			// Store and log H70 skills if loaded
			if (buildResult.loadedSkills && buildResult.loadedSkills.size > 0) {
				// Convert to LoadedSkillInfo array for UI display
				const loadedSkillInfos: LoadedSkillInfo[] = [];
				const taskSkillMap = buildResult.taskSkillMap || new Map();

				for (const [skillId, skillContent] of buildResult.loadedSkills) {
					// Find which tasks use this skill
					const taskIds: string[] = [];
					for (const [taskId, skillIds] of taskSkillMap) {
						if (skillIds.includes(skillId)) {
							taskIds.push(taskId);
						}
					}

					loadedSkillInfos.push({
						id: skillId,
						name: skillContent.skill.name,
						description: skillContent.skill.description,
						taskIds
					});
				}

				this.progress.loadedSkills = loadedSkillInfos;
				this.progress.taskSkillMap = taskSkillMap;

				const skillNames = loadedSkillInfos.map(s => s.name).join(', ');
				this.addLocalLog('info', `Loaded ${loadedSkillInfos.length} H70 skills: ${skillNames}`);
			}

			// Step 3: Generate copy-pasteable execution prompt (with H70 skills)
			const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3333';
			// Get MCP runtime snapshot for execution prompt
			const mcpSnapshot = getMcpRuntimeSnapshot();
			if (mcpSnapshot.connected) {
				this.addLocalLog('info', `${mcpSnapshot.connectedCount} MCP(s) with ${mcpSnapshot.tools.length} tool(s) available for this mission`);
			}

			const executionPrompt = generateExecutionPrompt(buildResult.mission, {
				loadedSkills: buildResult.loadedSkills,
				taskSkillMap: buildResult.taskSkillMap,
				taskMCPMap: buildResult.taskMCPMap,
				baseUrl,
				mcpSnapshot,
				includeSkills: pipelineConfig.includeSkills,
				includeMCPs: pipelineConfig.includeMCPs
			});
			this.progress.executionPrompt = executionPrompt;
			this.progress.multiLLMExecution = null;
			this.progress.multiLLMOptions = this.composeOrchestratorOptionsWithRuntime();

			if (this.progress.multiLLMOptions.enabled) {
				this.progress.multiLLMExecution = buildMultiLLMExecutionPack({
					mission: buildResult.mission,
					options: this.progress.multiLLMOptions,
					taskSkillMap: buildResult.taskSkillMap,
					baseUrl
				});
				this.progress.multiLLMExecution.missionId = buildResult.mission.id;
				this.emitMcpPlanningLogs(this.progress.multiLLMExecution);
				this.addLocalLog(
					'info',
					`Multi-LLM Orchestrator ready: ${this.progress.multiLLMExecution.providers.length} provider(s), strategy "${this.progress.multiLLMExecution.strategy}"`
				);
			} else {
				this.addLocalLog('info', 'Execution prompt generated - copy to Claude Code to start');
			}

			const shouldAutoDispatch =
				this.progress.multiLLMOptions.enabled &&
				this.progress.multiLLMOptions.autoDispatch &&
				Boolean(this.progress.multiLLMExecution);

			if (shouldAutoDispatch && !options.executionAuthority) {
				throw new Error('Auto-dispatch requires Harness Core Governor execution authority');
			}

			// Broadcast mission created event for sync
			broadcastMissionEvent('mission_created', buildResult.mission.id, {
				mission: buildResult.mission,
				executionPrompt,
				multiLLMExecution: this.progress.multiLLMExecution
			});

			if (!shouldAutoDispatch) {
				// Set status to running (waiting for Claude Code to pick up)
				this.progress.status = 'running';
				this.callbacks.onStatusChange?.('running');

				// Start health monitoring
				this.startHealthMonitoring();
			}

			// Auto-dispatch to providers if enabled
			if (shouldAutoDispatch && this.progress.multiLLMExecution) {
				const dispatchResult = await this.dispatchToProviders(
					this.progress.multiLLMExecution,
					this.progress.multiLLMOptions,
					options.relay,
					options.executionAuthority
				);
				if (!dispatchResult.success) {
					throw new Error(`Auto-dispatch failed: ${dispatchResult.error || 'unknown'}`);
				}
				this.progress.status = 'running';
				this.callbacks.onStatusChange?.('running');
				const providerCount = Object.keys(dispatchResult.sessions || {}).length;
				this.addLocalLog('info', `Auto-dispatched to ${providerCount} provider(s) - execution in progress`);
				this.startHealthMonitoring();
				this.startProviderHeartbeat();
				this.startPolling();
			}

			// Persist state after mission creation
			this.persistState();

			// Listen for sync events from Claude Code
			this.useWebSocket = get(isConnected);
			if (this.useWebSocket) {
				this.addLocalLog('info', 'Listening for updates from Claude Code...');
			} else {
				if (this.progress.multiLLMExecution?.enabled && !this.progress.multiLLMOptions.autoDispatch) {
					this.addLocalLog('info', 'Copy each provider prompt below and launch your configured models');
				} else if (!this.progress.multiLLMOptions.autoDispatch) {
					this.addLocalLog('info', 'Copy the prompt below and paste it into Claude Code');
				}
			}

			return this.progress;

		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			this.progress.status = 'failed';
			this.progress.error = errorMsg;
			this.progress.endTime = new Date();
			this.callbacks.onStatusChange?.('failed');
			this.callbacks.onError?.(errorMsg);
			this.addLocalLog('error', `Execution failed: ${errorMsg}`);
			this.persistState();  // Persist error state
			return this.progress;
		}
	}

	/**
	 * Dispatch execution pack to server-side provider runtime.
	 * Calls POST /api/dispatch which runs providers in parallel.
	 */
	private dispatchRelayMetadata(relay?: ExecutionRunOptions['relay']): ExecutionRunOptions['relay'] | undefined {
		if (!relay) return undefined;
		const metadata = { ...(relay as Record<string, unknown>) };
		delete metadata.executionAuthority;
		delete metadata.execution_authority;
		return metadata as ExecutionRunOptions['relay'];
	}

	private async dispatchToProviders(
		executionPack: import('$lib/services/multi-llm-orchestrator').MultiLLMExecutionPack,
		options: import('$lib/services/multi-llm-orchestrator').MultiLLMOrchestratorOptions,
		relay?: ExecutionRunOptions['relay'],
		executionAuthority?: unknown
	): Promise<{ success: boolean; sessions?: Record<string, unknown>; error?: string }> {
		const response = await fetch('/api/dispatch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				executionPack,
				apiKeys: options.apiKeys || {},
				workingDirectory: this.progress.mission?.context?.projectPath,
				...(executionAuthority ? { executionAuthority } : {}),
				relay: this.dispatchRelayMetadata(relay)
			})
		});
		if (!response.ok) {
			return { success: false, error: `dispatch responded ${response.status}` };
		}
		const rawBody = await response.text().catch(() => '');
		try {
			return rawBody ? JSON.parse(rawBody) : { success: false, error: 'dispatch returned empty body' };
		} catch {
			return { success: false, error: `dispatch returned HTTP 200 but body was not JSON: ${rawBody.slice(0, 300)}` };
		}
	}

	/**
	 * Pause execution
	 */
	async pause(): Promise<boolean> {
		if (!this.progress.missionId || this.progress.status !== 'running') {
			return false;
		}

		this.addLocalLog('info', 'Pause requires a governed mission-control command; local UI pause is disabled.');
		return false;
	}

	/**
	 * Resume execution
	 */
	async resume(): Promise<boolean> {
		if (!this.progress.missionId || this.progress.status !== 'paused') {
			return false;
		}

		this.addLocalLog('info', 'Resume requires a governed mission-control command; local UI resume is disabled.');
		return false;
	}

	/**
	 * Cancel execution
	 */
	async cancel(): Promise<boolean> {
		if (!this.progress.missionId) {
			return false;
		}

		this.addLocalLog('info', 'Cancel requires a governed mission-control command; local UI cancel is disabled.');
		return false;
	}

	/**
	 * Stop and cleanup
	 */
	stop(): void {
		this.stopPolling();
		this.stopProviderHeartbeat();
		this.stopHealthMonitoring();
		this.progress = this.createInitialProgress();
		clearMissionState();  // Clear persisted state when stopping
	}

	/**
	 * Resume a partial mission — re-runs only pending/failed tasks
	 */
	async resumePartial(): Promise<void> {
		if (this.progress.status !== 'partial' || !this.progress.mission) {
			this.addLocalLog('info', 'No partial mission to resume');
			return;
		}

		const mission = this.progress.mission;
		const pendingTasks = mission.tasks.filter(
			t => t.status === 'pending' || t.status === 'in_progress'
		);

		if (pendingTasks.length === 0) {
			this.addLocalLog('info', 'No pending tasks to resume — all tasks finished');
			return;
		}

		// Reset to running state
		this.progress.status = 'running';
		this.progress.endTime = null;
		this.progress.reconciliation = null;
		this.progress.checkpoint = null;
		this.callbacks.onStatusChange?.('running');

		// Generate resume prompt with only pending tasks
		const resumePrompt = generateResumeExecutionPrompt(
			mission,
			pendingTasks,
			{
				taskSkillMap: this.progress.taskSkillMap,
				baseUrl: typeof window !== 'undefined' ? window.location.origin : undefined
			}
		);
		this.progress.executionPrompt = resumePrompt;

		this.addLocalLog('info', `Resuming ${pendingTasks.length} pending tasks from partial mission`);

		// Restart monitoring
		this.startProviderHeartbeat();
		this.startPolling();
		this.startHealthMonitoring();

		// Persist and broadcast
		this.persistState();
		broadcastMissionEvent('mission_resumed', mission.id, {
			pendingTasks: pendingTasks.map(t => t.id),
			resumedAt: Date.now()
		});
	}

	/**
	 * Full cleanup including sync subscription and event bridge
	 */
	destroy(): void {
		this.stop();
		this.stopHealthMonitoring();
		if (this.syncUnsubscribe) {
			this.syncUnsubscribe();
			this.syncUnsubscribe = null;
		}
		if (this.eventBridgeUnsubscribe) {
			this.eventBridgeUnsubscribe();
			this.eventBridgeUnsubscribe = null;
		}
	}

	/**
	 * Start polling for mission updates
	 * Uses faster polling when WebSocket not available
	 */
	private startPolling(): void {
		this.stopPolling();

		// When WebSocket is connected, poll less frequently (backup only)
		// When no WebSocket, poll every 2 seconds for near-real-time updates
		const pollInterval = this.useWebSocket ? 10000 : 2000;

		this.pollingInterval = setInterval(async () => {
			await this.pollMissionStatus();
		}, pollInterval);

		// Immediately poll once
		this.pollMissionStatus();

		log.debug(`Polling started (${pollInterval}ms interval, WebSocket: ${this.useWebSocket})`);
	}

	/**
	 * Stop polling
	 */
	private stopPolling(): void {
		if (this.pollingInterval) {
			clearInterval(this.pollingInterval);
			this.pollingInterval = null;
		}
	}

	// ============================================
	// Health Monitoring Methods
	// ============================================

	/**
	 * Start health monitoring to detect stalls
	 */
	private startHealthMonitoring(): void {
		this.stopHealthMonitoring();
		this.lastProgressTime = Date.now();

		// Check every minute
		this.healthCheckInterval = setInterval(() => {
			this.checkHealth();
		}, 60000);

		log.debug('Health monitoring started');
	}

	/**
	 * Stop health monitoring
	 */
	private stopHealthMonitoring(): void {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}
	}

	/**
	 * Check execution health - detect stalls
	 */
	private checkHealth(): void {
		if (this.progress.status !== 'running') return;

		const minutesSinceProgress = (Date.now() - this.lastProgressTime) / 60000;

		if (minutesSinceProgress >= this.STALL_CRITICAL_MINUTES) {
			const message = `No meaningful progress for ${Math.round(minutesSinceProgress)} minutes - execution may be stalled`;
			this.progress.currentTaskMessage = message;
			this.addLocalLog('error', message);
			this.appendTaskTransition({
				state: 'info',
				taskId: this.progress.currentTaskId || undefined,
				taskName: this.progress.currentTaskName || undefined,
				message
			});
			// Log stall event (using mission_log type for compatibility)
			broadcastMissionEvent('mission_log', this.progress.missionId || '', {
				type: 'stall_warning',
				minutesSinceProgress: Math.round(minutesSinceProgress),
				currentTaskId: this.progress.currentTaskId,
				currentTaskName: this.progress.currentTaskName
			});
		} else if (minutesSinceProgress >= this.STALL_WARNING_MINUTES) {
			const message = `No meaningful progress for ${Math.round(minutesSinceProgress)} minutes - still watching this run`;
			this.progress.currentTaskMessage = message;
			this.addLocalLog('info', message);
			this.appendTaskTransition({
				state: 'info',
				taskId: this.progress.currentTaskId || undefined,
				taskName: this.progress.currentTaskName || undefined,
				message
			});
		}
	}

	/**
	 * Update last progress time - call on any progress
	 */
	private updateLastProgress(): void {
		this.lastProgressTime = Date.now();
	}

	private startProviderHeartbeat(): void {
		this.stopProviderHeartbeat();
		// Canvas progress should reflect mission events, not elapsed-time guesses.
		// Stall detection below still watches long quiet periods, but task state
		// now updates only when the runner reports state or completion.
	}

	private stopProviderHeartbeat(): void {
		if (this.providerHeartbeatInterval) {
			clearInterval(this.providerHeartbeatInterval);
			this.providerHeartbeatInterval = null;
		}
	}

	/**
	 * Poll mission status and logs
	 */
	private async pollProviderRuntimeStatus(): Promise<boolean> {
		if (!browser) return false;
		if (!this.progress.multiLLMExecution?.enabled) return false;
		if (!this.progress.missionId || !this.progress.mission) return false;
		if (!['creating', 'running'].includes(this.progress.status)) return false;

		const response = await fetch(`/api/dispatch?missionId=${encodeURIComponent(this.progress.missionId)}`);
		if (!response.ok) return false;

		const status = await response.json() as {
			allComplete?: boolean;
			anyFailed?: boolean;
			lastReason?: string | null;
			providers?: Record<string, AgentRuntimeStatus['status']>;
		};
		const providers = status.providers || {};
		const providerIds = Object.keys(providers);
		if (providerIds.length === 0) return false;

		for (const [providerId, providerStatus] of Object.entries(providers)) {
			this.updateAgentRuntime(providerId, providerId.toUpperCase(), {
				status: providerStatus,
				progress: providerStatus === 'completed' || providerStatus === 'failed' || providerStatus === 'cancelled' ? 100 : 8,
				message: status.lastReason || providerStatus
			});
		}

		if (!status.allComplete) {
			this.ensureProviderFallbackTaskStarted(
				{
					type: 'dispatch_started',
					missionId: this.progress.missionId,
					source: 'spawner-ui',
					timestamp: new Date().toISOString(),
					message: status.lastReason || 'Provider dispatch running',
					data: { providers: providerIds }
				},
				status.lastReason || 'Provider dispatch running',
				8
			);
			return true;
		}

		if (status.anyFailed) {
			this.progress.status = 'failed';
			this.progress.error = status.lastReason || 'Provider mission failed';
			this.progress.endTime = new Date();
			this.stopProviderHeartbeat();
			this.stopPolling();
			this.callbacks.onStatusChange?.('failed');
			this.callbacks.onError?.(this.progress.error);
			this.addLocalLog('info', `Provider runtime reported failure: ${this.progress.error}`);
			this.persistState();
			return true;
		}

		const completionEvent: BridgeEvent = {
			type: 'mission_completed',
			missionId: this.progress.missionId,
			source: 'spawner-ui',
			timestamp: new Date().toISOString(),
			message: status.lastReason || 'All providers completed successfully',
			data: {
				providers: Object.fromEntries(
					Object.entries(providers).map(([providerId, providerStatus]) => [
						providerId,
						{ status: providerStatus }
					])
				)
			}
		};

		this.progress.endTime = new Date();
		this.applyProviderMissionCompletionFallback(completionEvent, this.progress.mission);
		const isFullyComplete = this.reconcileMissionCompletion(this.progress.mission);
		if (isFullyComplete) {
			this.progress.status = 'completed';
			this.callbacks.onStatusChange?.('completed');
			this.addLocalLog('info', 'Mission completed successfully');
		}
		this.stopProviderHeartbeat();
		this.stopPolling();
		this.generateMissionCheckpoint(this.progress.mission);
		this.callbacks.onComplete?.(this.progress.mission);
		this.persistState();
		return true;
	}

	private async pollMissionStatus(): Promise<void> {
		if (!this.progress.missionId) return;

		try {
			const providerSettled = await this.pollProviderRuntimeStatus();
			if (providerSettled) return;

			// Get mission status
			const missionResult = await mcpClient.getMission(this.progress.missionId);
			if (missionResult.success && missionResult.data?.mission) {
				const mission = missionResult.data.mission;
				const previousMission = this.progress.mission;
				this.progress.mission = mission;

				// Update current task and broadcast if changed
				if (mission.current_task_id) {
					const task = mission.tasks.find(t => t.id === mission.current_task_id);
					if (task && task.id !== this.progress.currentTaskId) {
						this.progress.currentTaskId = task.id;
						this.progress.currentTaskName = task.title;
						this.progress.currentTaskProgress = 0;
						this.progress.currentTaskMessage = null;
						this.callbacks.onTaskStart?.(task.id, task.title);

						// Broadcast task started event for real-time sync
						broadcastTaskEvent('task_started', this.progress.missionId!, {
							taskId: task.id,
							taskName: task.title,
							agentId: task.assignedTo,
							skillId: this.getSkillIdForAgent(task.assignedTo)
						});
					}
				}

				// Detect task completions by comparing with previous state
				if (previousMission) {
					for (const task of mission.tasks) {
						const prevTask = previousMission.tasks.find(t => t.id === task.id);
						if (prevTask && prevTask.status !== task.status) {
							if (task.status === 'completed') {
								// Broadcast task completed
								broadcastTaskEvent('task_completed', this.progress.missionId!, {
									taskId: task.id,
									taskName: task.title,
									success: true,
									agentId: task.assignedTo
								});
							} else if (task.status === 'failed') {
								// Broadcast task failed
								broadcastTaskEvent('task_completed', this.progress.missionId!, {
									taskId: task.id,
									taskName: task.title,
									success: false,
									agentId: task.assignedTo
								});
							}
						}
					}
				}

				// Calculate progress with granularity
				this.recalculateOverallProgress();

				// Check for completion
				if (mission.status === 'completed') {
					this.progress.endTime = new Date();
					this.stopProviderHeartbeat();
					this.stopPolling();
					const isFullyComplete = this.reconcileMissionCompletion(mission);
					if (isFullyComplete) {
						this.progress.status = 'completed';
						this.callbacks.onStatusChange?.('completed');
					}
					this.generateMissionCheckpoint(mission);
					this.callbacks.onComplete?.(mission);
					this.persistState();
				} else if (mission.status === 'failed') {
					this.progress.status = 'failed';
					this.progress.error = mission.error || 'Mission failed';
					this.progress.endTime = new Date();
					this.stopProviderHeartbeat();
					this.stopPolling();
					this.callbacks.onStatusChange?.('failed');
					this.callbacks.onError?.(this.progress.error);
				}
			}

			// Get new logs
			const logsResult = await mcpClient.getMissionLogs(this.progress.missionId, {
				since: this.lastLogId ? undefined : undefined,
				limit: 50
			});

			if (logsResult.success && logsResult.data?.logs) {
				const newLogs = logsResult.data.logs.filter(
					log => !this.progress.logs.find(l => l.id === log.id)
				);

				for (const log of newLogs) {
					this.progress.logs.push(log);
					this.callbacks.onLog?.(log);

					// Track task completions
					if (log.type === 'complete' && log.task_id) {
						this.callbacks.onTaskComplete?.(log.task_id, true);
					} else if (log.type === 'error' && log.task_id) {
						this.callbacks.onTaskComplete?.(log.task_id, false);
					}
				}

				if (newLogs.length > 0) {
					this.lastLogId = newLogs[newLogs.length - 1].id;
				}
			}

		} catch (error) {
			log.error('Polling error:', error);
		}
	}

	/**
	 * Get skill ID for an agent
	 */
	private getSkillIdForAgent(agentId: string): string | undefined {
		const agent = this.progress.mission?.agents.find(a => a.id === agentId);
		return agent?.skills?.[0];
	}

	/**
	 * Add a local log entry (for UI events, not from MCP)
	 */
	private addLocalLog(type: 'info' | 'error', message: string): void {
		const createdAt = new Date().toISOString();
		const logType = type === 'info' ? 'progress' : 'error';
		const normalizedMessage = normalizeFlowMessage(message);
		if (logType === 'progress' && normalizedMessage) {
			for (let index = this.progress.logs.length - 1; index >= Math.max(0, this.progress.logs.length - 12); index -= 1) {
				const existing = this.progress.logs[index];
				if (existing.type !== logType) continue;
				if (normalizeFlowMessage(existing.message) !== normalizedMessage) continue;
				const updatedLog = {
					...existing,
					message,
					created_at: createdAt
				};
				this.progress.logs[index] = updatedLog;
				this.callbacks.onLog?.(updatedLog);
				return;
			}
		}

		const log: MissionLog = {
			id: `local-${Date.now()}`,
			mission_id: this.progress.missionId || '',
			agent_id: null,
			task_id: null,
			type: logType,
			message,
			data: {},
			created_at: createdAt
		};

		this.progress.logs.push(log);
		this.callbacks.onLog?.(log);
	}

	
	/**
	 * Reconcile mission completion — verify all tasks actually completed before accepting "done"
	 * Returns true if mission is fully complete, false if partial
	 */
	private reconcileMissionCompletion(mission: Mission): boolean {
		const snapshot = reconcileMissionTasks(mission.tasks);
		this.progress.reconciliation = {
			totalTasks: snapshot.totalTasks,
			completedTasks: snapshot.completedTasks,
			failedTasks: snapshot.failedTasks,
			pendingTasks: snapshot.pendingTasks,
			verdict: snapshot.verdict
		};

		if (!snapshot.isFullyComplete) {
			this.addLocalLog('info', `Reconciler: ${snapshot.pendingTasks.length}/${snapshot.totalTasks} tasks incomplete - mission marked partial (${snapshot.completedTasks} completed, ${snapshot.failedTasks} failed)`);
			this.progress.status = 'partial';
			this.callbacks.onStatusChange?.('partial');
			return false;
		}

		return true;
	}

	/**
	 * Generate post-mission checkpoint with quality metrics and review summary
	 */
	/**
	 * Phase 1 (sync): Generate checkpoint from available data — fast, shows modal immediately
	 * Phase 2 (async): Run server-side verification — updates checkpoint with real build/test results
	 */
	private generateMissionCheckpoint(mission: Mission): void {
		try {
			const loadedSkills = this.progress.loadedSkills?.map(s => s.id) || [];
			const requiredSkills = [...this.progress.taskSkillMap.values()].flat();
			const taskQualities = [...this.taskQualities.values()];

			// Phase 1: Generate checkpoint from log-parsed data (immediate)
			const checkpoint = generateCheckpoint(mission, {
				loadedSkills,
				requiredSkills,
				taskQualities,
				startTime: this.progress.startTime || new Date(),
				endTime: this.progress.endTime || new Date(),
				logs: this.progress.logs.map(l => ({ level: l.type === 'error' ? 'error' : 'info', message: l.message }))
			});

			this.progress.checkpoint = checkpoint;
			const specCoverage = checkpoint.specAlignment ? `${Math.round(checkpoint.specAlignment.coverageRate * 100)}%` : 'N/A';
			const qualitySummary = checkpoint.quality.taskQualityCount > 0 ? `${Math.round(checkpoint.quality.averageTaskQuality)}/100` : 'not scored';
			this.addLocalLog('info', `Checkpoint (preliminary): ${checkpoint.status} | Spec: ${specCoverage} | Ship: ${checkpoint.canShip ? 'YES' : 'NO'} (quality: ${qualitySummary})`);

			// Phase 2: Run independent server-side verification (async, upgrades checkpoint)
			const projectPath = mission.context?.projectPath;
			if (projectPath) {
				this.runServerVerificationAndUpgrade(mission, projectPath);
			}
		} catch (err) {
			this.addLocalLog('error', `Failed to generate checkpoint: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Async phase: run real build/typecheck/test verification and upgrade the checkpoint
	 * This is the Longshot active harness — independent of agent self-reporting
	 */
	private async runServerVerificationAndUpgrade(mission: Mission, projectPath: string): Promise<void> {
		try {
			this.addLocalLog('info', 'Running independent server-side verification...');
			const serverVerification = await this.runIndependentVerification(projectPath);

			// Run security scan (non-blocking — catch errors silently)
			let securityScan = null;
			try {
				this.addLocalLog('info', 'Running security scan (gitleaks, trivy, opengrep)...');
				const scanResp = await fetch('/api/scan', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ projectPath })
				});
				if (scanResp.ok) {
					securityScan = await scanResp.json();
					this.addLocalLog('info', `Security scan: ${securityScan.totalFindings} findings (${securityScan.criticalCount} critical, ${securityScan.highCount} high). Ship: ${securityScan.canShip ? 'OK' : 'BLOCKED'}`);
				}
			} catch {
				// Security scan is optional — don't block checkpoint on failure
			}

			// Regenerate checkpoint with real server data
			const loadedSkills = this.progress.loadedSkills?.map(s => s.id) || [];
			const requiredSkills = [...this.progress.taskSkillMap.values()].flat();
			const taskQualities = [...this.taskQualities.values()];

			const upgradedCheckpoint = generateCheckpoint(mission, {
				loadedSkills,
				requiredSkills,
				taskQualities,
				startTime: this.progress.startTime || new Date(),
				endTime: this.progress.endTime || new Date(),
				logs: this.progress.logs.map(l => ({ level: l.type === 'error' ? 'error' : 'info', message: l.message })),
				serverVerification,
				securityScan
			});

			this.progress.checkpoint = upgradedCheckpoint;

			const buildStatus = serverVerification.build ? (serverVerification.build.success ? 'PASS' : 'FAIL') : 'N/A';
			const tcStatus = serverVerification.typecheck ? (serverVerification.typecheck.success ? 'PASS' : 'FAIL') : 'N/A';
			const specCoverage = upgradedCheckpoint.specAlignment ? `${Math.round(upgradedCheckpoint.specAlignment.coverageRate * 100)}%` : 'N/A';
			this.addLocalLog('info', `Checkpoint (verified): ${upgradedCheckpoint.status} | Build: ${buildStatus} | TypeCheck: ${tcStatus} | Spec: ${specCoverage} | Ship: ${upgradedCheckpoint.canShip ? 'YES' : 'NO'}`);

			// Re-persist with verified data
			this.persistState();
		} catch (err) {
			this.addLocalLog('error', `Server verification failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Active verification: check if agent-reported files actually exist on disk
	 * Fires async — updates quality score when results return
	 */
	private async verifyFilesOnDisk(taskId: string, files: string[], projectPath: string): Promise<void> {
		try {
			const response = await fetch('/api/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'files', projectPath, files })
			});
			if (!response.ok) return;
			const result = await response.json();
			if (result.missing?.length > 0) {
				this.addLocalLog('info', `File verification: ${result.found?.length || 0}/${files.length} files exist. Missing: ${result.missing.join(', ')}`);
				// Downgrade quality if files are missing
				const existing = this.taskQualities.get(taskId);
				if (existing && result.existenceRate < 0.5) {
					existing.artifactsCreated = false;
					existing.score = Math.max(0, existing.score - 25);
					existing.details.push(`Filesystem check: ${result.missing.length} reported files not found on disk`);
					this.taskQualities.set(taskId, existing);
				}
			} else {
				this.addLocalLog('info', `File verification: all ${files.length} files confirmed on disk`);
			}
		} catch {
			// Non-blocking — API may not be reachable during testing
		}
	}

	/**
	 * Run independent build/typecheck verification against the project directory
	 * Called during checkpoint generation for real server-side verification
	 */
	async runIndependentVerification(projectPath: string): Promise<{
		build: { success: boolean; output: string; duration: number } | null;
		typecheck: { success: boolean; errorCount: number; output: string; duration: number } | null;
		test: { success: boolean; passed: number; failed: number; hasTestScript: boolean; duration: number } | null;
	}> {
		const results: {
			build: { success: boolean; output: string; duration: number } | null;
			typecheck: { success: boolean; errorCount: number; output: string; duration: number } | null;
			test: { success: boolean; passed: number; failed: number; hasTestScript: boolean; duration: number } | null;
		} = { build: null, typecheck: null, test: null };

		try {
			// Run build
			this.addLocalLog('info', 'Independent verification: running build...');
			const buildRes = await fetch('/api/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'build', projectPath })
			});
			if (buildRes.ok) {
				const buildData = await buildRes.json();
				results.build = {
					success: buildData.success,
					output: buildData.stderr || buildData.stdout || '',
					duration: buildData.duration
				};
				this.addLocalLog('info', `Independent verification: build ${buildData.success ? 'PASSED' : 'FAILED'} (${buildData.duration}ms)`);
			}

			// Run typecheck
			this.addLocalLog('info', 'Independent verification: running typecheck...');
			const tcRes = await fetch('/api/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'typecheck', projectPath })
			});
			if (tcRes.ok) {
				const tcData = await tcRes.json();
				results.typecheck = {
					success: tcData.success,
					errorCount: tcData.errorCount,
					output: tcData.stderr || tcData.stdout || '',
					duration: tcData.duration
				};
				this.addLocalLog('info', `Independent verification: typecheck ${tcData.success ? 'PASSED' : `FAILED (${tcData.errorCount} errors)`} (${tcData.duration}ms)`);
			}

			// Run tests
			this.addLocalLog('info', 'Independent verification: checking for tests...');
			const testRes = await fetch('/api/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'test', projectPath })
			});
			if (testRes.ok) {
				const testData = await testRes.json();
				results.test = {
					success: testData.success,
					passed: testData.passed,
					failed: testData.failed,
					hasTestScript: testData.hasTestScript,
					duration: testData.duration
				};
				if (testData.hasTestScript) {
					this.addLocalLog('info', `Independent verification: tests ${testData.success ? 'PASSED' : 'FAILED'} (${testData.passed} passed, ${testData.failed} failed)`);
				} else {
					this.addLocalLog('info', 'Independent verification: no test script found');
				}
			}
		} catch (err) {
			this.addLocalLog('error', `Independent verification failed: ${err instanceof Error ? err.message : String(err)}`);
		}

		return results;
	}

	/**
	 * Reset execution tracking for new execution
	 */
	private resetLearningTracking(): void {
		this.taskQualities.clear();
		this.taskRetryCount.clear();
	}
}

// Singleton instance
export const missionExecutor = new MissionExecutor();

// Export class for testing
export { MissionExecutor };
