import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { env } from '$env/dynamic/private';
import {
	getMissionControlBoard,
	getMissionControlRelaySnapshot,
	type MissionControlBoardEntry
} from './mission-control-relay';
import {
	enrichMissionControlBoardWithProviderResults,
	type MissionControlResultSummary
} from './mission-control-results';
import {
	missionControlPathForMission,
	resolveMissionControlAccess
} from './mission-control-access';
import {
	buildAgentBlackBoxReport,
	type AgentBlackBoxReport
} from './agent-event-ledger';
import { spawnerStateDir } from './spawner-state';
import { extractTraceRef } from './trace-ref';
import type { ProviderMissionResultSnapshot } from './provider-runtime';
import type {
	MissionControlAccessInfo,
	MissionControlCompletionEvidence,
	MissionControlProjectLineage,
	MissionControlTracePhase
} from '$lib/types/mission-control';

type BoardBuckets = Record<string, Array<MissionControlBoardEntry & MissionControlResultSummary>>;
type SkillPairingSource = 'kanban' | 'analysis' | 'canvas' | 'none';

interface TraceSkillTask {
	title: string;
	skills: string[];
}

export interface TraceSkillPairing {
	taskCount: number;
	pairedTaskCount: number;
	skillCount: number;
	pairingRatio: number;
	status: 'complete' | 'partial' | 'missing';
	source: SkillPairingSource;
	unpairedTasks: string[];
}

export interface MissionControlTrace {
	ok: true;
	missionId: string | null;
	requestId: string | null;
	traceRef: string | null;
	phase: MissionControlTracePhase;
	summary: string;
	progress: {
		percent: number;
		taskCounts: MissionControlBoardEntry['taskStatusCounts'] | null;
		currentTask: string | null;
	};
	missionControlAccess: MissionControlAccessInfo;
	surfaces: {
		telegram: {
			relay: MissionControlBoardEntry['telegramRelay'] | null;
			chatId: string | null;
			userId: string | null;
		};
		canvas: {
			pipelineId: string | null;
			pipelineName: string | null;
			autoRun: boolean | null;
			nodeCount: number | null;
		};
		kanban: {
			bucket: string | null;
			entry: (MissionControlBoardEntry & MissionControlResultSummary) | null;
		};
		dispatch: {
			allComplete: boolean;
			anyFailed: boolean;
			paused: boolean;
			providers: Record<string, string>;
			lastReason: string | null;
		} | null;
	};
	artifacts: {
		pendingRequest: Record<string, unknown> | null;
		analysisResult: Record<string, unknown> | null;
		lastCanvasLoad: Record<string, unknown> | null;
	};
	prdTrace: {
		file: string;
		entryCount: number;
		entries: Array<Record<string, unknown>>;
	};
	timeline: ReturnType<typeof getMissionControlRelaySnapshot>['recent'];
	providerResults: MissionControlResultSummary['providerResults'];
	providerSummary: string | null;
	completionEvidence: MissionControlCompletionEvidence | null;
	projectLineage: MissionControlProjectLineage | null;
	skillPairing: TraceSkillPairing;
	agentBlackBox: AgentBlackBoxReport;
	serverTime: string;
}

function getSpawnerDir(): string {
	return spawnerStateDir(env);
}

function normalizeId(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed || null;
}

function relayFromArtifact(artifact: Record<string, unknown> | null): Record<string, unknown> | null {
	return artifact?.relay && typeof artifact.relay === 'object'
		? (artifact.relay as Record<string, unknown>)
		: null;
}

function artifactRequestId(artifact: Record<string, unknown> | null): string | null {
	const relay = relayFromArtifact(artifact);
	return (
		(typeof artifact?.requestId === 'string' && artifact.requestId) ||
		(typeof relay?.requestId === 'string' && relay.requestId) ||
		null
	);
}

function artifactMissionId(artifact: Record<string, unknown> | null): string | null {
	const relay = relayFromArtifact(artifact);
	return (
		(typeof artifact?.missionId === 'string' && artifact.missionId) ||
		(typeof relay?.missionId === 'string' && relay.missionId) ||
		null
	);
}

function artifactMatches(
	artifact: Record<string, unknown> | null,
	missionId: string | null,
	requestId: string | null
): boolean {
	if (!artifact) return false;
	if (!missionId && !requestId) return true;
	const candidateMissionId = artifactMissionId(artifact);
	const candidateRequestId = artifactRequestId(artifact);
	return Boolean(
		(missionId && candidateMissionId === missionId) ||
		(requestId && candidateRequestId === requestId)
	);
}

function safeLoadFileKey(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'unknown';
}

function archivedCanvasLoadCandidates(spawnerDir: string, input: {
	missionId: string | null;
	requestId: string | null;
}): string[] {
	const candidates: string[] = [];
	if (input.requestId) {
		candidates.push(path.join(spawnerDir, 'canvas-loads', `${safeLoadFileKey(`prd-${input.requestId}`)}.json`));
	}
	if (input.missionId) {
		candidates.push(path.join(spawnerDir, 'canvas-loads', `mission-${safeLoadFileKey(input.missionId)}.json`));
	}
	return [...new Set(candidates)];
}

export function missionIdFromRequestId(requestId: string): string {
	const stamp = requestId.match(/(\d{10,})$/)?.[1];
	return `mission-${stamp || requestId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | null> {
	// NOTE: existsSync check then use is a TOCTOU pattern in concurrent code. The file may be deleted between the check and the read. Consider using try/catch ENOENT or async fs.promises.access.
	if (!existsSync(filePath)) return null;
	try {
		return JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
	} catch {
		return null;
	}
}

const PRD_TRACE_FILE = 'prd-auto-trace.jsonl';
const PRD_TRACE_ENTRY_LIMIT = 100;

/**
 * Ingest the PRD auto-analysis JSONL trail (spawner-state/prd-auto-trace.jsonl)
 * for one request so /trace shows the bridge-side PRD lifecycle alongside the
 * Mission Control timeline.
 */
async function readPrdTraceEntries(input: {
	spawnerDir: string;
	requestId: string | null;
	traceRef: string | null;
}): Promise<{ file: string; entryCount: number; entries: Array<Record<string, unknown>> }> {
	const empty = { file: PRD_TRACE_FILE, entryCount: 0, entries: [] as Array<Record<string, unknown>> };
	if (!input.requestId && !input.traceRef) return empty;
	const traceFile = path.join(input.spawnerDir, PRD_TRACE_FILE);
	if (!existsSync(traceFile)) return empty;
	try {
		const raw = await readFile(traceFile, 'utf-8');
		const entries: Array<Record<string, unknown>> = [];
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let row: unknown;
			try {
				row = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
			const record = row as Record<string, unknown>;
			const matchesRequest = Boolean(input.requestId && record.requestId === input.requestId);
			const matchesTraceRef = Boolean(input.traceRef && extractTraceRef(record) === input.traceRef);
			if (!matchesRequest && !matchesTraceRef) continue;
			entries.push(record);
		}
		return {
			file: PRD_TRACE_FILE,
			entryCount: entries.length,
			entries: entries.slice(-PRD_TRACE_ENTRY_LIMIT)
		};
	} catch {
		return empty;
	}
}

async function readArchivedCanvasLoad(input: {
	spawnerDir: string;
	missionId: string | null;
	requestId: string | null;
}): Promise<Record<string, unknown> | null> {
	for (const filePath of archivedCanvasLoadCandidates(input.spawnerDir, input)) {
		const artifact = await readJsonIfExists(filePath);
		if (artifactMatches(artifact, input.missionId, input.requestId)) return artifact;
	}
	return null;
}

function findBoardEntry(board: BoardBuckets, missionId: string | null) {
	if (!missionId) return { bucket: null, entry: null };
	for (const [bucket, entries] of Object.entries(board)) {
		const entry = entries.find((candidate) => candidate.missionId === missionId);
		if (entry) return { bucket, entry };
	}
	return { bucket: null, entry: null };
}

function progressPercent(entry: MissionControlBoardEntry | null): number {
	if (!entry?.taskStatusCounts?.total) return 0;
	const { completed, total } = entry.taskStatusCounts;
	if (entry.status === 'completed') return 100;
	return Math.round((completed / total) * 100);
}

function phaseFor(input: {
	boardBucket: string | null;
	dispatchStatus: MissionControlTrace['surfaces']['dispatch'];
	pendingRequest: Record<string, unknown> | null;
	analysisResult: Record<string, unknown> | null;
	lastCanvasLoad: Record<string, unknown> | null;
}): MissionControlTracePhase {
	if (input.boardBucket === 'failed' || input.dispatchStatus?.anyFailed) return 'failed';
	if (input.boardBucket === 'cancelled') return 'cancelled';
	if (input.boardBucket === 'paused' || input.dispatchStatus?.paused) return 'paused';
	if (input.boardBucket === 'completed' || input.dispatchStatus?.allComplete) return 'completed';
	if (input.boardBucket === 'running' || Object.values(input.dispatchStatus?.providers || {}).includes('running')) {
		return 'executing';
	}
	if (input.lastCanvasLoad) return 'canvas_ready';
	if (input.analysisResult) return 'planning';
	if (input.pendingRequest) return 'planning';
	return 'unknown';
}

function summaryFor(phase: MissionControlTracePhase, entry: MissionControlBoardEntry | null): string {
	if (entry?.lastSummary) return entry.lastSummary;
	switch (phase) {
		case 'planning':
			return 'Spark is shaping the PRD and preparing the canvas.';
		case 'canvas_ready':
			return 'Canvas pipeline is ready for execution.';
		case 'executing':
			return 'Mission execution is in progress.';
		case 'completed':
			return 'Mission completed.';
		case 'failed':
			return 'Mission failed.';
		case 'paused':
			return 'Mission paused.';
		case 'cancelled':
			return 'Mission cancelled.';
		default:
			return 'No trace data found for this mission yet.';
	}
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function taskTitle(value: unknown, fallback: string): string {
	if (!value || typeof value !== 'object') return fallback;
	const record = value as Record<string, unknown>;
	return (
		(typeof record.title === 'string' && record.title.trim()) ||
		(typeof record.name === 'string' && record.name.trim()) ||
		fallback
	);
}

function skillTasksFromAnalysis(analysisResult: Record<string, unknown> | null): TraceSkillTask[] {
	const tasks = Array.isArray(analysisResult?.tasks) ? analysisResult.tasks : [];
	return tasks.map((task, index) => {
		const record = task && typeof task === 'object' ? (task as Record<string, unknown>) : {};
		return {
			title: taskTitle(task, `task-${index + 1}`),
			skills: stringList(record.skills)
		};
	});
}

function skillTasksFromCanvas(lastCanvasLoad: Record<string, unknown> | null): TraceSkillTask[] {
	const nodes = Array.isArray(lastCanvasLoad?.nodes) ? lastCanvasLoad.nodes : [];
	return nodes.map((node, index) => {
		const record = node && typeof node === 'object' ? (node as Record<string, unknown>) : {};
		const skill = record.skill && typeof record.skill === 'object' ? (record.skill as Record<string, unknown>) : {};
		return {
			title: taskTitle(skill, taskTitle(node, `task-${index + 1}`)),
			skills: stringList(skill.tags)
		};
	});
}

function skillTasksFromEntry(entry: MissionControlBoardEntry | null): TraceSkillTask[] {
	return (entry?.tasks || []).map((task, index) => ({
		title: task.title || `task-${index + 1}`,
		skills: stringList(task.skills)
	}));
}

function buildSkillPairing(input: {
	entry: MissionControlBoardEntry | null;
	analysisResult: Record<string, unknown> | null;
	lastCanvasLoad: Record<string, unknown> | null;
}): TraceSkillPairing {
	const sources: Array<{ source: SkillPairingSource; tasks: TraceSkillTask[] }> = [
		{ source: 'kanban', tasks: skillTasksFromEntry(input.entry) },
		{ source: 'analysis', tasks: skillTasksFromAnalysis(input.analysisResult) },
		{ source: 'canvas', tasks: skillTasksFromCanvas(input.lastCanvasLoad) }
	];
	const selected = sources.find((source) => source.tasks.length > 0) || { source: 'none' as const, tasks: [] };
	const taskCount = selected.tasks.length;
	const pairedTasks = selected.tasks.filter((task) => task.skills.length > 0);
	const uniqueSkills = new Set(selected.tasks.flatMap((task) => task.skills));
	const pairingRatio = taskCount > 0 ? Math.round((pairedTasks.length / taskCount) * 100) : 0;
	const status = taskCount === 0 || pairedTasks.length === 0 ? 'missing' : pairedTasks.length === taskCount ? 'complete' : 'partial';

	return {
		taskCount,
		pairedTaskCount: pairedTasks.length,
		skillCount: uniqueSkills.size,
		pairingRatio,
		status,
		source: selected.source,
		unpairedTasks: selected.tasks.filter((task) => task.skills.length === 0).map((task) => task.title).slice(0, 10)
	};
}

export async function buildMissionControlTrace(input: {
	missionId?: string | null;
	requestId?: string | null;
	getProviderResults: (missionId: string) => ProviderMissionResultSnapshot[];
	getDispatchStatus?: (missionId: string) => MissionControlTrace['surfaces']['dispatch'];
}): Promise<MissionControlTrace> {
	const requestedRequestId = normalizeId(input.requestId);
	const requestedMissionId = normalizeId(input.missionId);
	const spawnerDir = getSpawnerDir();
	const pendingRequestRaw = await readJsonIfExists(path.join(spawnerDir, 'pending-request.json'));
	const lastCanvasLoadRaw = await readJsonIfExists(path.join(spawnerDir, 'last-canvas-load.json'));
	const pendingRequest = artifactMatches(pendingRequestRaw, requestedMissionId, requestedRequestId)
		? pendingRequestRaw
		: null;
	const archivedCanvasLoad = await readArchivedCanvasLoad({
		spawnerDir,
		missionId: requestedMissionId,
		requestId: requestedRequestId
	});
	const lastCanvasLoad = artifactMatches(lastCanvasLoadRaw, requestedMissionId, requestedRequestId)
		? lastCanvasLoadRaw
		: archivedCanvasLoad;
	const requestId =
		requestedRequestId ||
		artifactRequestId(pendingRequest) ||
		artifactRequestId(lastCanvasLoad) ||
		null;
	const missionId =
		requestedMissionId ||
		artifactMissionId(pendingRequest) ||
		artifactMissionId(lastCanvasLoad) ||
		(requestId ? missionIdFromRequestId(requestId) : null);
	const analysisResult = requestId
		? await readJsonIfExists(path.join(spawnerDir, 'results', `${requestId}.json`))
		: null;

	const board = enrichMissionControlBoardWithProviderResults(
		getMissionControlBoard(),
		input.getProviderResults
	) as BoardBuckets;
	const { bucket, entry } = findBoardEntry(board, missionId);
	const traceRef = extractTraceRef(pendingRequest, lastCanvasLoad, entry) || null;
	const dispatchStatus = missionId && input.getDispatchStatus ? input.getDispatchStatus(missionId) : null;
	const relay = entry?.telegramRelay ?? null;
	const traceSnapshot = getMissionControlRelaySnapshot(missionId || undefined);
	const missionControlAccess = resolveMissionControlAccess(missionControlPathForMission(missionId));
	const agentBlackBox = buildAgentBlackBoxReport({
		requestId,
		sessionId: missionId ? `mission-control:${missionId}` : null,
		limit: 12
	});
	const phase = phaseFor({
		boardBucket: bucket,
		dispatchStatus,
		pendingRequest,
		analysisResult,
		lastCanvasLoad
	});
	const skillPairing = buildSkillPairing({ entry, analysisResult, lastCanvasLoad });
	const prdTrace = await readPrdTraceEntries({ spawnerDir, requestId, traceRef });

	return {
		ok: true,
		missionId,
		requestId,
		traceRef,
		phase,
		summary: summaryFor(phase, entry),
		progress: {
			percent: progressPercent(entry),
			taskCounts: entry?.taskStatusCounts ?? null,
			currentTask: entry?.taskName ?? null
		},
		missionControlAccess,
		surfaces: {
			telegram: {
				relay,
				chatId:
					typeof pendingRequest?.relay === 'object' && pendingRequest.relay
						? ((pendingRequest.relay as Record<string, unknown>).chatId as string) || null
						: null,
				userId:
					typeof pendingRequest?.relay === 'object' && pendingRequest.relay
						? ((pendingRequest.relay as Record<string, unknown>).userId as string) || null
						: null
			},
			canvas: {
				pipelineId: typeof lastCanvasLoad?.pipelineId === 'string' ? lastCanvasLoad.pipelineId : null,
				pipelineName: typeof lastCanvasLoad?.pipelineName === 'string' ? lastCanvasLoad.pipelineName : null,
				autoRun: typeof lastCanvasLoad?.autoRun === 'boolean' ? lastCanvasLoad.autoRun : null,
				nodeCount: Array.isArray(lastCanvasLoad?.nodes) ? lastCanvasLoad.nodes.length : null
			},
			kanban: {
				bucket,
				entry
			},
			dispatch: dispatchStatus
		},
		artifacts: {
			pendingRequest,
			analysisResult,
			lastCanvasLoad
		},
		prdTrace,
		timeline: traceSnapshot.recent,
		providerResults: entry?.providerResults ?? [],
		providerSummary: entry?.providerSummary ?? null,
		completionEvidence: entry?.completionEvidence ?? null,
		projectLineage: entry?.projectLineage ?? null,
		skillPairing,
		agentBlackBox,
		serverTime: new Date().toISOString()
	};
}
