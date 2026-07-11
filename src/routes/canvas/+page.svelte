<script lang="ts">
	import { logger } from '$lib/utils/logger';
	import DraggableNode from '$lib/components/nodes/DraggableNode.svelte';
	import SkillsPanel from '$lib/components/SkillsPanel.svelte';
	import BrandLogo from '$lib/components/BrandLogo.svelte';
	import ConnectionLine from '$lib/components/ConnectionLine.svelte';
	import ExecutionPanel from '$lib/components/ExecutionPanel.svelte';
	import ContextMenu from '$lib/components/ContextMenu.svelte';
	import Minimap from '$lib/components/Minimap.svelte';
	import NodeConfigPanel from '$lib/components/NodeConfigPanel.svelte';
	import { canvasState, nodes, connections, selectedNodeId, selectedNodeIds, selectedConnectionId, selectedNode, draggingConnection, cuttingLine, selectionBox, snapToGrid, gridSize, addNode, addConnection, addNodesWithConnections, selectNode, selectConnection, selectAllNodes, clearSelection, deleteSelected, duplicateSelected, copySelected, pasteFromClipboard, removeConnection, removeNode, setZoom, setPan, zoomToFit, frameSelected, clearCanvas, loadCanvas, enableAutoSave, deleteSavedCanvas, getSavedCanvasInfo, undo, redo, canUndo, canRedo, clearHistory, startConnectionCut, updateConnectionCut, endConnectionCut, cancelConnectionCut, startSelectionBox, updateSelectionBox, endSelectionBox, cancelSelectionBox, toggleSnapToGrid, snapPosition, autoLayout, endConnectionDrag, resetTransientState, updateNodeStatus } from '$lib/stores/canvas.svelte';
import { get } from 'svelte/store';
	import type { CuttingLine, CanvasNode, Connection, DraggingConnection, SelectionBox } from '$lib/stores/canvas.svelte';
	import { onMount, tick } from 'svelte';
	import { goto, beforeNavigate, afterNavigate } from '$app/navigation';
	import { type Skill, getSkillById } from '$lib/stores/skills.svelte';
	import { validateForMission, buildMissionFromCanvas } from '$lib/services/mission-builder';
	import { mcpState } from '$lib/stores/mcp.svelte';
	import { reconnectAll as reconnectMCPs, connectedInstances } from '$lib/stores/mcps.svelte';
	import { getGoalState, hasPendingGoal, clearGoal } from '$lib/stores/project-goal.svelte';
	import { generatePipeline } from '$lib/services/smart-pipeline';
	import { initCanvasSync } from '$lib/services/canvas-sync';
	import PipelineSelector from '$lib/components/PipelineSelector.svelte';
	import SessionStateBar from '$lib/components/SessionStateBar.svelte';
	import { initPipelines, saveCurrentPipeline, getActivePipelineData, ensurePipeline, switchPipeline, activePipelineId as activePipelineIdStore, activePipeline as activePipelineStore, pipelines as pipelinesStore, type PipelineData } from '$lib/stores/pipelines.svelte';
	import { hasResumableMission } from '$lib/services/persistence';
	import { DroppedSkillSchema, safeJsonParse } from '$lib/types/schemas';
	import { getLatestPipelineLoad, getPendingLoad, type PendingPipelineLoad } from '$lib/services/pipeline-loader';
	import { getCanvasExecutionAction } from '$lib/services/canvas-execution-action';
	import {
		buildCanvasMissionHistoryCanvas,
		buildCanvasMissionHistoryPlaceholder,
		buildCanvasMissionStatusUpdates,
		findMissionControlBoardEntryForCanvas
	} from '$lib/services/canvas-mission-status';
	import {
		getPipelineLoadKey,
		readablePipelineNameFromId,
		shouldAutoApplyLatestLoad as shouldAutoApplyPipelineLoad
	} from '$lib/services/canvas-pipeline-load-rules';
	import { loadSkills, skills as skillsStore } from '$lib/stores/skills.svelte';
	import { workflowTemplates } from '$lib/data/templates';
	import type { SparkAgentCanvasSnapshot } from '$lib/services/spark-agent-bridge';
	import type { MissionControlBoardEntry } from '$lib/types/mission-control';

	let showExecution = $state(false);
	let executionMinimized = $state(false);
	let executionAutoRunToken = $state<number | null>(null);
	let executionPanelKey = $state('manual');
	let executionAuthority = $state<unknown | null>(null);
	let executionRelay = $state<{
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
	} | null>(null);
	let showNodeDetails = $state(false);
	let showMissionExport = $state(false);
	let missionName = $state('');
	let missionDescription = $state('');
	let missionExporting = $state(false);
	let missionExportError = $state<string | null>(null);
	let lastCanvasMissionStatusSyncKey = $state<string | null>(null);
	let isMcpConnected = $state(false);
	let mcpConnectedCount = $state(0);
	let canvasEl = $state<HTMLDivElement>();
	let lastSaved = $state<Date | null>(null);

	function missionHistoryRelay(missionId: string, goal?: string | null) {
		const cleanGoal = goal?.trim();
		return {
			missionId,
			...(cleanGoal ? { goal: cleanGoal } : {}),
			autoRun: false
		};
	}

	// Context menu state
	let contextMenu = $state<{ x: number; y: number; type: 'node' | 'connection' | 'canvas'; targetId?: string } | null>(null);

	// Confirmation modal state
	let showClearConfirm = $state(false);

	// Goal processing state
	let goalProcessing = $state(false);
	let goalProcessingMessage = $state('');
	let goalProcessingError = $state<string | null>(null);
	let goalSummary = $state<string | null>(null);

	// Fix 1 & 3: Track mount state to ensure goal processing waits for full initialization
	let isMounted = $state(false);
	let pendingGoalProcess = $state(false);
	let lastSparkAgentSyncAt: string | null = null;
	let isApplyingSparkAgentUpdate = false;
	let sparkPipelineActive = false;
	const APPLIED_PIPELINE_LOAD_PREFIX = 'spawner:canvas:applied-load:';

	type SparkAgentCanvasSkillNode = {
		id: string;
		skillId: string;
		skillName: string;
		description: string;
		position: { x: number; y: number };
		tags?: string[];
		skills?: string[];
		skillChain?: string[];
		skill?: {
			tags?: string[];
			skills?: string[];
			skillChain?: string[];
		};
	};

	type SparkAgentCanvasLink = {
		id: string;
		sourceNodeId: string;
		targetNodeId: string;
	};

	// Force sync local state from stores
	// This ensures local variables are in sync after async operations
	function forceStoreSync() {
		const state = get(canvasState);
		zoom = state.zoom;
		pan = state.pan;
		currentNodes = get(nodes);
		currentConnections = get(connections);
		currentSelectedNodeId = get(selectedNodeId);
		currentSelectedNodeIds = get(selectedNodeIds);
		currentSelectedConnectionId = get(selectedConnectionId);
		currentSelectedNode = get(selectedNode);
		currentDraggingConnection = get(draggingConnection);
		currentCuttingLine = get(cuttingLine);
		currentSelectionBox = get(selectionBox);
		currentSnapToGrid = get(snapToGrid);
		currentGridSize = get(gridSize);
		currentCanUndo = get(canUndo);
		currentCanRedo = get(canRedo);
	}

	// Clean up when navigating away from the canvas page
	beforeNavigate(() => {
		// Reset all transient state before leaving
		resetTransientState();
		// Reset local states
		isPanning = false;
		isCutting = false;
		isSelecting = false;
	});

	// Reset state when arriving at canvas page (handles client-side navigation)
	afterNavigate(() => {
		// Reset transient state after navigation completes
		resetTransientState();
		isPanning = false;
		isCutting = false;
		isSelecting = false;

		// Fix 6: Force sync local state from stores after navigation
		forceStoreSync();

		// Note: pendingGoalProcess is now set in onMount when a goal is detected
		// This ensures a new pipeline is created BEFORE loading old data
	});

	/**
	 * Process pending goal using new atomic pipeline generation
	 *
	 * KISS principle: Simple, reliable, atomic.
	 * Uses smart-pipeline.ts to generate complete pipeline, then loads it atomically.
	 */
	async function processGoalIfPending() {
		if (!pendingGoalProcess || !isMounted) return;

		pendingGoalProcess = false;
		const goalState = getGoalState();

		if (!goalState.input) {
			clearGoal();
			return;
		}

		goalProcessing = true;
		goalProcessingMessage = 'Analyzing your project with AI...';
		goalProcessingError = null;

		try {
			// Generate pipeline atomically using smart-pipeline
			const result = await generatePipeline(goalState.input);

			if (!result.success || !result.pipeline) {
				goalProcessingError = result.error || 'Failed to generate pipeline';
				return;
			}

			const { pipeline } = result;

			// Create nodes with proper IDs, keeping track of skill-to-node mapping
			const skillToNodeId = new Map<string, string>();
			const canvasNodes = pipeline.nodes.map(node => {
				const nodeId = `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
				skillToNodeId.set(node.skillId, nodeId);
				return {
					id: nodeId,
					skillId: node.skillId,
					skill: node.skill,
					position: node.position,
					status: 'idle' as const
				};
			});

			// Convert pipeline connections to canvas connections
			const canvasConnections = pipeline.connections
				.map(conn => {
					const sourceNodeId = skillToNodeId.get(conn.sourceId);
					const targetNodeId = skillToNodeId.get(conn.targetId);
					if (!sourceNodeId || !targetNodeId) return null;
					return {
						id: `conn-${crypto.randomUUID()}`,
						sourceNodeId,
						sourcePortId: conn.sourcePort,
						targetNodeId,
						targetPortId: conn.targetPort
					};
				})
				.filter((c): c is NonNullable<typeof c> => c !== null);

			// Load pipeline atomically - one state update, no intermediate states
			canvasState.update(state => ({
				...state,
				nodes: canvasNodes,
				connections: canvasConnections,
				zoom: 1,
				pan: { x: 0, y: 0 }
			}));

			goalSummary = pipeline.summary;
			goalProcessingMessage = `Added ${pipeline.nodes.length} skills`;

			// CRITICAL: Sync local state from stores after atomic update
			// Without this, local variables are stale and canvas becomes unresponsive
			await tick();
			forceStoreSync();

			// Reset all interaction states to ensure clean canvas
			isPanning = false;
			isCutting = false;
			isSelecting = false;
			resetTransientState();

			// Zoom to fit after DOM update
			await tick();
			if (canvasEl) {
				const rect = canvasEl.getBoundingClientRect();
				zoomToFit(rect.width, rect.height);
			}

		} catch (error) {
			console.error('[Canvas] Goal processing error:', error);
			goalProcessingError = error instanceof Error ? error.message : 'An error occurred';
		} finally {
			goalProcessing = false;
			// Final state sync to ensure everything is clean
			forceStoreSync();
			resetTransientState();
			clearGoal();
		}
	}

	// Watch for when both mount is complete and there's a pending goal
	$effect(() => {
		if (isMounted && pendingGoalProcess) {
			processGoalIfPending();
		}
	});

	function resolveSparkAgentSkill(node: SparkAgentCanvasSkillNode): Skill {
		const availableSkills = get(skillsStore);
		const nestedSkill = node.skill;
		const incomingSkillChain = node.skillChain?.length
			? node.skillChain
			: nestedSkill?.skillChain?.length
				? nestedSkill.skillChain
			: node.skills?.length
				? node.skills
				: nestedSkill?.skills?.length
					? nestedSkill.skills
				: [];
		const incomingTags = node.tags?.length ? node.tags : nestedSkill?.tags || [];
		const existing =
			availableSkills.find((skill) => skill.id === node.skillId) ||
			availableSkills.find((skill) => skill.name === node.skillName);
		if (existing) {
			return {
				...existing,
				tags: incomingTags.length > 0 ? incomingTags : existing.tags,
				skillChain: incomingSkillChain.length > 0 ? incomingSkillChain : existing.skillChain
			};
		}

		return {
			id: node.skillId,
			name: node.skillName || node.skillId,
			description: node.description || `Spark skill ${node.skillName || node.skillId}`,
			category: 'development',
			tier: 'free',
			tags: incomingTags.length > 0 ? incomingTags : incomingSkillChain,
			triggers: [],
			handoffs: [],
			pairsWell: [],
			skillChain: incomingSkillChain.length > 0 ? incomingSkillChain : undefined
		};
	}

	async function applySparkAgentSnapshot(snapshot: SparkAgentCanvasSnapshot): Promise<void> {
		if (isApplyingSparkAgentUpdate) return;
		isApplyingSparkAgentUpdate = true;

		try {
			const incomingNodes = snapshot.nodes as SparkAgentCanvasSkillNode[];
			const incomingConnections = snapshot.connections as SparkAgentCanvasLink[];
			const nodeIds = new Set(incomingNodes.map((node) => node.id));

			const canvasNodes: CanvasNode[] = incomingNodes.map((node) => ({
				id: node.id,
				skillId: node.skillId,
				skill: resolveSparkAgentSkill(node),
				position: node.position,
				status: 'idle'
			}));

			const canvasConnections: Connection[] = incomingConnections
				.filter((connection) => nodeIds.has(connection.sourceNodeId) && nodeIds.has(connection.targetNodeId))
				.map((connection) => ({
					id: connection.id,
					sourceNodeId: connection.sourceNodeId,
					sourcePortId: 'output',
					targetNodeId: connection.targetNodeId,
					targetPortId: 'input'
				}));

			ensurePipeline(snapshot.pipelineId, snapshot.pipelineName);
			canvasState.update((state) => ({
				...state,
				nodes: canvasNodes,
				connections: canvasConnections,
				selectedNodeId: null,
				selectedNodeIds: [],
				selectedConnectionId: null
			}));

			saveCurrentPipeline({
				nodes: canvasNodes,
				connections: canvasConnections,
				zoom: get(canvasState).zoom,
				pan: get(canvasState).pan
			});
			lastSaved = new Date();
			clearHistory();
			await tick();
			forceStoreSync();
		} finally {
			isApplyingSparkAgentUpdate = false;
		}
	}

	async function syncSparkAgentCanvasState(sessionId: string | null): Promise<void> {
		if (!sessionId) return;
		if (goalProcessing) return;
		if (sparkPipelineActive) return;

		const params = new URLSearchParams({ sessionId });
		if (lastSparkAgentSyncAt) params.set('since', lastSparkAgentSyncAt);
		const query = `?${params.toString()}`;
		const response = await fetch(`/api/spark-agent/canvas-state${query}`);
		if (!response.ok) return;

		const payload = (await response.json()) as {
			hasUpdate?: boolean;
			snapshot?: SparkAgentCanvasSnapshot | null;
		};

		if (!payload?.hasUpdate || !payload.snapshot) return;
		lastSparkAgentSyncAt = payload.snapshot.updatedAt;
		await applySparkAgentSnapshot(payload.snapshot);
	}

	async function syncCanvasMissionStatusesFromBoard(missionId?: string | null): Promise<void> {
		const nodeSnapshot = get(nodes);
		if (nodeSnapshot.length === 0) return;

		const response = await fetch('/api/mission-control/board');
		if (!response.ok) return;

		const data = await response.json();
		const board = data?.board as Record<string, MissionControlBoardEntry[]> | undefined;
		const activePipeline = get(activePipelineStore);
		const boardEntry = findMissionControlBoardEntryForCanvas(board, {
			missionId: missionId || executionRelay?.missionId || null,
			pipelineId: get(activePipelineIdStore),
			pipelineName: activePipeline?.name || null
		});

		if (!boardEntry?.tasks?.length) return;
		if (
			boardEntry.missionId &&
			(executionRelay?.missionId !== boardEntry.missionId || (!executionRelay?.goal && boardEntry.missionName))
		) {
			executionAuthority = null;
			executionRelay = {
				...(executionRelay || {}),
				missionId: boardEntry.missionId,
				...(boardEntry.missionName ? { goal: boardEntry.missionName } : {}),
				autoRun: false
			};
		}

		const updates = buildCanvasMissionStatusUpdates(nodeSnapshot, boardEntry.tasks);
		if (updates.length === 0) return;

		const syncKey = `${boardEntry.missionId}:${boardEntry.lastUpdated}:${updates
			.map((update) => `${update.nodeId}:${update.status}`)
			.join('|')}`;
		if (syncKey === lastCanvasMissionStatusSyncKey) return;

		for (const update of updates) {
			updateNodeStatus(update.nodeId, update.status);
		}
		lastCanvasMissionStatusSyncKey = syncKey;
		forceStoreSync();
		saveCurrentPipelineData();
	}

	onMount(() => {
		// Reset all transient store state first (handles client-side navigation)
		resetTransientState();
		// Reset local states
		isPanning = false;
		isCutting = false;
		isSelecting = false;

		// Initialize pipeline system
		initPipelines();
		sparkPipelineActive = (get(activePipelineIdStore) || '').startsWith('prd-tg-build');
		let disposed = false;
		let disableAutoSave: (() => void) | null = null;
		let pipelineAutoSaveInterval: ReturnType<typeof setInterval> | null = null;
		let cleanupCanvasSync: (() => void) | null = null;
		let stuckStateInterval: ReturnType<typeof setInterval> | null = null;
		let sparkAgentSyncInterval: ReturnType<typeof setInterval> | null = null;
		let pendingLoadPollInterval: ReturnType<typeof setInterval> | null = null;
		let canvasMissionStatusPollInterval: ReturnType<typeof setInterval> | null = null;
		let resizeObserver: ResizeObserver | null = null;

		// Global mouseup handler to reset stuck states (catches mouseup outside canvas)
		function handleGlobalMouseUp() {
			if (isPanning || isCutting || isSelecting) {
				handleMouseUp();
			}
		}

		// Builder panel requests to frame newly added nodes
		function handleBuilderFrameSelected() {
			if (canvasEl) {
				const rect = canvasEl.getBoundingClientRect();
				frameSelected(rect.width, rect.height);
			}
		}

		let lastAppliedLatestLoadKey: string | null = null;

		function getAppliedPipelineLoadKey(load: PendingPipelineLoad): string | null {
			if (typeof sessionStorage === 'undefined') return null;
			return sessionStorage.getItem(`${APPLIED_PIPELINE_LOAD_PREFIX}${load.pipelineId}`);
		}

		function markAppliedPipelineLoad(load: PendingPipelineLoad): void {
			if (typeof sessionStorage === 'undefined') return;
			sessionStorage.setItem(`${APPLIED_PIPELINE_LOAD_PREFIX}${load.pipelineId}`, getPipelineLoadKey(load));
		}

		function shouldAutoApplyLatestLoad(load: PendingPipelineLoad, requestedPipelineId: string | null = null): boolean {
			return shouldAutoApplyPipelineLoad({
				load,
				disposed,
				requestedPipelineId,
				lastAppliedLatestLoadKey,
				appliedPipelineLoadKey: getAppliedPipelineLoadKey(load),
				activePipelineId: get(activePipelineIdStore),
				currentNodes: get(nodes)
			});
		}

		function applyPipelineLoad(load: PendingPipelineLoad, reason: 'queued' | 'latest-recovery' | 'latest-sync'): boolean {
			if (disposed) return false;
			const loadKey = getPipelineLoadKey(load);
			const activeId = get(activePipelineIdStore);
			if (
				(loadKey === lastAppliedLatestLoadKey || loadKey === getAppliedPipelineLoadKey(load)) &&
				activeId === load.pipelineId &&
				get(nodes).length > 0
			) {
				return false;
			}

			// PENDING LOAD: PRD analysis or goal processing queued a pipeline
			logger.info(`[Canvas] Loading ${reason} pipeline:`, load.pipelineName);
			logger.info('[Canvas] Source:', load.source, '| Nodes:', load.nodes.length, '| Connections:', load.connections.length);

			// Ensure the exact queued pipeline ID exists and is active
			const targetPipeline = ensurePipeline(load.pipelineId, load.pipelineName);

			// Clear and load the exact nodes/connections
			clearCanvas();
			if (load.nodes.length > 0) {
				addNodesWithConnections(load.nodes, load.connections);
			}
			executionAuthority = load.executionAuthority ?? null;
			executionRelay = load.relay || null;
			sparkPipelineActive = load.source === 'prd-bridge' || load.source === 'creator-mission';

			// Save immediately
			saveCurrentPipeline({
				nodes: get(nodes),
				connections: get(connections),
				zoom: 1,
				pan: { x: 0, y: 0 }
			});

			lastSaved = new Date();
			logger.info(
				'[Canvas] Loaded pipeline:',
				targetPipeline.name,
				`(${targetPipeline.id})`,
				'with',
				get(nodes).length,
				'nodes and',
				get(connections).length,
				'connections'
			);
			forceStoreSync();
			void syncCanvasMissionStatusesFromBoard(load.relay?.missionId || null).catch((error) => {
				console.warn('[Canvas] Mission status sync failed after pipeline load:', error);
			});
			if (
				(load.autoRun || load.relay?.autoRun) &&
				executionAuthority &&
				new URL(window.location.href).searchParams.get('noexec') !== '1'
			) {
				executionPanelKey = `${load.pipelineId}:${load.timestamp || Date.now()}`;
				showExecution = true;
				executionMinimized = false;
				executionAutoRunToken = Date.now();
			} else if ((load.autoRun || load.relay?.autoRun) && !executionAuthority) {
				logger.info('[Canvas] Stored auto-run load opened in inspect mode; no live execution authority was present.');
			}
			lastAppliedLatestLoadKey = loadKey;
			markAppliedPipelineLoad(load);
			return true;
		}

		function loadExplicitPipelineFromUrl(url: URL): boolean {
			const pipelineId = url.searchParams.get('pipeline')?.trim();
			if (!pipelineId) return false;
			const missionId = url.searchParams.get('mission')?.trim();

			if (!get(pipelinesStore).some((pipeline) => pipeline.id === pipelineId)) {
				logger.info('[Canvas] Requested pipeline is not in local storage yet; waiting for archived load:', pipelineId);
				return false;
			}

			const data = switchPipeline(pipelineId);
			if (!data) {
				console.warn('[Canvas] Requested pipeline not found:', pipelineId);
				return false;
			}
			if (
				missionId &&
				pipelineId.startsWith('mission-history-') &&
				(!Array.isArray(data.nodes) || data.nodes.length === 0)
			) {
				return false;
			}

			loadPipelineToCanvas(data);
			lastSaved = new Date();
			sparkPipelineActive = pipelineId.startsWith('prd-');
			if (missionId) {
				executionAuthority = null;
				executionRelay = missionHistoryRelay(missionId, readablePipelineNameFromId(pipelineId));
				if (url.searchParams.get('noexec') !== '1') {
					executionPanelKey = `${pipelineId}:${missionId}:history`;
					showExecution = true;
					executionMinimized = false;
				}
			}
			logger.info('[Canvas] Loaded explicit pipeline from URL:', pipelineId);
			return true;
		}

		function holdRequestedPipelineWhileWaiting(pipelineId: string): boolean {
			if (!pipelineId) return false;
			const metadata = ensurePipeline(pipelineId, readablePipelineNameFromId(pipelineId));
			const data = switchPipeline(pipelineId) || {
				nodes: [],
				connections: [],
				zoom: 1,
				pan: { x: 0, y: 0 }
			};
			loadPipelineToCanvas(data);
			lastSaved = new Date();
			sparkPipelineActive = pipelineId.startsWith('prd-');
			logger.info('[Canvas] Waiting for requested pipeline load:', metadata.id);
			return true;
		}

		function holdRequestedMissionWhileWaiting(missionId: string, suppressExec: boolean): boolean {
			const pipelineId = `mission-history-${missionId}`;
			ensurePipeline(pipelineId, `Mission ${missionId}`);
			const missionCanvas = buildCanvasMissionHistoryPlaceholder(missionId);
			loadPipelineToCanvas(missionCanvas);
			saveCurrentPipeline(missionCanvas);
			lastSaved = new Date();
			sparkPipelineActive = false;
			executionAuthority = null;
			executionRelay = missionHistoryRelay(missionId, `Mission ${missionId}`);
			if (!suppressExec) {
				executionPanelKey = `${pipelineId}:${missionId}:history`;
				showExecution = true;
				executionMinimized = false;
			}
			logger.info('[Canvas] Holding mission-scoped canvas while waiting for Mission Control:', missionId);
			return true;
		}

		async function consumePendingLoadFromQueue(requestedPipelineId: string | null = null): Promise<boolean> {
			const pendingLoad = await getPendingLoad(requestedPipelineId);
			if (disposed || !pendingLoad) return false;
			return applyPipelineLoad(pendingLoad, 'queued');
		}

		async function syncLatestSparkLoad(requestedPipelineId: string | null = null): Promise<boolean> {
			const latestLoad = await getLatestPipelineLoad(requestedPipelineId);
			if (disposed || !latestLoad || !shouldAutoApplyLatestLoad(latestLoad, requestedPipelineId)) return false;
			logger.info('[Canvas] Syncing latest Spark pipeline load:', latestLoad.pipelineName);
			return applyPipelineLoad(latestLoad, 'latest-sync');
		}

		async function loadMissionOnlyCanvasFromBoard(missionId: string | null, suppressExec: boolean): Promise<boolean> {
			if (!missionId) return false;
			const response = await fetch('/api/mission-control/board');
			if (!response.ok) return false;

			const data = await response.json();
			const board = data?.board as Record<string, MissionControlBoardEntry[]> | undefined;
			const boardEntry = findMissionControlBoardEntryForCanvas(board, { missionId });
			if (!boardEntry) return false;

			const pipelineId = `mission-history-${missionId}`;
			ensurePipeline(pipelineId, boardEntry.missionName || missionId);
			const missionCanvas = buildCanvasMissionHistoryCanvas(boardEntry);
			loadPipelineToCanvas(missionCanvas);
			saveCurrentPipeline(missionCanvas);
			lastSaved = new Date();
			sparkPipelineActive = false;
			executionAuthority = null;
			executionRelay = missionHistoryRelay(missionId, boardEntry.missionName || missionId);
			if (!suppressExec) {
				executionPanelKey = `${pipelineId}:${missionId}:history`;
				showExecution = true;
				executionMinimized = false;
			}
			logger.info('[Canvas] Loaded mission-only canvas from Mission Control:', missionId);
			return true;
		}

		void (async () => {
		try {
			await loadSkills();
			if (disposed) return;

			// Reconnect any previously-connected MCPs so tools are available for missions
			reconnectMCPs().catch((e) => console.warn('[Canvas] MCP reconnect error:', e));

		// Auto-show execution panel if there's an active/resumable mission
		// (suppressed via ?noexec=1 query for landing-page screenshot capture)
		const url = new URL(window.location.href);
		const suppressExec = url.searchParams.get('noexec') === '1';
		const requestedPipelineId = url.searchParams.get('pipeline')?.trim() || null;
		const requestedMissionId = url.searchParams.get('mission')?.trim() || null;
		const requestedSparkAgentSessionId =
			url.searchParams.get('sparkAgentSessionId')?.trim() ||
			url.searchParams.get('sparkAgentSession')?.trim() ||
			null;
		const loadedExplicitPipeline = loadExplicitPipelineFromUrl(url);
		const loadedMissionOnlyCanvas =
			!loadedExplicitPipeline && requestedMissionId && (!requestedPipelineId || requestedPipelineId.startsWith('mission-history-'))
				? await loadMissionOnlyCanvasFromBoard(requestedMissionId, suppressExec)
				: false;
		const hasResumable = hasResumableMission();
		logger.info('[Canvas] hasResumableMission:', hasResumable);
		if (hasResumable && !suppressExec) {
			showExecution = true;
			logger.info('[Canvas] Auto-showing execution panel');
		}

		// =====================================================================
		// SINGLE LOADING PATH - No more race conditions!
		// =====================================================================
		// Priority: 1. Pending load (from PRD/goal) → 2. Active pipeline
		// =====================================================================

		const consumedPendingLoad =
			loadedExplicitPipeline || loadedMissionOnlyCanvas
				? false
				: await consumePendingLoadFromQueue(requestedPipelineId);
		if (disposed) return;

		if (!loadedExplicitPipeline && !loadedMissionOnlyCanvas && !consumedPendingLoad) {
			// NO PENDING LOAD: Load active pipeline from localStorage
			const latestSynced = await syncLatestSparkLoad(requestedPipelineId);
			if (disposed) return;
			if (latestSynced) {
				// Latest Spark load wins when another tab/client already consumed
				// the one-shot pending queue before this visible canvas tab.
			} else if (requestedPipelineId) {
				// A mission-specific canvas link must not show whatever project
				// happened to be active locally while its PRD analysis is still
				// pending. Hold the requested pipeline id and keep polling for its
				// matching load instead.
				holdRequestedPipelineWhileWaiting(requestedPipelineId);
			} else if (requestedMissionId) {
				// A mission-scoped history link must never fall back to the
				// locally active canvas. Hold a mission placeholder instead.
				holdRequestedMissionWhileWaiting(requestedMissionId, suppressExec);
			} else {
				const pipelineData = getActivePipelineData();
				if (pipelineData && pipelineData.nodes?.length > 0) {
					loadPipelineToCanvas(pipelineData);
					lastSaved = new Date();
					logger.info('[Canvas] Loaded active pipeline with', pipelineData.nodes?.length || 0, 'nodes');
				} else {
					const latestLoad = await getLatestPipelineLoad(requestedPipelineId);
					if (latestLoad?.nodes?.length && shouldAutoApplyLatestLoad(latestLoad, requestedPipelineId)) {
						logger.info('[Canvas] Active pipeline is empty; recovering latest Spark pipeline load');
						applyPipelineLoad(latestLoad, 'latest-recovery');
					} else if (pipelineData) {
						loadPipelineToCanvas(pipelineData);
						lastSaved = new Date();
						logger.info('[Canvas] Loaded empty active pipeline');
					} else {
						// Fallback: try old format for migration
						const loaded = loadCanvas();
						if (loaded) {
							const info = getSavedCanvasInfo();
							if (info) {
								lastSaved = info.savedAt;
							}
						}
					}
				}
			}
		}

		// Initialize history with current state
		clearHistory();

		await syncCanvasMissionStatusesFromBoard(url.searchParams.get('mission')?.trim() || null).catch((error) => {
			console.warn('[Canvas] Initial mission status sync failed:', error);
		});

		// Enable auto-save with pipeline support
		disableAutoSave = enableAutoSave(1000);

		// Set up pipeline auto-save (syncs to pipeline storage)
		pipelineAutoSaveInterval = setInterval(() => {
			saveCurrentPipelineData();
		}, 2000);
		canvasMissionStatusPollInterval = setInterval(() => {
			void syncCanvasMissionStatusesFromBoard(url.searchParams.get('mission')?.trim() || null).catch((error) => {
				console.warn('[Canvas] Mission status sync poll failed:', error);
			});
		}, 3000);

		// Initialize canvas sync for Claude Code integration
		cleanupCanvasSync = initCanvasSync();

		// Keep /canvas in sync with external Spark agent command API updates
		await syncSparkAgentCanvasState(requestedSparkAgentSessionId).catch((error) => {
			console.warn('[Canvas] Initial Spark Agent sync failed:', error);
		});
		sparkAgentSyncInterval = setInterval(() => {
			void syncSparkAgentCanvasState(requestedSparkAgentSessionId).catch((error) => {
				console.warn('[Canvas] Spark Agent sync poll failed:', error);
			});
		}, 1200);
		pendingLoadPollInterval = setInterval(() => {
			void (async () => {
				const consumed = await consumePendingLoadFromQueue(requestedPipelineId);
				if (!consumed) {
					await syncLatestSparkLoad(requestedPipelineId);
				}
			})().catch((error) => {
				console.warn('[Canvas] Pending/latest load poll failed:', error);
			});
		}, 2500);

		window.addEventListener('mouseup', handleGlobalMouseUp);

		// FIX 15: Safety valve - detect and reset stuck interaction states
		// This runs periodically to catch any states that got stuck due to edge cases
		let lastInteractionCheck = Date.now();
		let wasInteracting = false;
		stuckStateInterval = setInterval(() => {
			const isInteracting = isPanning || isCutting || isSelecting || currentDraggingConnection !== null;
			const now = Date.now();

			if (isInteracting && wasInteracting) {
				// Been interacting for the whole interval - check if stuck
				const timeSinceCheck = now - lastInteractionCheck;
				if (timeSinceCheck > 3000) { // 3 seconds without mouseup = probably stuck
					console.warn('Resetting stuck canvas interaction states');
					isPanning = false;
					isCutting = false;
					isSelecting = false;
					resetTransientState();
					endConnectionDrag(); // Also reset any stuck connection drag
					forceStoreSync();
				}
			}

			if (isInteracting) {
				wasInteracting = true;
			} else {
				wasInteracting = false;
				lastInteractionCheck = now;
			}
		}, 1000);

		window.addEventListener('builder:frame-selected', handleBuilderFrameSelected);

		// Track canvas dimensions for minimap
		resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				canvasWidth = entry.contentRect.width;
				canvasHeight = entry.contentRect.height;
			}
		});

		// Use requestAnimationFrame to ensure canvasEl is bound after render
		requestAnimationFrame(() => {
			if (disposed || !resizeObserver) return;
			if (canvasEl) {
				resizeObserver.observe(canvasEl);
				// Get initial dimensions
				const rect = canvasEl.getBoundingClientRect();
				canvasWidth = rect.width;
				canvasHeight = rect.height;
			}
			// Fix 6: Force sync local state from stores after mount
			forceStoreSync();
			// Fix 3: Mark as fully mounted after all initialization is complete
			// This triggers goal processing if there's a pending goal
			isMounted = true;
		});
		} catch (mountError) {
			console.error('[Canvas] Mount initialization failed:', mountError);
		}
		})();

		return () => {
			disposed = true;
			// Fix 3: Mark as unmounted before cleanup
			isMounted = false;
			pendingGoalProcess = false;
			disableAutoSave?.();
			if (pipelineAutoSaveInterval) clearInterval(pipelineAutoSaveInterval);
			if (stuckStateInterval) clearInterval(stuckStateInterval); // FIX 15: Clean up stuck state detector
			if (sparkAgentSyncInterval) clearInterval(sparkAgentSyncInterval);
			if (pendingLoadPollInterval) clearInterval(pendingLoadPollInterval);
			if (canvasMissionStatusPollInterval) clearInterval(canvasMissionStatusPollInterval);
			cleanupCanvasSync?.();
			resizeObserver?.disconnect();
			window.removeEventListener('mouseup', handleGlobalMouseUp);
			window.removeEventListener('builder:frame-selected', handleBuilderFrameSelected);
			// Save current pipeline before unmount
			saveCurrentPipelineData();
			// Reset all transient state on unmount (catches HMR and other edge cases)
			resetTransientState();
			isPanning = false;
			isCutting = false;
			isSelecting = false;
		};
	});

	function handleMinimapPan(x: number, y: number) {
		setPan({ x, y });
	}

	function openExecutionFromToolbar() {
		const action = getCanvasExecutionAction({
			nodeCount: currentNodes.length,
			activePipelineId: get(activePipelineIdStore),
			relay: executionRelay,
			now: Date.now()
		});
		if (action.disabled) return;
		executionAutoRunToken = action.autoRunToken;
		executionPanelKey = action.panelKey;
		showExecution = true;
		executionMinimized = false;
	}

	function handleClear() {
		if (currentNodes.length > 0) {
			showClearConfirm = true;
			return;
		}
		clearCanvas();
		deleteSavedCanvas();
		lastSaved = null;
	}

	function confirmClear() {
		clearCanvas();
		deleteSavedCanvas();
		lastSaved = null;
		showClearConfirm = false;
	}

	function cancelClear() {
		showClearConfirm = false;
	}

	// Pipeline management functions
	function loadPipelineToCanvas(data: PipelineData) {
		// Clear current canvas first
		clearCanvas();

		// Set zoom and pan
		setZoom(data.zoom || 1);
		setPan(data.pan || { x: 0, y: 0 });

		// Add nodes
		if (data.nodes && data.nodes.length > 0) {
			// We need to restore the full node structure
			canvasState.update(state => ({
				...state,
				nodes: data.nodes,
				connections: data.connections || []
			}));
		}

		// Clear history after loading
		clearHistory();
		forceStoreSync();
	}

	function saveCurrentPipelineData() {
		const state = get(canvasState);
		saveCurrentPipeline({
			nodes: state.nodes,
			connections: state.connections,
			zoom: state.zoom,
			pan: state.pan
		});
	}

	function getCurrentCanvasData() {
		const state = get(canvasState);
		return {
			nodes: state.nodes,
			connections: state.connections,
			zoom: state.zoom,
			pan: state.pan
		};
	}

	function handlePipelineSwitch(data: PipelineData | null) {
		if (data) {
			loadPipelineToCanvas(data);
		} else {
			// New empty pipeline
			clearCanvas();
			clearHistory();
		}
		lastSaved = new Date();
	}

	// Subscribe to connection states
	$effect(() => {
		const unsub1 = mcpState.subscribe((s) => (isMcpConnected = s.status === 'connected'));
		const unsub2 = connectedInstances.subscribe((instances) => (mcpConnectedCount = instances.length));
		return () => { unsub1(); unsub2(); };
	});

	// Mission export handlers
	function openMissionExport() {
		// Validate first
		const validation = validateForMission(currentNodes, currentConnections);
		if (!validation.valid) {
			missionExportError = validation.issues.join('\n');
		} else {
			missionExportError = null;
		}
		// Generate default name from first node or timestamp
		if (!missionName) {
			const timestamp = new Date().toISOString().slice(0, 10);
			missionName = currentNodes.length > 0
				? `${currentNodes[0].skill.name} Workflow`
				: `Workflow ${timestamp}`;
		}
		showMissionExport = true;
	}

	async function handleMissionExport() {
		if (!missionName.trim()) {
			missionExportError = 'Mission name is required';
			return;
		}

		missionExporting = true;
		missionExportError = null;

		try {
			const result = await buildMissionFromCanvas(currentNodes, currentConnections, {
				name: missionName.trim(),
				description: missionDescription.trim() || undefined
			});

			if (result.success && result.mission) {
				showMissionExport = false;
				missionName = '';
				missionDescription = '';
				// Navigate to the new mission
				goto(`/missions/${result.mission.id}`);
			} else {
				missionExportError = result.error || 'Failed to create mission';
			}
		} catch (e) {
			missionExportError = e instanceof Error ? e.message : 'Unknown error';
		} finally {
			missionExporting = false;
		}
	}

	function closeMissionExport() {
		showMissionExport = false;
		missionExportError = null;
	}

	let zoom = $state(1);
	let pan = $state({ x: 0, y: 0 });
	let isPanning = $state(false);
	let panStart = $state({ x: 0, y: 0 });

	$effect(() => {
		const unsubscribe = canvasState.subscribe((state) => { zoom = state.zoom; pan = state.pan; });
		return unsubscribe;
	});

	let currentNodes = $state<CanvasNode[]>([]);
	let currentConnections = $state<Connection[]>([]);
	let currentSelectedNodeId = $state<string | null>(null);
	let currentSelectedNodeIds = $state<string[]>([]);
	let currentSelectedConnectionId = $state<string | null>(null);
	let currentSelectedNode = $state<CanvasNode | null>(null);
	let currentDraggingConnection = $state<DraggingConnection | null>(null);
	let currentCuttingLine = $state<CuttingLine | null>(null);
	let currentSelectionBox = $state<SelectionBox | null>(null);
	let currentSnapToGrid = $state(true);
	let currentGridSize = $state(24);
	let isCutting = $state(false);
	let isSelecting = $state(false);
	let currentCanUndo = $state(false);
	let currentCanRedo = $state(false);
	let toolbarExecutionAction = $derived.by(() =>
		getCanvasExecutionAction({
			nodeCount: currentNodes.length,
			activePipelineId: get(activePipelineIdStore),
			relay: executionRelay
		})
	);

	// Node search
	let searchQuery = $state('');
	let showSearch = $state(false);
	let selectedSearchIndex = $state(0);
	let searchInputEl = $state<HTMLInputElement>();

	// Minimap
	let showMinimap = $state(true);
	let canvasWidth = $state(800);
	let canvasHeight = $state(600);

	// Auto-layout
	let showLayoutMenu = $state(false);

	function handleAutoLayout(mode: 'grid' | 'horizontal' | 'vertical' | 'category') {
		autoLayout(canvasWidth, canvasHeight, mode);
		showLayoutMenu = false;
	}

	function addAdventureJoyPreset() {
		const template = workflowTemplates.find((entry) => entry.id === 'adventure-joy');
		if (!template) return;

		const state = get(canvasState);
		const baseX = 120 - state.pan.x / state.zoom;
		const baseY = 120 - state.pan.y / state.zoom;

		const nodeDefs: { skill: Skill; position: { x: number; y: number } }[] = [];
		for (const templateNode of template.nodes) {
			const skill = getSkillById(templateNode.skillId);
			if (!skill) continue;
			nodeDefs.push({
				skill,
				position: snapPosition(baseX + templateNode.offsetX, baseY + templateNode.offsetY)
			});
		}

		if (nodeDefs.length === 0) return;
		addNodesWithConnections(nodeDefs, template.connections);
		if (canvasEl) {
			const rect = canvasEl.getBoundingClientRect();
			frameSelected(rect.width, rect.height);
		}
	}

	// Filter nodes matching search query
	const matchingNodes = $derived(() => {
		if (!searchQuery.trim()) return [];
		const query = searchQuery.toLowerCase();
		return currentNodes.filter(node =>
			node.skill.name.toLowerCase().includes(query) ||
			node.skill.description?.toLowerCase().includes(query) ||
			node.skill.category.toLowerCase().includes(query) ||
			node.skill.tags?.some(tag => tag.toLowerCase().includes(query))
		);
	});

	function toggleSearch() {
		showSearch = !showSearch;
		if (showSearch) {
			selectedSearchIndex = 0;
			setTimeout(() => searchInputEl?.focus(), 0);
		} else {
			searchQuery = '';
			selectedSearchIndex = 0;
		}
	}

	function focusNode(nodeId: string) {
		const node = currentNodes.find(n => n.id === nodeId);
		if (!node || !canvasEl) return;

		selectNode(nodeId);

		// Center viewport on node
		if (!canvasEl) return;
		const rect = canvasEl.getBoundingClientRect();
		const NODE_WIDTH = 224;
		const NODE_HEIGHT = 96;
		const centerX = node.position.x + NODE_WIDTH / 2;
		const centerY = node.position.y + NODE_HEIGHT / 2;
		const panX = rect.width / 2 - centerX * zoom;
		const panY = rect.height / 2 - centerY * zoom;

		setPan({ x: panX, y: panY });
	}

	function handleSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			toggleSearch();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			const matches = matchingNodes();
			selectedSearchIndex = Math.min(selectedSearchIndex + 1, Math.max(matches.length - 1, 0));
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedSearchIndex = Math.max(selectedSearchIndex - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const matches = matchingNodes();
			const targetNode = matches[selectedSearchIndex] ?? matches[0];
			if (targetNode) {
				focusNode(targetNode.id);
				toggleSearch();
			}
		}
	}

	$effect(() => {
		const unsub1 = nodes.subscribe((n) => (currentNodes = n));
		const unsub2 = connections.subscribe((c) => (currentConnections = c));
		const unsub3 = selectedNodeId.subscribe((id) => (currentSelectedNodeId = id));
		const unsub4 = selectedNodeIds.subscribe((ids) => (currentSelectedNodeIds = ids));
		const unsub5 = selectedConnectionId.subscribe((id) => (currentSelectedConnectionId = id));
		const unsub6 = selectedNode.subscribe((node) => (currentSelectedNode = node));
		const unsub7 = draggingConnection.subscribe((dc) => (currentDraggingConnection = dc));
		const unsub8 = canUndo.subscribe((v) => (currentCanUndo = v));
		const unsub9 = canRedo.subscribe((v) => (currentCanRedo = v));
		const unsub10 = cuttingLine.subscribe((cl) => (currentCuttingLine = cl));
		const unsub11 = selectionBox.subscribe((sb) => (currentSelectionBox = sb));
		const unsub12 = snapToGrid.subscribe((s) => (currentSnapToGrid = s));
		const unsub13 = gridSize.subscribe((g) => (currentGridSize = g));
		return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); unsub6(); unsub7(); unsub8(); unsub9(); unsub10(); unsub11(); unsub12(); unsub13(); };
	});

	function handleKeydown(e: KeyboardEvent) {
		// Don't handle shortcuts if typing in an input
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
			return;
		}

		// Delete: Remove selected nodes or connection
		if (e.key === 'Delete' || e.key === 'Backspace') {
			e.preventDefault();
			deleteSelected();
		}
		// Undo: Ctrl+Z (Windows/Linux) or Cmd+Z (Mac)
		if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
			e.preventDefault();
			undo();
		}
		// Redo: Ctrl+Shift+Z or Ctrl+Y (Windows/Linux) or Cmd+Shift+Z (Mac)
		if ((e.ctrlKey || e.metaKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
			e.preventDefault();
			redo();
		}
		// Select All: Ctrl+A
		if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
			e.preventDefault();
			selectAllNodes();
		}
		// Duplicate: Ctrl+D
		if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
			e.preventDefault();
			duplicateSelected();
		}
		// Copy: Ctrl+C
		if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
			e.preventDefault();
			copySelected();
		}
		// Paste: Ctrl+V
		if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
			e.preventDefault();
			pasteFromClipboard();
		}
		// Escape: Clear selection
		if (e.key === 'Escape') {
			clearSelection();
			showNodeDetails = false;
		}
		// Frame selected: F key
		if (e.key === 'f' && !e.ctrlKey && !e.metaKey && currentSelectedNodeIds.length > 0) {
			e.preventDefault();
			if (canvasEl) {
				const rect = canvasEl.getBoundingClientRect();
				frameSelected(rect.width, rect.height);
			}
		}
		// Search: Ctrl+F
		if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
			e.preventDefault();
			toggleSearch();
		}
	}

	function getTempConnectionPath(dc: DraggingConnection): string {
		if (!dc) return '';
		const { startX, startY, currentX, currentY, sourcePortType } = dc;
		let fromX: number, fromY: number, toX: number, toY: number;
		if (sourcePortType === 'output') {
			fromX = startX; fromY = startY;
			toX = currentX; toY = currentY;
		} else {
			fromX = currentX; fromY = currentY;
			toX = startX; toY = startY;
		}
		const midX = (fromX + toX) / 2;
		return 'M ' + fromX + ' ' + fromY + ' C ' + midX + ' ' + fromY + ', ' + midX + ' ' + toY + ', ' + toX + ' ' + toY;
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		if (!e.dataTransfer) return;
		const skillJson = e.dataTransfer.getData('application/json');
		if (!skillJson) return;
		// SECURITY: Validate JSON with Zod schema
		const skill = safeJsonParse(skillJson, DroppedSkillSchema, 'canvas-drop');
		if (!skill) {
			console.error('Invalid skill data dropped on canvas');
			return;
		}

		const normalizedTier = typeof skill.tier === 'number' ? (skill.tier > 1 ? 'premium' : 'free') : (skill.tier || 'free');
		const normalizedSkill: Skill = {
			id: skill.id,
			name: skill.name || skill.id,
			description: skill.description || '',
			category: (skill.category as Skill['category']) || 'development',
			tier: normalizedTier,
			tags: skill.tags || [],
			triggers: skill.triggers || [],
			handoffs: skill.handoffs || [],
			pairsWell: skill.pairsWell || []
		};

		if (!canvasEl) return;
		const rect = canvasEl.getBoundingClientRect();
		const rawX = (e.clientX - rect.left - pan.x) / zoom;
		const rawY = (e.clientY - rect.top - pan.y) / zoom;
		const snapped = snapPosition(rawX, rawY);
		addNode(normalizedSkill, snapped);
	}

	function handleDragOver(e: DragEvent) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }

	// Handle click on handoff port - spawn the recommended skill and auto-connect
	function handleHandoffClick(skillId: string, sourceNodeId: string, sourcePortId: string) {
		const skill = getSkillById(skillId);
		if (!skill) {
			console.warn(`Skill not found: ${skillId}`);
			return;
		}

		// Find the source node to position the new node relative to it
		const sourceNode = currentNodes.find(n => n.id === sourceNodeId);
		if (!sourceNode) return;

		// Position the new node to the right of the source node
		const newPosition = snapPosition(
			sourceNode.position.x + 250, // 250px to the right
			sourceNode.position.y
		);

		// Add the new node
		const newNodeId = addNode(skill, newPosition);

		// Auto-connect from the handoff port to the new node's input
		if (newNodeId) {
			addConnection(sourceNodeId, sourcePortId, newNodeId, 'input');
			// Select the new node
			selectNode(newNodeId);
		}
	}

	function handleCanvasClick(e: MouseEvent) { if (e.target === e.currentTarget) { clearSelection(); showLayoutMenu = false; } }
	function handleCanvasAreaKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			clearSelection();
			showLayoutMenu = false;
		}
	}
	function handleZoomIn() { setZoom(zoom + 0.1); }
	function handleZoomOut() { setZoom(zoom - 0.1); }
	function handleZoomReset() { setZoom(1); }
	function handleZoomToFit() {
		if (canvasEl) {
			const rect = canvasEl.getBoundingClientRect();
			zoomToFit(rect.width, rect.height);
		}
	}
	function handleMouseDown(e: MouseEvent) {
		// Safety: ensure canvasEl exists
		if (!canvasEl) return;

		// Only handle canvas interactions if clicking directly on canvas or its background layers
		// Node elements handle their own mousedown with stopPropagation
		const target = e.target as HTMLElement;
		const isCanvasBackground = target === canvasEl ||
			target.classList.contains('canvas-area') ||
			target.tagName === 'svg' ||
			target.closest('svg.absolute');

		// FIX 14: More robust node detection - check for ANY element inside a node
		// This catches cases where click is on inner elements like SkillNode content
		const isInsideNode = target.closest('.draggable-node') ||
			target.closest('.node') ||
			target.closest('.port-handle');

		// If clicking inside a node, let the node handle it
		if (isInsideNode) {
			return;
		}

		// If not on canvas background and not inside a node, still don't start panning
		// This prevents accidental panning from unexpected elements
		if (!isCanvasBackground) {
			return;
		}

		// Ctrl+left-click to start cutting connections (Blender-style)
		if (e.button === 0 && e.ctrlKey && !e.altKey) {
			e.preventDefault();
			isCutting = true;
			const rect = canvasEl.getBoundingClientRect();
			const x = (e.clientX - rect.left - pan.x) / zoom;
			const y = (e.clientY - rect.top - pan.y) / zoom;
			startConnectionCut(x, y);
			return;
		}
		// Shift+left-click on empty canvas to start selection box
		if (e.button === 0 && e.shiftKey && !e.ctrlKey) {
			e.preventDefault();
			isSelecting = true;
			const rect = canvasEl.getBoundingClientRect();
			const x = (e.clientX - rect.left - pan.x) / zoom;
			const y = (e.clientY - rect.top - pan.y) / zoom;
			startSelectionBox(x, y);
			return;
		}
		// Left-click on empty canvas OR middle-click OR Alt+left-click for panning
		if (e.button === 1 || (e.button === 0 && e.altKey) || (e.button === 0 && !e.ctrlKey && !e.shiftKey)) {
			isPanning = true;
			panStart = { x: e.clientX - pan.x, y: e.clientY - pan.y };
			e.preventDefault();
			return;
		}
	}
	function handleMouseMove(e: MouseEvent) {
		// Safety check
		if (!canvasEl) return;

		if (isPanning) {
			setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
		}
		if (isCutting) {
			const rect = canvasEl.getBoundingClientRect();
			const x = (e.clientX - rect.left - pan.x) / zoom;
			const y = (e.clientY - rect.top - pan.y) / zoom;
			updateConnectionCut(x, y);
		}
		if (isSelecting) {
			const rect = canvasEl.getBoundingClientRect();
			const x = (e.clientX - rect.left - pan.x) / zoom;
			const y = (e.clientY - rect.top - pan.y) / zoom;
			updateSelectionBox(x, y);
		}
	}
	function handleMouseUp() {
		isPanning = false;
		if (isCutting) {
			isCutting = false;
			endConnectionCut();
		}
		if (isSelecting) {
			isSelecting = false;
			endSelectionBox();
		}
	}

	function handleCanvasContextMenu(e: MouseEvent) {
		e.preventDefault();
		contextMenu = { x: e.clientX, y: e.clientY, type: 'canvas' };
	}

	function handleNodeContextMenu(nodeId: string, e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		// Select the node if not already selected
		if (!currentSelectedNodeIds.includes(nodeId)) {
			selectNode(nodeId);
		}
		contextMenu = { x: e.clientX, y: e.clientY, type: 'node', targetId: nodeId };
	}

	function handleConnectionContextMenu(connectionId: string, e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		selectConnection(connectionId);
		contextMenu = { x: e.clientX, y: e.clientY, type: 'connection', targetId: connectionId };
	}

	function closeContextMenu() {
		contextMenu = null;
	}

	function getContextMenuItems() {
		if (!contextMenu) return [];

		if (contextMenu.type === 'canvas') {
			return [
				{ label: 'Paste', icon: '📋', action: pasteFromClipboard, shortcut: 'Ctrl+V' },
				{ label: 'Select All', icon: '☑', action: selectAllNodes, shortcut: 'Ctrl+A' },
				{ divider: true as const },
				{ label: 'Zoom to Fit', icon: '🔍', action: handleZoomToFit },
				{ label: 'Reset Zoom', icon: '↺', action: handleZoomReset }
			];
		}

		if (contextMenu.type === 'node') {
			const hasMultipleSelected = currentSelectedNodeIds.length > 1;
			return [
				{ label: 'Open Details', icon: '📄', action: () => (showNodeDetails = true) },
				{ divider: true as const },
				{ label: 'Copy', icon: '📋', action: copySelected, shortcut: 'Ctrl+C' },
				{ label: 'Duplicate', icon: '⧉', action: duplicateSelected, shortcut: 'Ctrl+D' },
				{ divider: true as const },
				{ label: hasMultipleSelected ? `Delete ${currentSelectedNodeIds.length} nodes` : 'Delete', icon: '🗑', action: deleteSelected, shortcut: 'Del', danger: true }
			];
		}

		if (contextMenu.type === 'connection') {
			return [
				{ label: 'Delete Connection', icon: '🗑', action: () => contextMenu?.targetId && removeConnection(contextMenu.targetId), shortcut: 'Del', danger: true }
			];
		}

		return [];
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="h-screen flex bg-bg-primary relative">
	<aside class="w-64 border-r border-surface-border bg-bg-secondary flex flex-col z-10">
		<div class="h-14 px-4 border-b border-surface-border flex items-center justify-center">
			<BrandLogo size="md" />
		</div>
		<div class="flex-1 overflow-hidden"><SkillsPanel /></div>
		<div class="p-3 border-t border-surface-border">
			<div class="flex items-center justify-between">
				<div class="text-xs text-text-tertiary font-mono">{currentNodes.length} nodes</div>
				<div class="flex items-center gap-2">
					<span class="flex items-center gap-1 text-xs font-mono {mcpConnectedCount > 0 ? 'text-accent-primary' : 'text-text-tertiary'}" title="{mcpConnectedCount} MCP{mcpConnectedCount !== 1 ? 's' : ''} connected">
						<span class="w-1.5 h-1.5 rounded-full {mcpConnectedCount > 0 ? 'bg-accent-primary' : 'bg-text-tertiary'}"></span>
						{mcpConnectedCount} MCP{mcpConnectedCount !== 1 ? 's' : ''}
					</span>
				</div>
			</div>
		</div>
	</aside>
	<main class="flex-1 flex flex-col">
		<!-- Session State Bar - shows when returning to an active mission -->
		<SessionStateBar onOpenExecution={() => showExecution = true} />

		<!-- Two-row toolbar -->
		<header class="h-14 flex items-center px-4 gap-3 border-b border-surface-border bg-bg-secondary">
			<!-- Pipeline selector -->
			<PipelineSelector
				onSwitch={handlePipelineSwitch}
				onBeforeSwitch={getCurrentCanvasData}
			/>

			<div class="w-px h-5 bg-surface-border"></div>

			<!-- Undo/Redo -->
			<div class="flex items-center gap-1">
				<button class="toolbar-btn" onclick={() => undo()} disabled={!currentCanUndo} title="Undo (Ctrl+Z)">
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/>
					</svg>
				</button>
				<button class="toolbar-btn" onclick={() => redo()} disabled={!currentCanRedo} title="Redo (Ctrl+Y)">
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6"/>
					</svg>
				</button>
			</div>

			<div class="w-px h-5 bg-surface-border"></div>

			<!-- Zoom controls -->
			<div class="flex items-center gap-1">
				<button class="toolbar-btn" onclick={handleZoomOut} title="Zoom out">
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4"/>
					</svg>
				</button>
				<button class="toolbar-btn min-w-[3.25rem] font-mono text-xs" onclick={handleZoomReset} title="Reset zoom">
					{Math.round(zoom * 100)}%
				</button>
				<button class="toolbar-btn" onclick={handleZoomIn} title="Zoom in">
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
					</svg>
				</button>
			</div>

			<div class="flex-1"></div>

			<!-- Primary actions -->
			<div class="flex items-center gap-2">
				<button
					onclick={handleClear}
					disabled={currentNodes.length === 0}
					class="canvas-action-btn"
					title="Clear all nodes from canvas"
				>
					Clear All
				</button>
				<button
					onclick={openMissionExport}
					class="canvas-action-btn"
					disabled={currentNodes.length === 0 || !isMcpConnected}
					title={!isMcpConnected ? 'Connect to MCP to export missions' : 'Export workflow as mission'}
				>
					Export
				</button>
				<button
					onclick={openExecutionFromToolbar}
					class="canvas-action-btn canvas-action-btn-primary"
					disabled={toolbarExecutionAction.disabled}
					title={toolbarExecutionAction.title}
				>
					{toolbarExecutionAction.label}
				</button>
			</div>
		</header>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div bind:this={canvasEl} class="canvas-area flex-1 relative overflow-hidden bg-bg-primary" class:panning={isPanning} class:cutting={isCutting} class:selecting={isSelecting} ondrop={handleDrop} ondragover={handleDragOver} onclick={handleCanvasClick} oncontextmenu={handleCanvasContextMenu} onmousedown={handleMouseDown} onmousemove={handleMouseMove} onmouseup={handleMouseUp} onmouseleave={handleMouseUp} onkeydown={handleCanvasAreaKeydown} role="application" tabindex="0">
			<div class="canvas-grid absolute inset-0 pointer-events-none" style="background-size: {40 * zoom}px {40 * zoom}px; background-position: {pan.x}px {pan.y}px;"></div>
			<div class="absolute pointer-events-none" style="transform: translate({pan.x}px, {pan.y}px);"><div class="pointer-events-none" style="transform: scale({zoom}); transform-origin: 0 0;">
				<svg class="absolute inset-0 pointer-events-none overflow-visible" style="z-index: 1;"><defs><marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00C49A" /></marker></defs>{#each currentConnections as connection}{@const sourceNode = currentNodes.find((node) => node.id === connection.sourceNodeId)}{@const targetNode = currentNodes.find((node) => node.id === connection.targetNodeId)}<ConnectionLine {connection} nodes={currentNodes} selected={currentSelectedConnectionId === connection.id} isActive={sourceNode?.status === 'running' || targetNode?.status === 'running'} isCompleted={sourceNode?.status === 'success' && targetNode?.status === 'success'} hasError={sourceNode?.status === 'error' || targetNode?.status === 'error'} />{/each}{#if currentDraggingConnection}<path d={getTempConnectionPath(currentDraggingConnection)} fill="none" stroke="#00C49A" stroke-width="2" stroke-dasharray="4 4" class="temp-connection" />{/if}{#if currentCuttingLine}<line x1={currentCuttingLine.startX} y1={currentCuttingLine.startY} x2={currentCuttingLine.currentX} y2={currentCuttingLine.currentY} stroke="#ef4444" stroke-width="2" stroke-dasharray="6 3" class="cutting-line" /><circle cx={currentCuttingLine.startX} cy={currentCuttingLine.startY} r="4" fill="#ef4444" /><circle cx={currentCuttingLine.currentX} cy={currentCuttingLine.currentY} r="4" fill="#ef4444" />{/if}{#if currentSelectionBox}{@const x = Math.min(currentSelectionBox.startX, currentSelectionBox.currentX)}{@const y = Math.min(currentSelectionBox.startY, currentSelectionBox.currentY)}{@const w = Math.abs(currentSelectionBox.currentX - currentSelectionBox.startX)}{@const h = Math.abs(currentSelectionBox.currentY - currentSelectionBox.startY)}<rect {x} {y} width={w} height={h} fill="rgba(0, 196, 154, 0.1)" stroke="#00C49A" stroke-width="1" stroke-dasharray="4 2" class="selection-box" />{/if}</svg>
				{#each currentNodes as node (node.id)}<DraggableNode {node} selected={currentSelectedNodeIds.includes(node.id)} {zoom} {pan} onOpenDetails={() => (showNodeDetails = true)} onContextMenu={(e) => handleNodeContextMenu(node.id, e)} onHandoffClick={handleHandoffClick} />{/each}
			</div></div>
			{#if currentNodes.length === 0}<div class="absolute inset-0 flex items-center justify-center pointer-events-none"><div class="text-center"><h3 class="text-lg font-medium text-text-primary mb-2">No skills on canvas</h3><p class="text-sm text-text-secondary">Drag skills from the sidebar</p></div></div>{/if}
			<!-- Search overlay -->
			{#if showSearch}
				<button type="button" class="canvas-search-overlay" aria-label="Close canvas search" onclick={toggleSearch}></button>
				<div class="canvas-search-shell" role="dialog" aria-modal="true" aria-label="Search canvas nodes">
					<div class="canvas-search-modal">
						<div class="canvas-search-input-row">
							<svg class="canvas-search-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
							</svg>
							<input
								bind:this={searchInputEl}
								bind:value={searchQuery}
								oninput={() => (selectedSearchIndex = 0)}
								onkeydown={handleSearchKeydown}
								type="text"
								placeholder="Search canvas nodes..."
								class="canvas-search-input"
							/>
							{#if searchQuery}
								<button type="button" onclick={() => { searchQuery = ''; selectedSearchIndex = 0; searchInputEl?.focus(); }} class="canvas-search-clear" aria-label="Clear search">
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M6 18L18 6M6 6l12 12"/></svg>
								</button>
							{/if}
							<kbd class="canvas-search-key">esc</kbd>
						</div>
						{#if searchQuery.trim()}
							<div class="canvas-search-results">
								<p class="canvas-search-group-label">Canvas nodes</p>
								{#each matchingNodes() as node, index}
									<button
										type="button"
										onmouseenter={() => (selectedSearchIndex = index)}
										onclick={() => { focusNode(node.id); toggleSearch(); }}
										class:selected={index === selectedSearchIndex}
										class="canvas-search-result"
									>
										<span class="canvas-search-result-icon">
											<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m4 12 8 4.5 8-4.5"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m4 16.5 8 4.5 8-4.5"/></svg>
										</span>
										<span class="canvas-search-result-body">
											<span class="canvas-search-result-title">{node.skill.name}</span>
											<span class="canvas-search-result-desc">{node.skill.description || node.skill.id}</span>
										</span>
										<span class="canvas-search-result-meta">{node.skill.category}</span>
										{#if index === selectedSearchIndex}
											<kbd class="canvas-search-key">enter</kbd>
										{/if}
									</button>
								{:else}
									<div class="canvas-search-empty">No matching nodes</div>
								{/each}
							</div>
						{:else}
							<div class="canvas-search-hint">
								<p class="canvas-search-hint-title">Search the current canvas</p>
								<p>Find a node by name, category, description, or tag, then jump straight to it.</p>
							</div>
						{/if}
					</div>
				</div>
			{/if}
			<!-- Goal processing overlay -->
			{#if goalProcessing}
				<div class="absolute inset-0 z-40 flex items-center justify-center bg-bg-primary/80 backdrop-blur-sm pointer-events-none">
					<div class="bg-bg-secondary border border-surface-border rounded-lg p-6 max-w-sm text-center">
						<div class="animate-spin w-8 h-8 border-2 border-accent-primary border-t-transparent rounded-full mx-auto mb-4"></div>
						<p class="text-text-primary font-mono text-sm">{goalProcessingMessage}</p>
						<p class="text-text-tertiary text-xs mt-2">Matching skills to your project...</p>
					</div>
				</div>
			{/if}
			<!-- Goal summary banner -->
			{#if goalSummary && !goalProcessing}
				<div class="absolute top-4 left-4 z-30 bg-bg-secondary border border-accent-primary/30 rounded-md px-3 py-2 max-w-xs">
					<p class="text-xs font-mono text-accent-primary mb-0.5">Project Goal</p>
					<p class="text-sm text-text-primary truncate">{goalSummary}</p>
					<button
						onclick={() => goalSummary = null}
						class="absolute top-1 right-1 text-text-tertiary hover:text-text-secondary p-1"
						aria-label="Dismiss goal summary"
					>
						<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
					</button>
				</div>
			{/if}
			<!-- Goal error toast -->
			{#if goalProcessingError}
				<div class="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 bg-red-500/10 border border-red-500/30 rounded-md px-4 py-3 max-w-md">
					<div class="flex items-start gap-3">
						<svg class="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
						</svg>
						<div>
							<p class="text-sm text-red-400 font-mono">{goalProcessingError}</p>
							<p class="text-xs text-text-tertiary mt-1">Try adding more details about your project</p>
						</div>
						<button
							onclick={() => goalProcessingError = null}
							class="text-text-tertiary hover:text-text-secondary p-1 ml-auto"
							aria-label="Dismiss error"
						>
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
						</button>
					</div>
				</div>
			{/if}
			<!-- Minimap -->
			{#if showMinimap}
				<Minimap
					nodes={currentNodes}
					{zoom}
					{pan}
					viewportWidth={canvasWidth}
					viewportHeight={canvasHeight}
					onPanTo={handleMinimapPan}
				/>
			{/if}
		</div>
	</main>
</div>

<!-- Node Details Panel - absolute positioned overlay with slide animation -->
{#if showNodeDetails && currentSelectedNode}
	<div class="fixed top-0 right-0 h-screen z-50 shadow-xl slide-in">
		<NodeConfigPanel
			node={currentSelectedNode}
			onClose={() => (showNodeDetails = false)}
			onDelete={() => { removeNode(currentSelectedNode!.id); showNodeDetails = false; }}
		/>
	</div>
{/if}

{#if showExecution}
	{#key executionPanelKey}
		<ExecutionPanel
			onClose={() => (showExecution = false)}
			minimized={executionMinimized}
			onToggleMinimize={() => (executionMinimized = !executionMinimized)}
			autoRunToken={executionAutoRunToken || undefined}
			executionAuthority={executionAuthority || undefined}
			relay={executionRelay || undefined}
		/>
	{/key}
{/if}

{#if contextMenu}
	<ContextMenu x={contextMenu.x} y={contextMenu.y} items={getContextMenuItems()} onClose={closeContextMenu} />
{/if}

{#if showMissionExport}
	<!-- Mission Export Modal -->
	<div class="fixed inset-0 z-50 flex items-center justify-center">
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="absolute inset-0 bg-black/60" onclick={closeMissionExport} role="presentation"></div>

		<!-- Modal -->
		<div class="relative w-full max-w-md bg-bg-secondary border border-surface-border rounded-lg shadow-xl overflow-hidden">
			<div class="p-4 border-b border-surface-border flex items-center justify-between">
				<h2 class="text-lg font-medium text-text-primary">Export to Mission</h2>
				<button onclick={closeMissionExport} class="text-text-tertiary hover:text-text-secondary" aria-label="Close export dialog">
					<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
					</svg>
				</button>
			</div>

			<div class="p-4 space-y-4">
				{#if missionExportError}
					<div class="p-3 border border-red-500/30 bg-red-500/10 text-sm text-red-400 font-mono whitespace-pre-wrap">
						{missionExportError}
					</div>
				{/if}

				<div>
					<label for="mission-name" class="block text-sm font-mono text-text-tertiary mb-1.5">
						Mission Name *
					</label>
					<input
						id="mission-name"
						type="text"
						bind:value={missionName}
						placeholder="My Workflow"
						class="w-full px-3 py-2 bg-bg-primary border border-surface-border rounded-md text-text-primary font-mono text-sm placeholder:text-text-tertiary focus:outline-none focus:border-accent-primary"
					/>
				</div>

				<div>
					<label for="mission-desc" class="block text-sm font-mono text-text-tertiary mb-1.5">
						Description
					</label>
					<textarea
						id="mission-desc"
						bind:value={missionDescription}
						placeholder="What does this workflow accomplish?"
						rows="3"
						class="w-full px-3 py-2 bg-bg-primary border border-surface-border rounded-md text-text-primary font-mono text-sm placeholder:text-text-tertiary focus:outline-none focus:border-accent-primary resize-none"
					></textarea>
				</div>

				<div class="pt-2 text-xs font-mono text-text-tertiary">
					This will create a mission with {currentNodes.length} task{currentNodes.length !== 1 ? 's' : ''} and {currentConnections.length} connection{currentConnections.length !== 1 ? 's' : ''}.
				</div>
			</div>

			<div class="p-4 border-t border-surface-border flex items-center justify-end gap-2">
				<button
					onclick={closeMissionExport}
					class="px-4 py-2 text-sm font-mono text-text-secondary border border-surface-border rounded-md hover:border-text-tertiary hover:text-text-primary transition-all"
				>
					Cancel
				</button>
				<button
					onclick={handleMissionExport}
					disabled={missionExporting || !missionName.trim()}
					class="px-4 py-2 text-sm font-mono bg-accent-primary text-bg-primary rounded-md hover:bg-accent-primary-hover transition-all disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{missionExporting ? 'Creating...' : 'Create Mission'}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if showClearConfirm}
	<!-- Clear Canvas Confirmation Modal -->
	<div class="fixed inset-0 z-50 flex items-center justify-center">
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="absolute inset-0 bg-black/60" onclick={cancelClear} role="presentation"></div>

		<!-- Modal -->
		<div class="relative w-full max-w-sm bg-bg-secondary border border-red-500/30 rounded-lg shadow-xl overflow-hidden">
			<div class="p-4 border-b border-surface-border flex items-center gap-3">
				<div class="w-10 h-10 flex items-center justify-center bg-red-500/10 border border-red-500/30 rounded-md">
					<svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
					</svg>
				</div>
				<div>
					<h2 class="text-lg font-medium text-text-primary">Clear Canvas</h2>
					<p class="text-xs text-text-tertiary font-mono">This action cannot be undone</p>
				</div>
			</div>

			<div class="p-4">
				<p class="text-sm text-text-secondary">
					You are about to delete <span class="text-red-400 font-mono">{currentNodes.length} node{currentNodes.length !== 1 ? 's' : ''}</span> and <span class="text-red-400 font-mono">{currentConnections.length} connection{currentConnections.length !== 1 ? 's' : ''}</span> from the canvas.
				</p>
				<p class="text-sm text-text-tertiary mt-2">
					This will permanently remove all your work. Consider exporting first.
				</p>
			</div>

			<div class="p-4 border-t border-surface-border flex items-center justify-end gap-2">
				<button
					onclick={cancelClear}
					class="px-4 py-2 text-sm font-mono text-text-secondary border border-surface-border rounded-md hover:border-text-tertiary hover:text-text-primary transition-all"
				>
					Cancel
				</button>
				<button
					onclick={confirmClear}
					class="px-4 py-2 text-sm font-mono bg-red-500 text-white rounded-md hover:bg-red-600 transition-all"
				>
					Clear All
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.canvas-area {
		cursor: grab;
		background: #181c26;
	}
	.canvas-grid {
		/* Crossing line grid at 40px — same as spark-agent board-stage */
		background-image:
			linear-gradient(rgb(148 163 184 / 0.105) 1px, transparent 1px),
			linear-gradient(90deg, rgb(148 163 184 / 0.105) 1px, transparent 1px);
		opacity: 0.62;
	}
	.canvas-area.panning { cursor: grabbing; }
	.canvas-area.cutting { cursor: crosshair; }
	.canvas-area.selecting { cursor: crosshair; }
	.selection-box { pointer-events: none; }
	.temp-connection {
		opacity: 0.7;
		animation: dash 0.5s linear infinite;
	}
	.cutting-line {
		filter: drop-shadow(0 0 4px #ef4444);
		animation: cut-dash 0.3s linear infinite;
	}
	@keyframes dash {
		to { stroke-dashoffset: -8; }
	}
	@keyframes cut-dash {
		to { stroke-dashoffset: -9; }
	}
	
	.slide-in {
		animation: slideInFromRight 0.2s ease-out;
	}
	
	@keyframes slideInFromRight {
		from {
			transform: translateX(100%);
		}
		to {
			transform: translateX(0);
		}
	}

	.canvas-search-overlay {
		position: fixed;
		inset: 0;
		z-index: 80;
		border: 0;
		background: rgb(0 0 0 / 0.52);
		backdrop-filter: blur(8px);
		animation: canvasSearchOverlayIn 180ms ease-out both;
	}

	.canvas-search-shell {
		position: fixed;
		inset: 0;
		z-index: 81;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 14vh 16px 24px;
		pointer-events: none;
	}

	.canvas-search-modal {
		width: min(620px, 100%);
		overflow: hidden;
		border: 1px solid rgb(var(--accent-rgb) / 0.42);
		border-radius: 8px;
		background: var(--surface);
		box-shadow:
			0 0 0 3px rgb(var(--accent-rgb) / 0.08),
			0 24px 80px -30px rgb(0 0 0 / 0.92);
		pointer-events: auto;
		animation: canvasSearchModalIn 240ms cubic-bezier(0.22, 1, 0.36, 1) both;
	}

	.canvas-search-input-row {
		display: flex;
		align-items: center;
		gap: 16px;
		border-bottom: 1px solid var(--border);
		padding: 18px 22px;
	}

	.canvas-search-icon {
		width: 20px;
		height: 20px;
		flex: 0 0 auto;
		color: var(--accent);
	}

	.canvas-search-input {
		min-width: 0;
		flex: 1;
		border: 0;
		background: transparent;
		color: var(--text);
		font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
		font-size: 18px;
		line-height: 1.35;
		outline: none;
		caret-color: var(--accent);
	}

	.canvas-search-input:focus,
	.canvas-search-input:focus-visible {
		outline: none;
		box-shadow: none;
	}

	.canvas-search-input::placeholder {
		color: rgb(var(--text-tertiary-rgb) / 0.45);
	}

	.canvas-search-clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-tertiary);
		cursor: pointer;
		transition:
			background-color 160ms ease,
			color 160ms ease;
	}

	.canvas-search-clear:hover {
		background: var(--bg-subtle);
		color: var(--text);
	}

	.canvas-search-key {
		border: 1px solid var(--border-strong);
		border-radius: 5px;
		background: var(--bg-subtle);
		padding: 3px 6px;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 10px;
		line-height: 1;
		color: var(--text-tertiary);
	}

	.canvas-search-results {
		max-height: min(430px, 54vh);
		overflow-y: auto;
		padding: 8px 0;
	}

	.canvas-search-group-label {
		padding: 12px 20px 4px;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 1.5px;
		color: rgb(var(--text-tertiary-rgb) / 0.68);
	}

	.canvas-search-result {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 12px;
		border: 0;
		background: transparent;
		padding: 10px 20px;
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			background-color 180ms ease,
			color 180ms ease;
	}

	.canvas-search-result:hover,
	.canvas-search-result.selected {
		background: rgb(var(--accent-rgb) / 0.065);
		color: var(--text);
	}

	.canvas-search-result-icon {
		display: inline-flex;
		width: 34px;
		height: 34px;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		background: var(--border);
		color: var(--text-tertiary);
		transition:
			background-color 180ms ease,
			color 180ms ease;
	}

	.canvas-search-result.selected .canvas-search-result-icon,
	.canvas-search-result:hover .canvas-search-result-icon {
		background: rgb(var(--accent-rgb) / 0.15);
		color: var(--accent);
	}

	.canvas-search-result-body {
		display: grid;
		min-width: 0;
		flex: 1;
		gap: 2px;
		text-align: left;
	}

	.canvas-search-result-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 14px;
		font-weight: 650;
		color: var(--text);
	}

	.canvas-search-result-desc {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		color: rgb(var(--text-tertiary-rgb) / 0.72);
	}

	.canvas-search-result-meta {
		max-width: 120px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		border: 1px solid rgb(var(--accent-rgb) / 0.25);
		border-radius: 5px;
		padding: 3px 6px;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 10px;
		text-transform: uppercase;
		color: var(--accent);
	}

	.canvas-search-hint,
	.canvas-search-empty {
		display: grid;
		justify-items: center;
		gap: 8px;
		padding: 34px 24px;
		text-align: center;
		color: rgb(var(--text-tertiary-rgb) / 0.72);
	}

	.canvas-search-hint-title {
		color: var(--text);
		font-size: 14px;
		font-weight: 650;
	}

	@keyframes canvasSearchModalIn {
		0% {
			opacity: 0;
			transform: scale(0.95) translateY(-8px);
		}
		100% {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}

	@keyframes canvasSearchOverlayIn {
		0% { opacity: 0; }
		100% { opacity: 1; }
	}

	/* Toolbar button styles */
	:global(.toolbar-btn) {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		color: var(--text-secondary);
		background: rgb(var(--surface-rgb) / 0.24);
		border: 1px solid transparent;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.15s;
	}
	:global(.toolbar-btn:hover) {
		color: var(--text-primary);
		background: var(--surface-active);
		border-color: var(--border);
	}
	:global(.toolbar-btn:disabled) {
		opacity: 0.4;
		cursor: not-allowed;
	}
	:global(.toolbar-btn:disabled:hover) {
		background: transparent;
		color: var(--text-secondary);
	}

	:global(.canvas-action-btn) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 32px;
		padding: 0 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: rgb(var(--surface-rgb) / 0.26);
		color: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1;
		transition: all 0.15s ease;
	}

	:global(.canvas-action-btn:hover) {
		border-color: var(--text-tertiary);
		color: var(--text-primary);
		background: var(--surface-active);
	}

	:global(.canvas-action-btn:disabled) {
		cursor: not-allowed;
		opacity: 0.45;
	}

	:global(.canvas-action-btn-primary) {
		border-color: rgb(var(--accent-rgb) / 0.35);
		background: var(--accent);
		color: var(--accent-fg);
		font-weight: 600;
		box-shadow: 0 10px 26px -18px rgb(var(--accent-rgb) / 0.9);
	}

	:global(.canvas-action-btn-primary:hover) {
		border-color: rgb(var(--accent-rgb) / 0.55);
		background: var(--accent-hover);
		color: var(--accent-fg);
	}

	/* Smaller toolbar buttons for row 2 */
	:global(.toolbar-btn-sm) {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		height: 24px;
		font-size: 11px;
		font-family: var(--font-mono);
		color: var(--text-tertiary);
		background: transparent;
		border: none;
		border-radius: 5px;
		cursor: pointer;
		transition: all 0.15s;
	}
	:global(.toolbar-btn-sm:hover) {
		color: var(--text-secondary);
		background: var(--surface-active);
	}
	:global(.toolbar-btn-sm.active) {
		color: var(--accent);
		background: var(--accent-subtle);
	}
	:global(.toolbar-btn-sm.active:hover) {
		background: var(--accent-mid);
	}
</style>
