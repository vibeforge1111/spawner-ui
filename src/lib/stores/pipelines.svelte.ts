import { logger } from '$lib/utils/logger';
/**
 * Pipeline Manager Store
 *
 * Manages multiple named canvas pipelines with save/load/switch functionality.
 */

import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import { z } from 'zod';
import { CanvasStoreConnectionSchema, CanvasStoreNodeSchema, safeJsonParse } from '$lib/types/schemas';
import type { CanvasNode, Connection } from '$lib/stores/canvas.svelte';

const PIPELINES_KEY = 'spawner-pipelines';
const PIPELINE_PREFIX = 'spawner-pipeline-';

// =============================================================================
// Zod Schemas for Pipeline Validation
// =============================================================================

const PipelineMetadataSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
	nodeCount: z.number(),
	connectionCount: z.number(),
	createdAt: z.string(),
	updatedAt: z.string(),
	thumbnail: z.string().optional()
});

const PipelineDataSchema = z.object({
	nodes: z.array(CanvasStoreNodeSchema),
	connections: z.array(CanvasStoreConnectionSchema),
	zoom: z.number().optional().default(1),
	pan: z.object({ x: z.number(), y: z.number() }).optional().default({ x: 0, y: 0 })
});

const PipelinesRegistrySchema = z.object({
	pipelines: z.array(PipelineMetadataSchema),
	activePipelineId: z.string().nullable()
});

const PipelineImportSchema = z.object({
	version: z.number().optional(),
	metadata: PipelineMetadataSchema.optional(),
	data: PipelineDataSchema.optional(),
	pipelines: z.array(PipelineMetadataSchema).optional()
}).passthrough();

// =============================================================================
// Type Definitions
// =============================================================================

export interface PipelineMetadata {
	id: string;
	name: string;
	description?: string;
	nodeCount: number;
	connectionCount: number;
	createdAt: string;
	updatedAt: string;
	thumbnail?: string;
}

export interface PipelineData {
	nodes: CanvasNode[];
	connections: Connection[];
	zoom: number;
	pan: { x: number; y: number };
}

interface PipelinesState {
	pipelines: PipelineMetadata[];
	activePipelineId: string | null;
	isLoading: boolean;
}

const initialState: PipelinesState = {
	pipelines: [],
	activePipelineId: null,
	isLoading: true
};

// Create the store
export const pipelinesState = writable<PipelinesState>(initialState);

// Derived stores for convenience
export const pipelines = derived(pipelinesState, $state => $state.pipelines);
export const activePipelineId = derived(pipelinesState, $state => $state.activePipelineId);
export const activePipeline = derived(pipelinesState, $state =>
	$state.pipelines.find(p => p.id === $state.activePipelineId) || null
);
export const isLoading = derived(pipelinesState, $state => $state.isLoading);

/**
 * Generate a unique pipeline ID
 */
function generateId(): string {
	return `pipe-${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Get storage key for a pipeline's data
 */
function getPipelineStorageKey(id: string): string {
	return `${PIPELINE_PREFIX}${id}`;
}

/**
 * Save pipelines registry to localStorage
 */
function saveRegistry(): void {
	if (!browser) return;
	const state = get(pipelinesState);
	localStorage.setItem(PIPELINES_KEY, JSON.stringify({
		pipelines: state.pipelines,
		activePipelineId: state.activePipelineId
	}));
}

/**
 * Initialize pipelines from localStorage
 */
export function initPipelines(): void {
	if (!browser) return;

	try {
		const saved = localStorage.getItem(PIPELINES_KEY);

		if (saved) {
			// SECURITY: Validate JSON with Zod schema
			const data = safeJsonParse(saved, PipelinesRegistrySchema, 'pipelines-registry');
			if (data) {
				pipelinesState.update(state => ({
					...state,
					pipelines: data.pipelines || [],
					activePipelineId: data.activePipelineId || null,
					isLoading: false
				}));
			} else {
				console.warn('[Pipelines] Invalid registry data, starting fresh');
				pipelinesState.update(state => ({ ...state, isLoading: false }));
			}
		} else {
			// First time - migrate from old single canvas if exists
			const oldCanvas = localStorage.getItem('spawner-canvas-state');
			if (oldCanvas) {
				// SECURITY: Validate JSON with Zod schema
				const canvasData = safeJsonParse(oldCanvas, PipelineDataSchema, 'canvas-migration') as unknown as PipelineData | undefined;
				if (!canvasData) {
					console.warn('[Pipelines] Invalid old canvas data, skipping migration');
					pipelinesState.update(state => ({ ...state, isLoading: false }));
					return;
				}
				const newPipeline = createPipelineFromData('My First Pipeline', canvasData);
				pipelinesState.update(state => ({
					...state,
					pipelines: [newPipeline.metadata],
					activePipelineId: newPipeline.metadata.id,
					isLoading: false
				}));
				// Save the pipeline data
				localStorage.setItem(getPipelineStorageKey(newPipeline.metadata.id), JSON.stringify(newPipeline.data));
				saveRegistry();
				// Clean up old format
				localStorage.removeItem('spawner-canvas-state');
			} else {
				// Create a default empty pipeline
				const defaultPipeline = createNewPipeline('Untitled Pipeline');
				pipelinesState.update(state => ({
					...state,
					isLoading: false
				}));
			}
		}
	} catch (e) {
		console.error('Failed to load pipelines:', e);
		pipelinesState.update(state => ({ ...state, isLoading: false }));
	}
}

/**
 * Create a new pipeline from existing canvas data
 */
function createPipelineFromData(name: string, canvasData: Partial<PipelineData>): { metadata: PipelineMetadata; data: PipelineData } {
	const id = generateId();
	const now = new Date().toISOString();

	return {
		metadata: {
			id,
			name,
			nodeCount: canvasData.nodes?.length || 0,
			connectionCount: canvasData.connections?.length || 0,
			createdAt: now,
			updatedAt: now
		},
		data: {
			nodes: canvasData.nodes || [],
			connections: canvasData.connections || [],
			zoom: canvasData.zoom || 1,
			pan: canvasData.pan || { x: 0, y: 0 }
		}
	};
}

/**
 * Create a new empty pipeline
 *
 * Note: Pipeline loading is now handled by the file-based pipeline-loader system.
 * Use queuePipelineLoad() from '$lib/services/pipeline-loader' to queue a pipeline
 * with nodes/connections, then navigate to /canvas.
 */
export function createNewPipeline(name: string = 'Untitled Pipeline'): PipelineMetadata {
	if (!browser) throw new Error('Cannot create pipeline on server');

	const id = generateId();
	const now = new Date().toISOString();

	const metadata: PipelineMetadata = {
		id,
		name,
		nodeCount: 0,
		connectionCount: 0,
		createdAt: now,
		updatedAt: now
	};

	const data: PipelineData = {
		nodes: [],
		connections: [],
		zoom: 1,
		pan: { x: 0, y: 0 }
	};

	// Save pipeline data
	localStorage.setItem(getPipelineStorageKey(id), JSON.stringify(data));

	// Update registry
	pipelinesState.update(state => ({
		...state,
		pipelines: [...state.pipelines, metadata],
		activePipelineId: id
	}));
	saveRegistry();

	logger.info('[Pipelines] Created new pipeline:', id, name);

	return metadata;
}

/**
 * Ensure a pipeline exists with a specific ID and make it active.
 * Used by file-queued loads to preserve stable IDs across navigation/processes.
 */
export function ensurePipeline(id: string, name: string = 'Untitled Pipeline'): PipelineMetadata {
	if (!browser) throw new Error('Cannot ensure pipeline on server');

	const state = get(pipelinesState);
	const existing = state.pipelines.find((p) => p.id === id);
	const now = new Date().toISOString();

	if (existing) {
		const shouldRename = existing.name !== name;
		pipelinesState.update((s) => ({
			...s,
			activePipelineId: id,
			pipelines: s.pipelines.map((p) =>
				p.id === id
					? {
						...p,
						name: shouldRename ? name : p.name,
						updatedAt: shouldRename ? now : p.updatedAt
					}
					: p
			)
		}));
		saveRegistry();
		return { ...existing, name: shouldRename ? name : existing.name, updatedAt: shouldRename ? now : existing.updatedAt };
	}

	const metadata: PipelineMetadata = {
		id,
		name,
		nodeCount: 0,
		connectionCount: 0,
		createdAt: now,
		updatedAt: now
	};

	const data: PipelineData = {
		nodes: [],
		connections: [],
		zoom: 1,
		pan: { x: 0, y: 0 }
	};

	localStorage.setItem(getPipelineStorageKey(id), JSON.stringify(data));

	pipelinesState.update((s) => ({
		...s,
		pipelines: [...s.pipelines, metadata],
		activePipelineId: id
	}));
	saveRegistry();

	return metadata;
}

/**
 * Switch to a different pipeline
 */
export function switchPipeline(id: string): PipelineData | null {
	if (!browser) return null;

	const state = get(pipelinesState);
	const pipeline = state.pipelines.find(p => p.id === id);

	if (!pipeline) {
		console.error('Pipeline not found:', id);
		return null;
	}

	// Save current pipeline first
	saveCurrentPipeline();

	// Load the new pipeline data
	try {
		const saved = localStorage.getItem(getPipelineStorageKey(id));
		if (saved) {
			// SECURITY: Validate JSON with Zod schema
			const data = safeJsonParse(saved, PipelineDataSchema, 'pipeline-data') as unknown as PipelineData | undefined;
			if (!data) {
				console.error('Invalid pipeline data for:', id);
				return null;
			}

			// Update active pipeline
			pipelinesState.update(state => ({
				...state,
				activePipelineId: id
			}));
			saveRegistry();

			return data as PipelineData;
		}
	} catch (e) {
		console.error('Failed to load pipeline:', e);
	}

	return null;
}

/**
 * Save current pipeline data
 */
export function saveCurrentPipeline(canvasData?: PipelineData): void {
	if (!browser) return;

	const state = get(pipelinesState);
	if (!state.activePipelineId) return;

	// If no canvas data provided, we can't save (caller should provide it)
	if (!canvasData) return;

	const data: PipelineData = {
		nodes: canvasData.nodes,
		connections: canvasData.connections,
		zoom: canvasData.zoom,
		pan: canvasData.pan
	};

	// Save pipeline data
	localStorage.setItem(getPipelineStorageKey(state.activePipelineId), JSON.stringify(data));

	// Update metadata
	pipelinesState.update(s => ({
		...s,
		pipelines: s.pipelines.map(p =>
			p.id === state.activePipelineId
				? {
					...p,
					nodeCount: canvasData.nodes.length,
					connectionCount: canvasData.connections.length,
					updatedAt: new Date().toISOString()
				}
				: p
		)
	}));
	saveRegistry();
}

/**
 * Rename a pipeline
 */
export function renamePipeline(id: string, newName: string): void {
	if (!browser) return;

	pipelinesState.update(state => ({
		...state,
		pipelines: state.pipelines.map(p =>
			p.id === id ? { ...p, name: newName, updatedAt: new Date().toISOString() } : p
		)
	}));
	saveRegistry();
}

/**
 * Duplicate a pipeline
 */
export function duplicatePipeline(id: string): PipelineMetadata | null {
	if (!browser) return null;

	const state = get(pipelinesState);
	const original = state.pipelines.find(p => p.id === id);

	if (!original) return null;

	try {
		const originalData = localStorage.getItem(getPipelineStorageKey(id));
		if (!originalData) return null;

		const newId = generateId();
		const now = new Date().toISOString();

		const newMetadata: PipelineMetadata = {
			...original,
			id: newId,
			name: `${original.name} (Copy)`,
			createdAt: now,
			updatedAt: now
		};

		// Save duplicated data
		localStorage.setItem(getPipelineStorageKey(newId), originalData);

		// Update registry
		pipelinesState.update(state => ({
			...state,
			pipelines: [...state.pipelines, newMetadata]
		}));
		saveRegistry();

		return newMetadata;
	} catch (e) {
		console.error('Failed to duplicate pipeline:', e);
		return null;
	}
}

/**
 * Delete a pipeline
 */
export function deletePipeline(id: string): boolean {
	if (!browser) return false;

	const state = get(pipelinesState);

	// Don't delete the last pipeline
	if (state.pipelines.length <= 1) {
		console.warn('Cannot delete the last pipeline');
		return false;
	}

	// Remove pipeline data
	localStorage.removeItem(getPipelineStorageKey(id));

	// Update registry
	pipelinesState.update(s => {
		const newPipelines = s.pipelines.filter(p => p.id !== id);
		const newActiveId = s.activePipelineId === id
			? newPipelines[0]?.id || null
			: s.activePipelineId;

		return {
			...s,
			pipelines: newPipelines,
			activePipelineId: newActiveId
		};
	});
	saveRegistry();

	return true;
}

/**
 * Load a specific pipeline's data
 */
export function loadPipelineData(id: string): PipelineData | null {
	if (!browser) return null;

	try {
		const saved = localStorage.getItem(getPipelineStorageKey(id));
		if (saved) {
			// SECURITY: Validate JSON with Zod schema
			const data = safeJsonParse(saved, PipelineDataSchema, 'pipeline-data-load') as unknown as PipelineData | undefined;
			return (data as PipelineData) || null;
		}
	} catch (e) {
		console.error('Failed to load pipeline data:', e);
	}

	return null;
}

/**
 * Get the active pipeline's data
 */
export function getActivePipelineData(): PipelineData | null {
	const state = get(pipelinesState);
	if (!state.activePipelineId) return null;
	return loadPipelineData(state.activePipelineId);
}

/**
 * Update pipeline description
 */
export function updatePipelineDescription(id: string, description: string): void {
	if (!browser) return;

	pipelinesState.update(state => ({
		...state,
		pipelines: state.pipelines.map(p =>
			p.id === id ? { ...p, description, updatedAt: new Date().toISOString() } : p
		)
	}));
	saveRegistry();
}

/**
 * Export a pipeline to a JSON file
 */
export function exportPipeline(id: string): void {
	if (!browser) return;

	const metadata = get(pipelines).find(p => p.id === id);
	const data = loadPipelineData(id);

	if (!metadata || !data) {
		console.error('Pipeline not found:', id);
		return;
	}

	const exportData = {
		version: '1.0.0',
		metadata: {
			...metadata,
			exportedAt: new Date().toISOString()
		},
		data
	};

	// Create download link
	const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${metadata.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_pipeline.json`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);

	logger.info('[Pipelines] Exported pipeline:', metadata.name);
}

/**
 * Import a pipeline from a JSON file
 */
export async function importPipeline(file: File): Promise<PipelineMetadata | null> {
	if (!browser) return null;

	try {
		const text = await file.text();

		// SECURITY: Validate JSON with Zod schema
		const importData = safeJsonParse(text, PipelineImportSchema, 'pipeline-import');
		if (!importData) {
			throw new Error('Invalid pipeline file: failed schema validation');
		}

		// Validate required fields
		if (!importData.version || !importData.metadata || !importData.data) {
			throw new Error('Invalid pipeline file format');
		}

		// Create new pipeline with imported data
		const newId = generateId();
		const now = new Date().toISOString();

		const newMetadata: PipelineMetadata = {
			id: newId,
			name: `${importData.metadata.name} (imported)`,
			description: importData.metadata.description,
			nodeCount: importData.data.nodes?.length || 0,
			connectionCount: importData.data.connections?.length || 0,
			createdAt: now,
			updatedAt: now
		};

		// Save the pipeline data
		localStorage.setItem(getPipelineStorageKey(newId), JSON.stringify(importData.data));

		// Add to registry
		pipelinesState.update(state => ({
			...state,
			pipelines: [...state.pipelines, newMetadata],
			activePipelineId: newId // Switch to imported pipeline
		}));

		saveRegistry();

		logger.info('[Pipelines] Imported pipeline:', newMetadata.name);
		return newMetadata;
	} catch (e) {
		console.error('[Pipelines] Import failed:', e);
		return null;
	}
}

/**
 * Export all pipelines as a backup
 */
export function exportAllPipelines(): void {
	if (!browser) return;

	const allPipelines = get(pipelines);
	const exportData = {
		version: '1.0.0',
		exportedAt: new Date().toISOString(),
		pipelines: allPipelines.map(metadata => ({
			metadata,
			data: loadPipelineData(metadata.id)
		}))
	};

	// Create download link
	const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `spawner_pipelines_backup_${Date.now()}.json`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);

	logger.info('[Pipelines] Exported all pipelines:', allPipelines.length);
}
