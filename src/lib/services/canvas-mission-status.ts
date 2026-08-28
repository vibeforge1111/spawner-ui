import type { CanvasNode, Connection } from '$lib/stores/canvas.svelte';
import type { MissionControlBoardEntry, MissionControlTaskStatus } from '$lib/types/mission-control';

type CanvasNodeStatus = CanvasNode['status'];
type MissionControlBoard = Record<string, MissionControlBoardEntry[]>;

export interface CanvasMissionStatusUpdate {
	nodeId: string;
	status: CanvasNodeStatus;
	taskTitle: string;
}

export interface CanvasMissionBoardLookup {
	missionId?: string | null;
	pipelineId?: string | null;
	pipelineName?: string | null;
}

export interface CanvasMissionHistoryCanvas {
	nodes: CanvasNode[];
	connections: Connection[];
	zoom: number;
	pan: { x: number; y: number };
}

function normalizeLabel(value: string | null | undefined): string {
	return (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseLastUpdatedOrTail(value: string | null | undefined): number {
	// Date.parse('') and Date.parse('not-iso') both return NaN. Returning a NaN
	// arithmetic result from a sort comparator leaves V8 TimSort with an undefined
	// ordering. Mirrors src/lib/server/mission-control-relay.ts lastUpdatedSortTime.
	const parsed = Date.parse(value || '');
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function latestFirst(a: MissionControlBoardEntry, b: MissionControlBoardEntry): number {
	return parseLastUpdatedOrTail(b.lastUpdated) - parseLastUpdatedOrTail(a.lastUpdated);
}

function missionNumericSuffix(missionId: string | null | undefined): string | null {
	return missionId?.match(/\d{10,}/)?.[0] || null;
}

export function flattenMissionControlBoard(board: MissionControlBoard | null | undefined): MissionControlBoardEntry[] {
	if (!board) return [];
	return Object.values(board).flat().sort(latestFirst);
}

export function findMissionControlBoardEntryForCanvas(
	board: MissionControlBoard | null | undefined,
	lookup: CanvasMissionBoardLookup
): MissionControlBoardEntry | null {
	const entries = flattenMissionControlBoard(board);
	const missionId = lookup.missionId?.trim();
	if (missionId) {
		const exact = entries.find((entry) => entry.missionId === missionId);
		if (exact) return exact;
	}

	const pipelineId = lookup.pipelineId?.trim().toLowerCase() || '';
	if (pipelineId) {
		const pipelineMatch = entries.find((entry) => {
			const missionId = entry.missionId.toLowerCase();
			const numericSuffix = missionNumericSuffix(entry.missionId);
			return pipelineId.includes(missionId) || Boolean(numericSuffix && pipelineId.includes(numericSuffix));
		});
		if (pipelineMatch) return pipelineMatch;
	}

	const pipelineName = normalizeLabel(lookup.pipelineName);
	if (pipelineName) {
		const exactName = entries.find((entry) => normalizeLabel(entry.missionName) === pipelineName);
		if (exactName) return exactName;

		const partialName = entries.find((entry) => {
			const missionName = normalizeLabel(entry.missionName);
			return Boolean(missionName && (pipelineName.includes(missionName) || missionName.includes(pipelineName)));
		});
		if (partialName) return partialName;
	}

	return null;
}

export function taskMatchesCanvasNode(node: CanvasNode, taskId: string, taskName?: string): boolean {
	const nodeName = node.skill.name || '';
	const skillId = node.skill.id || '';
	const normalizedTaskName = normalizeLabel(taskName);
	const normalizedTaskId = normalizeLabel(taskId);
	const normalizedNodeName = normalizeLabel(nodeName);
	return (
		node.id === taskId ||
		skillId === taskId ||
		skillId === `task-${taskId}` ||
		nodeName === taskName ||
		nodeName === taskId ||
		nodeName.startsWith(`${taskId}:`) ||
		(Boolean(taskName) && nodeName.startsWith(`${taskName}:`)) ||
		(Boolean(normalizedTaskName) && normalizedNodeName.includes(normalizedTaskName)) ||
		(Boolean(normalizedTaskId) && normalizedNodeName.includes(normalizedTaskId))
	);
}

export function canvasStatusForMissionControlTask(status: MissionControlTaskStatus | undefined): CanvasNodeStatus {
	if (status === 'completed') return 'success';
	if (status === 'failed' || status === 'cancelled') return 'error';
	if (status === 'running') return 'running';
	return 'queued';
}

export function buildCanvasMissionStatusUpdates(
	canvasNodes: CanvasNode[],
	tasks: MissionControlBoardEntry['tasks']
): CanvasMissionStatusUpdate[] {
	const updates: CanvasMissionStatusUpdate[] = [];
	const matchedNodeIds = new Set<string>();

	for (const task of tasks) {
		const node = canvasNodes.find(
			(candidate) => !matchedNodeIds.has(candidate.id) && taskMatchesCanvasNode(candidate, task.title, task.title)
		);
		if (!node) continue;
		matchedNodeIds.add(node.id);
		updates.push({
			nodeId: node.id,
			status: canvasStatusForMissionControlTask(task.status),
			taskTitle: task.title
		});
	}

	return updates;
}

function compactNodeId(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48) || 'task'
	);
}

function missionHistoryNode(
	missionId: string,
	title: string,
	index: number,
	status?: MissionControlTaskStatus,
	description = 'Mission Control task',
	skills: string[] = []
): CanvasNode {
	return {
		id: `mission-history-${compactNodeId(missionId)}-${index + 1}`,
		skillId: `mission-task-${index + 1}`,
		skill: {
			id: `mission-task-${index + 1}`,
			name: title,
			description,
			category: 'development',
			tier: 'free',
			tags: skills,
			skillChain: skills,
			chainDescription: skills.length > 0 ? `Paired skills: ${skills.join(', ')}` : undefined,
			triggers: ['mission-control-history']
		},
		position: {
			x: 120 + index * 280,
			y: 160 + (index % 2) * 72
		},
		status: canvasStatusForMissionControlTask(status)
	};
}

export function buildCanvasMissionHistoryCanvas(entry: MissionControlBoardEntry): CanvasMissionHistoryCanvas {
	const fallbackStatus: MissionControlTaskStatus = entry.status === 'completed' ? 'completed' : 'queued';
	const taskRows: { title: string; skills: string[]; status?: MissionControlTaskStatus }[] = entry.tasks?.length
		? entry.tasks
		: (entry.taskNames?.length ? entry.taskNames : [entry.taskName || entry.missionName || 'Mission'])
				.filter((title): title is string => Boolean(title))
				.map((title) => ({ title, skills: [], status: fallbackStatus }));

	const nodes = taskRows.map((task, index) =>
		missionHistoryNode(
			entry.missionId,
			task.title || `Task ${index + 1}`,
			index,
			task.status,
			entry.missionName ? `${entry.missionName} mission task` : 'Mission Control task',
			task.skills
		)
	);

	const connections = nodes.slice(1).map((node, index) => ({
		id: `mission-history-conn-${compactNodeId(entry.missionId)}-${index + 1}`,
		sourceNodeId: nodes[index].id,
		sourcePortId: 'output',
		targetNodeId: node.id,
		targetPortId: 'input'
	}));

	return {
		nodes,
		connections,
		zoom: 1,
		pan: { x: 0, y: 0 }
	};
}

export function buildCanvasMissionHistoryPlaceholder(missionId: string): CanvasMissionHistoryCanvas {
	return {
		nodes: [
			missionHistoryNode(
				missionId,
				'Loading Mission Control history',
				0,
				'queued',
				`Waiting for Mission Control data for ${missionId}`
			)
		],
		connections: [],
		zoom: 1,
		pan: { x: 0, y: 0 }
	};
}
