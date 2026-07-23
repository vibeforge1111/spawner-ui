/**
 * Provider Runtime Manager
 *
 * Singleton that manages concurrent LLM provider execution sessions.
 * Routes tasks to the correct provider client (OpenAI-compat for API providers,
 * terminal CLI for local tools like Claude and Codex).
 */

import type { BridgeEvent } from '$lib/services/event-bridge';
import {
	buildMultiLLMExecutionPack,
	createDefaultMultiLLMOptions,
	type MultiLLMExecutionPack,
	type MultiLLMProviderConfig
} from '$lib/services/multi-llm-orchestrator';
import type {
	ProviderResult,
	ProviderSession,
	ProviderSessionStatus
} from './provider-clients/types';
import { createBridgeEvent } from './provider-clients/types';
import {
	executeOpenAICompatRequest,
	type OpenAICompatOptions
} from './provider-clients/openai-compat-client';
import { buildFilesystemArtifactPrompt, materializeProviderArtifacts } from './provider-artifacts';
import { executeSparkHarnessRequest } from './provider-clients/spark-harness-client';
import { sparkAgentBridge } from '$lib/services/spark-agent-bridge';
import type { SparkAgentProviderTaskAuthorityPolicy } from '$lib/services/spark-agent-bridge';
import { eventBridge } from '$lib/services/event-bridge';
import { mcpClient } from '$lib/services/mcp-client';
import { agentWorkTimeoutMs } from './timeout-config';
import { extractTraceRef } from './trace-ref';
import {
	assertNativeGovernorHarnessAuthority,
	resolveExecutionAuthority,
	type HarnessAuthorityVerdict
} from './harness-authority';
import { parseJsonOrFallback } from '$lib/utils/safe-json';
import { readFile } from 'node:fs/promises';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnerStateDir } from './spawner-state';

export interface DispatchOptions {
	executionPack: MultiLLMExecutionPack;
	apiKeys: Record<string, string>;
	workingDirectory?: string;
	executionAuthority?: unknown;
	authorityRequestId?: string | null;
	traceRef?: string | null;
	pipelineId?: string | null;
	onEvent: (event: BridgeEvent) => void;
}

export interface DispatchResult {
	success: boolean;
	missionId: string;
	sessions: Record<string, { status: ProviderSessionStatus; error?: string }>;
	startedAt: string;
	authority: HarnessAuthorityVerdict;
}

interface MissionDispatchSnapshot {
	executionPack: MultiLLMExecutionPack;
	apiKeys: Record<string, string>;
	workingDirectory?: string;
	executionAuthority?: unknown;
	authorityRequestId?: string | null;
}

export interface ProviderMissionResultSnapshot {
	providerId: string;
	status: ProviderSessionStatus;
	requestId?: string | null;
	traceRef?: string | null;
	pipelineId?: string | null;
	response: string | null;
	error: string | null;
	durationMs: number | null;
	tokenUsage: ProviderResult['tokenUsage'] | null;
	startedAt: string;
	completedAt: string | null;
}

const PROVIDER_TASK_ACTIVITY_INTERVAL_MS = 120_000;
const PROVIDER_TASK_ACTIVITY_MIN_ESTIMATE_MS = 90_000;
const PROVIDER_TASK_ACTIVITY_MAX_ESTIMATE_MS = 8 * 60_000;
const PROVIDER_TASK_ACTIVITY_BASE_MS = 55_000;
const PROVIDER_TASK_ACTIVITY_PER_TASK_MS = 35_000;
const PROVIDER_STALE_RUNNING_GRACE_MS = 5 * 60_000;
const PROVIDER_DISPATCH_AUTHORITY_POLICY: SparkAgentProviderTaskAuthorityPolicy = {
	toolName: 'spawner.dispatch',
	mutationClass: 'launches_mission'
};

function getSpawnerStateDir(): string {
	return spawnerStateDir();
}

function getActiveMissionPath(): string {
	return path.join(getSpawnerStateDir(), 'active-mission.json');
}

function getProviderResultsPath(): string {
	return path.join(getSpawnerStateDir(), 'mission-provider-results.json');
}

function envStaleRunningProviderMs(): number | null {
	const raw = process.env.SPAWNER_PROVIDER_STALE_RUNNING_MS;
	if (!raw) return null;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function staleRunningProviderMs(): number {
	const fromEnv = envStaleRunningProviderMs();
	if (fromEnv !== null) return Math.max(60_000, fromEnv);
	return Math.max(
		60_000,
		agentWorkTimeoutMs() + PROVIDER_STALE_RUNNING_GRACE_MS
	);
}

function estimateProviderTaskActivityMs(taskCount: number): number {
	const normalizedTaskCount = Math.max(1, Math.min(12, Math.trunc(taskCount) || 1));
	return Math.min(
		PROVIDER_TASK_ACTIVITY_MAX_ESTIMATE_MS,
		Math.max(
			PROVIDER_TASK_ACTIVITY_MIN_ESTIMATE_MS,
			PROVIDER_TASK_ACTIVITY_BASE_MS + normalizedTaskCount * PROVIDER_TASK_ACTIVITY_PER_TASK_MS
		)
	);
}

function formatDurationCompact(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 10 && seconds > 0) return `${minutes}m ${seconds}s`;
	return `${minutes}m`;
}

function isTerminalProviderStatus(status: ProviderSessionStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function reconcileStaleProviderResults(
	results: ProviderMissionResultSnapshot[],
	options: { now?: number; staleMs?: number; orphaned?: boolean } = {}
): { results: ProviderMissionResultSnapshot[]; changed: boolean } {
	const now = options.now ?? Date.now();
	const staleMs = options.staleMs ?? staleRunningProviderMs();
	const completedAt = new Date(now).toISOString();
	let changed = false;
	const reconciled = results.map((result) => {
		if (result.status !== 'running') return result;
		const startedAtMs = Date.parse(result.startedAt);
		const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, now - startedAtMs) : 0;
		if (!options.orphaned && (!Number.isFinite(startedAtMs) || durationMs < staleMs)) return result;
		changed = true;
		return {
			...result,
			status: 'failed' as ProviderSessionStatus,
			error:
				result.error ||
				(options.orphaned
					? 'Provider runtime has no active session after Spawner restart; marked stale so the mission can be run again.'
					: `Provider runtime went quiet after ${formatDurationCompact(durationMs)}; marked stale so the mission stops reporting as active.`),
			durationMs: result.durationMs ?? durationMs,
			completedAt: result.completedAt || completedAt
		};
	});
	return { results: reconciled, changed };
}

function formatProviderTaskActivityMessage(
	providerLabel: string,
	taskName: string,
	assignedTaskCount: number
): string {
	const packLabel = assignedTaskCount > 1 ? `${assignedTaskCount} task pack` : taskName;
	return `${providerLabel} is still working through ${packLabel}.`;
}

function isBusyFileSystemError(error: unknown): boolean {
	return (
		Boolean(error) &&
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		((error as { code?: string }).code === 'EBUSY' || (error as { code?: string }).code === 'EPERM')
	);
}

export function providerShouldUseSparkExecutionBridge(
	provider: Pick<MultiLLMProviderConfig, 'sparkExecutionBridge'>,
	env: Record<string, string | undefined> = process.env
): boolean {
	return Boolean(
		provider.sparkExecutionBridge &&
			((env.SPARK_AGENT_HARNESS_URL || '').trim() || (env.SPARK_HARNESS_URL || '').trim())
	);
}

function sessionToResultSnapshot(session: ProviderSession): ProviderMissionResultSnapshot {
	return withMissionTraceMetadata(session.missionId, {
		providerId: session.providerId,
		status: session.status,
		requestId: session.requestId ?? null,
		traceRef: session.traceRef ?? null,
		pipelineId: session.pipelineId ?? null,
		response: session.result?.response ?? null,
		error: session.error ?? session.result?.error ?? null,
		durationMs: session.result?.durationMs ?? null,
		tokenUsage: session.result?.tokenUsage ?? null,
		startedAt: session.startedAt.toISOString(),
		completedAt: session.completedAt ? session.completedAt.toISOString() : null
	});
}

function missionTraceMetadata(missionId: string): {
	requestId: string | null;
	traceRef: string | null;
	pipelineId: string | null;
} {
	for (const fileName of ['last-canvas-load.json', 'pending-request.json']) {
		try {
			const raw = readFileSync(path.join(getSpawnerStateDir(), fileName), 'utf-8');
			const parsed = parseJsonOrFallback<Record<string, unknown>>(raw, {}, `mission-trace-metadata:${fileName}`);
			const relay = parsed.relay && typeof parsed.relay === 'object'
				? (parsed.relay as Record<string, unknown>)
				: null;
			const missionIds = [
				typeof parsed.missionId === 'string' ? parsed.missionId : null,
				typeof relay?.missionId === 'string' ? relay.missionId : null
			];
			if (!missionIds.includes(missionId)) continue;
			return {
				requestId:
					(typeof parsed.requestId === 'string' && parsed.requestId) ||
					(typeof relay?.requestId === 'string' && relay.requestId) ||
					null,
				traceRef: extractTraceRef(parsed, relay) || null,
				pipelineId:
					(typeof parsed.pipelineId === 'string' && parsed.pipelineId) ||
					(typeof relay?.pipelineId === 'string' && relay.pipelineId) ||
					null
			};
		} catch {
			// Mission metadata is best-effort; provider execution should not depend on it.
		}
	}
	return { requestId: null, traceRef: null, pipelineId: null };
}

function withMissionTraceMetadata(
	missionId: string,
	result: ProviderMissionResultSnapshot
): ProviderMissionResultSnapshot {
	const metadata = missionTraceMetadata(missionId);
	const requestId = result.requestId || metadata.requestId;
	const traceRef = result.traceRef || metadata.traceRef;
	const pipelineId = result.pipelineId || metadata.pipelineId;
	return {
		...result,
		...(requestId ? { requestId } : {}),
		...(traceRef ? { traceRef } : {}),
		...(pipelineId ? { pipelineId } : {})
	};
}

class ProviderRuntimeManager {
	private sessions = new Map<string, ProviderSession>();
	private sparkAgentSessionIds = new Map<string, string>();
	private dispatchSnapshots = new Map<string, MissionDispatchSnapshot>();
	private providerTaskHeartbeats = new Map<string, ReturnType<typeof setInterval>>();
	private providerTaskTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
	private missionEventHandlers = new Map<string, (event: BridgeEvent) => void>();
	private pausedMissions = new Set<string>();
	private pausedReasons = new Map<string, string>();
	private lastStatusReason = new Map<string, string>();
	private persistedResults = this.loadPersistedResults();

	private sessionKey(missionId: string, providerId: string): string {
		return `${missionId}:${providerId}`;
	}

	private rememberStatusReason(missionId: string, reason?: string): void {
		if (!reason) return;
		this.lastStatusReason.set(missionId, reason);
	}

	private loadPersistedResults(): Map<string, ProviderMissionResultSnapshot[]> {
		try {
			const persistPath = getProviderResultsPath();
			if (!existsSync(persistPath)) return new Map();
			const raw = readFileSync(persistPath, 'utf-8');
			if (!raw.trim()) return new Map();
			const parsed = parseJsonOrFallback<{ missions?: Record<string, ProviderMissionResultSnapshot[]> }>(
				raw,
				{},
				'provider-results'
			);
			return new Map(
				Object.entries(parsed.missions ?? {}).map(([missionId, results]) => [
					missionId,
					Array.isArray(results) ? results.map((result) => withMissionTraceMetadata(missionId, result)) : []
				])
			);
		} catch (error) {
			console.warn('[ProviderRuntime] Failed to load persisted provider results:', error);
			return new Map();
		}
	}

	private persistResults(): void {
		try {
			const persistPath = getProviderResultsPath();
			mkdirSync(path.dirname(persistPath), { recursive: true });
			const tempPath = `${persistPath}.${randomUUID()}.tmp`;
			writeFileSync(
				tempPath,
				JSON.stringify({ missions: Object.fromEntries(this.persistedResults) }, null, 2),
				'utf-8'
			);
			try {
				renameSync(tempPath, persistPath);
			} catch (renameError) {
				try {
					copyFileSync(tempPath, persistPath);
					rmSync(tempPath, { force: true });
				} catch (copyError) {
					rmSync(tempPath, { force: true });
					if (process.env.VITEST && isBusyFileSystemError(copyError)) {
						return;
					}
					throw copyError;
				}
			}
		} catch (error) {
			console.warn('[ProviderRuntime] Failed to persist provider results:', error);
		}
	}

	private persistMissionSessions(missionId: string): void {
		const snapshots = this.getSessionsForMission(missionId).map(sessionToResultSnapshot);
		if (snapshots.length === 0) return;
		this.persistedResults.set(missionId, snapshots);
		this.persistResults();
	}

	private reconcileStaleLiveSessions(missionId: string): void {
		const now = Date.now();
		const staleMs = staleRunningProviderMs();
		let changed = false;
		const staleSessions: ProviderSession[] = [];

		for (const [key, session] of this.sessions) {
			if (session.missionId !== missionId || session.status !== 'running') continue;
			const durationMs = Math.max(0, now - session.startedAt.getTime());
			if (durationMs < staleMs) continue;

			const reason = `Provider runtime went quiet after ${formatDurationCompact(durationMs)}; marked stale so the mission stops reporting as active.`;
			const heartbeat = this.providerTaskHeartbeats.get(key);
			if (heartbeat) {
				clearInterval(heartbeat);
				this.providerTaskHeartbeats.delete(key);
			}
			const timeout = this.providerTaskTimeouts.get(key);
			if (timeout) {
				clearTimeout(timeout);
				this.providerTaskTimeouts.delete(key);
			}

			session.status = 'failed';
			session.error = session.error || reason;
			session.completedAt = new Date(now);
			session.result = {
				success: false,
				error: session.error,
				durationMs: session.result?.durationMs ?? durationMs,
				tokenUsage: session.result?.tokenUsage
			};
			this.rememberStatusReason(missionId, reason);
			changed = true;
			staleSessions.push(session);
		}

		if (changed) {
			this.persistMissionSessions(missionId);
			this.emitStaleLiveSessionEvents(missionId, staleSessions, new Date(now).toISOString());
		}
	}

	private emitStaleLiveSessionEvents(
		missionId: string,
		staleSessions: ProviderSession[],
		timestamp: string
	): void {
		const onEvent = this.missionEventHandlers.get(missionId);
		if (!onEvent) return;

		for (const session of staleSessions) {
			const reason = session.error || 'Provider runtime went quiet; stale running session was closed.';
			onEvent({
				type: 'task_failed',
				missionId,
				source: session.providerId,
				timestamp,
				message: reason,
				data: {
					success: false,
					error: reason,
					provider: session.providerId,
					durationMs: session.result?.durationMs ?? null,
					stale: true
				}
			});
		}

		const allSessions = this.getSessionsForMission(missionId);
		if (allSessions.length === 0 || !allSessions.every((session) => isTerminalProviderStatus(session.status))) {
			return;
		}

		onEvent({
			type: 'mission_failed',
			missionId,
			source: 'spawner-ui',
			timestamp,
			message: `Mission completed with errors (${allSessions.filter((session) => session.status === 'failed').length} failed)`,
			data: {
				stale: true,
				providers: Object.fromEntries(
					allSessions.map((session) => [
						session.providerId,
						{ status: session.status, error: session.error, durationMs: session.result?.durationMs }
					])
				)
			}
		});
		this.missionEventHandlers.delete(missionId);
	}

	private getReconciledPersistedResults(missionId: string): ProviderMissionResultSnapshot[] {
		const persisted = this.persistedResults.get(missionId) ?? [];
		const orphaned = !this.dispatchSnapshots.has(missionId);
		const reconciled = reconcileStaleProviderResults(persisted, { orphaned });
		const withMetadata = reconciled.results.map((result) => withMissionTraceMetadata(missionId, result));
		const metadataChanged = withMetadata.some(
			(result, index) => result.requestId !== reconciled.results[index]?.requestId || result.traceRef !== reconciled.results[index]?.traceRef
		);
		if (reconciled.changed || metadataChanged) {
			this.persistedResults.set(missionId, withMetadata);
			this.persistResults();
			this.rememberStatusReason(
				missionId,
				orphaned
					? 'Provider runtime restart left no active session; stale running session was closed.'
					: 'Provider runtime went quiet; stale running session was closed.'
			);
		}
		return withMetadata;
	}

	private async recoverDispatchSnapshot(missionId: string): Promise<MissionDispatchSnapshot | null> {
		const existing = this.dispatchSnapshots.get(missionId);
		if (existing) return existing;

		const activeMissionPath = getActiveMissionPath();
		if (existsSync(activeMissionPath)) {
			try {
				const raw = await readFile(activeMissionPath, 'utf-8');
				const state = parseJsonOrFallback<{
					missionId?: string;
					multiLLMExecution?: MultiLLMExecutionPack | null;
				}>(raw, {}, 'active-mission-recovery');
				if (state.missionId === missionId && state.multiLLMExecution) {
					const apiKeys: Record<string, string> = {};
					for (const provider of state.multiLLMExecution.providers || []) {
						if (provider.requiresApiKey && provider.apiKeyEnv) {
							const value = process.env[provider.apiKeyEnv];
							if (value && value.trim()) {
								apiKeys[provider.id] = value.trim();
							}
						}
					}

					const snapshot: MissionDispatchSnapshot = {
						executionPack: state.multiLLMExecution,
						apiKeys,
						workingDirectory: undefined
					};
					this.dispatchSnapshots.set(missionId, snapshot);
					this.rememberStatusReason(missionId, 'Recovered dispatch snapshot from active mission state; recovered authority is evidence only');
					return snapshot;
				}
			} catch (error) {
				console.warn('[ProviderRuntime] Failed to recover dispatch snapshot from active mission file:', error);
			}
		}

		try {
			const missionResult = await mcpClient.getMission(missionId);
			const mission = missionResult.success ? missionResult.data?.mission : null;
			if (!mission) {
				return null;
			}

			const options = createDefaultMultiLLMOptions();
			const executionPack = buildMultiLLMExecutionPack({ mission, options });
			const apiKeys: Record<string, string> = {};
			for (const provider of executionPack.providers) {
				if (provider.apiKeyEnv) {
					const value = process.env[provider.apiKeyEnv];
					if (value && value.trim()) {
						apiKeys[provider.id] = value.trim();
					}
				}
			}

			const snapshot: MissionDispatchSnapshot = {
				executionPack,
				apiKeys,
				workingDirectory: undefined
			};
			this.dispatchSnapshots.set(missionId, snapshot);
			this.rememberStatusReason(missionId, 'Rebuilt dispatch snapshot from mission record');
			return snapshot;
		} catch (error) {
			console.warn('[ProviderRuntime] Failed to rebuild dispatch snapshot from mission record:', error);
			return null;
		}
	}

	async dispatch(options: DispatchOptions): Promise<DispatchResult> {
		const { executionPack, apiKeys, workingDirectory, onEvent } = options;
		const missionId = extractMissionId(executionPack);
		const startedAt = new Date().toISOString();
		const sessionStatuses: DispatchResult['sessions'] = {};
		const executionAuthority = resolveExecutionAuthority(options.executionAuthority);
		const authority = assertNativeGovernorHarnessAuthority({
			authority: executionAuthority,
			toolName: 'spawner.dispatch',
			ownerSystem: 'spawner-ui',
			mutationClass: 'launches_mission',
			requestId: options.authorityRequestId
		});

		const traceMetadata = missionTraceMetadata(missionId);
		const sessionRequestId = options.authorityRequestId ?? traceMetadata.requestId;
		const sessionTraceRef = options.traceRef ?? traceMetadata.traceRef;
		const sessionPipelineId = options.pipelineId ?? traceMetadata.pipelineId;

		this.dispatchSnapshots.set(missionId, {
			executionPack,
			apiKeys: { ...apiKeys },
			workingDirectory,
			executionAuthority,
			authorityRequestId: options.authorityRequestId ?? null
		});
		this.missionEventHandlers.set(missionId, onEvent);
		this.pausedMissions.delete(missionId);
		this.pausedReasons.delete(missionId);
		this.lastStatusReason.set(missionId, 'Dispatch started');

		onEvent({
			type: 'dispatch_started',
			missionId,
			source: 'spawner-ui',
			timestamp: startedAt,
			message: `Dispatching to ${executionPack.providers.length} provider(s)`,
			data: {
				strategy: executionPack.strategy,
				providers: executionPack.providers.map((p) => p.id),
				authority: {
					source: authority.source,
					traceId: authority.traceId,
					governorOutcome: authority.governorOutcome
				}
			}
		});

		const providerPromises: Promise<void>[] = [];

		for (const provider of executionPack.providers) {
			const key = this.sessionKey(missionId, provider.id);
			const abortController = new AbortController();

			const session: ProviderSession = {
				providerId: provider.id,
				missionId,
				requestId: sessionRequestId,
				traceRef: sessionTraceRef,
				pipelineId: sessionPipelineId,
				status: 'idle',
				abortController,
				startedAt: new Date(),
				completedAt: null,
				result: null,
				error: null
			};

			this.sessions.set(key, session);

			// Resolve API key: request body -> env var fallback
			const apiKey = resolveApiKey(provider, apiKeys);
			const providerPrompt = executionPack.providerPrompts[provider.id] || '';

			if (!providerPrompt) {
				session.status = 'failed';
				session.error = 'No provider prompt generated';
				sessionStatuses[provider.id] = { status: 'failed', error: session.error };
				this.persistMissionSessions(missionId);
				onEvent(
					createBridgeEvent('log', { provider, missionId, onEvent, signal: abortController.signal }, {
						message: `Skipping ${provider.label}: no prompt generated`
					})
				);
				continue;
			}

			if (provider.requiresApiKey && !apiKey) {
				session.status = 'failed';
				session.error = `No API key for ${provider.label} (set ${provider.apiKeyEnv} in .env or provide in UI)`;
				sessionStatuses[provider.id] = { status: 'failed', error: session.error };
				this.persistMissionSessions(missionId);
				onEvent(
					createBridgeEvent('log', { provider, missionId, onEvent, signal: abortController.signal }, {
						message: `Skipping ${provider.label}: no API key configured`
					})
				);
				continue;
			}

			const assignment = executionPack.assignments[provider.id];
			const assignedExecutionTasks =
				assignment?.mode === 'execute' ? assignment.taskIds.length : 0;
			const executesFilesystem =
				provider.executesFilesystem === true ||
				(provider.kind === 'terminal_cli' && (provider.id === 'claude' || provider.id === 'codex'));
			if (assignedExecutionTasks > 0 && !executesFilesystem) {
				session.status = 'failed';
				session.error =
					`${provider.label} is connected for chat/reasoning, but it is not configured as a filesystem executor. ` +
					`Use a terminal executor provider or add an execution bridge before auto-dispatching implementation tasks.`;
				session.completedAt = new Date();
				sessionStatuses[provider.id] = { status: 'failed', error: session.error };
				this.rememberStatusReason(missionId, session.error);
				this.persistMissionSessions(missionId);
				onEvent(
					createBridgeEvent('task_failed', { provider, missionId, onEvent, signal: abortController.signal }, {
						message: session.error,
						data: {
							success: false,
							error: session.error,
							provider: provider.id,
							providerLabel: provider.label,
							assignedTaskCount: assignedExecutionTasks,
							requiresFilesystemExecutor: true
						}
					})
				);
				continue;
			}

			session.status = 'running';
			sessionStatuses[provider.id] = { status: 'running' };
			this.persistMissionSessions(missionId);
			const stopTaskActivity = this.startProviderTaskActivity({
				executionPack,
				provider,
				missionId,
				signal: abortController.signal,
				onEvent
			});

			const providerTimeoutMs = agentWorkTimeoutMs();
			let providerTimedOut = false;
			const providerTimeout = setTimeout(() => {
				this.providerTaskTimeouts.delete(key);
				if (isTerminalProviderStatus(session.status)) return;
				providerTimedOut = true;
				abortController.abort();
				this.rememberStatusReason(
					missionId,
					`${provider.label} timed out after ${Math.round(providerTimeoutMs / 1000)}s`
				);
				onEvent(
					createBridgeEvent('task_failed', { provider, missionId, onEvent, signal: abortController.signal }, {
						message: `${provider.label} timed out after ${Math.round(providerTimeoutMs / 1000)}s`,
						data: {
							success: false,
							error: 'Provider execution timed out',
							provider: provider.id,
							providerLabel: provider.label,
							timeoutMs: providerTimeoutMs
						}
					})
				);
			}, providerTimeoutMs);
			this.providerTaskTimeouts.set(key, providerTimeout);

			const promise = this.executeProvider(
				provider,
				providerPrompt,
				apiKey || '',
				missionId,
				abortController,
				workingDirectory,
				executionAuthority,
				onEvent
			).then((result) => {
				stopTaskActivity();
				clearTimeout(providerTimeout);
				this.providerTaskTimeouts.delete(key);
				if (isTerminalProviderStatus(session.status)) {
					sessionStatuses[provider.id] = {
						status: session.status,
						error: session.error || undefined
					};
					this.persistMissionSessions(missionId);
					return;
				}
				if (providerTimedOut && (result.error === 'Cancelled' || result.error === 'AbortError')) {
					result = {
						success: false,
						error: `${provider.label} timed out after ${Math.round(providerTimeoutMs / 1000)}s`,
						durationMs: providerTimeoutMs
					};
				}
				session.result = result;
				if (session.status === 'cancelled' || result.error === 'Cancelled') {
					session.status = 'cancelled';
					session.error = result.error || session.error;
				} else {
					session.status = result.success ? 'completed' : 'failed';
					session.error = result.error || null;
				}
				session.completedAt = new Date();
				sessionStatuses[provider.id] = {
					status: session.status,
					error: session.error || undefined
				};
				this.persistMissionSessions(missionId);
			}).catch((error) => {
				stopTaskActivity();
				clearTimeout(providerTimeout);
				this.providerTaskTimeouts.delete(key);
				throw error;
			});

			providerPromises.push(promise);
		}

		// Run all providers in parallel - don't await here for immediate return
		// But we need to handle completion
		Promise.allSettled(providerPromises).then(() => {
			const allSessions = this.getSessionsForMission(missionId);
			const allComplete = allSessions.every((s) => isTerminalProviderStatus(s.status));
			const anyFailed = allSessions.some((s) => s.status === 'failed');

			if (allComplete && !this.pausedMissions.has(missionId)) {
				const allCancelled = allSessions.every((s) => s.status === 'cancelled');
				const type = allCancelled ? 'mission_cancelled' : anyFailed ? 'mission_failed' : 'mission_completed';
				this.rememberStatusReason(
					missionId,
					allCancelled
						? 'Mission cancelled'
						: anyFailed
							? 'Mission completed with provider failures'
							: 'Mission completed successfully'
				);
				onEvent({
					type,
					missionId,
					source: 'spawner-ui',
					timestamp: new Date().toISOString(),
					message: allCancelled
						? 'Mission cancelled'
						: anyFailed
						? `Mission completed with errors (${allSessions.filter((s) => s.status === 'failed').length} failed)`
						: `All ${allSessions.length} providers completed successfully`,
					data: {
						providers: Object.fromEntries(
							allSessions.map((s) => [
								s.providerId,
								{ status: s.status, error: s.error, durationMs: s.result?.durationMs }
							])
						)
					}
				});
			}
			if (allComplete) {
				this.missionEventHandlers.delete(missionId);
			}
		});
		this.persistMissionSessions(missionId);

		return {
			success: true,
			missionId,
			sessions: sessionStatuses,
			startedAt,
			authority
		};
	}

	private startProviderTaskActivity(options: {
		executionPack: MultiLLMExecutionPack;
		provider: MultiLLMProviderConfig;
		missionId: string;
		signal: AbortSignal;
		onEvent: (event: BridgeEvent) => void;
	}): () => void {
		const { executionPack, provider, missionId, signal, onEvent } = options;
		const assignment = executionPack.assignments[provider.id];
		const taskIds = assignment?.mode === 'execute' ? assignment.taskIds : [];
		if (taskIds.length === 0) return () => {};

		const key = this.sessionKey(missionId, provider.id);
		const previous = this.providerTaskHeartbeats.get(key);
		if (previous) {
			clearInterval(previous);
			this.providerTaskHeartbeats.delete(key);
		}

		const taskId = taskIds[0];
		const taskName = executionPack.mcpTaskPlans[taskId]?.taskTitle || taskId;
		const startedAt = Date.now();
		const estimatedDurationMs = estimateProviderTaskActivityMs(taskIds.length);
		let lastProgress = 8;

		const emitTaskProgress = () => {
			const elapsedMs = Date.now() - startedAt;
			const estimatedRatio = Math.min(1, elapsedMs / estimatedDurationMs);
			const nextProgress = Math.min(
				88,
				Math.max(lastProgress, Math.round(10 + estimatedRatio * 78))
			);
			lastProgress = nextProgress;
			onEvent(
				createBridgeEvent('task_progress', { provider, missionId, onEvent, signal }, {
					taskId,
					taskName,
					progress: nextProgress,
					message: formatProviderTaskActivityMessage(
						provider.label,
						taskName,
						taskIds.length
					),
					data: {
						taskId,
						taskName,
						progress: nextProgress,
						kind: 'provider_heartbeat',
						suppressExternalRelay: true,
						provider: provider.id,
						providerLabel: provider.label,
						assignedTaskIds: taskIds,
						assignedTaskCount: taskIds.length,
						elapsedMs
					}
				})
			);
		};

		onEvent(
			createBridgeEvent('task_started', { provider, missionId, onEvent, signal }, {
				taskId,
				taskName,
				progress: lastProgress,
				message: `${provider.label} started ${taskName}`,
				data: {
					taskId,
					taskName,
					progress: lastProgress,
					provider: provider.id,
					providerLabel: provider.label,
					assignedTaskIds: taskIds,
					assignedTaskCount: taskIds.length,
					elapsedMs: 0
				}
			})
		);
		emitTaskProgress();

		const interval = setInterval(emitTaskProgress, PROVIDER_TASK_ACTIVITY_INTERVAL_MS);
		this.providerTaskHeartbeats.set(key, interval);

		const stop = () => {
			const active = this.providerTaskHeartbeats.get(key);
			if (active) {
				clearInterval(active);
				this.providerTaskHeartbeats.delete(key);
			}
		};
		signal.addEventListener('abort', stop, { once: true });
		return stop;
	}

	private async executeProvider(
		provider: MultiLLMProviderConfig,
		prompt: string,
		apiKey: string,
		missionId: string,
		abortController: AbortController,
		workingDirectory: string | undefined,
		executionAuthority: unknown,
		onEvent: (event: BridgeEvent) => void
	): Promise<ProviderResult> {
		try {
			if (provider.kind === 'openai_compat') {
				if (providerShouldUseSparkExecutionBridge(provider)) {
					return await executeSparkHarnessRequest({
						provider,
						missionId,
						prompt,
						workingDirectory,
						signal: abortController.signal,
						onEvent
					});
				}

				const opts: OpenAICompatOptions = {
					provider,
					apiKey,
					missionId,
					signal: abortController.signal,
					onEvent
				};
				if (provider.executesFilesystem && workingDirectory) {
					onEvent(
						createBridgeEvent('task_progress', { provider, missionId, onEvent, signal: abortController.signal }, {
							progress: 18,
							message: `${provider.label} is generating compact project files for the hosted preview.`,
							data: {
								kind: 'artifact_generation',
								provider: provider.id,
								providerLabel: provider.label,
								previewState: 'preparing'
							}
						})
					);
					const result = await executeOpenAICompatRequest(
						opts,
						[{ role: 'user', content: buildFilesystemArtifactPrompt(prompt) }],
						false
					);
					if (!result.success) return result;
					const materialized = await materializeProviderArtifacts({
						response: result.response || '',
						workingDirectory
					});
					if (!materialized.ok) {
						return {
							success: false,
							error: materialized.error,
							response: result.response,
							tokenUsage: result.tokenUsage,
							durationMs: result.durationMs
						};
					}
					onEvent(
						createBridgeEvent('task_completed', { provider, missionId, onEvent, signal: abortController.signal }, {
							message: `${provider.label} wrote ${materialized.files.length} project file${materialized.files.length === 1 ? '' : 's'}`,
							data: {
								success: true,
								filesChanged: materialized.files,
								provider: provider.id,
								providerLabel: provider.label
							}
						})
					);
					const responseSummary = {
						status: 'completed',
						summary:
							materialized.summary ||
							`Materialized ${materialized.files.length} hosted project file${materialized.files.length === 1 ? '' : 's'} from ${provider.label}.`,
						project_path: workingDirectory,
						changed_files: materialized.files,
						verification: ['Created files in the hosted Spark workspace for preview.']
					};
					return {
						...result,
						response: JSON.stringify(responseSummary)
					};
				}

				return await executeOpenAICompatRequest(opts, [{ role: 'user', content: prompt }]);
			}

			if (provider.kind === 'terminal_cli') {
				if (provider.id !== 'claude' && provider.id !== 'codex') {
					return {
						success: false,
						error: `Spark agent runtime bridge only supports claude/codex in Step 2 (received: ${provider.id})`
					};
				}

				const sessionKey = this.sessionKey(missionId, provider.id);
				const requestedSparkAgentSessionId = `${missionId}-${provider.id}-${Date.now().toString(36)}`;
				this.sparkAgentSessionIds.set(sessionKey, requestedSparkAgentSessionId);

				const workerResult = await sparkAgentBridge.executeProviderTask({
					providerId: provider.id,
					missionId,
					prompt,
					executionAuthority,
					authorityPolicy: PROVIDER_DISPATCH_AUTHORITY_POLICY,
					model: provider.model,
					workingDirectory,
					commandTemplate: provider.commandTemplate,
					sparkAgentSessionId: requestedSparkAgentSessionId,
					signal: abortController.signal
				});
				this.sparkAgentSessionIds.set(sessionKey, workerResult.sparkAgentSessionId);
				if (workerResult.success && workerResult.response) {
					onEvent(
						createBridgeEvent('task_completed', { provider, missionId, onEvent, signal: abortController.signal }, {
							message: `${provider.label} completed (${workerResult.response.length} chars)`,
							data: {
								success: true,
								responseLength: workerResult.response.length,
								response: workerResult.response,
								provider: provider.id,
								providerLabel: provider.label
							}
						})
					);
				} else if (!workerResult.success && !(workerResult.error === 'Cancelled' && this.pausedMissions.has(missionId))) {
					const failureText = workerResult.error || workerResult.response || 'unknown error';
					onEvent(
						createBridgeEvent('task_failed', { provider, missionId, onEvent, signal: abortController.signal }, {
							message: `${provider.label} failed: ${failureText}`,
							data: {
								success: false,
								error: failureText,
								response: workerResult.response,
								provider: provider.id,
								providerLabel: provider.label
							}
						})
					);
				}
				return {
					success: workerResult.success,
					response: workerResult.response,
					error: workerResult.error,
					durationMs: workerResult.durationMs
				};
			}

			// Custom or unhandled provider kind
			onEvent(
				createBridgeEvent('log', { provider, missionId, onEvent, signal: abortController.signal }, {
					message: `Provider ${provider.label} (kind: ${provider.kind}) not supported for auto-dispatch`
				})
			);
			return {
				success: false,
				error: `Provider kind "${provider.kind}" not yet supported for auto-dispatch`
			};
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return { success: false, error };
		}
	}

	async cancelProvider(missionId: string, providerId: string): Promise<boolean> {
		const key = this.sessionKey(missionId, providerId);
		const session = this.sessions.get(key);
		if (!session || session.status !== 'running') return false;

		session.abortController.abort();
		const sparkAgentSessionId = this.sparkAgentSessionIds.get(key);
		if (sparkAgentSessionId) {
			sparkAgentBridge.cancelProviderTask(sparkAgentSessionId, 'Cancelled by user');
		}
		session.status = 'cancelled';
		session.completedAt = new Date();
		this.persistMissionSessions(missionId);
		return true;
	}

	private assertMissionControlAuthority(executionAuthority: unknown): HarnessAuthorityVerdict {
		return assertNativeGovernorHarnessAuthority({
			authority: resolveExecutionAuthority(executionAuthority),
			toolName: 'spawner.mission_control.command',
			ownerSystem: 'spawner-ui',
			mutationClass: 'controls_mission'
		});
	}

	private async cancelMissionAuthorized(missionId: string, reason = 'Mission cancelled'): Promise<void> {
		for (const [key, session] of this.sessions) {
			if (session.missionId === missionId && session.status === 'running') {
				session.abortController.abort();
				const sparkAgentSessionId = this.sparkAgentSessionIds.get(key);
				if (sparkAgentSessionId) {
					sparkAgentBridge.cancelProviderTask(sparkAgentSessionId, reason);
				}
				session.status = 'cancelled';
				session.error = reason;
				session.completedAt = new Date();
			}
		}
		this.persistMissionSessions(missionId);
		this.rememberStatusReason(missionId, reason);
	}

	async cancelMission(missionId: string, reason = 'Mission cancelled', executionAuthority?: unknown): Promise<void> {
		this.assertMissionControlAuthority(executionAuthority);
		await this.cancelMissionAuthorized(missionId, reason);
	}

	async pauseMission(missionId: string, executionAuthority?: unknown): Promise<{ paused: boolean; reason?: string }> {
		this.assertMissionControlAuthority(executionAuthority);
		const running = this.getSessionsForMission(missionId).filter((s) => s.status === 'running');
		if (running.length === 0) {
			const knownMission =
				this.getSessionsForMission(missionId).length > 0 ||
				this.persistedResults.has(missionId) ||
				this.dispatchSnapshots.has(missionId) ||
				this.pausedMissions.has(missionId);
			if (!knownMission) {
				try {
					const missionResult = await mcpClient.getMission(missionId);
					const mission = missionResult.success ? missionResult.data?.mission : null;
					if (mission) {
						if (mission.status === 'completed' || mission.status === 'failed') {
							const reason = `Mission is already ${mission.status}.`;
							this.rememberStatusReason(missionId, reason);
							return { paused: false, reason };
						}
						this.pausedMissions.add(missionId);
						this.pausedReasons.set(missionId, 'Mission paused; no active provider sessions were running.');
						this.rememberStatusReason(missionId, 'Mission paused');
						return { paused: true, reason: 'Mission paused' };
					}
				} catch {
					// Keep the user-facing not-found path below; pause should not fail loudly while probing storage.
				}
			}
			const reason = knownMission
				? 'No active provider sessions to pause.'
				: 'Mission not found or no provider sessions.';
			this.rememberStatusReason(missionId, reason);
			return { paused: false, reason };
		}

		this.pausedMissions.add(missionId);
		this.pausedReasons.set(missionId, 'Mission paused');
		await this.cancelMissionAuthorized(missionId, 'Mission paused');
		this.rememberStatusReason(missionId, 'Mission paused');
		return { paused: true, reason: 'Mission paused' };
	}

	async resumeMission(
		missionId: string,
		onEvent: (event: BridgeEvent) => void = (event) => eventBridge.emit(event),
		executionAuthority?: unknown,
		dispatchAuthority?: unknown
	): Promise<{ resumed: boolean; reason?: string }> {
		this.assertMissionControlAuthority(executionAuthority);
		if (!this.pausedMissions.has(missionId)) {
			const reason = 'Mission is not paused.';
			this.rememberStatusReason(missionId, reason);
			return { resumed: false, reason };
		}

		const snapshot = await this.recoverDispatchSnapshot(missionId);
		if (!snapshot) {
			const reason = 'No dispatch snapshot available to resume mission (recovery failed from active state/mission record).';
			this.pausedReasons.set(missionId, reason);
			this.rememberStatusReason(missionId, reason);
			return { resumed: false, reason };
		}

		const active = this.getSessionsForMission(missionId).some((s) => s.status === 'running');
		if (active) {
			this.pausedMissions.delete(missionId);
			this.pausedReasons.delete(missionId);
			const reason = 'Mission already has running provider sessions.';
			this.rememberStatusReason(missionId, reason);
			return { resumed: true, reason };
		}
		const freshDispatchAuthority = resolveExecutionAuthority(dispatchAuthority);
		if (!freshDispatchAuthority) {
			const reason = 'Fresh dispatch authority is required to resume provider execution; stored dispatch authority is evidence only.';
			this.pausedReasons.set(missionId, reason);
			this.rememberStatusReason(missionId, reason);
			return { resumed: false, reason };
		}
		assertNativeGovernorHarnessAuthority({
			authority: freshDispatchAuthority,
			toolName: 'spawner.dispatch',
			ownerSystem: 'spawner-ui',
			mutationClass: 'launches_mission'
		});

		await this.dispatch({
			executionPack: snapshot.executionPack,
			apiKeys: { ...snapshot.apiKeys },
			workingDirectory: snapshot.workingDirectory,
			executionAuthority: freshDispatchAuthority,
			authorityRequestId: snapshot.authorityRequestId,
			onEvent
		});
		this.pausedMissions.delete(missionId);
		this.pausedReasons.delete(missionId);
		this.rememberStatusReason(missionId, 'Mission resumed');
		return { resumed: true, reason: 'Mission resumed' };
	}

	getSessionsForMission(missionId: string): ProviderSession[] {
		const sessions: ProviderSession[] = [];
		for (const [, session] of this.sessions) {
			if (session.missionId === missionId) {
				sessions.push(session);
			}
		}
		return sessions;
	}

	getMissionResults(missionId: string): ProviderMissionResultSnapshot[] {
		this.reconcileStaleLiveSessions(missionId);
		const live = this.getSessionsForMission(missionId);
		if (live.length > 0) {
			return live.map(sessionToResultSnapshot);
		}
		return this.getReconciledPersistedResults(missionId);
	}

	markMissionTerminalFromLifecycleEvent(input: {
		missionId: string;
		status: 'completed' | 'failed' | 'cancelled';
		providerId?: string | null;
		response?: string | null;
		error?: string | null;
		completedAt?: string | null;
		reason?: string | null;
	}): void {
		const terminalStatus: ProviderSessionStatus = input.status;
		const completedAt = input.completedAt ? new Date(input.completedAt) : new Date();
		const sessionMatches = this.getSessionsForMission(input.missionId).filter(
			(session) => !input.providerId || session.providerId === input.providerId
		);

		for (const session of sessionMatches) {
			if (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') {
				continue;
			}
			session.status = terminalStatus;
			session.completedAt = completedAt;
			session.error = terminalStatus === 'failed' ? input.error || session.error || 'Mission failed' : session.error;
			session.result = {
				success: terminalStatus === 'completed',
				response: input.response || session.result?.response,
				error: terminalStatus === 'failed' ? input.error || session.result?.error || 'Mission failed' : session.result?.error,
				durationMs: session.result?.durationMs ?? Math.max(0, completedAt.getTime() - session.startedAt.getTime()),
				tokenUsage: session.result?.tokenUsage
			};
		}

		const persisted = this.persistedResults.get(input.missionId) ?? [];
		const providerIds =
			input.providerId
				? [input.providerId]
				: sessionMatches.length > 0
					? sessionMatches.map((session) => session.providerId)
					: persisted.map((result) => result.providerId);

		if (persisted.length > 0 && providerIds.length > 0) {
			const next = persisted.map((result) => {
				if (!providerIds.includes(result.providerId)) return result;
				if (result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled') {
					return result;
				}
				return {
					...result,
					status: terminalStatus,
					response: input.response || result.response,
					error: terminalStatus === 'failed' ? input.error || result.error || 'Mission failed' : result.error,
					durationMs:
						result.durationMs ??
						(() => {
							const startedMs = Date.parse(result.startedAt || '');
							return Number.isFinite(startedMs)
								? Math.max(0, completedAt.getTime() - startedMs)
								: 0;
						})(),
					completedAt: result.completedAt || completedAt.toISOString()
				};
			});
			this.persistedResults.set(input.missionId, next);
			this.persistResults();
		} else {
			this.persistMissionSessions(input.missionId);
		}

		this.rememberStatusReason(
			input.missionId,
			input.reason ||
				(terminalStatus === 'completed'
					? 'Mission completed from lifecycle event'
					: 'Mission failed from lifecycle event')
		);
	}

	getMissionStatus(missionId: string): {
		allComplete: boolean;
		anyFailed: boolean;
		paused: boolean;
		pausedReason: string | null;
		lastReason: string | null;
		snapshotAvailable: boolean;
		resumeable: boolean;
		resumeBlocker: string | null;
		providers: Record<string, ProviderSessionStatus>;
	} {
		this.reconcileStaleLiveSessions(missionId);
		const sessions = this.getSessionsForMission(missionId);
		const persisted = sessions.length === 0 ? this.getReconciledPersistedResults(missionId) : [];
		const providers: Record<string, ProviderSessionStatus> = {};
		for (const s of sessions) {
			providers[s.providerId] = s.status;
		}
		for (const result of persisted) {
			providers[result.providerId] = result.status;
		}
		const paused = this.pausedMissions.has(missionId);
		const snapshotAvailable = this.dispatchSnapshots.has(missionId);
		const pausedReason = this.pausedReasons.get(missionId) || null;
		const resumeable = paused && snapshotAvailable;
		const resumeBlocker = paused && !snapshotAvailable
			? pausedReason || 'Missing dispatch snapshot; resume will attempt reconstruction on demand.'
			: null;

		return {
			allComplete:
				sessions.length > 0
					? sessions.every((s) => isTerminalProviderStatus(s.status))
					: persisted.length > 0 && persisted.every((result) => isTerminalProviderStatus(result.status)),
			anyFailed: sessions.some((s) => s.status === 'failed') || persisted.some((result) => result.status === 'failed'),
			paused,
			pausedReason,
			lastReason: this.lastStatusReason.get(missionId) || null,
			snapshotAvailable,
			resumeable,
			resumeBlocker,
			providers
		};
	}

	cleanup(missionId: string): void {
		for (const [key, session] of this.sessions) {
			if (session.missionId === missionId) {
				const heartbeat = this.providerTaskHeartbeats.get(key);
				if (heartbeat) {
					clearInterval(heartbeat);
					this.providerTaskHeartbeats.delete(key);
				}
				const timeout = this.providerTaskTimeouts.get(key);
				if (timeout) {
					clearTimeout(timeout);
					this.providerTaskTimeouts.delete(key);
				}
				if (session.status === 'running') {
					session.abortController.abort();
					const sparkAgentSessionId = this.sparkAgentSessionIds.get(key);
					if (sparkAgentSessionId) {
						sparkAgentBridge.cancelProviderTask(sparkAgentSessionId, 'Runtime cleanup');
					}
				}
				this.sparkAgentSessionIds.delete(key);
				this.sessions.delete(key);
			}
		}
		this.dispatchSnapshots.delete(missionId);
		this.missionEventHandlers.delete(missionId);
		this.pausedMissions.delete(missionId);
		this.pausedReasons.delete(missionId);
		this.lastStatusReason.delete(missionId);
		this.persistedResults.delete(missionId);
		this.persistResults();
	}

	clearInMemoryForTests(missionId: string): void {
		for (const [key, session] of this.sessions) {
			if (session.missionId === missionId) {
				const heartbeat = this.providerTaskHeartbeats.get(key);
				if (heartbeat) {
					clearInterval(heartbeat);
					this.providerTaskHeartbeats.delete(key);
				}
				const timeout = this.providerTaskTimeouts.get(key);
				if (timeout) {
					clearTimeout(timeout);
					this.providerTaskTimeouts.delete(key);
				}
				this.sparkAgentSessionIds.delete(key);
				this.sessions.delete(key);
			}
		}
		this.dispatchSnapshots.delete(missionId);
		this.missionEventHandlers.delete(missionId);
		this.pausedMissions.delete(missionId);
		this.pausedReasons.delete(missionId);
		this.lastStatusReason.delete(missionId);
	}
}

function extractMissionId(pack: MultiLLMExecutionPack): string {
	if (pack.missionId) return pack.missionId;
	// Legacy fallback: orchestrator prompts embed "Mission ID: xxx"
	const firstPrompt = Object.values(pack.providerPrompts)[0] || '';
	const match = firstPrompt.match(/Mission ID:\s*(\S+)/);
	return match?.[1] || `dispatch-${Date.now()}`;
}

function resolveApiKey(
	provider: MultiLLMProviderConfig,
	requestKeys: Record<string, string>
): string | undefined {
	// Keys are pre-merged by the dispatch API route (server env + UI-provided).
	// The API route uses SvelteKit's $env/dynamic/private for proper .env resolution.
	if (requestKeys[provider.id]) return requestKeys[provider.id];
	return undefined;
}

// Singleton
export const providerRuntime = new ProviderRuntimeManager();
