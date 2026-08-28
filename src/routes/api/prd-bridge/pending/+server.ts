/**
 * PRD Bridge - Pending Endpoint
 *
 * Returns any pending PRD analysis requests.
 * Claude Code can poll this endpoint or check the file directly.
 *
 * GET /api/prd-bridge/pending - Get pending request info
 * DELETE /api/prd-bridge/pending - Clear the pending request after processing
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { reconcilePendingPrdCanonicalResult } from '$lib/server/prd-canonical-result-reconciliation';
import { writeFileAtomic } from '$lib/server/atomic-write';
import { spawnerStateDir } from '$lib/server/spawner-state';
import { requireControlAuth } from '$lib/server/mcp-auth';

const PRD_BRIDGE_PENDING_AUTH = {
	surface: 'PRDBridgePending',
	apiKeyEnvVar: 'EVENTS_API_KEY',
	fallbackApiKeyEnvVar: 'MCP_API_KEY',
	apiKeyQueryParam: 'apiKey',
	apiKeyCookieName: 'spawner_events_api_key',
	allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
} as const;

function getPrdBridgePaths() {
	const spawnerDir = spawnerStateDir();
	return {
		pendingPrdFile: join(spawnerDir, 'pending-prd.md'),
		pendingRequestFile: join(spawnerDir, 'pending-request.json')
	};
}

/**
 * GET - Check if there's a pending PRD analysis request
 */
export const GET: RequestHandler = async (event) => {
	const unauthorized = requireControlAuth(event, {
		...PRD_BRIDGE_PENDING_AUTH,
		allowLoopbackWithoutKey: true,
	});
	if (unauthorized) return unauthorized;

	try {
		const { pendingPrdFile, pendingRequestFile } = getPrdBridgePaths();
		const canReadWorkerPayload = requireControlAuth(event, {
			...PRD_BRIDGE_PENDING_AUTH,
			allowLoopbackWithoutKey: false
		}) === null;

		if (!existsSync(pendingRequestFile)) {
			return json({ pending: false });
		}

		const requestMeta = JSON.parse(await readFile(pendingRequestFile, 'utf-8'));
		const requestId = typeof requestMeta.requestId === 'string' ? requestMeta.requestId : undefined;
		if (canReadWorkerPayload) {
			const canonicalResult = await reconcilePendingPrdCanonicalResult({
				requestId,
				source: 'prd_bridge_pending_get'
			});
			if (canonicalResult.reconciled || canonicalResult.reason === 'already_complete') {
				return json({ pending: false });
			}
		}

		// Only return if status is pending
		if (requestMeta.status !== 'pending') {
			return json({ pending: false });
		}

		if (!canReadWorkerPayload) {
			return json({
				pending: true,
				requestId: requestMeta.requestId,
				missionId: requestMeta.missionId,
				projectName: requestMeta.projectName,
				timestamp: requestMeta.timestamp,
				authorityBoundary: {
					payload: 'metadata_only',
					prdContent: 'requires_control_auth',
					reconciliation: 'requires_control_auth'
				}
			});
		}

		// Read the PRD content
		let prdContent = '';
		// NOTE: existsSync check then use is a TOCTOU pattern in concurrent code. The file may be deleted between the check and the read. Consider using try/catch ENOENT or async fs.promises.access.
		if (existsSync(pendingPrdFile)) {
			prdContent = await readFile(pendingPrdFile, 'utf-8');
		}

		return json({
			pending: true,
			requestId: requestMeta.requestId,
			missionId: requestMeta.missionId,
			projectName: requestMeta.projectName,
			timestamp: requestMeta.timestamp,
			prdContent,
			options: requestMeta.options || { includeSkills: true, includeMCPs: true },
			relay: requestMeta.relay || null,
			buildMode: requestMeta.buildMode || null,
			buildModeReason: requestMeta.buildModeReason || null
		});
	} catch (error) {
		console.error('[PRDBridge] Error reading pending request:', error);
		return json({ pending: false, error: 'Failed to read pending request' });
	}
};

/**
 * DELETE - Clear the pending request (mark as processed)
 */
export const DELETE: RequestHandler = async (event) => {
	const unauthorized = requireControlAuth(event, {
		...PRD_BRIDGE_PENDING_AUTH,
		allowLoopbackWithoutKey: false,
	});
	if (unauthorized) return unauthorized;

	try {
		const { pendingRequestFile } = getPrdBridgePaths();

		if (existsSync(pendingRequestFile)) {
			const requestMeta = JSON.parse(await readFile(pendingRequestFile, 'utf-8'));
			requestMeta.status = 'processed';
			requestMeta.processedAt = new Date().toISOString();
			// Atomic so a concurrent GET /api/prd-bridge/pending poll
			// (Welcome.svelte polls every 2s) can't read a half-written
			// pending-request.json. The GET handler at line 37 JSON.parses
			// this same file and would otherwise throw SyntaxError +
			// return pending:false during the truncation window.
			await writeFileAtomic(pendingRequestFile, JSON.stringify(requestMeta, null, 2));
		}

		return json({ success: true });
	} catch (error) {
		console.error('[PRDBridge] Error clearing pending request:', error);
		return json({ error: 'Failed to clear pending request' }, { status: 500 });
	}
};
