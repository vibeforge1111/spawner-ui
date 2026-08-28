/**
 * PRD Bridge - Result Endpoint
 *
 * Stores and retrieves PRD analysis results.
 * This is a file-based fallback when SSE doesn't work.
 *
 * POST /api/prd-bridge/result - Store analysis result (called by event handler)
 * GET /api/prd-bridge/result?requestId=xxx - Get result for a specific request
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { assertSafeId, PathSafetyError, resolveWithinBaseDir } from '$lib/server/path-safety';
import { projectStoredPrdAnalysisResultForTier } from '$lib/server/prd-analysis-result-schema';
import { readPendingRequestRecord } from '$lib/server/prd-pending-requests';
import { relayMissionControlEvent } from '$lib/server/mission-control-relay';
import { spawnerStateDir } from '$lib/server/spawner-state';
import { extractTraceRef } from '$lib/server/trace-ref';
import { requireControlAuth } from '$lib/server/mcp-auth';
import { logger } from '$lib/utils/logger';
import { parseJsonOrThrow } from '$lib/utils/safe-json';
import { appendPrdTraceWithContinuity } from '$lib/server/prd-trace-proof-continuity';
import { stripProviderDeterministicArtifactProof } from '$lib/server/prd-deterministic-artifact-proof';

const log = logger.scope('PRDBridge');

function getResultsDir(): string {
	const spawnerDir = spawnerStateDir();
	return join(spawnerDir, 'results');
}

function tierForPendingRequest(pending: Record<string, unknown> | null): string {
	return pending && typeof pending.tier === 'string' ? pending.tier : 'base';
}

function missionIdForPendingRequest(pending: Record<string, unknown>, requestId: string): string {
	if (typeof pending.missionId === 'string' && pending.missionId.trim()) return pending.missionId;
	const stamp = requestId.match(/(\d{10,})$/)?.[1];
	return `mission-${stamp || requestId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

async function appendPrdTrace(requestId: string, event: string, details: Record<string, unknown> = {}): Promise<void> {
	try {
		await appendPrdTraceWithContinuity({ stateDir: spawnerStateDir(), requestId, event, details });
	} catch {
		// Trace failures are non-fatal.
	}
}

function resultReadAuthPayload(event: Parameters<typeof requireControlAuth>[0]) {
	const openRead = requireControlAuth(event, {
		surface: 'PRDBridgeResult',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: true,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
	if (openRead) return { openRead, hasControlAuth: false };

	const strictRead = requireControlAuth(event, {
		surface: 'PRDBridgeResult',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});

	return { openRead: null, hasControlAuth: strictRead === null };
}

function summarizeStoredResult(requestId: string, result: Record<string, unknown>) {
	const tasks = Array.isArray(result.tasks) ? result.tasks : [];
	const skills = Array.isArray(result.skills) ? result.skills : [];
	const metadata = result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)
		? (result.metadata as Record<string, unknown>)
		: {};

	return {
		requestId,
		success: result.success === true,
		projectName: typeof result.projectName === 'string' ? result.projectName : null,
		projectType: typeof result.projectType === 'string' ? result.projectType : null,
		complexity: typeof result.complexity === 'string' ? result.complexity : null,
		taskCount: tasks.length,
		skillCount: skills.length,
		metadata: {
			canonical: metadata.canonical === true,
			provisional: metadata.provisional === true,
			resultAuthority: typeof metadata.resultAuthority === 'string' ? metadata.resultAuthority : null
		}
	};
}

/**
 * POST - Store an analysis result
 */
export const POST: RequestHandler = async (event) => {
	const unauthorized = requireControlAuth(event, {
		surface: 'PRDBridgeResult',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
	if (unauthorized) return unauthorized;

	try {
		const { request } = event;
		const { requestId, result } = await request.json();

		if (!requestId || !result || typeof requestId !== 'string') {
			return json({ error: 'requestId and result are required' }, { status: 400 });
		}
		assertSafeId(requestId, 'requestId');

		// Machine-origin results must bind to a governed pending request created
		// by a governed dispatch; unmatched requestIds are rejected fail-closed
		// with no result write or state change.
		const pendingRequest = await readPendingRequestRecord(spawnerStateDir(), requestId);
		if (!pendingRequest) {
			await appendPrdTrace(requestId, 'result_rejected_unbound', {
				source: 'prd-bridge-result',
				reason: 'no governed pending request matches requestId'
			});
			log.warn(`Rejected unbound PRD result for: ${requestId}`);
			return json(
				{
					error: 'Unknown requestId: PRD results must bind to a governed pending request.',
					code: 'prd_result_unbound',
					requestId
				},
				{ status: 409 }
			);
		}

		const traceRef = extractTraceRef(pendingRequest);
		const resultRecord = result && typeof result === 'object' && !Array.isArray(result)
			? (result as Record<string, unknown>)
			: {};
		const {
			deterministicArtifactProof: _untrustedTopLevelProof,
			...safeResultRecord
		} = resultRecord;
		const metadataRecord = resultRecord.metadata && typeof resultRecord.metadata === 'object' && !Array.isArray(resultRecord.metadata)
			? (resultRecord.metadata as Record<string, unknown>)
			: {};
		const safeProviderMetadata = stripProviderDeterministicArtifactProof(metadataRecord);
		const storedResult = await projectStoredPrdAnalysisResultForTier(
			requestId,
			{
				...safeResultRecord,
				...(traceRef ? { traceRef } : {}),
				metadata: {
					...safeProviderMetadata,
					...(traceRef ? { traceRef } : {}),
					canonical: true,
					provisional: false,
					resultAuthority: 'provider_result'
				}
			},
			tierForPendingRequest(pendingRequest)
		);

		// Ensure results directory exists
		const resultsDir = getResultsDir();

		// NOTE: existsSync check then use is a TOCTOU pattern in concurrent code. The file may be deleted between the check and the read. Consider using try/catch ENOENT or async fs.promises.access.
		if (!existsSync(resultsDir)) {
			await mkdir(resultsDir, { recursive: true });
		}

		// Write result to file
		const resultFile = resolveWithinBaseDir(resultsDir, `${requestId}.json`);
		await writeFile(resultFile, JSON.stringify(storedResult, null, 2), 'utf-8');

		const missionId = missionIdForPendingRequest(pendingRequest, requestId);
		const pipelineId = typeof pendingRequest.pipelineId === 'string' ? pendingRequest.pipelineId : null;
		await appendPrdTrace(requestId, 'canonical_result_stored', {
			source: 'prd-bridge-result',
			...(traceRef ? { traceRef, trace_ref: traceRef } : {}),
			missionId,
			...(pipelineId ? { pipelineId } : {})
		});
		void relayMissionControlEvent({
			type: 'log',
			missionId,
			missionName:
				typeof pendingRequest.projectName === 'string' ? pendingRequest.projectName : undefined,
			taskName: 'PRD analysis result',
			message: 'Canonical PRD analysis result stored from provider result callback.',
			source: 'prd-bridge',
			data: {
				requestId,
				...(traceRef ? { traceRef } : {}),
				pipelineId,
				resultFileName: `${requestId}.json`,
				resultAuthority: 'provider_result'
			}
		});

		log.info(`Stored result for: ${requestId}`);
		return json({ success: true, requestId, ...(traceRef ? { traceRef } : {}) });
	} catch (error) {
		if (error instanceof PathSafetyError) {
			return json({ error: error.message }, { status: error.status });
		}
		if (error instanceof Error && error.message.startsWith('Invalid PRD analysis result:')) {
			return json({ error: error.message }, { status: 400 });
		}
		if (error instanceof Error && error.message.startsWith('Invalid PRD analysis result: requestId mismatch')) {
			return json({ error: error.message }, { status: 400 });
		}

		console.error('[PRDBridge] Error storing result:', error);
		return json({ error: 'Failed to store result' }, { status: 500 });
	}
};

/**
 * GET - Retrieve an analysis result by requestId
 */
export const GET: RequestHandler = async (event) => {
	const { openRead, hasControlAuth } = resultReadAuthPayload(event);
	if (openRead) return openRead;

	try {
		const { url } = event;
		const requestId = url.searchParams.get('requestId');

		if (!requestId) {
			return json({ error: 'requestId is required' }, { status: 400 });
		}
		assertSafeId(requestId, 'requestId');

		const resultsDir = getResultsDir();
		const resultFile = resolveWithinBaseDir(resultsDir, `${requestId}.json`);

		if (!existsSync(resultFile)) {
			return json({ found: false, requestId });
		}

		const result = parseJsonOrThrow<Record<string, unknown>>(
			await readFile(resultFile, 'utf-8'),
			`prd-result:${requestId}`
		);
		if (!hasControlAuth) {
			const resultRecord = result && typeof result === 'object' && !Array.isArray(result)
				? (result as Record<string, unknown>)
				: {};
			return json({
				found: true,
				requestId,
				summary: summarizeStoredResult(requestId, resultRecord),
				authorityBoundary: {
					payload: 'metadata_only',
					result: 'requires_control_auth'
				}
			});
		}
		return json({ found: true, requestId, result });
	} catch (error) {
		if (error instanceof PathSafetyError) {
			return json({ error: error.message }, { status: error.status });
		}

		console.error('[PRDBridge] Error reading result:', error);
		return json({ error: 'Failed to read result' }, { status: 500 });
	}
};
