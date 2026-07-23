import { env } from '$env/dynamic/private';
import * as fs from 'fs';
import * as path from 'path';
import {
	compactMissionControlDisplayText,
	readableMissionControlSummary,
	sanitizeMissionControlDisplayText
} from './mission-control-display';
import {
	extractMissionControlProjectLineage,
	mergeMissionControlProjectLineage
} from './mission-control-lineage';
import {
	missionControlPathForMission,
	resolveMissionControlAccess
} from './mission-control-access';
import {
	appendAgentEvent,
	buildMissionControlAgentEvent,
	missionStateForEvent
} from './agent-event-ledger';
import { syncCreatorMissionTraceFromLifecycleEvent } from './creator-mission-trace-sync';
import { spawnerStateDir } from './spawner-state';
import { joinMaybeWindowsPath } from './spawner-state';
import { extractTraceRef } from './trace-ref';
import {
	emptyMissionControlTaskStatusCounts,
	isMissionControlTerminalStatus,
	type MissionControlBoardEntry,
	type MissionControlAccessInfo,
	type MissionControlBoardStatus,
	type MissionControlProjectLineage,
	type MissionControlRelayTarget,
	type MissionControlTaskStatus,
	type MissionControlTaskStatusCounts
} from '$lib/types/mission-control';

export type {
	MissionControlBoardEntry,
	MissionControlBoardStatus,
	MissionControlRelayTarget,
	MissionControlTaskStatus,
	MissionControlTaskStatusCounts
} from '$lib/types/mission-control';

export interface MissionControlBridgeEvent {
	id?: string;
	type?: string;
	missionId?: string;
	missionName?: string;
	taskId?: string;
	taskName?: string;
	message?: string;
	timestamp?: string;
	source?: string;
	data?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface MissionControlRelayStatusEntry {
	eventType: string;
	missionId: string;
	missionName: string | null;
	executionPolicy?: 'manual_run' | 'read_only' | string | null;
	taskId: string | null;
	taskName: string | null;
	taskSkills: string[];
	plannedTasks: Array<{ title: string; skills: string[] }>;
	assignedTaskIds: string[];
	requestId: string | null;
	traceRef: string | null;
	/** Canvas pipeline the mission was dispatched from; null/absent when no pipeline exists. */
	pipelineId?: string | null;
	providerId?: string | null;
	model?: string | null;
	progress: number | null;
	summary: string;
	timestamp: string;
	source: string;
	telegramRelay?: MissionControlRelayTarget | null;
	missionControlAccess?: MissionControlAccessInfo | null;
	projectLineage?: MissionControlProjectLineage | null;
}

export interface MissionControlRelaySnapshot {
	enabled: {
		sparkIngest: boolean;
		webhooks: boolean;
	};
	persistence: {
		path: string;
		exists: boolean;
		sizeBytes: number | null;
	};
	targets: {
		sparkIngestUrl: string | null;
		webhookCount: number;
	};
	stats: {
		totalRelayed: number;
		perMission: Record<string, number>;
	};
	recent: MissionControlRelayStatusEntry[];
}

const RELAY_EVENT_TYPES = new Set([
	'mission_created',
	'mission_started',
	'mission_paused',
	'mission_resumed',
	'mission_completed',
	'mission_failed',
	'mission_cancelled',
	'task_started',
	'task_progress',
	'progress',
	'task_completed',
	'task_failed',
	'task_cancelled',
	'dispatch_started',
	'provider_feedback',
	'log'
]);

const MAX_RECENT_EVENTS = Number(env.MISSION_CONTROL_RECENT_EVENT_LIMIT) || 1000;
const MAX_RECENT_EVENTS_PER_MISSION = Number(env.MISSION_CONTROL_RECENT_EVENT_LIMIT_PER_MISSION) || 120;
const DEFAULT_STALE_NON_TERMINAL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SPARK_INGEST_URL = env.SPARK_MISSION_CONTROL_INGEST_URL || '';
const DEFAULT_SPARK_TOKEN = env.SPARKD_TOKEN || '';

function localEnvValue(key: string): string | null {
	const envPath = path.resolve(process.cwd(), '.env');
	if (!fs.existsSync(envPath)) return null;
	const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
	for (const line of [...lines].reverse()) {
		const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
		if (!match || match[1] !== key) continue;
		return match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
	}
	return null;
}

const DEFAULT_WEBHOOKS = (localEnvValue('MISSION_CONTROL_WEBHOOK_URLS') || env.MISSION_CONTROL_WEBHOOK_URLS || '')
	.split(',')
	.map((value) => value.trim())
	.filter(Boolean);
const DEFAULT_TELEGRAM_RELAY_SECRET = localEnvValue('TELEGRAM_RELAY_SECRET') || env.TELEGRAM_RELAY_SECRET?.trim() || '';
const STALE_NON_TERMINAL_MS = Number(env.MISSION_CONTROL_STALE_NONTERMINAL_MS) || DEFAULT_STALE_NON_TERMINAL_MS;
const TASK_TERMINAL_EVENTS = new Set(['task_completed', 'task_failed', 'task_cancelled']);

// Persist relay state so HMR reloads + server restarts don't wipe the history.
// Small file, synchronous writes; we're on the order of tens of events.
export function getMissionControlPersistPath(): string {
	const spawnerDir = spawnerStateDir(env);
	return joinMaybeWindowsPath(spawnerDir, 'mission-control.json');
}

function getMissionControlPersistenceInfo(): MissionControlRelaySnapshot['persistence'] {
	const persistPath = getMissionControlPersistPath();
	try {
		const stat = fs.existsSync(persistPath) ? fs.statSync(persistPath) : null;
		return {
			path: persistPath,
			exists: Boolean(stat),
			sizeBytes: stat?.size ?? null
		};
	} catch {
		return {
			path: persistPath,
			exists: false,
			sizeBytes: null
		};
	}
}

export function isMissionControlMissionId(value: unknown): value is string {
	return typeof value === 'string' && /^(spark|mission)-[A-Za-z0-9_-]+$/.test(value.trim());
}

function loadPersistedState() {
	try {
		const persistPath = getMissionControlPersistPath();
		if (!fs.existsSync(persistPath)) return null;
		const raw = fs.readFileSync(persistPath, 'utf-8').replace(/^\uFEFF/, '');
		const parsed = JSON.parse(raw);
		const recent = Array.isArray(parsed.recent)
			? parsed.recent
					.filter((entry: MissionControlRelayStatusEntry) => isMissionControlMissionId(entry?.missionId))
					.slice(0, MAX_RECENT_EVENTS)
			: [];
		const perMission = Object.entries(parsed.perMission ?? {})
			.filter(([missionId]) => isMissionControlMissionId(missionId))
			.map(([k, v]) => [k, Number(v) || 0] as [string, number]);
		return {
			totalRelayed: Number(parsed.totalRelayed) || 0,
			perMission: new Map<string, number>(perMission),
			recent
		};
	} catch {
		return null;
	}
}

function persistState() {
	try {
		const persistPath = getMissionControlPersistPath();
		const dir = path.dirname(persistPath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const tmp = `${persistPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
		fs.writeFileSync(
			tmp,
			JSON.stringify({
				totalRelayed: relayState.totalRelayed,
				perMission: Object.fromEntries(relayState.perMission),
				recent: relayState.recent
			}),
			'utf-8'
		);
		fs.renameSync(tmp, persistPath);
	} catch {
		/* persist is best-effort */
	}
}

const persisted = loadPersistedState();
const relayState: {
	totalRelayed: number;
	perMission: Map<string, number>;
	recent: MissionControlRelayStatusEntry[];
} = persisted ?? {
	totalRelayed: 0,
	perMission: new Map<string, number>(),
	recent: []
};

// Lifecycle-state maps are server-process-lifetime; without a cap, every
// mission/task ID processed since the last restart accumulates an entry
// and the maps grow unbounded. Cap each map and evict the oldest
// insertion when the cap is reached. Map iteration order preserves
// insertion order, so the first key reached is the oldest.
const MAX_LIFECYCLE_ENTRIES = 5000;
const missionLifecycleStates = new Map<string, string>();
const taskLifecycleStates = new Map<string, string>();

function setBoundedLifecycle(map: Map<string, string>, key: string, value: string): void {
	if (!map.has(key) && map.size >= MAX_LIFECYCLE_ENTRIES) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}

// Seed lifecycle dedup maps from the persisted recent entries so that, after a
// server restart, replays of an already-recorded terminal lifecycle event are
// skipped instead of re-broadcast to Spark ingest and webhooks.
function seedLifecycleStatesFromRecent(): void {
	// recent is newest-first (unshift); walk oldest-first so the latest status wins.
	// recent is capped (MAX_RECENT_EVENTS), so this seeds far fewer than
	// MAX_LIFECYCLE_ENTRIES entries; route through setBoundedLifecycle to keep a
	// single insertion path and preserve the cap invariant.
	for (let i = relayState.recent.length - 1; i >= 0; i -= 1) {
		const entry = relayState.recent[i];
		const taskStatus = lifecycleTaskStatusForEvent(entry.eventType);
		if (taskStatus) {
			const identity = taskIdentityForStatusEntry(entry);
			if (identity) {
				setBoundedLifecycle(taskLifecycleStates, `${entry.missionId}:${identity}`, taskStatus);
			}
			continue;
		}
		const missionStatus = lifecycleMissionStatusForEvent(entry.eventType);
		if (missionStatus) {
			setBoundedLifecycle(missionLifecycleStates, entry.missionId, missionStatus);
		}
	}
}
seedLifecycleStatesFromRecent();

function normalizeMissionId(event: MissionControlBridgeEvent): string {
	return typeof event.missionId === 'string' && event.missionId.trim().length > 0 ? event.missionId : 'unknown-mission';
}

function requestIdFromEventData(data: Record<string, unknown> | null | undefined): string | null {
	const value = data?.requestId;
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function pipelineIdFromEventData(data: Record<string, unknown> | null | undefined): string | null {
	const value = data?.pipelineId;
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function executionPolicyFromEventData(data: Record<string, unknown> | null | undefined): string | null {
	const value = data?.executionPolicy ?? data?.execution_policy;
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hasTelegramRelayTarget(target: MissionControlRelayTarget | null | undefined): target is MissionControlRelayTarget {
	return Boolean(target && (target.port !== null || target.profile !== null || target.url !== null));
}

function knownMissionMetadata(missionId: string): {
	requestId: string | null;
	traceRef: string | null;
	pipelineId: string | null;
	telegramRelay: MissionControlRelayTarget | null;
} {
	for (const entry of relayState.recent) {
		if (entry.missionId !== missionId) continue;
		if (entry.requestId || entry.traceRef || entry.pipelineId || hasTelegramRelayTarget(entry.telegramRelay)) {
			return {
				requestId: entry.requestId,
				traceRef: entry.traceRef,
				pipelineId: entry.pipelineId ?? null,
				telegramRelay: hasTelegramRelayTarget(entry.telegramRelay) ? entry.telegramRelay : null
			};
		}
	}
	return { requestId: null, traceRef: null, pipelineId: null, telegramRelay: null };
}

function enrichMissionEventWithKnownMetadata(event: MissionControlBridgeEvent): MissionControlBridgeEvent {
	const missionId = normalizeMissionId(event);
	const data = event.data && typeof event.data === 'object' ? event.data : null;
	const known = knownMissionMetadata(missionId);
	const currentRequestId = requestIdFromEventData(data);
	const currentTraceRef = extractTraceRef(data, event);
	const currentPipelineId = pipelineIdFromEventData(data);
	const currentTelegramRelay = getTelegramRelayTarget(event);
	const requestId = currentRequestId || known.requestId;
	const traceRef = currentTraceRef || known.traceRef;
	const pipelineId = currentPipelineId || known.pipelineId;
	const telegramRelay = hasTelegramRelayTarget(currentTelegramRelay) ? null : known.telegramRelay;

	if (
		(!requestId || currentRequestId) &&
		(!traceRef || currentTraceRef) &&
		(!pipelineId || currentPipelineId) &&
		!telegramRelay
	) {
		return event;
	}

	return {
		...event,
		data: {
			...(data ?? {}),
			...(requestId && !currentRequestId ? { requestId } : {}),
			...(traceRef && !currentTraceRef ? { traceRef } : {}),
			...(pipelineId && !currentPipelineId ? { pipelineId } : {}),
			...(telegramRelay ? { telegramRelay } : {})
		}
	};
}

function toStatusEntry(event: MissionControlBridgeEvent): MissionControlRelayStatusEntry {
	const missionId = normalizeMissionId(event);
	const timestamp =
		typeof event.timestamp === 'string' && event.timestamp.trim().length > 0
			? event.timestamp
			: new Date().toISOString();

	const dataMissionName =
		event.data && typeof (event.data as Record<string, unknown>).missionName === 'string'
			? ((event.data as Record<string, unknown>).missionName as string)
			: null;
	const dataMission =
		event.data && typeof (event.data as Record<string, unknown>).mission === 'object'
			? ((event.data as Record<string, unknown>).mission as Record<string, unknown>)
			: null;
	const missionObjectName = typeof dataMission?.name === 'string' ? dataMission.name : null;

	const dataSkillsRaw = event.data && (event.data as Record<string, unknown>).skills;
	const taskSkills = Array.isArray(dataSkillsRaw)
		? dataSkillsRaw.filter((s): s is string => typeof s === 'string')
		: [];
	const plannedTasksRaw = event.data && (event.data as Record<string, unknown>).plannedTasks;
	const plannedTasks = Array.isArray(plannedTasksRaw)
		? plannedTasksRaw
				.map((task) => {
					if (!task || typeof task !== 'object') return null;
					const raw = task as Record<string, unknown>;
					const title = typeof raw.title === 'string' ? sanitizeMissionControlDisplayText(raw.title) : '';
					if (!title) return null;
					const skills = Array.isArray(raw.skills)
						? raw.skills.filter((skill): skill is string => typeof skill === 'string')
						: [];
					return { title, skills };
				})
				.filter((task): task is { title: string; skills: string[] } => Boolean(task))
		: [];
	const assignedTaskIdsRaw = event.data && (event.data as Record<string, unknown>).assignedTaskIds;
	const assignedTaskIds = Array.isArray(assignedTaskIdsRaw)
		? assignedTaskIdsRaw.filter((taskId): taskId is string => typeof taskId === 'string' && taskId.trim().length > 0)
		: [];
	const requestId = requestIdFromEventData(event.data);
	const executionPolicy = executionPolicyFromEventData(event.data);
	const traceRef = extractTraceRef(event.data, event);
	const pipelineId = pipelineIdFromEventData(event.data);
	const providerId =
		event.data && typeof (event.data as Record<string, unknown>).providerId === 'string'
			? ((event.data as Record<string, unknown>).providerId as string)
			: event.data && typeof (event.data as Record<string, unknown>).provider === 'string'
				? ((event.data as Record<string, unknown>).provider as string)
				: null;
	const model =
		event.data && typeof (event.data as Record<string, unknown>).model === 'string'
			? ((event.data as Record<string, unknown>).model as string)
			: null;
	const dataTaskId = event.data && typeof (event.data as Record<string, unknown>).taskId === 'string'
		? ((event.data as Record<string, unknown>).taskId as string)
		: null;
	const dataTaskName = event.data && typeof (event.data as Record<string, unknown>).taskName === 'string'
		? ((event.data as Record<string, unknown>).taskName as string)
		: null;
	const rawProgress =
		typeof event.progress === 'number'
			? event.progress
			: event.data && typeof (event.data as Record<string, unknown>).progress === 'number'
				? ((event.data as Record<string, unknown>).progress as number)
				: event.data && typeof (event.data as Record<string, unknown>).percent === 'number'
					? ((event.data as Record<string, unknown>).percent as number)
					: null;
	const progress =
		typeof rawProgress === 'number' && Number.isFinite(rawProgress)
			? Math.max(0, Math.min(100, Math.round(rawProgress)))
			: null;
	const telegramRelay = getTelegramRelayTarget(event);
	const hasTelegramRelay =
		telegramRelay.port !== null || telegramRelay.profile !== null || telegramRelay.url !== null;
	const missionControlAccess = resolveMissionControlAccess(missionControlPathForMission(missionId));
	const projectLineage = extractMissionControlProjectLineage({
		data: event.data ?? null,
		missionName: typeof event.missionName === 'string' ? event.missionName : dataMissionName || missionObjectName,
		message: typeof event.message === 'string' ? event.message : null
	});

	return {
		eventType: typeof event.type === 'string' ? event.type : 'unknown',
		missionId,
		missionName: typeof event.missionName === 'string' ? event.missionName : dataMissionName || missionObjectName,
		executionPolicy,
		taskId: typeof event.taskId === 'string' ? event.taskId : dataTaskId,
		taskName: typeof event.taskName === 'string' ? event.taskName : dataTaskName,
		taskSkills,
		plannedTasks,
		assignedTaskIds,
		requestId,
		traceRef,
		pipelineId,
		providerId,
		model,
		progress,
		summary: summarizeMissionControlEvent(event),
		timestamp,
		source: typeof event.source === 'string' ? event.source : 'unknown',
		telegramRelay: hasTelegramRelay ? telegramRelay : null,
		missionControlAccess,
		projectLineage
	};
}

function shouldRecordMissionControlEvent(event: MissionControlBridgeEvent): boolean {
	const type = typeof event.type === 'string' ? event.type : '';
	if (!type || !RELAY_EVENT_TYPES.has(type)) {
		return false;
	}

	return true;
}

function recordRelayEvent(event: MissionControlBridgeEvent): void {
	const entry = toStatusEntry(event);
	if (!isMissionControlMissionId(entry.missionId)) {
		// Surface the drop so non-conformant emitters notice their events never reach
		// /kanban, /trace, or any board view. The event was accepted by /api/events
		// (and is still broadcast via SSE) — only the board persistence is filtered.
		// Suppress the warning for events with no missionId at all (those are never
		// intended to be mission-scoped).
		if (entry.missionId) {
			console.warn(
				`[mission-control-relay] mission event "${entry.eventType}" for missionId ` +
				`"${entry.missionId}" was accepted but will not appear on the board: ` +
				`missionId must match /^(spark|mission)-[A-Za-z0-9_-]+$/.`
			);
		}
		return;
	}
	relayState.totalRelayed += 1;
	relayState.perMission.set(entry.missionId, (relayState.perMission.get(entry.missionId) || 0) + 1);
	relayState.recent.unshift(entry);
	if (relayState.recent.length > MAX_RECENT_EVENTS) {
		relayState.recent.length = MAX_RECENT_EVENTS;
	}
	persistState();
	recordAgentLedgerEvent(entry);
	syncCreatorMissionTraceFromLifecycleEvent(event);
}

function recordAgentLedgerEvent(entry: MissionControlRelayStatusEntry): void {
	try {
		appendAgentEvent(
			buildMissionControlAgentEvent({
				eventType: entry.eventType,
				missionId: entry.missionId,
				missionName: entry.missionName,
				taskId: entry.taskId,
				taskName: entry.taskName,
				progress: entry.progress,
				summary: readableMissionControlSummary(entry.summary) || entry.summary,
				timestamp: entry.timestamp,
				source: entry.source,
				requestId: requestIdFromStatusEntry(entry),
				traceRef: entry.traceRef,
				toState: missionStateForEvent(entry.eventType),
				providerId: entry.providerId,
				model: entry.model
			}),
			{
				requestId: requestIdFromStatusEntry(entry),
				sessionId: `mission-control:${entry.missionId}`,
				actorId: entry.source
			}
		);
	} catch {
		/* agent event ledger is best-effort */
	}
}

function requestIdFromStatusEntry(entry: MissionControlRelayStatusEntry): string | null {
	const requestId = entry.requestId;
	if (typeof requestId === 'string' && requestId.trim()) {
		return requestId.trim();
	}
	return null;
}

export function getMissionControlRelaySnapshot(missionId?: string): MissionControlRelaySnapshot {
	const normalizedMission =
		typeof missionId === 'string' && missionId.trim().length > 0 ? missionId.trim() : undefined;

	const perMission = Object.fromEntries(relayState.perMission.entries());
	const recent = normalizedMission
		? relayState.recent.filter((entry) => entry.missionId === normalizedMission).slice(0, MAX_RECENT_EVENTS_PER_MISSION)
		: relayState.recent.slice(0, 25);
	const displayRecent = recent.map((entry) => ({
		...entry,
		summary: readableMissionControlSummary(entry.summary) || entry.summary
	}));

	return {
		enabled: {
			sparkIngest: Boolean(DEFAULT_SPARK_INGEST_URL),
			webhooks: DEFAULT_WEBHOOKS.length > 0
		},
		persistence: getMissionControlPersistenceInfo(),
		targets: {
			sparkIngestUrl: DEFAULT_SPARK_INGEST_URL || null,
			webhookCount: DEFAULT_WEBHOOKS.length
		},
		stats: {
			totalRelayed: relayState.totalRelayed,
			perMission
		},
		recent: displayRecent
	};
}

function mapEventTypeToBoardStatus(eventType: string): MissionControlBoardStatus | null {
	switch (eventType) {
		case 'mission_created':
			return 'created';
		case 'mission_started':
		case 'mission_resumed':
		case 'task_started':
		case 'task_progress':
		case 'progress':
		case 'task_completed':
		case 'task_failed':
		case 'task_cancelled':
		case 'dispatch_started':
		case 'provider_feedback':
		case 'log':
			return 'running';
		case 'mission_paused':
			return 'paused';
		case 'mission_completed':
			return 'completed';
		case 'mission_failed':
			return 'failed';
		case 'mission_cancelled':
			return 'cancelled';
		default:
			return null;
	}
}

function isMissionStartEvent(eventType: string): boolean {
	return [
		'mission_started',
		'mission_resumed',
		'dispatch_started',
		'task_started',
		'task_progress',
		'progress'
	].includes(eventType);
}

function isExecutionStartEvent(eventType: string): boolean {
	return eventType === 'mission_started' || eventType === 'dispatch_started';
}

function entryStartsExecution(entry: MissionControlRelayStatusEntry): boolean {
	return entry.executionPolicy !== 'read_only' && isExecutionStartEvent(entry.eventType);
}

function entryStartsLifecycle(entry: MissionControlRelayStatusEntry): boolean {
	return entry.executionPolicy !== 'read_only' && isMissionStartEvent(entry.eventType);
}

function earlierTimestamp(current: string | null, candidate: string): string {
	if (!current) return candidate;
	const currentMs = Date.parse(current);
	const candidateMs = Date.parse(candidate);
	if (!Number.isFinite(currentMs)) return candidate;
	if (!Number.isFinite(candidateMs)) return current;
	return candidateMs < currentMs ? candidate : current;
}

function isStaleNonTerminalStatus(status: MissionControlBoardStatus, timestamp: string): boolean {
	if (isMissionControlTerminalStatus(status) || status === 'paused') {
		return false;
	}
	const updatedAt = Date.parse(timestamp);
	if (!Number.isFinite(updatedAt)) {
		return false;
	}
	return Date.now() - updatedAt > STALE_NON_TERMINAL_MS;
}

function emptyTaskStatusCounts(): MissionControlTaskStatusCounts {
	return emptyMissionControlTaskStatusCounts();
}

function taskStatusForEvent(eventType: string): MissionControlTaskStatus | null {
	switch (eventType) {
		case 'task_started':
		case 'task_progress':
		case 'progress':
			return 'running';
		case 'task_completed':
			return 'completed';
		case 'task_failed':
			return 'failed';
		case 'task_cancelled':
			return 'cancelled';
		default:
			return null;
	}
}

function boardStatusForEntry(entry: MissionControlRelayStatusEntry): MissionControlBoardStatus | null {
	const status = mapEventTypeToBoardStatus(entry.eventType);
	if (entry.executionPolicy === 'read_only' && status === 'running') {
		return 'created';
	}
	return status;
}

function lifecycleTaskStatusForEvent(eventType: string): MissionControlTaskStatus | null {
	switch (eventType) {
		case 'task_started':
			return 'running';
		case 'task_completed':
			return 'completed';
		case 'task_failed':
			return 'failed';
		case 'task_cancelled':
			return 'cancelled';
		default:
			return null;
	}
}

function lifecycleMissionStatusForEvent(eventType: string): MissionControlBoardStatus | null {
	switch (eventType) {
		case 'mission_started':
		case 'mission_resumed':
			return 'running';
		case 'mission_paused':
			return 'paused';
		case 'mission_completed':
			return 'completed';
		case 'mission_failed':
			return 'failed';
		case 'mission_cancelled':
			return 'cancelled';
		default:
			return null;
	}
}

function taskIdentityForEvent(event: MissionControlBridgeEvent): string | null {
	const data = event.data && typeof event.data === 'object' ? event.data : {};
	const taskId =
		typeof event.taskId === 'string'
			? event.taskId
			: typeof data.taskId === 'string'
				? data.taskId
				: null;
	if (taskId?.trim()) return `id:${taskId.trim()}`;

	const taskName =
		typeof event.taskName === 'string'
			? event.taskName
			: typeof data.taskName === 'string'
				? data.taskName
				: null;
	if (taskName?.trim()) return `name:${canonicalTaskTitle(taskName)}`;

	return null;
}

function taskIdentityForStatusEntry(entry: MissionControlRelayStatusEntry): string | null {
	if (entry.taskId?.trim()) return `id:${entry.taskId.trim()}`;
	if (entry.taskName?.trim()) return `name:${canonicalTaskTitle(entry.taskName)}`;
	return null;
}

function eventAllowsParallelTaskStarts(event: MissionControlBridgeEvent): boolean {
	const data = event.data && typeof event.data === 'object' ? event.data : {};
	return data.parallel === true || data.allowParallel === true || data.executionMode === 'parallel';
}

function hasOpenTaskStartForSameSource(event: MissionControlBridgeEvent): boolean {
	if (event.type !== 'task_started') return false;
	if (eventAllowsParallelTaskStarts(event)) return false;

	const missionId = normalizeMissionId(event);
	const source = typeof event.source === 'string' ? event.source : 'unknown';
	const taskIdentity = taskIdentityForEvent(event);
	let skippedCurrent = false;

	for (const entry of relayState.recent) {
		if (entry.missionId !== missionId || entry.source !== source) continue;
		if (
			!skippedCurrent &&
			entry.eventType === 'task_started' &&
			taskIdentity &&
			taskIdentityForStatusEntry(entry) === taskIdentity
		) {
			skippedCurrent = true;
			continue;
		}
		if (TASK_TERMINAL_EVENTS.has(entry.eventType)) return false;
		if (entry.eventType === 'mission_completed' || entry.eventType === 'mission_failed' || entry.eventType === 'mission_cancelled') {
			return false;
		}
		if (entry.eventType === 'task_started') return true;
	}

	return false;
}

function shouldRecordLifecycleTransition(event: MissionControlBridgeEvent): boolean {
	const type = typeof event.type === 'string' ? event.type : '';
	const missionId = normalizeMissionId(event);
	const taskStatus = lifecycleTaskStatusForEvent(type);
	if (taskStatus) {
		const taskIdentity = taskIdentityForEvent(event);
		if (!taskIdentity) return true;
		const key = `${missionId}:${taskIdentity}`;
		if (taskLifecycleStates.get(key) === taskStatus) {
			return false;
		}
		setBoundedLifecycle(taskLifecycleStates, key, taskStatus);
		return true;
	}

	const missionStatus = lifecycleMissionStatusForEvent(type);
	if (!missionStatus) return true;
	if (missionLifecycleStates.get(missionId) === missionStatus) {
		return false;
	}
	setBoundedLifecycle(missionLifecycleStates, missionId, missionStatus);
	return true;
}

function canonicalTaskTitle(title: string): string {
	return title
		.replace(/^T\d+\s*:\s*/i, '')
		.replace(/^task-[a-z0-9_-]+\s*:\s*/i, '')
		.replace(/^creator-[a-z0-9_-]+\s*:\s*/i, '')
		.trim()
		.toLowerCase();
}

function taskOrdinalFromLabel(title: string): number | null {
	const match = title.match(/^task-(\d+)(?:\b|-|_)/i) || title.match(/^node-(\d+)-task-/i);
	if (!match) return null;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function taskKeyFromLabel(title: string): string | null {
	const match = title.match(/^([a-z0-9]+(?:[-_][a-z0-9]+)+)(?:\s*:|\b)/i);
	return match ? match[1].toLowerCase() : null;
}

function creatorTaskKeyFromLabel(title: string): string | null {
	const lower = title.toLowerCase();
	const explicit = lower.match(
		/\b(creator-intent-plan|domain-chip-contract|benchmark-pack|specialization-path|autoloop-policy|telegram-spawner-flow|creator-validation|swarm-publish-packet)\b/
	);
	if (explicit) return explicit[1];
	if (/\block\b.*\bcreator intent\b|\bcreator intent\b.*\btask graph\b/.test(lower)) return 'creator-intent-plan';
	if (/\bdomain chip\b/.test(lower)) return 'domain-chip-contract';
	if (/\bbenchmark pack\b/.test(lower)) return 'benchmark-pack';
	if (/\bspeciali[sz]ation path\b/.test(lower)) return 'specialization-path';
	if (/\bautoloop\b/.test(lower)) return 'autoloop-policy';
	if (/\btelegram\b.*\bspawner\b|\bspawner\b.*\btelegram\b/.test(lower)) return 'telegram-spawner-flow';
	if (/\bcreator validation\b|\bvalidate\b.*\bcreator artifacts\b|\bvalidation gates\b/.test(lower)) return 'creator-validation';
	if (/\bswarm\b.*\bpublish packet\b|\bpublish packet\b/.test(lower)) return 'swarm-publish-packet';
	return null;
}

function mergeTaskStatus(
	current: MissionControlTaskStatus | undefined,
	next: MissionControlTaskStatus
): MissionControlTaskStatus {
	if (!current) return next;
	if (current === 'failed' || current === 'cancelled' || current === 'completed') return current;
	return next;
}

function findTaskForAssignedTaskId(
	entry: MissionControlBoardEntry,
	assignedTaskId: string,
	index: number
): MissionControlBoardEntry['tasks'][number] | undefined {
	const label = sanitizeMissionControlDisplayText(assignedTaskId);
	const canonicalLabel = canonicalTaskTitle(label);
	const labelKey = taskKeyFromLabel(label);
	const creatorKey = creatorTaskKeyFromLabel(label);
	const labelOrdinal = taskOrdinalFromLabel(label);
	const indexedTask = entry.tasks[index];
	const indexedOrdinal = indexedTask ? taskOrdinalFromLabel(indexedTask.title) : null;
	return (
		entry.tasks.find((candidate) => canonicalTaskTitle(candidate.title) === canonicalLabel) ||
		(labelKey ? entry.tasks.find((candidate) => taskKeyFromLabel(candidate.title) === labelKey) : undefined) ||
		(creatorKey ? entry.tasks.find((candidate) => creatorTaskKeyFromLabel(candidate.title) === creatorKey) : undefined) ||
		(labelOrdinal !== null
			? entry.tasks.find((candidate) => taskOrdinalFromLabel(candidate.title) === labelOrdinal)
			: undefined) ||
		(indexedTask && (indexedOrdinal === null || indexedOrdinal === index + 1) ? indexedTask : undefined)
	);
}

function recalculateTaskStatusCounts(entry: MissionControlBoardEntry): void {
	const counts = emptyTaskStatusCounts();
	for (const task of entry.tasks) {
		const status = task.status ?? 'queued';
		counts[status] += 1;
	}
	counts.total = entry.tasks.length;
	entry.taskNames = entry.tasks.map((task) => task.title);
	entry.taskCount = entry.tasks.length;
	entry.taskStatusCounts = counts;
}

function maybeRecordAssignedTaskPackProgress(
	entry: MissionControlBoardEntry,
	event: MissionControlRelayStatusEntry
): void {
	const assignedTaskIds = Array.isArray(event.assignedTaskIds) ? event.assignedTaskIds : [];
	if (event.progress === null || assignedTaskIds.length === 0) return;
	const activeTaskId = typeof event.taskId === 'string' && event.taskId.trim() ? event.taskId : assignedTaskIds[0];
	assignedTaskIds.forEach((taskId, index) => {
		const isActiveTask = taskId === activeTaskId;
		let task = findTaskForAssignedTaskId(entry, taskId, index);
		if (!task) {
			const title = isActiveTask && event.taskName
				? sanitizeMissionControlDisplayText(event.taskName)
				: sanitizeMissionControlDisplayText(taskId);
			task = {
				title,
				skills: [],
				status: isActiveTask ? 'running' : 'queued'
			};
			entry.tasks.push(task);
			entry.taskNames.push(task.title);
		}
		if (!isActiveTask) return;
		if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return;
		task.status = 'running';
	});
}

function maybeRecordTask(entry: MissionControlBoardEntry, event: MissionControlRelayStatusEntry): void {
	const status = taskStatusForEvent(event.eventType);
	if (!status) return;
	if (!event.taskName && !event.taskId) return;
	if (event.executionPolicy === 'read_only' && status === 'running') return;

	const label = sanitizeMissionControlDisplayText(event.taskName || event.taskId || 'task');
	const canonicalLabel = canonicalTaskTitle(label);
	let task = entry.tasks.find((candidate) => canonicalTaskTitle(candidate.title) === canonicalLabel);
	if (!task) {
		const labelKey = taskKeyFromLabel(label);
		if (labelKey) {
			task = entry.tasks.find((candidate) => taskKeyFromLabel(candidate.title) === labelKey);
		}
	}
	if (!task) {
		const creatorKey = creatorTaskKeyFromLabel(label);
		if (creatorKey) {
			task = entry.tasks.find((candidate) => creatorTaskKeyFromLabel(candidate.title) === creatorKey);
		}
	}
	if (!task) {
		const ordinal = taskOrdinalFromLabel(label);
		if (ordinal !== null) {
			task = entry.tasks.find((candidate) => taskOrdinalFromLabel(candidate.title) === ordinal);
			const indexedTask = entry.tasks[ordinal - 1];
			const indexedOrdinal = indexedTask ? taskOrdinalFromLabel(indexedTask.title) : null;
			if (!task && indexedTask && (indexedOrdinal === null || indexedOrdinal === ordinal)) {
				task = indexedTask;
			}
		}
	}
	if (!task && (event.eventType === 'task_progress' || event.eventType === 'progress')) {
		return;
	}
	if (!task) {
		task = { title: label, skills: event.taskSkills ?? [], status, progress: event.progress ?? undefined };
		entry.tasks.push(task);
		entry.taskNames.push(label);
		entry.taskCount = entry.taskNames.length;
		return;
	}

	task.status = mergeTaskStatus(task.status, status);
	if ((!task.skills || task.skills.length === 0) && event.taskSkills.length > 0) {
		task.skills = event.taskSkills;
	}
}

function seedPlannedTasks(entry: MissionControlBoardEntry, event: MissionControlRelayStatusEntry): void {
	const plannedTasks = Array.isArray(event.plannedTasks) ? event.plannedTasks : [];
	if (plannedTasks.length === 0) return;
	const plannedOrder: MissionControlBoardEntry['tasks'] = [];
	const plannedMatches = new Set<MissionControlBoardEntry['tasks'][number]>();
	for (const [index, planned] of plannedTasks.entries()) {
		const canonicalLabel = canonicalTaskTitle(planned.title);
		const plannedKey = taskKeyFromLabel(planned.title);
		const plannedCreatorKey = creatorTaskKeyFromLabel(planned.title);
		const plannedOrdinal = index + 1;
		let existing = entry.tasks.find((candidate) => {
			if (canonicalTaskTitle(candidate.title) === canonicalLabel) return true;
			return Boolean(plannedKey && taskKeyFromLabel(candidate.title) === plannedKey);
		})
			|| (plannedCreatorKey
				? entry.tasks.find((candidate) => creatorTaskKeyFromLabel(candidate.title) === plannedCreatorKey)
				: undefined)
			|| entry.tasks.find((candidate) => taskOrdinalFromLabel(candidate.title) === plannedOrdinal);
		if (existing) {
			existing.title = planned.title;
			if ((!existing.skills || existing.skills.length === 0) && planned.skills.length > 0) {
				existing.skills = planned.skills;
			}
		} else {
			existing = { title: planned.title, skills: planned.skills, status: 'queued' };
		}
		plannedOrder.push(existing);
		plannedMatches.add(existing);
	}
	const unplannedTasks = entry.tasks.filter((task) => !plannedMatches.has(task));
	entry.tasks = [...plannedOrder, ...unplannedTasks];
	entry.taskNames = entry.tasks.map((task) => task.title);
	entry.taskCount = entry.taskNames.length;
}

function taskMatchesRelayEntry(task: MissionControlBoardEntry['tasks'][number], event: MissionControlRelayStatusEntry): boolean {
	const label = event.taskName || event.taskId || '';
	if (!label) return false;
	if (canonicalTaskTitle(task.title) === canonicalTaskTitle(label)) return true;
	const labelKey = taskKeyFromLabel(label);
	if (labelKey && taskKeyFromLabel(task.title) === labelKey) return true;
	const creatorKey = creatorTaskKeyFromLabel(label);
	if (creatorKey && creatorTaskKeyFromLabel(task.title) === creatorKey) return true;
	const labelOrdinal = taskOrdinalFromLabel(label);
	return labelOrdinal !== null && taskOrdinalFromLabel(task.title) === labelOrdinal;
}

function latestTaskStartSource(
	task: MissionControlBoardEntry['tasks'][number],
	events: MissionControlRelayStatusEntry[]
): string | null {
	const match = events.find((event) => event.eventType === 'task_started' && taskMatchesRelayEntry(task, event));
	return match?.source || null;
}

function latestTaskStartTimestampMs(
	task: MissionControlBoardEntry['tasks'][number],
	events: MissionControlRelayStatusEntry[]
): number | null {
	const match = events.find((event) => event.eventType === 'task_started' && taskMatchesRelayEntry(task, event));
	if (!match) return null;
	const timestampMs = Date.parse(match.timestamp);
	return Number.isFinite(timestampMs) ? timestampMs : null;
}

function normalizeSingleSourceRunningTaskBurst(
	entry: MissionControlBoardEntry,
	events: MissionControlRelayStatusEntry[]
): void {
	const runningTasks = entry.tasks.filter((task) => task.status === 'running');
	if (runningTasks.length === 1) {
		entry.taskName = runningTasks[0].title;
		return;
	}
	if (runningTasks.length === 0) return;

	const runningSources = new Set(
		runningTasks
			.map((task) => latestTaskStartSource(task, events))
			.filter((source): source is string => Boolean(source))
	);
	if (runningSources.size > 1) return;

	const startTimes = runningTasks
		.map((task) => latestTaskStartTimestampMs(task, events))
		.filter((value): value is number => value !== null);
	const rapidBurst =
		startTimes.length > 1 &&
		Math.max(...startTimes) - Math.min(...startTimes) <= 500;
	const activeTask = runningTasks.reduce((best, task) => {
		const bestStartedAt = latestTaskStartTimestampMs(best, events);
		const taskStartedAt = latestTaskStartTimestampMs(task, events);
		if (bestStartedAt !== null && taskStartedAt !== null && bestStartedAt !== taskStartedAt) {
			if (rapidBurst) return taskStartedAt < bestStartedAt ? task : best;
			return taskStartedAt > bestStartedAt ? task : best;
		}
		const bestOrdinal = taskOrdinalFromLabel(best.title) ?? Number.MAX_SAFE_INTEGER;
		const taskOrdinal = taskOrdinalFromLabel(task.title) ?? Number.MAX_SAFE_INTEGER;
		if (rapidBurst) return taskOrdinal < bestOrdinal ? task : best;
		return taskOrdinal > bestOrdinal ? task : best;
	}, runningTasks[0]);

	for (const task of runningTasks) {
		if (task === activeTask) continue;
		task.status = 'queued';
		delete task.progress;
	}
	entry.taskName = activeTask.title;
}

function closeOpenTasksForTerminalMission(entry: MissionControlBoardEntry): void {
	if (!isMissionControlTerminalStatus(entry.status)) return;
	entry.taskName = null;
	const terminalTaskStatus =
		entry.status === 'completed' ? 'completed' : entry.status === 'cancelled' ? 'cancelled' : 'failed';
	for (const task of entry.tasks) {
		if (!task.status || task.status === 'queued' || task.status === 'running') {
			task.status = terminalTaskStatus;
		}
	}
}

function lastUpdatedSortTime(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function compareMissionControlEntriesByLastUpdatedDesc<T extends { lastUpdated: string }>(
	a: T,
	b: T
): number {
	const aTime = lastUpdatedSortTime(a.lastUpdated);
	const bTime = lastUpdatedSortTime(b.lastUpdated);
	if (aTime === bTime) return 0;
	return bTime - aTime;
}

function recordLifecycleTimestamps(
	entry: MissionControlBoardEntry,
	event: MissionControlRelayStatusEntry
): void {
	if (event.eventType === 'mission_created') {
		entry.queuedAt = earlierTimestamp(entry.queuedAt, event.timestamp);
	}
	if (entryStartsLifecycle(event)) {
		entry.startedAt = earlierTimestamp(entry.startedAt, event.timestamp);
	}
}

export function getMissionControlBoard(): Record<string, MissionControlBoardEntry[]> {
	const byMission = new Map<string, MissionControlBoardEntry>();
	const terminalMissionIds = new Set(
		relayState.recent
			.filter((entry) => ['mission_completed', 'mission_failed', 'mission_cancelled'].includes(entry.eventType))
			.map((entry) => entry.missionId)
	);

	for (const entry of relayState.recent) {
		if (!isMissionControlMissionId(entry.missionId)) continue;
		const status = boardStatusForEntry(entry);
		if (!status) continue;
		if (isStaleNonTerminalStatus(status, entry.timestamp) && !terminalMissionIds.has(entry.missionId)) continue;
		if (
			terminalMissionIds.has(entry.missionId) &&
			status !== 'completed' &&
			status !== 'failed' &&
			status !== 'cancelled' &&
			status !== 'paused' &&
			!byMission.has(entry.missionId)
		) continue;

		const existing = byMission.get(entry.missionId);
		if (!existing) {
			byMission.set(entry.missionId, {
				missionId: entry.missionId,
				traceRef: entry.traceRef,
				pipelineId: entry.pipelineId ?? null,
				missionName: entry.missionName ? sanitizeMissionControlDisplayText(entry.missionName) : null,
				status,
				lastEventType: entry.eventType,
				lastUpdated: entry.timestamp,
				executionStarted: entryStartsExecution(entry),
				executionPolicy: entry.executionPolicy ?? null,
				queuedAt: entry.eventType === 'mission_created' ? entry.timestamp : null,
				startedAt: entryStartsLifecycle(entry) ? entry.timestamp : null,
				lastSummary: sanitizeMissionControlDisplayText(readableMissionControlSummary(entry.summary) || entry.summary),
				taskName: entry.taskName ? sanitizeMissionControlDisplayText(entry.taskName) : null,
				taskCount: 0,
				taskNames: [],
				taskStatusCounts: emptyTaskStatusCounts(),
				tasks: [],
				telegramRelay: entry.telegramRelay ?? null,
				missionControlAccess: entry.missionControlAccess ?? null,
				projectLineage: entry.projectLineage ?? null
			});
		} else {
			if (!existing.traceRef && entry.traceRef) {
				existing.traceRef = entry.traceRef;
			}
			if (!existing.pipelineId && entry.pipelineId) {
				existing.pipelineId = entry.pipelineId;
			}
			if (!isMissionControlTerminalStatus(existing.status) && !existing.taskName && entry.taskName) {
				existing.taskName = sanitizeMissionControlDisplayText(entry.taskName);
			}
			if (!existing.missionName && entry.missionName) {
				existing.missionName = sanitizeMissionControlDisplayText(entry.missionName);
			}
			if (!existing.executionPolicy && entry.executionPolicy) {
				existing.executionPolicy = entry.executionPolicy;
			}
			if (!existing.telegramRelay && entry.telegramRelay) {
				existing.telegramRelay = entry.telegramRelay;
			}
			if (!existing.missionControlAccess && entry.missionControlAccess) {
				existing.missionControlAccess = entry.missionControlAccess;
			}
			if (entryStartsExecution(entry)) {
				existing.executionStarted = true;
			}
			existing.projectLineage = mergeMissionControlProjectLineage(
				existing.projectLineage,
				entry.projectLineage
			);
		}

		const current = byMission.get(entry.missionId)!;
		recordLifecycleTimestamps(current, entry);
		seedPlannedTasks(current, entry);
		maybeRecordAssignedTaskPackProgress(current, entry);
		maybeRecordTask(current, entry);
	}

	const board: Record<MissionControlBoardStatus, MissionControlBoardEntry[]> = {
		running: [],
		paused: [],
		completed: [],
		failed: [],
		cancelled: [],
		created: []
	};

	for (const entry of byMission.values()) {
		const missionEvents = relayState.recent.filter((event) => event.missionId === entry.missionId);
		normalizeSingleSourceRunningTaskBurst(entry, missionEvents);
		closeOpenTasksForTerminalMission(entry);
		recalculateTaskStatusCounts(entry);
		board[entry.status].push(entry);
	}

	for (const entries of Object.values(board)) {
		entries.sort(compareMissionControlEntriesByLastUpdatedDesc);
	}

	return board;
}

export function shouldRelayMissionControlEvent(event: MissionControlBridgeEvent): boolean {
	if (!shouldRecordMissionControlEvent(event)) {
		return false;
	}

	const source = typeof event.source === 'string' ? event.source : '';
	if (source === 'spawner-ui') {
		return false;
	}

	if (event.data && (event.data as Record<string, unknown>).suppressExternalRelay === true) {
		return false;
	}

	if (event.data && (event.data as Record<string, unknown>).suppressRelay === true) {
		return false;
	}

	if (hasOpenTaskStartForSameSource(event)) {
		return false;
	}

	return true;
}

export function summarizeMissionControlEvent(event: MissionControlBridgeEvent): string {
	const type = typeof event.type === 'string' ? event.type : 'event';
	const dataTaskName =
		event.data && typeof (event.data as Record<string, unknown>).taskName === 'string'
			? ((event.data as Record<string, unknown>).taskName as string)
			: undefined;
	const taskName =
		typeof event.taskName === 'string'
			? event.taskName
			: typeof event.taskId === 'string'
				? event.taskId
				: dataTaskName;
	const cleanTaskName = taskName ? sanitizeMissionControlDisplayText(taskName) : null;
	const cleanMessage =
		typeof event.message === 'string' ? compactMissionControlDisplayText(event.message, 220) : null;

	switch (type) {
		case 'mission_created':
			return `${event.missionName || 'Mission'} entered To do.`;
		case 'mission_started':
			return 'Mission started.';
		case 'mission_paused':
			return 'Mission paused.';
		case 'mission_resumed':
			return 'Mission resumed.';
		case 'mission_completed':
			return 'Mission completed.';
		case 'mission_failed':
			return 'Mission failed.';
		case 'mission_cancelled':
			return 'Mission cancelled by user.';
		case 'task_started':
			return readableMissionControlSummary(`Task started: ${cleanTaskName || 'task'}`) || 'Task started.';
		case 'task_progress':
		case 'progress':
			return readableMissionControlSummary(cleanMessage || cleanTaskName || 'Working') || 'Working.';
		case 'task_completed':
			return readableMissionControlSummary(`Task completed: ${cleanTaskName || 'task'}`) || 'Task completed.';
		case 'task_failed':
			return readableMissionControlSummary(`Task failed: ${cleanTaskName || 'task'}`) || 'Task failed.';
		case 'task_cancelled':
			return readableMissionControlSummary(`Task cancelled: ${cleanTaskName || 'task'}`) || 'Task cancelled.';
		case 'dispatch_started':
			return 'Dispatch started.';
		case 'provider_feedback':
			return readableMissionControlSummary(cleanMessage || cleanTaskName || 'Update') || 'Update.';
		case 'log':
			return readableMissionControlSummary(cleanMessage || 'Log update') || 'Log update.';
		default:
			return readableMissionControlSummary(type) || 'Event recorded.';
	}
}

export function buildSparkMissionControlEvent(event: MissionControlBridgeEvent): Record<string, unknown> {
	const tsMs = event.timestamp ? Date.parse(event.timestamp) : Date.now();
	const ts = Number.isFinite(tsMs) ? Math.max(1, tsMs / 1000) : Date.now() / 1000;
	const missionId = normalizeMissionId(event);
	const missionControlAccess = resolveMissionControlAccess(missionControlPathForMission(missionId));
	const traceRef = extractTraceRef(event.data, event);
	const safeEvent = redactMissionControlEventForExternal(event);
	const safeData = redactMissionControlDataForExternal(event);
	const summary = sanitizeExternalText(summarizeMissionControlEvent(event), 220);

	return {
		v: 1,
		source: 'spawner-ui',
		kind: 'system',
		ts,
		session_id: `mission-control:${missionId}`,
		trace_id:
			typeof event.id === 'string'
				? event.id
				: `mc-${missionId}-${typeof event.type === 'string' ? event.type : 'event'}-${Math.floor(ts * 1000)}`,
		payload: {
			event_type: 'mission_control_event',
			mission_event_type: typeof event.type === 'string' ? event.type : 'unknown',
			mission_id: typeof event.missionId === 'string' ? event.missionId : null,
			task_id: typeof event.taskId === 'string' ? event.taskId : null,
			task_name: typeof event.taskName === 'string' ? event.taskName : null,
			trace_ref: traceRef,
			message: typeof event.message === 'string' ? sanitizeExternalText(event.message, 220) : null,
			summary,
			bridge_source: typeof event.source === 'string' ? event.source : 'unknown',
			meta: {
				origin: 'spawner-ui',
				event_id: typeof event.id === 'string' ? event.id : null,
				trace_ref: traceRef,
				mission_control_access: missionControlAccess
			},
			data: safeData,
			event: safeEvent
		}
	};
}

async function postJson(url: string, payload: unknown, token?: string, extraHeaders?: Record<string, string>): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 7_000);
	try {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};
		if (extraHeaders) {
			Object.assign(headers, extraHeaders);
		}
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}

		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload),
			signal: controller.signal
		});

		if (!response.ok) {
			const body = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
		}
	} finally {
		clearTimeout(timeout);
	}
}

function normalizeRelayPort(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return Math.trunc(value);
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
	}
	return null;
}

function webhookPort(url: string): number | null {
	try {
		const parsed = new URL(url);
		if (parsed.port) {
			return normalizeRelayPort(parsed.port);
		}
		return parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : null;
	} catch {
		return null;
	}
}

function normalizeRelayProfile(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getTelegramRelayTarget(event: MissionControlBridgeEvent): MissionControlRelayTarget {
	const data = event.data;
	if (!data || typeof data !== 'object') {
		return { port: null, profile: null, url: null };
	}
	const relay = data.telegramRelay && typeof data.telegramRelay === 'object'
		? data.telegramRelay as Record<string, unknown>
		: null;
	const urlRaw = relay?.url ?? data.telegramRelayUrl;
	const port = normalizeRelayPort(relay?.port ?? data.telegramRelayPort);
	const profile = normalizeRelayProfile(relay?.profile ?? data.telegramRelayProfile);
	const url = typeof urlRaw === 'string' && urlRaw.trim() ? urlRaw.trim() : null;
	return { port, profile, url };
}

const LOCAL_URL_PATTERN = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s'"<>)]*/gi;
const SECRET_VALUE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{12,}|\d{5,}:[A-Za-z0-9_-]{20,})\b/g;
const EXTERNAL_SAFE_DATA_KEYS = new Set([
	'assignedTaskIds',
	'autoAnalysisStatus',
	'buildMode',
	'buildModeReason',
	'iterationNumber',
	'canonicalResultAvailable',
	'durationMs',
	'missionControlAccess',
	'missionName',
	'parentMissionId',
	'percent',
	'pipelineId',
	'plannedTasks',
	'progress',
	'projectId',
	'provider',
	'providerProcessSuccess',
	'requestId',
	'skills',
	'status',
	'taskId',
	'taskName',
	'telegramRelay',
	'telegramRelayPort',
	'telegramRelayProfile',
	'title',
	'traceRef'
]);
const SENSITIVE_EXTERNAL_DATA_KEY = /(?:content|env|file|full|goal|key|log|output|password|path|prompt|raw|secret|source|token|workspace)/i;

function sanitizeExternalText(value: string, maxLength = 220): string {
	return (
		compactMissionControlDisplayText(value, maxLength)
			?.replace(LOCAL_URL_PATTERN, '[local url]')
			.replace(SECRET_VALUE_PATTERN, '[secret]') ?? ''
	);
}

function sanitizeExternalScalar(value: unknown): unknown {
	if (typeof value === 'string') return sanitizeExternalText(value);
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'boolean' || value === null) return value;
	return null;
}

function sanitizeExternalArray(value: unknown[]): unknown[] {
	return value
		.slice(0, 24)
		.map((item) => sanitizeExternalValue(item))
		.filter((item) => item !== null && item !== undefined);
}

function sanitizeExternalObject(value: Record<string, unknown>): Record<string, unknown> {
	const safe: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!EXTERNAL_SAFE_DATA_KEYS.has(key) || SENSITIVE_EXTERNAL_DATA_KEY.test(key)) continue;
		const sanitized = sanitizeExternalValue(raw);
		if (sanitized !== null && sanitized !== undefined && sanitized !== '') {
			safe[key] = sanitized;
		}
	}
	return safe;
}

function sanitizeExternalValue(value: unknown): unknown {
	if (Array.isArray(value)) return sanitizeExternalArray(value);
	if (value && typeof value === 'object') return sanitizeExternalObject(value as Record<string, unknown>);
	return sanitizeExternalScalar(value);
}

function redactTelegramRelayForExternal(target: MissionControlRelayTarget): MissionControlRelayTarget | null {
	LOCAL_URL_PATTERN.lastIndex = 0;
	const url = target.url && !LOCAL_URL_PATTERN.test(target.url) ? sanitizeExternalText(target.url, 180) : null;
	LOCAL_URL_PATTERN.lastIndex = 0;
	if (target.port === null && target.profile === null && url === null) return null;
	return { port: target.port, profile: target.profile, url };
}

function redactMissionControlDataForExternal(event: MissionControlBridgeEvent): Record<string, unknown> {
	const data = event.data && typeof event.data === 'object' ? sanitizeExternalObject(event.data) : {};
	const telegramRelay = redactTelegramRelayForExternal(getTelegramRelayTarget(event));
	if (telegramRelay) {
		data.telegramRelay = telegramRelay;
	}
	data.missionControlAccess = resolveMissionControlAccess(missionControlPathForMission(normalizeMissionId(event)));
	return data;
}

function redactMissionControlEventForExternal(event: MissionControlBridgeEvent): Record<string, unknown> {
	const safeEvent: Record<string, unknown> = {
		type: typeof event.type === 'string' ? event.type : 'unknown',
		missionId: typeof event.missionId === 'string' ? event.missionId : null,
		missionName: typeof event.missionName === 'string' ? sanitizeExternalText(event.missionName, 140) : null,
		taskId: typeof event.taskId === 'string' ? sanitizeExternalText(event.taskId, 120) : null,
		taskName: typeof event.taskName === 'string' ? sanitizeExternalText(event.taskName, 140) : null,
		timestamp: typeof event.timestamp === 'string' ? event.timestamp : null,
		source: typeof event.source === 'string' ? sanitizeExternalText(event.source, 80) : 'unknown',
		data: redactMissionControlDataForExternal(event)
	};
	if (typeof event.id === 'string') {
		safeEvent.id = sanitizeExternalText(event.id, 120);
	}
	return safeEvent;
}

export function selectWebhookUrlsForMissionEvent(event: MissionControlBridgeEvent, urls = DEFAULT_WEBHOOKS): string[] {
	const target = getTelegramRelayTarget(event);
	if (!target.url && target.port === null) {
		return urls;
	}
	if (target.url) {
		const matched = urls.filter((url) => url === target.url);
		if (matched.length > 0) return matched;
		const targetUrlPort = webhookPort(target.url);
		if (targetUrlPort !== null) {
			const portMatched = urls.filter((url) => webhookPort(url) === targetUrlPort);
			return portMatched;
		}
		return [];
	}
	const portMatched = urls.filter((url) => {
		if (target.port !== null && webhookPort(url) === target.port) {
			return true;
		}
		return false;
	});
	return portMatched;
}

export async function relayMissionControlEvent(event: MissionControlBridgeEvent): Promise<void> {
	if (!shouldRecordMissionControlEvent(event)) {
		return;
	}

	const enrichedEvent = enrichMissionEventWithKnownMetadata(event);

	if (!shouldRecordLifecycleTransition(enrichedEvent)) {
		return;
	}

	recordRelayEvent(enrichedEvent);

	if (!shouldRelayMissionControlEvent(enrichedEvent)) {
		return;
	}

	const tasks: Promise<void>[] = [];
	const sparkIngestUrl = DEFAULT_SPARK_INGEST_URL;
	if (sparkIngestUrl) {
		const sparkPayload = buildSparkMissionControlEvent(enrichedEvent);
		tasks.push(
			postJson(sparkIngestUrl, sparkPayload, DEFAULT_SPARK_TOKEN).catch((error) => {
				console.warn('[MissionControlRelay] Spark ingest relay failed:', error);
			})
		);
	}

	const webhookUrls = selectWebhookUrlsForMissionEvent(enrichedEvent);
	if (webhookUrls.length > 0) {
		const webhookPayload = {
			type: 'mission_control_event',
			timestamp: new Date().toISOString(),
			summary: sanitizeExternalText(summarizeMissionControlEvent(enrichedEvent), 220),
			missionControl: resolveMissionControlAccess(missionControlPathForMission(normalizeMissionId(enrichedEvent))),
			event: redactMissionControlEventForExternal(enrichedEvent)
		};
		const relayHeaders = DEFAULT_TELEGRAM_RELAY_SECRET
			? { 'X-Spark-Telegram-Relay-Secret': DEFAULT_TELEGRAM_RELAY_SECRET }
			: undefined;
		for (const url of webhookUrls) {
			tasks.push(
				postJson(url, webhookPayload, undefined, relayHeaders).catch((error) => {
					console.warn(`[MissionControlRelay] Webhook relay failed (${url}):`, error);
				})
			);
		}
	}

	if (tasks.length > 0) {
		await Promise.all(tasks);
	}
}
