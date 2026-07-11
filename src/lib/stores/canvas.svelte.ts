import { safeJsonParse } from '$lib/server/safe-json';
import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import type { Skill } from './skills.svelte';
import { generatePorts, arePortTypesCompatible } from '$lib/utils/ports';
import { CanvasStoreSavedStateSchema, safeJsonParse } from '$lib/types/schemas';

const STORAGE_KEY = 'spawner-canvas-state';
const MAX_HISTORY_SIZE = 50;

export interface CanvasNode {
	id: string;
	skillId: string;
	skill: Skill;
	position: { x: number; y: number };
	status?: 'idle' | 'queued' | 'running' | 'success' | 'error';
}

export interface Connection {
	id: string;
	sourceNodeId: string;
	sourcePortId: string;
	targetNodeId: string;
	targetPortId: string;
}

export interface DraggingConnection {
	sourceNodeId: string;
	sourcePortId: string;
	sourcePortType: 'input' | 'output';
	startX: number;
	startY: number;
	currentX: number;
	currentY: number;
}

export interface CuttingLine {
	startX: number;
	startY: number;
	currentX: number;
	currentY: number;
}

export interface SelectionBox {
	startX: number;
	startY: number;
	currentX: number;
	currentY: number;
}

export interface CanvasState {
	nodes: CanvasNode[];
	connections: Connection[];
	selectedNodeId: string | null;
	selectedNodeIds: string[];
	selectedConnectionId: string | null;
	zoom: number;
	pan: { x: number; y: number };
	draggingConnection: DraggingConnection | null;
	cuttingLine: CuttingLine | null;
	selectionBox: SelectionBox | null;
	snapToGrid: boolean;
	gridSize: number;
}

const initialState: CanvasState = {
	nodes: [],
	connections: [],
	selectedNodeId: null,
	selectedNodeIds: [],
	selectedConnectionId: null,
	zoom: 1,
	pan: { x: 0, y: 0 },
	draggingConnection: null,
	cuttingLine: null,
	selectionBox: null,
	snapToGrid: true,
	gridSize: 24
};

export const canvasState = writable<CanvasState>(initialState);
export const nodes = derived(canvasState, ($state) => $state.nodes);
export const connections = derived(canvasState, ($state) => $state.connections);
export const selectedNodeId = derived(canvasState, ($state) => $state.selectedNodeId);
export const selectedNodeIds = derived(canvasState, ($state) => $state.selectedNodeIds);
export const selectedConnectionId = derived(canvasState, ($state) => $state.selectedConnectionId);
export const draggingConnection = derived(canvasState, ($state) => $state.draggingConnection);
export const cuttingLine = derived(canvasState, ($state) => $state.cuttingLine);
export const selectionBox = derived(canvasState, ($state) => $state.selectionBox);
export const snapToGrid = derived(canvasState, ($state) => $state.snapToGrid);
export const gridSize = derived(canvasState, ($state) => $state.gridSize);

export const selectedNode = derived(canvasState, ($state) => {
	if (!$state.selectedNodeId) return null;
	return $state.nodes.find((n) => n.id === $state.selectedNodeId) || null;
});

export const selectedNodes = derived(canvasState, ($state) => {
	return $state.nodes.filter((n) => $state.selectedNodeIds.includes(n.id));
});

export const selectedConnection = derived(canvasState, ($state) => {
	if (!$state.selectedConnectionId) return null;
	return $state.connections.find((c) => c.id === $state.selectedConnectionId) || null;
});

// History for undo/redo
interface HistoryEntry {
	nodes: CanvasNode[];
	connections: Connection[];
}

const historyStack = writable<HistoryEntry[]>([]);
const historyIndex = writable<number>(-1);

export const canUndo = derived([historyStack, historyIndex], ([$stack, $index]) => $index > 0);
export const canRedo = derived([historyStack, historyIndex], ([$stack, $index]) => $index < $stack.length - 1);

function getHistoryEntry(): HistoryEntry {
	const state = get(canvasState);
	return {
		nodes: JSON.parse(JSON.stringify(state.nodes)),
		connections: JSON.parse(JSON.stringify(state.connections))
	};
}

/**
 * Push current state to history stack (call after significant changes)
 */
export function pushHistory() {
	const entry = getHistoryEntry();
	const currentIndex = get(historyIndex);
	let currentStack = get(historyStack);

	// If we're not at the end, truncate forward history
	if (currentIndex < currentStack.length - 1) {
		currentStack = currentStack.slice(0, currentIndex + 1);
	}

	// Add new entry
	currentStack = [...currentStack, entry];

	// Limit history size
	if (currentStack.length > MAX_HISTORY_SIZE) {
		currentStack = currentStack.slice(currentStack.length - MAX_HISTORY_SIZE);
	}

	historyStack.set(currentStack);
	historyIndex.set(currentStack.length - 1);
}

/**
 * Undo last action
 */
export function undo(): boolean {
	const currentIndex = get(historyIndex);
	if (currentIndex <= 0) return false;

	const newIndex = currentIndex - 1;
	const stack = get(historyStack);
	const entry = stack[newIndex];

	if (!entry) return false;

	// Restore state without pushing to history
	canvasState.update((state) => ({
		...state,
		nodes: JSON.parse(JSON.stringify(entry.nodes)),
		connections: JSON.parse(JSON.stringify(entry.connections)),
		selectedNodeId: null
	}));

	historyIndex.set(newIndex);
	return true;
}

/**
 * Redo previously undone action
 */
export function redo(): boolean {
	const currentIndex = get(historyIndex);
	const stack = get(historyStack);

	if (currentIndex >= stack.length - 1) return false;

	const newIndex = currentIndex + 1;
	const entry = stack[newIndex];

	if (!entry) return false;

	// Restore state without pushing to history
	canvasState.update((state) => ({
		...state,
		nodes: JSON.parse(JSON.stringify(entry.nodes)),
		connections: JSON.parse(JSON.stringify(entry.connections)),
		selectedNodeId: null
	}));

	historyIndex.set(newIndex);
	return true;
}

/**
 * Clear history stack
 */
export function clearHistory() {
	historyStack.set([getHistoryEntry()]);
	historyIndex.set(0);
}

let nodeIdCounter = 0;

export function addNode(skill: Skill, position: { x: number; y: number }): string {
	pushHistory();

	nodeIdCounter++;
	const id = 'node-' + nodeIdCounter + '-' + Math.random().toString(36).slice(2, 8);
	const node: CanvasNode = {
		id,
		skillId: skill.id,
		skill,
		position,
		status: 'idle'
	};

	canvasState.update((state) => ({
		...state,
		nodes: [...state.nodes, node]
	}));

	return id;
}

/**
 * Add multiple nodes with connections at once (for templates)
 * @param nodeDefs Array of skill + position pairs
 * @param connectionDefs Array of connection definitions using indices
 * @returns Array of created node IDs
 */
export function addNodesWithConnections(
	nodeDefs: { skill: Skill; position: { x: number; y: number } }[],
	connectionDefs: { sourceIndex: number; targetIndex: number; sourcePortId?: string; targetPortId?: string }[]
): string[] {
	if (nodeDefs.length === 0) return [];

	pushHistory();

	const nodeIds: string[] = [];

	// Add all nodes
	for (const nodeDef of nodeDefs) {
		nodeIdCounter++;
		const id = 'node-' + nodeIdCounter + '-' + Math.random().toString(36).slice(2, 8);
		const node: CanvasNode = {
			id,
			skillId: nodeDef.skill.id,
			skill: nodeDef.skill,
			position: nodeDef.position,
			status: 'idle'
		};
		nodeIds.push(id);

		canvasState.update((state) => ({
			...state,
			nodes: [...state.nodes, node]
		}));
	}

	// Add all connections
	for (const connDef of connectionDefs) {
		const sourceId = nodeIds[connDef.sourceIndex];
		const targetId = nodeIds[connDef.targetIndex];
		if (sourceId && targetId) {
			const id = 'conn-' + crypto.randomUUID();
			const connection: Connection = {
				id,
				sourceNodeId: sourceId,
				sourcePortId: connDef.sourcePortId || 'output',
				targetNodeId: targetId,
				targetPortId: connDef.targetPortId || 'input'
			};

			canvasState.update((state) => ({
				...state,
				connections: [...state.connections, connection]
			}));
		}
	}

	// Select the newly added nodes
	canvasState.update((state) => ({
		...state,
		selectedNodeIds: nodeIds,
		selectedNodeId: nodeIds.length === 1 ? nodeIds[0] : null
	}));

	return nodeIds;
}

export function removeNode(nodeId: string) {
	pushHistory();

	canvasState.update((state) => ({
		...state,
		nodes: state.nodes.filter((n) => n.id !== nodeId),
		connections: state.connections.filter(
			(c) => c.sourceNodeId !== nodeId && c.targetNodeId !== nodeId
		),
		selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId
	}));
}

export function updateNodePosition(nodeId: string, position: { x: number; y: number }) {
	canvasState.update((state) => ({
		...state,
		nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n))
	}));
}

export function selectNode(nodeId: string | null) {
	canvasState.update((state) => ({
		...state,
		selectedNodeId: nodeId,
		selectedNodeIds: nodeId ? [nodeId] : [],
		selectedConnectionId: null // Clear connection selection when selecting node
	}));
}

export function selectConnection(connectionId: string | null) {
	canvasState.update((state) => ({
		...state,
		selectedConnectionId: connectionId,
		selectedNodeId: null, // Clear node selection when selecting connection
		selectedNodeIds: []
	}));
}

export function toggleNodeSelection(nodeId: string, addToSelection: boolean) {
	canvasState.update((state) => {
		if (addToSelection) {
			// Shift+click: add/remove from selection
			const isSelected = state.selectedNodeIds.includes(nodeId);
			const newSelectedIds = isSelected
				? state.selectedNodeIds.filter((id) => id !== nodeId)
				: [...state.selectedNodeIds, nodeId];
			return {
				...state,
				selectedNodeIds: newSelectedIds,
				selectedNodeId: newSelectedIds.length === 1 ? newSelectedIds[0] : state.selectedNodeId,
				selectedConnectionId: null
			};
		} else {
			// Normal click: select only this node
			return {
				...state,
				selectedNodeId: nodeId,
				selectedNodeIds: [nodeId],
				selectedConnectionId: null
			};
		}
	});
}

export function selectAllNodes() {
	canvasState.update((state) => ({
		...state,
		selectedNodeIds: state.nodes.map((n) => n.id),
		selectedNodeId: state.nodes.length === 1 ? state.nodes[0].id : null,
		selectedConnectionId: null
	}));
}

export function clearSelection() {
	canvasState.update((state) => ({
		...state,
		selectedNodeId: null,
		selectedNodeIds: [],
		selectedConnectionId: null
	}));
}

export function deleteSelected() {
	const state = get(canvasState);

	// Delete selected connection
	if (state.selectedConnectionId) {
		removeConnection(state.selectedConnectionId);
		return;
	}

	// Delete selected nodes
	if (state.selectedNodeIds.length > 0) {
		pushHistory();
		canvasState.update((s) => ({
			...s,
			nodes: s.nodes.filter((n) => !state.selectedNodeIds.includes(n.id)),
			connections: s.connections.filter(
				(c) => !state.selectedNodeIds.includes(c.sourceNodeId) && !state.selectedNodeIds.includes(c.targetNodeId)
			),
			selectedNodeId: null,
			selectedNodeIds: [],
			selectedConnectionId: null
		}));
	}
}

// Clipboard for copy/paste
let clipboard: { nodes: CanvasNode[]; connections: Connection[] } | null = null;

export function duplicateSelected(): string[] {
	const state = get(canvasState);
	if (state.selectedNodeIds.length === 0) return [];

	pushHistory();
	const newNodeIds: string[] = [];
	const idMap: Record<string, string> = {};

	// Duplicate nodes with offset
	const nodesToDuplicate = state.nodes.filter((n) => state.selectedNodeIds.includes(n.id));
	const newNodes: CanvasNode[] = [];

	nodesToDuplicate.forEach((node) => {
		nodeIdCounter++;
		const newId = 'node-' + nodeIdCounter + '-' + Math.random().toString(36).slice(2, 8);
		idMap[node.id] = newId;
		newNodeIds.push(newId);

		newNodes.push({
			...node,
			id: newId,
			position: { x: node.position.x + 30, y: node.position.y + 30 }
		});
	});

	// Duplicate connections between selected nodes
	const connectionsToDuplicate = state.connections.filter(
		(c) => state.selectedNodeIds.includes(c.sourceNodeId) && state.selectedNodeIds.includes(c.targetNodeId)
	);
	const newConnections: Connection[] = connectionsToDuplicate.map((conn) => ({
		...conn,
		id: 'conn-' + crypto.randomUUID(),
		sourceNodeId: idMap[conn.sourceNodeId],
		targetNodeId: idMap[conn.targetNodeId]
	}));

	canvasState.update((s) => ({
		...s,
		nodes: [...s.nodes, ...newNodes],
		connections: [...s.connections, ...newConnections],
		selectedNodeIds: newNodeIds,
		selectedNodeId: newNodeIds.length === 1 ? newNodeIds[0] : null
	}));

	return newNodeIds;
}

export function copySelected() {
	const state = get(canvasState);
	if (state.selectedNodeIds.length === 0) return;

	const nodesToCopy = state.nodes.filter((n) => state.selectedNodeIds.includes(n.id));
	const connectionsToCopy = state.connections.filter(
		(c) => state.selectedNodeIds.includes(c.sourceNodeId) && state.selectedNodeIds.includes(c.targetNodeId)
	);

	try {
		clipboard = {
			nodes: JSON.parse(JSON.stringify(nodesToCopy)),
			connections: JSON.parse(JSON.stringify(connectionsToCopy))
		};
	} catch {
		clipboard = null;
		return;
	}
}

export function pasteFromClipboard(): string[] {
	if (!clipboard || clipboard.nodes.length === 0) return [];

	pushHistory();
	const newNodeIds: string[] = [];
	const idMap: Record<string, string> = {};

	// Create new nodes from clipboard
	const newNodes: CanvasNode[] = clipboard.nodes.map((node) => {
		nodeIdCounter++;
		const newId = 'node-' + nodeIdCounter + '-' + Math.random().toString(36).slice(2, 8);
		idMap[node.id] = newId;
		newNodeIds.push(newId);

		return {
			...node,
			id: newId,
			position: { x: node.position.x + 50, y: node.position.y + 50 },
			status: 'idle' as const
		};
	});

	// Recreate connections
	const newConnections: Connection[] = clipboard.connections.map((conn) => ({
		...conn,
		id: 'conn-' + crypto.randomUUID(),
		sourceNodeId: idMap[conn.sourceNodeId],
		targetNodeId: idMap[conn.targetNodeId]
	}));

	canvasState.update((s) => ({
		...s,
		nodes: [...s.nodes, ...newNodes],
		connections: [...s.connections, ...newConnections],
		selectedNodeIds: newNodeIds,
		selectedNodeId: newNodeIds.length === 1 ? newNodeIds[0] : null
	}));

	// Update clipboard positions for subsequent pastes
	clipboard = {
		nodes: clipboard.nodes.map((n) => ({ ...n, position: { x: n.position.x + 50, y: n.position.y + 50 } })),
		connections: clipboard.connections
	};

	return newNodeIds;
}

export function addConnection(
	sourceNodeId: string,
	sourcePortId: string,
	targetNodeId: string,
	targetPortId: string
): string {
	pushHistory();

	const id = 'conn-' + crypto.randomUUID();
	const connection: Connection = {
		id,
		sourceNodeId,
		sourcePortId,
		targetNodeId,
		targetPortId
	};

	canvasState.update((state) => ({
		...state,
		connections: [...state.connections, connection]
	}));

	return id;
}

export function removeConnection(connectionId: string) {
	pushHistory();

	canvasState.update((state) => ({
		...state,
		connections: state.connections.filter((c) => c.id !== connectionId)
	}));
}

export function setZoom(zoom: number) {
	canvasState.update((state) => ({
		...state,
		zoom: Math.max(0.25, Math.min(2, zoom))
	}));
}

export function setPan(pan: { x: number; y: number }) {
	canvasState.update((state) => ({
		...state,
		pan
	}));
}

const NODE_WIDTH = 224;
const NODE_HEIGHT = 96;

export function zoomToFit(canvasWidth: number, canvasHeight: number, padding = 50) {
	const state = get(canvasState);
	if (state.nodes.length === 0) {
		canvasState.update((s) => ({ ...s, zoom: 1, pan: { x: 0, y: 0 } }));
		return;
	}

	// Calculate bounding box of all nodes
	const minX = Math.min(...state.nodes.map((n) => n.position.x));
	const minY = Math.min(...state.nodes.map((n) => n.position.y));
	const maxX = Math.max(...state.nodes.map((n) => n.position.x + NODE_WIDTH));
	const maxY = Math.max(...state.nodes.map((n) => n.position.y + NODE_HEIGHT));

	const contentWidth = maxX - minX;
	const contentHeight = maxY - minY;

	// Calculate zoom to fit
	const availableWidth = canvasWidth - padding * 2;
	const availableHeight = canvasHeight - padding * 2;
	const zoom = Math.min(
		Math.max(0.25, Math.min(2, availableWidth / contentWidth)),
		Math.max(0.25, Math.min(2, availableHeight / contentHeight))
	);

	// Calculate pan to center
	const centerX = (minX + maxX) / 2;
	const centerY = (minY + maxY) / 2;
	const panX = canvasWidth / 2 - centerX * zoom;
	const panY = canvasHeight / 2 - centerY * zoom;

	canvasState.update((s) => ({ ...s, zoom, pan: { x: panX, y: panY } }));
}

export function frameSelected(canvasWidth: number, canvasHeight: number, padding = 80) {
	const state = get(canvasState);
	const selectedNodes = state.nodes.filter((n) => state.selectedNodeIds.includes(n.id));
	if (selectedNodes.length === 0) return;

	// Calculate bounding box of selected nodes
	const minX = Math.min(...selectedNodes.map((n) => n.position.x));
	const minY = Math.min(...selectedNodes.map((n) => n.position.y));
	const maxX = Math.max(...selectedNodes.map((n) => n.position.x + NODE_WIDTH));
	const maxY = Math.max(...selectedNodes.map((n) => n.position.y + NODE_HEIGHT));

	const contentWidth = maxX - minX;
	const contentHeight = maxY - minY;

	// Calculate zoom to fit selection
	const availableWidth = canvasWidth - padding * 2;
	const availableHeight = canvasHeight - padding * 2;
	const zoom = Math.min(
		Math.max(0.5, Math.min(1.5, availableWidth / contentWidth)),
		Math.max(0.5, Math.min(1.5, availableHeight / contentHeight))
	);

	// Calculate pan to center selection
	const centerX = (minX + maxX) / 2;
	const centerY = (minY + maxY) / 2;
	const panX = canvasWidth / 2 - centerX * zoom;
	const panY = canvasHeight / 2 - centerY * zoom;

	canvasState.update((s) => ({ ...s, zoom, pan: { x: panX, y: panY } }));
}

export function startConnectionDrag(
	sourceNodeId: string,
	sourcePortId: string,
	sourcePortType: 'input' | 'output',
	startX: number,
	startY: number
) {
	canvasState.update((state) => ({
		...state,
		draggingConnection: {
			sourceNodeId,
			sourcePortId,
			sourcePortType,
			startX,
			startY,
			currentX: startX,
			currentY: startY
		}
	}));
}

export function updateConnectionDrag(currentX: number, currentY: number) {
	canvasState.update((state) => {
		if (!state.draggingConnection) return state;
		return {
			...state,
			draggingConnection: {
				...state.draggingConnection,
				currentX,
				currentY
			}
		};
	});
}

export function endConnectionDrag() {
	canvasState.update((state) => ({
		...state,
		draggingConnection: null
	}));
}

export function completeConnection(targetNodeId: string, targetPortId: string): boolean {
	const state = get(canvasState);
	const drag = state.draggingConnection;
	if (!drag) return false;

	// Cannot connect to same node
	if (drag.sourceNodeId === targetNodeId) {
		endConnectionDrag();
		return false;
	}

	// Check if connection already exists
	const exists = state.connections.some(
		(c) =>
			(c.sourceNodeId === drag.sourceNodeId && c.targetNodeId === targetNodeId) ||
			(c.sourceNodeId === targetNodeId && c.targetNodeId === drag.sourceNodeId)
	);
	if (exists) {
		endConnectionDrag();
		return false;
	}

	// Validate port type compatibility
	const sourceNode = state.nodes.find((n) => n.id === drag.sourceNodeId);
	const targetNode = state.nodes.find((n) => n.id === targetNodeId);

	if (sourceNode && targetNode) {
		const sourcePorts = generatePorts({
			category: sourceNode.skill.category,
			handoffs: sourceNode.skill.handoffs,
			pairsWell: sourceNode.skill.pairsWell,
			tags: sourceNode.skill.tags
		});
		const targetPorts = generatePorts({
			category: targetNode.skill.category,
			handoffs: targetNode.skill.handoffs,
			pairsWell: targetNode.skill.pairsWell,
			tags: targetNode.skill.tags
		});

		// Get port types
		let sourcePortType, targetPortType;
		if (drag.sourcePortType === 'output') {
			const sourcePort = sourcePorts.outputs.find((p) => p.id === drag.sourcePortId);
			const targetPort = targetPorts.inputs.find((p) => p.id === targetPortId);
			sourcePortType = sourcePort?.type || 'any';
			targetPortType = targetPort?.type || 'any';
		} else {
			const sourcePort = sourcePorts.inputs.find((p) => p.id === drag.sourcePortId);
			const targetPort = targetPorts.outputs.find((p) => p.id === targetPortId);
			// Reverse for input-to-output connection
			sourcePortType = targetPort?.type || 'any';
			targetPortType = sourcePort?.type || 'any';
		}

		if (!arePortTypesCompatible(sourcePortType, targetPortType)) {
			endConnectionDrag();
			return false;
		}
	}

	// Output connects to input
	if (drag.sourcePortType === 'output') {
		addConnection(drag.sourceNodeId, drag.sourcePortId, targetNodeId, targetPortId);
	} else {
		// Input connects from output (reverse)
		addConnection(targetNodeId, targetPortId, drag.sourceNodeId, drag.sourcePortId);
	}

	endConnectionDrag();
	return true;
}

/**
 * Check if a potential connection would be valid (for visual feedback during drag)
 */
export function wouldConnectionBeValid(targetNodeId: string, targetPortId: string): boolean {
	const state = get(canvasState);
	const drag = state.draggingConnection;
	if (!drag) return false;

	// Cannot connect to same node
	if (drag.sourceNodeId === targetNodeId) return false;

	// Check if connection already exists
	const exists = state.connections.some(
		(c) =>
			(c.sourceNodeId === drag.sourceNodeId && c.targetNodeId === targetNodeId) ||
			(c.sourceNodeId === targetNodeId && c.targetNodeId === drag.sourceNodeId)
	);
	if (exists) return false;

	// Validate port type compatibility
	const sourceNode = state.nodes.find((n) => n.id === drag.sourceNodeId);
	const targetNode = state.nodes.find((n) => n.id === targetNodeId);

	if (!sourceNode || !targetNode) return false;

	const sourcePorts = generatePorts({
		category: sourceNode.skill.category,
		handoffs: sourceNode.skill.handoffs,
		pairsWell: sourceNode.skill.pairsWell,
		tags: sourceNode.skill.tags
	});
	const targetPorts = generatePorts({
		category: targetNode.skill.category,
		handoffs: targetNode.skill.handoffs,
		pairsWell: targetNode.skill.pairsWell,
		tags: targetNode.skill.tags
	});

	let sourcePortType, targetPortType;
	if (drag.sourcePortType === 'output') {
		const sourcePort = sourcePorts.outputs.find((p) => p.id === drag.sourcePortId);
		const targetPort = targetPorts.inputs.find((p) => p.id === targetPortId);
		sourcePortType = sourcePort?.type || 'any';
		targetPortType = targetPort?.type || 'any';
	} else {
		const sourcePort = sourcePorts.inputs.find((p) => p.id === drag.sourcePortId);
		const targetPort = targetPorts.outputs.find((p) => p.id === targetPortId);
		sourcePortType = targetPort?.type || 'any';
		targetPortType = sourcePort?.type || 'any';
	}

	return arePortTypesCompatible(sourcePortType, targetPortType);
}

// Connection cutting functions (Blender-style Ctrl+drag to cut)
export function startConnectionCut(startX: number, startY: number) {
	canvasState.update((state) => ({
		...state,
		cuttingLine: { startX, startY, currentX: startX, currentY: startY }
	}));
}

export function updateConnectionCut(currentX: number, currentY: number) {
	canvasState.update((state) => {
		if (!state.cuttingLine) return state;
		return {
			...state,
			cuttingLine: { ...state.cuttingLine, currentX, currentY }
		};
	});
}

// Helper: Check if line segment intersects with bezier curve (approximated)
function lineIntersectsBezier(
	lineX1: number, lineY1: number, lineX2: number, lineY2: number,
	bezierStartX: number, bezierStartY: number, bezierEndX: number, bezierEndY: number
): boolean {
	// Approximate bezier with line segments and check intersection
	const midX = (bezierStartX + bezierEndX) / 2;
	const segments = [
		{ x1: bezierStartX, y1: bezierStartY, x2: midX, y2: bezierStartY },
		{ x1: midX, y1: bezierStartY, x2: midX, y2: bezierEndY },
		{ x1: midX, y1: bezierEndY, x2: bezierEndX, y2: bezierEndY }
	];

	for (const seg of segments) {
		if (lineSegmentsIntersect(lineX1, lineY1, lineX2, lineY2, seg.x1, seg.y1, seg.x2, seg.y2)) {
			return true;
		}
	}
	return false;
}

// Helper: Check if two line segments intersect
function lineSegmentsIntersect(
	x1: number, y1: number, x2: number, y2: number,
	x3: number, y3: number, x4: number, y4: number
): boolean {
	const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
	if (Math.abs(denom) < 0.0001) return false; // Parallel

	const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
	const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;

	return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
}

export function endConnectionCut(): string[] {
	const state = get(canvasState);
	if (!state.cuttingLine) return [];

	const { startX, startY, currentX, currentY } = state.cuttingLine;
	const cutConnectionIds: string[] = [];

	// Check each connection for intersection with cutting line
	for (const conn of state.connections) {
		const sourceNode = state.nodes.find((n) => n.id === conn.sourceNodeId);
		const targetNode = state.nodes.find((n) => n.id === conn.targetNodeId);
		if (!sourceNode || !targetNode) continue;

		// Get bezier endpoints (simplified - assumes ports are on edges)
		const bezierStartX = sourceNode.position.x + NODE_WIDTH;
		const bezierStartY = sourceNode.position.y + NODE_HEIGHT / 2;
		const bezierEndX = targetNode.position.x;
		const bezierEndY = targetNode.position.y + NODE_HEIGHT / 2;

		if (lineIntersectsBezier(startX, startY, currentX, currentY, bezierStartX, bezierStartY, bezierEndX, bezierEndY)) {
			cutConnectionIds.push(conn.id);
		}
	}

	// Clear cutting line first
	canvasState.update((s) => ({ ...s, cuttingLine: null }));

	// Remove cut connections if any were found
	if (cutConnectionIds.length > 0) {
		pushHistory();
		canvasState.update((s) => ({
			...s,
			connections: s.connections.filter((c) => !cutConnectionIds.includes(c.id))
		}));
	}

	return cutConnectionIds;
}

export function cancelConnectionCut() {
	canvasState.update((state) => ({
		...state,
		cuttingLine: null
	}));
}

// Selection box (marquee) functions
export function startSelectionBox(startX: number, startY: number) {
	canvasState.update((state) => ({
		...state,
		selectionBox: { startX, startY, currentX: startX, currentY: startY }
	}));
}

export function updateSelectionBox(currentX: number, currentY: number) {
	canvasState.update((state) => {
		if (!state.selectionBox) return state;
		return {
			...state,
			selectionBox: { ...state.selectionBox, currentX, currentY }
		};
	});
}

export function endSelectionBox(): string[] {
	const state = get(canvasState);
	if (!state.selectionBox) return [];

	const { startX, startY, currentX, currentY } = state.selectionBox;
	const minX = Math.min(startX, currentX);
	const maxX = Math.max(startX, currentX);
	const minY = Math.min(startY, currentY);
	const maxY = Math.max(startY, currentY);

	// Find all nodes within the selection box
	const selectedIds: string[] = [];
	for (const node of state.nodes) {
		const nodeRight = node.position.x + NODE_WIDTH;
		const nodeBottom = node.position.y + NODE_HEIGHT;

		// Check if node overlaps with selection box
		if (
			node.position.x < maxX &&
			nodeRight > minX &&
			node.position.y < maxY &&
			nodeBottom > minY
		) {
			selectedIds.push(node.id);
		}
	}

	canvasState.update((s) => ({
		...s,
		selectionBox: null,
		selectedNodeIds: selectedIds,
		selectedNodeId: selectedIds.length === 1 ? selectedIds[0] : null,
		selectedConnectionId: null
	}));

	return selectedIds;
}

export function cancelSelectionBox() {
	canvasState.update((state) => ({
		...state,
		selectionBox: null
	}));
}

/**
 * Reset all transient state (used when navigating away or on page mount)
 * This clears: dragging connections, cutting lines, selection boxes, and selections
 * but preserves nodes, connections, zoom, and pan
 */
export function resetTransientState() {
	canvasState.update((state) => ({
		...state,
		draggingConnection: null,
		cuttingLine: null,
		selectionBox: null,
		selectedNodeId: null,
		selectedNodeIds: [],
		selectedConnectionId: null
	}));
}

// Snap to grid functions
export function toggleSnapToGrid() {
	canvasState.update((state) => ({
		...state,
		snapToGrid: !state.snapToGrid
	}));
}

export function setGridSize(size: number) {
	canvasState.update((state) => ({
		...state,
		gridSize: Math.max(8, Math.min(64, size))
	}));
}

export function snapPosition(x: number, y: number): { x: number; y: number } {
	const state = get(canvasState);
	if (!state.snapToGrid) return { x, y };

	const { gridSize } = state;
	return {
		x: Math.round(x / gridSize) * gridSize,
		y: Math.round(y / gridSize) * gridSize
	};
}

/**
 * Auto-layout: arrange nodes in a grid grouped by category
 */
export function autoLayout(
	canvasWidth: number,
	canvasHeight: number,
	mode: 'grid' | 'horizontal' | 'vertical' | 'category' = 'category'
) {
	const state = get(canvasState);
	if (state.nodes.length === 0) return;

	pushHistory();

	const NODE_WIDTH = 224;
	const NODE_HEIGHT = 96;
	const GAP_X = 48;
	const GAP_Y = 36;
	const PADDING = 50;
	const { gridSize } = state;

	let newNodes: CanvasNode[];

	switch (mode) {
		case 'grid': {
			// Simple grid layout
			const cols = Math.ceil(Math.sqrt(state.nodes.length));
			newNodes = state.nodes.map((node, i) => {
				const col = i % cols;
				const row = Math.floor(i / cols);
				return {
					...node,
					position: snapPosition(
						PADDING + col * (NODE_WIDTH + GAP_X),
						PADDING + row * (NODE_HEIGHT + GAP_Y)
					)
				};
			});
			break;
		}

		case 'horizontal': {
			// Single row
			newNodes = state.nodes.map((node, i) => ({
				...node,
				position: snapPosition(PADDING + i * (NODE_WIDTH + GAP_X), PADDING)
			}));
			break;
		}

		case 'vertical': {
			// Single column
			newNodes = state.nodes.map((node, i) => ({
				...node,
				position: snapPosition(PADDING, PADDING + i * (NODE_HEIGHT + GAP_Y))
			}));
			break;
		}

		case 'category':
		default: {
			// Group by category, arrange in columns
			const nodesByCategory = new Map<string, CanvasNode[]>();
			for (const node of state.nodes) {
				const cat = node.skill.category || 'other';
				if (!nodesByCategory.has(cat)) {
					nodesByCategory.set(cat, []);
				}
				nodesByCategory.get(cat)!.push(node);
			}

			const categories = Array.from(nodesByCategory.keys()).sort();
			const nodeMap = new Map<string, { x: number; y: number }>();

			let colX = PADDING;
			for (const category of categories) {
				const catNodes = nodesByCategory.get(category)!;
				let rowY = PADDING;

				for (const node of catNodes) {
					nodeMap.set(node.id, snapPosition(colX, rowY));
					rowY += NODE_HEIGHT + GAP_Y;
				}

				colX += NODE_WIDTH + GAP_X * 2;
			}

			newNodes = state.nodes.map((node) => ({
				...node,
				position: nodeMap.get(node.id) || node.position
			}));
			break;
		}
	}

	canvasState.update((s) => ({
		...s,
		nodes: newNodes
	}));
}

export function clearCanvas() {
	pushHistory();

	canvasState.set(initialState);
	nodeIdCounter = 0;
}

export function getNode(nodeId: string): CanvasNode | undefined {
	return get(canvasState).nodes.find((n) => n.id === nodeId);
}

export function getNodeConnections(nodeId: string): Connection[] {
	return get(canvasState).connections.filter(
		(c) => c.sourceNodeId === nodeId || c.targetNodeId === nodeId
	);
}

export function updateNodeStatus(nodeId: string, status: CanvasNode['status']) {
	canvasState.update((state) => ({
		...state,
		nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, status } : n))
	}));
}

export function resetAllNodeStatus() {
	canvasState.update((state) => ({
		...state,
		nodes: state.nodes.map((n) => ({ ...n, status: 'idle' as const }))
	}));
}

// Persistence functions

interface SavedCanvasState {
	version?: number;
	nodes: CanvasNode[];
	connections: Connection[];
	zoom: number;
	pan: { x: number; y: number };
	savedAt: string;
}

/**
 * Save canvas state to localStorage
 */
export function saveCanvas(): boolean {
	if (!browser) return false;

	try {
		const state = get(canvasState);
		const saveData: SavedCanvasState = {
			nodes: state.nodes,
			connections: state.connections,
			zoom: state.zoom,
			pan: state.pan,
			savedAt: new Date().toISOString()
		};

		localStorage.setItem(STORAGE_KEY, JSON.stringify(saveData));
		return true;
	} catch (e) {
		console.error('Failed to save canvas:', e);
		return false;
	}
}

/**
 * Load canvas state from localStorage
 */
export function loadCanvas(): boolean {
	if (!browser) return false;

	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (!saved) return false;

		// SECURITY: Validate JSON with Zod schema
		const saveData = safeJsonParse(saved, CanvasStoreSavedStateSchema, 'canvas-state');
		if (!saveData) {
			console.warn('[Canvas] Invalid saved state, skipping load');
			return false;
		}

		// Reset node counter based on loaded nodes
		const maxId = saveData.nodes.reduce((max, node) => {
			const match = node.id.match(/node-(\d+)-/);
			if (match) {
				return Math.max(max, parseInt(match[1], 10));
			}
			return max;
		}, 0);
		nodeIdCounter = maxId;

		canvasState.set({
			// Cast through unknown to CanvasNode[] since we've validated the structure with Zod
			// The schema validates the core structure; runtime may have additional properties
			nodes: saveData.nodes.map((n) => ({ ...n, status: 'idle' as const })) as unknown as CanvasNode[],
			connections: saveData.connections as unknown as Connection[] || [],
			selectedNodeId: null,
			selectedNodeIds: [],
			selectedConnectionId: null,
			zoom: saveData.zoom || 1,
			pan: saveData.pan || { x: 0, y: 0 },
			draggingConnection: null,
			cuttingLine: null,
			selectionBox: null,
			snapToGrid: true,
			gridSize: 24
		});

		return true;
	} catch (e) {
		console.error('Failed to load canvas:', e);
		return false;
	}
}

/**
 * Check if there's saved canvas state
 */
export function hasSavedCanvas(): boolean {
	if (!browser) return false;

	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		return saved !== null;
	} catch {
		return false;
	}
}

/**
 * Get the saved canvas timestamp
 */
export function getSavedCanvasInfo(): { savedAt: Date; nodeCount: number } | null {
	if (!browser) return null;

	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (!saved) return null;

		// SECURITY: Validate JSON with Zod schema
		const saveData = safeJsonParse(saved, CanvasStoreSavedStateSchema, 'canvas-info');
		if (!saveData) return null;

		return {
			savedAt: new Date(saveData.savedAt || ''),
			nodeCount: saveData.nodes?.length || 0
		};
	} catch {
		return null;
	}
}

/**
 * Delete saved canvas state
 */
export function deleteSavedCanvas(): void {
	if (!browser) return;

	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch (e) {
		console.error('Failed to delete saved canvas:', e);
	}
}

/**
 * Auto-save: Subscribe to changes and save
 */
let autoSaveTimeout: ReturnType<typeof setTimeout> | null = null;

export function enableAutoSave(debounceMs = 1000): () => void {
	const unsubscribe = canvasState.subscribe(() => {
		if (autoSaveTimeout) {
			clearTimeout(autoSaveTimeout);
		}

		autoSaveTimeout = setTimeout(() => {
			saveCanvas();
		}, debounceMs);
	});

	// Mirror canvas writes from sibling tabs so a second tab's view stays
	// current with the first. Skip while local edits are still pending so
	// we never reach into an in-progress drag/typing tab. Refresh otherwise.
	const onStorage = (event: StorageEvent) => {
		if (event.key !== STORAGE_KEY || event.newValue === null) return;
		if (autoSaveTimeout) return;
		loadCanvas();
	};
	if (browser) {
		window.addEventListener('storage', onStorage);
	}

	return () => {
		unsubscribe();
		if (browser) {
			window.removeEventListener('storage', onStorage);
		}
		if (autoSaveTimeout) {
			clearTimeout(autoSaveTimeout);
		}
	};
}

/**
 * Export canvas to JSON file (download)
 */
export function exportCanvasToFile(filename = 'canvas-export.json'): boolean {
	if (!browser) return false;

	try {
		const state = get(canvasState);
		const exportData: SavedCanvasState = {
			version: 1,
			savedAt: new Date().toISOString(),
			nodes: state.nodes,
			connections: state.connections,
			zoom: state.zoom,
			pan: state.pan
		};

		const json = JSON.stringify(exportData, null, 2);
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);

		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);

		return true;
	} catch (e) {
		console.error('Failed to export canvas:', e);
		return false;
	}
}

/**
 * Import canvas from JSON file
 */
export function importCanvasFromFile(file: File): Promise<boolean> {
	return new Promise((resolve) => {
		if (!browser) {
			resolve(false);
			return;
		}

		const reader = new FileReader();
		reader.onload = (e) => {
			try {
				const content = e.target?.result as string;

				// SECURITY: Validate JSON with Zod schema
				const importData = safeJsonParse(content, CanvasStoreSavedStateSchema, 'canvas-import');
				if (!importData) {
					console.error('Invalid canvas file: failed schema validation');
					resolve(false);
					return;
				}

				pushHistory();

				// Reset node counter based on imported nodes
				const maxId = importData.nodes.reduce((max, node) => {
					const match = node.id.match(/node-(\d+)-/);
					if (match) {
						return Math.max(max, parseInt(match[1], 10));
					}
					return max;
				}, 0);
				nodeIdCounter = maxId;

				canvasState.set({
					// Cast through unknown to CanvasNode[] since we've validated the structure with Zod
					// The schema validates the core structure; runtime may have additional properties
					nodes: importData.nodes.map((n) => ({ ...n, status: 'idle' as const })) as unknown as CanvasNode[],
					connections: importData.connections as unknown as Connection[] || [],
					selectedNodeId: null,
					selectedNodeIds: [],
					selectedConnectionId: null,
					zoom: importData.zoom || 1,
					pan: importData.pan || { x: 0, y: 0 },
					draggingConnection: null,
					cuttingLine: null,
					selectionBox: null,
					snapToGrid: true,
					gridSize: 24
				});

				resolve(true);
			} catch (err) {
				console.error('Failed to parse canvas file:', err);
				resolve(false);
			}
		};

		reader.onerror = () => {
			console.error('Failed to read file');
			resolve(false);
		};

		reader.readAsText(file);
	});
}

/**
 * Get canvas export data as JSON string (for clipboard, etc.)
 */
export function getCanvasExportData(): string {
	const state = get(canvasState);
	const exportData: SavedCanvasState = {
		version: 1,
		savedAt: new Date().toISOString(),
		nodes: state.nodes,
		connections: state.connections,
		zoom: state.zoom,
		pan: state.pan
	};
	return JSON.stringify(exportData, null, 2);
}
