/**
 * Pipeline Loader API
 *
 * Single endpoint for the file-based pipeline loading queue.
 * This eliminates race conditions by persisting load requests to disk.
 *
 * POST - Queue a pipeline to load
 * GET  - Get (and consume) the pending load
 * DELETE - Clear the pending load
 */

import { json, type RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { logger } from '$lib/utils/logger';
import { spawnerStateDir } from '$lib/server/spawner-state';
import { parseJsonOrFallback } from '$lib/utils/safe-json';
import { enforceRateLimit, requireControlAuth } from '$lib/server/mcp-auth';
import { stripAuthorityResidue } from '$lib/server/authority-residue';

const log = logger.scope('PipelineLoader');

function getSpawnerDir(): string {
	return spawnerStateDir();
}

function getPendingLoadFile(): string {
	return join(getSpawnerDir(), 'pending-load.json');
}

function getLastLoadFile(): string {
	return join(getSpawnerDir(), 'last-canvas-load.json');
}

function getLoadArchiveDir(): string {
	return join(getSpawnerDir(), 'canvas-loads');
}

function safeLoadFileKey(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'unknown';
}

function getArchivedLoadFile(pipelineId: string): string {
	return join(getLoadArchiveDir(), `${safeLoadFileKey(pipelineId)}.json`);
}

// Ensure the configured Spawner state directory exists.
async function ensureDir(): Promise<void> {
	const spawnerDir = getSpawnerDir();
	if (!existsSync(spawnerDir)) {
		await mkdir(spawnerDir, { recursive: true });
	}
	const archiveDir = getLoadArchiveDir();
	if (!existsSync(archiveDir)) {
		await mkdir(archiveDir, { recursive: true });
	}
}

function requirePipelineLoaderMutationAuth(event: RequestEvent): Response | null {
	return requireControlAuth(event, {
		surface: 'PipelineLoader',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
}

function requirePipelineLoaderReadAuth(event: RequestEvent): Response | null {
	return requireControlAuth(event, {
		surface: 'PipelineLoader',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: true,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
}

function renderSafePipelineLoad(load: Record<string, unknown>): Record<string, unknown> {
	const { executionPrompt, relay, autoRun, ...rest } = load;
	return {
		...rest,
		autoRun: false,
		authorityBoundary: {
			payload: 'render_only',
			executionPrompt: 'requires_control_auth',
			relay: 'requires_control_auth',
			consume: 'requires_control_auth'
		}
	};
}

/**
 * POST - Queue a pipeline to load
 */
export const POST: RequestHandler = async (event) => {
	const unauthorized = requireControlAuth(event, { surface: 'PipelineLoaderAPI', apiKeyEnvVar: 'MCP_API_KEY' });
	if (unauthorized) return unauthorized;
	const { request } = event;

	try {
		const { request } = event;
		await ensureDir();
		const payload = await request.json();

		// Validate required fields
		if (!payload.pipelineId || !payload.pipelineName) {
			return json({ error: 'pipelineId and pipelineName are required' }, { status: 400 });
		}

		// Ensure nodes and connections are arrays
		const load = stripAuthorityResidue({
			pipelineId: payload.pipelineId,
			pipelineName: payload.pipelineName,
			nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
			connections: Array.isArray(payload.connections) ? payload.connections : [],
			source: payload.source || 'new',
			buildMode: payload.buildMode,
			buildModeReason: payload.buildModeReason,
			executionPrompt: payload.executionPrompt,
			autoRun: payload.autoRun === true,
			relay: payload.relay,
			timestamp: payload.timestamp || new Date().toISOString()
		});

		await writeFile(getPendingLoadFile(), JSON.stringify(load, null, 2), 'utf-8');
		await writeFile(getLastLoadFile(), JSON.stringify(load, null, 2), 'utf-8');
		await writeFile(getArchivedLoadFile(String(load.pipelineId)), JSON.stringify(load, null, 2), 'utf-8');

		log.info(`Queued: ${load.pipelineName} (${load.nodes.length} nodes, ${load.connections.length} connections)`);

		return json({ success: true, queued: load.pipelineName });
	} catch (error) {
		console.error('[PipelineLoader] POST error:', error);
		return json({ error: 'Failed to queue pipeline load' }, { status: 500 });
	}
};

/**
 * GET - Get the pending load (optionally peek without consuming)
 */
export const GET: RequestHandler = async (event) => {
	const unauthorized = requireControlAuth(event, { surface: 'PipelineLoaderAPI', apiKeyEnvVar: 'MCP_API_KEY' });
	if (unauthorized) return unauthorized;
	const { url } = event;

	try {
		const { url } = event;
		const canConsumeLoad = requirePipelineLoaderMutationAuth(event) === null;
		const peek = url.searchParams.get('peek') === 'true';
		const latest = url.searchParams.get('latest') === 'true';
		const requestedPipelineId = url.searchParams.get('pipeline')?.trim() || null;
		let loadFile = latest && requestedPipelineId ? getArchivedLoadFile(requestedPipelineId) : latest ? getLastLoadFile() : getPendingLoadFile();
		if (latest && requestedPipelineId && !existsSync(loadFile)) {
			loadFile = getLastLoadFile();
		}

		if (!existsSync(loadFile)) {
			return json({ pending: false });
		}

		const content = await readFile(loadFile, 'utf-8');
		const load = parseJsonOrFallback<Record<string, unknown>>(content, {}, 'pipeline-loader');
		if (requestedPipelineId && load?.pipelineId !== requestedPipelineId) {
			return json({ pending: false });
		}

		// If not peeking, delete the file (consume the load). Multiple canvas
		// tabs can race here; the read load is still valid even when another
		// client deletes the queue file first or Windows briefly denies unlink.
		if (!peek && !latest && canConsumeLoad) {
			try {
				await unlink(loadFile);
				log.info(`Consumed: ${load.pipelineName}`);
			} catch (unlinkError) {
				const code = unlinkError && typeof unlinkError === 'object' && 'code' in unlinkError
					? String((unlinkError as { code?: unknown }).code)
					: 'unknown';
				if (code === 'ENOENT' || code === 'EPERM') {
					console.warn(`[PipelineLoader] Queue already consumed or locked after read (${code}); returning load anyway.`);
				} else {
					throw unlinkError;
				}
			}
		}

		return json({
			pending: true,
			load: canConsumeLoad ? load : renderSafePipelineLoad(load),
			consumed: !peek && !latest && canConsumeLoad
		});
	} catch (error) {
		console.error('[PipelineLoader] GET error:', error);
		return json({ pending: false });
	}
};

/**
 * DELETE - Clear the pending load
 */
export const DELETE: RequestHandler = async (event) => {
	const unauthorized = requireControlAuth(event, { surface: 'PipelineLoaderAPI', apiKeyEnvVar: 'MCP_API_KEY' });
	if (unauthorized) return unauthorized;

	try {
		const pendingLoadFile = getPendingLoadFile();
		if (existsSync(pendingLoadFile)) {
			await unlink(pendingLoadFile);
			log.info('Cleared pending load');
		}
		return json({ success: true });
	} catch (error) {
		console.error('[PipelineLoader] DELETE error:', error);
		return json({ error: 'Failed to clear pending load' }, { status: 500 });
	}
};
