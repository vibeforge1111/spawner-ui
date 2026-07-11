import { logger } from '$lib/utils/logger';
import { getEventsAuthHeaders } from './events-auth-client';
/**
 * PRD Bridge Service
 *
 * Enables Claude Code (running in terminal) to analyze PRDs uploaded to Spawner UI.
 *
 * Flow:
 * 1. User uploads PRD in Spawner UI
 * 2. UI writes PRD to pending-prd.md in the configured Spawner state root
 * 3. UI sends event {type: "prd_analysis_requested"}
 * 4. Claude Code reads the PRD and analyzes with real AI
 * 5. Claude Code sends event {type: "prd_analysis_complete", data: {...}}
 * 6. UI receives the intelligent analysis
 *
 * This uses REAL Claude intelligence, not regex pattern matching.
 */

import { browser } from '$app/environment';
import { writable, get } from 'svelte/store';
import type { BridgeEvent } from './event-bridge';
import type { Skill } from '$lib/stores/skills.svelte';

const PRD_BRIDGE_TIMEOUT_MS = 30 * 60 * 1000;

// =============================================================================
// TYPES
// =============================================================================

export interface PRDAnalysisRequest {
	prdPath: string;
	prdContent: string;
	projectName?: string;
	requestId: string;
	timestamp: string;
}

export interface PRDAnalysisResult {
	requestId: string;
	success: boolean;
	error?: string;

	// The intelligent analysis
	projectName: string;
	projectType: string;
	complexity: 'simple' | 'moderate' | 'complex';

	// Infrastructure decisions (by Claude, not regex)
	infrastructure: {
		needsAuth: boolean;
		authReason?: string;
		needsDatabase: boolean;
		databaseReason?: string;
		needsAPI: boolean;
		apiReason?: string;
	};

	// Tech stack recommendations
	techStack: {
		framework: string;
		language: string;
		styling?: string;
		database?: string;
		auth?: string;
		deployment?: string;
	};

	// Tasks - variable count based on actual complexity (could be 5 or 25)
	tasks: Array<{
		id: string;
		title: string;
		description?: string;
		summary?: string;
		skills: string[];
		phase?: number;
		dependsOn?: string[];
		dependencies?: string[];
		workspaceTargets?: string[];
		acceptanceCriteria?: string[];
		verificationCommands?: string[];
		verification?: {
			criteria: string[];
			files?: string[];
			commands?: string[];
		};
	}>;

	// H70 skills to load
	skills: string[];

	// The execution prompt (ready to copy-paste)
	executionPrompt: string;
}

// =============================================================================
// STATE
// =============================================================================

export const analysisStatus = writable<'idle' | 'pending' | 'analyzing' | 'complete' | 'error'>('idle');
export const analysisResult = writable<PRDAnalysisResult | null>(null);
export const analysisError = writable<string | null>(null);

// Pending requests waiting for response
const pendingRequests = new Map<string, {
	resolve: (result: PRDAnalysisResult) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}>();

// =============================================================================
// BRIDGE FUNCTIONS
// =============================================================================

/**
 * Initialize the bridge - listen for analysis responses
 */
let bridgeInitialized = false;

export async function initPRDBridge(): Promise<void> {
	if (!browser || bridgeInitialized) return;

	try {
		// Dynamic import to get the client event bridge
		const { clientEventBridge } = await import('./event-bridge');

		if (!clientEventBridge) {
			console.warn('[PRDBridge] clientEventBridge not available');
			return;
		}

		// Subscribe to bridge events
		clientEventBridge.subscribe((event: BridgeEvent) => {
			logger.info('[PRDBridge] Received event:', event.type);
			if (event.type === 'prd_analysis_complete') {
				handleAnalysisComplete(event);
			} else if (event.type === 'prd_analysis_error') {
				handleAnalysisError(event);
			} else if (event.type === 'prd_analysis_progress') {
				logger.info('[PRDBridge] Analysis progress:', event.message);
			}
		});

		bridgeInitialized = true;
		logger.info('[PRDBridge] Initialized, listening for analysis responses');
	} catch (e) {
		console.error('[PRDBridge] Failed to initialize:', e);
	}
}

/**
 * Request PRD analysis from Claude Code
 *
 * This sends the PRD to Claude Code (via file + event) and waits for response.
 */
export async function requestPRDAnalysis(
	prdContent: string,
	projectName?: string,
	timeoutMs: number = PRD_BRIDGE_TIMEOUT_MS
): Promise<PRDAnalysisResult> {
	const requestId = `prd-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

	analysisStatus.set('pending');
	analysisError.set(null);

	try {
		// Step 1: Write PRD to file for Claude to read
		const prdPath = await writePRDToFile(prdContent, requestId);

		// Step 2: Send request event
		const request: PRDAnalysisRequest = {
			prdPath,
			prdContent: prdContent.slice(0, 500) + (prdContent.length > 500 ? '...' : ''), // Summary only in event
			projectName,
			requestId,
			timestamp: new Date().toISOString()
		};

		await sendAnalysisRequest(request);
		analysisStatus.set('analyzing');

		// Step 3: Wait for response
		const result = await waitForAnalysisResponse(requestId, timeoutMs);

		analysisStatus.set('complete');
		analysisResult.set(result);

		return result;

	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		analysisStatus.set('error');
		analysisError.set(message);
		throw error;
	}
}

/**
 * Write PRD to a file that Claude Code can read
 */
async function writePRDToFile(content: string, requestId: string): Promise<string> {
	// Use the API to write the file
	const response = await fetch('/api/prd-bridge/write', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ content, requestId })
	});

	if (!response.ok) {
		throw new Error('Failed to write PRD file');
	}

	const { path } = await response.json();
	return path;
}

/**
 * Send analysis request event
 */
async function sendAnalysisRequest(request: PRDAnalysisRequest): Promise<void> {
	const response = await fetch('/api/events', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...getEventsAuthHeaders()
		},
		body: JSON.stringify({
			type: 'prd_analysis_requested',
			data: request,
			source: 'spawner-ui'
		})
	});

	if (!response.ok) {
		throw new Error('Failed to send analysis request');
	}

	logger.info('[PRDBridge] Analysis request sent:', request.requestId);
}

/**
 * Wait for Claude Code to respond with analysis
 */
function waitForAnalysisResponse(requestId: string, timeoutMs: number): Promise<PRDAnalysisResult> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error('Analysis timeout - Claude Code may not be connected'));
		}, timeoutMs);

		pendingRequests.set(requestId, { resolve, reject, timeout });
	});
}

/**
 * Handle analysis complete event from Claude Code
 */
function handleAnalysisComplete(event: BridgeEvent): void {
	const data = event.data as { requestId?: string; result?: PRDAnalysisResult };

	logger.info('[PRDBridge] Received analysis complete event:', data?.requestId);

	if (!data?.requestId) {
		console.warn('[PRDBridge] Received analysis without requestId');
		return;
	}

	// Always update the stores so UI can react
	if (data.result) {
		analysisResult.set(data.result);
		analysisStatus.set('complete');
		logger.info('[PRDBridge] Updated stores with result:', data.result.projectName);
	}

	// Also resolve any pending promise-based requests
	const pending = pendingRequests.get(data.requestId);
	if (pending) {
		clearTimeout(pending.timeout);
		pendingRequests.delete(data.requestId);

		if (data.result) {
			pending.resolve(data.result);
		} else {
			pending.reject(new Error('No result in analysis response'));
		}
	}
}

/**
 * Handle analysis error event from Claude Code
 */
function handleAnalysisError(event: BridgeEvent): void {
	const data = event.data as { requestId?: string; error?: string };

	if (!data?.requestId) return;

	const pending = pendingRequests.get(data.requestId);
	if (pending) {
		clearTimeout(pending.timeout);
		pendingRequests.delete(data.requestId);
		pending.reject(new Error(data.error || 'Analysis failed'));
	}
}

// =============================================================================
// CLAUDE CODE HELPER FUNCTIONS
// These are used by Claude Code to respond to analysis requests
// =============================================================================

/**
 * Format for Claude Code to send analysis result
 *
 * Claude Code should call:
 * EVENTS_AUTH_KEY="${EVENTS_API_KEY:-$MCP_API_KEY}"
 * curl -X POST http://localhost:3333/api/events \
 *   -H "Content-Type: application/json" \
 *   -H "x-api-key: $EVENTS_AUTH_KEY" \
 *   -d '{"type":"prd_analysis_complete","data":{"requestId":"...","result":{...}}}'
 */
export function getAnalysisResponseFormat(requestId: string, result: PRDAnalysisResult): string {
	return JSON.stringify({
		type: 'prd_analysis_complete',
		data: { requestId, result },
		source: 'claude-code'
	}, null, 2);
}

// =============================================================================
// PENDING RESULT CHECK
// Used by canvas page to recover from navigation before result arrived
// =============================================================================

/**
 * Check for a pending PRD analysis that has a stored result.
 * This handles the case where user navigated to canvas before the result arrived.
 *
 * Returns the result if found, null otherwise.
 */
export async function checkPendingPRDResult(): Promise<PRDAnalysisResult | null> {
	try {
		const authHeaders = getEventsAuthHeaders();
		// Check if there's a pending request
		const pendingResponse = await fetch('/api/prd-bridge/pending', { headers: authHeaders });
		const pendingData = await pendingResponse.json();

		if (!pendingData.pending || !pendingData.requestId) {
			return null;
		}

		// Check if there's a stored result for this request
		const resultResponse = await fetch(`/api/prd-bridge/result?requestId=${pendingData.requestId}`, {
			headers: authHeaders
		});
		const resultData = await resultResponse.json();

		if (!resultData.found || !resultData.result) {
			return null;
		}

		logger.info('[PRDBridge] Found pending result:', resultData.result.projectName);

		// Clear the pending request now that we've found the result
		await fetch('/api/prd-bridge/pending', { method: 'DELETE', headers: authHeaders });

		return resultData.result;
	} catch (error) {
		console.error('[PRDBridge] Error checking pending result:', error);
		return null;
	}
}

// =============================================================================
// WORKFLOW CONVERSION
// Converts PRD analysis result to canvas workflow
// =============================================================================

export interface WorkflowFromPRD {
	nodes: { skill: Skill; position: { x: number; y: number } }[];
	connections: { sourceIndex: number; targetIndex: number }[];
	projectName: string;
}

/**
 * Convert a PRD analysis result to a canvas workflow.
 * This function can be used from both Welcome.svelte and canvas page.
 */
export function prdResultToWorkflow(result: PRDAnalysisResult, skillsList: Skill[]): WorkflowFromPRD {
	const nodes: { skill: Skill; position: { x: number; y: number } }[] = [];
	const connections: { sourceIndex: number; targetIndex: number }[] = [];

	// Create a skill lookup map for category inference
	const skillMap = new Map<string, Skill>();
	for (const skill of skillsList) {
		skillMap.set(skill.id.toLowerCase(), skill);
	}

	// Infer category from task skills
	function inferCategory(taskSkills: string[]): Skill['category'] {
		for (const skillId of taskSkills) {
			const skill = skillMap.get(skillId.toLowerCase());
			if (skill) return skill.category;
		}
		return 'development';
	}

	// Layout constants
	const NODE_WIDTH = 300;
	const NODE_HEIGHT = 140;
	const HORIZONTAL_GAP = 100;
	const VERTICAL_GAP = 60;
	const START_X = 100;
	const START_Y = 100;
	const MAX_PER_ROW = 4; // Wrap to next row after this many in a single rank

	// ── Layered layout ─────────────────────────────────────────────────
	// Assign each task a "depth" (longest path from any root via dependsOn).
	// Tasks with no deps land in column 0. A task that depends on a depth-N
	// task lands at depth >= N+1. Same-depth tasks stack in a single column,
	// wrapping to multiple sub-rows when a column gets too tall to keep the
	// canvas readable instead of spaghetti.

	const taskById = new Map<string, typeof result.tasks[number]>();
	for (const t of result.tasks) taskById.set(t.id, t);

	function dependenciesOf(task: typeof result.tasks[number]): string[] {
		return task.dependsOn || task.dependencies || [];
	}

	function descriptionOf(task: typeof result.tasks[number]): string {
		const lines = [task.description || task.summary || task.title];
		if (task.acceptanceCriteria?.length) {
			lines.push('', 'Acceptance criteria:', ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`));
		}
		if (task.verificationCommands?.length) {
			lines.push('', 'Verification commands:', ...task.verificationCommands.map((command) => `- ${command}`));
		}
		return lines.join('\n');
	}

	const depthCache = new Map<string, number>();
	function depthOf(taskId: string, stack: Set<string> = new Set()): number {
		if (depthCache.has(taskId)) return depthCache.get(taskId)!;
		if (stack.has(taskId)) return 0; // cycle guard
		const task = taskById.get(taskId);
		if (!task) return 0;
		stack.add(taskId);
		let d = 0;
		for (const dep of dependenciesOf(task)) {
			if (taskById.has(dep)) d = Math.max(d, depthOf(dep, stack) + 1);
		}
		// If a task has no deps but a non-1 phase, respect the phase as a hint
		if (dependenciesOf(task).length === 0 && task.phase && task.phase > 1) {
			d = Math.max(d, task.phase - 1);
		}
		stack.delete(taskId);
		depthCache.set(taskId, d);
		return d;
	}

	// Bucket tasks by depth, preserving incoming order
	const byDepth = new Map<number, typeof result.tasks>();
	for (const task of result.tasks) {
		const d = depthOf(task.id);
		if (!byDepth.has(d)) byDepth.set(d, []);
		byDepth.get(d)!.push(task);
	}

	const taskIndexMap = new Map<string, number>();
	let nodeIndex = 0;
	const sortedDepths = [...byDepth.keys()].sort((a, b) => a - b);

	for (const d of sortedDepths) {
		const column = byDepth.get(d)!;
		// If a column gets too tall, wrap into sub-columns to avoid a thin spike
		const subColumns = Math.ceil(column.length / MAX_PER_ROW);
		const colHeight = Math.ceil(column.length / subColumns);

		for (let i = 0; i < column.length; i++) {
			const task = column[i];
			const subCol = Math.floor(i / colHeight);
			const rowInSub = i % colHeight;

			const taskNode: Skill = {
				id: task.id,
				name: task.title,
				description: descriptionOf(task),
				category: inferCategory(task.skills),
				tier: 'free',
				tags: task.skills,
				triggers: [],
				skillChain: task.skills
			};

			const position = {
				x: START_X + (d + subCol) * (NODE_WIDTH + HORIZONTAL_GAP),
				y: START_Y + rowInSub * (NODE_HEIGHT + VERTICAL_GAP)
			};

			nodes.push({ skill: taskNode, position });
			taskIndexMap.set(task.id, nodeIndex);
			nodeIndex++;
		}
	}

	// Connections from explicit dependsOn
	for (const task of result.tasks) {
		const targetIndex = taskIndexMap.get(task.id);
		if (targetIndex === undefined) continue;
		for (const depId of dependenciesOf(task)) {
			const sourceIndex = taskIndexMap.get(depId);
			if (sourceIndex !== undefined) {
				connections.push({ sourceIndex, targetIndex });
			}
		}
	}

	// Fallback — if no explicit dependencies were declared, chain tasks
	return { nodes, connections, projectName: result.projectName || 'PRD Pipeline' };
}
