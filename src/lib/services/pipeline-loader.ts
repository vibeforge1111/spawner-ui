/**
 * Pipeline Loader - Single Source of Truth
 *
 * This service is the ONLY way pipelines get loaded to the canvas.
 * It eliminates race conditions by using a file-based queue.
 *
 * HOW IT WORKS:
 * 1. When PRD/goal/anything wants to load a pipeline, it calls queuePipelineLoad()
 * 2. This writes to pending-load.json in the configured Spawner state root
 * 3. Canvas onMount calls getPendingLoad() which reads and DELETES the file
 * 4. If no pending load, canvas falls back to active pipeline from localStorage
 *
 * NO MORE:
 * - sessionStorage hints
 * - Multiple competing paths
 * - Race conditions between stores
 */

import { browser } from '$app/environment';
import type { Skill } from '$lib/stores/skills.svelte';
import { logger } from '$lib/utils/logger';

const log = logger.scope('PipelineLoader');

export interface PendingPipelineLoad {
	pipelineId: string;
	pipelineName: string;
	nodes: Array<{ skill: Skill; position: { x: number; y: number } }>;
	connections: Array<{ sourceIndex: number; targetIndex: number; sourcePortId?: string; targetPortId?: string }>;
	source: 'prd' | 'prd-bridge' | 'creator-mission' | 'goal' | 'new' | 'switch';
	buildMode?: 'direct' | 'advanced_prd';
	buildModeReason?: string;
	executionPrompt?: string;
	executionAuthority?: unknown;
	autoRun?: boolean;
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
	timestamp: string;
}

const PENDING_LOAD_ENDPOINT = '/api/pipeline-loader';

/**
 * Queue a pipeline to be loaded on next canvas mount.
 * This is the ONLY way to ensure a pipeline loads correctly.
 */
export async function queuePipelineLoad(load: Omit<PendingPipelineLoad, 'timestamp'>): Promise<boolean> {
	if (!browser) return false;

	try {
		const payload: PendingPipelineLoad = {
			...load,
			timestamp: new Date().toISOString()
		};

		// NOTE: This fetch() has no AbortController. Long-running servers can hang the request indefinitely. Add { signal: AbortSignal.timeout(30000) } to bound the wait.
		const response = await fetch(PENDING_LOAD_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});

		if (!response.ok) {
			console.error('[PipelineLoader] Failed to queue load:', response.statusText);
			return false;
		}

		log.info(
			`Queued pipeline load: ${load.pipelineName} with ${load.nodes.length} nodes and ${load.connections.length} connections`
		);
		return true;
	} catch (error) {
		console.error('[PipelineLoader] Error queueing load:', error);
		return false;
	}
}

/**
 * Get and consume the pending pipeline load.
 * Returns the load data and consumes it server-side.
 * The API GET already deletes the pending file.
 */
export async function getPendingLoad(requestedPipelineId: string | null = null): Promise<PendingPipelineLoad | null> {
	if (!browser) return null;

	try {
		const url = requestedPipelineId
			? `${PENDING_LOAD_ENDPOINT}?pipeline=${encodeURIComponent(requestedPipelineId)}`
			: PENDING_LOAD_ENDPOINT;
		const response = await fetch(url, {
			method: 'GET'
		});

		if (!response.ok) {
			if (response.status === 404) {
				// No pending load - this is normal
				return null;
			}
			console.error('[PipelineLoader] Failed to get pending load:', response.statusText);
			return null;
		}

		const data = await response.json();

		if (!data.pending) {
			return null;
		}

		log.info(`Found pending load: ${data.load.pipelineName}`);

		return data.load as PendingPipelineLoad;
	} catch (error) {
		console.error('[PipelineLoader] Error getting pending load:', error);
		return null;
	}
}

/**
 * Get the most recent queued canvas load without consuming it.
 * This lets /canvas recover when another tab consumed the one-shot queue
 * before the user's visible tab had valid pipeline state saved locally.
 */
export async function getLatestPipelineLoad(requestedPipelineId: string | null = null): Promise<PendingPipelineLoad | null> {
	if (!browser) return null;

	try {
		const url = requestedPipelineId
			? `${PENDING_LOAD_ENDPOINT}?latest=true&pipeline=${encodeURIComponent(requestedPipelineId)}`
			: `${PENDING_LOAD_ENDPOINT}?latest=true`;
		const response = await fetch(url, {
			method: 'GET'
		});

		if (!response.ok) {
			console.error('[PipelineLoader] Failed to get latest load:', response.statusText);
			return null;
		}

		const data = await response.json();
		if (!data.pending) {
			return null;
		}

		return data.load as PendingPipelineLoad;
	} catch (error) {
		console.error('[PipelineLoader] Error getting latest load:', error);
		return null;
	}
}

/**
 * Check if there's a pending load WITHOUT consuming it.
 * Use this to show loading indicators.
 */
export async function hasPendingLoad(): Promise<boolean> {
	if (!browser) return false;

	try {
		const response = await fetch(`${PENDING_LOAD_ENDPOINT}?peek=true`);
		if (!response.ok) return false;
		const data = await response.json();
		return data.pending === true;
	} catch {
		return false;
	}
}
