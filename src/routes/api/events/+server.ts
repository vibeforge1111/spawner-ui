/**
 * Event Bridge API - Receives events from Claude Code and broadcasts to spawner-ui
 *
 * POST /api/events - Receive an event from Claude Code
 * GET /api/events - SSE stream for real-time event updates
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { eventBridge } from '$lib/services/event-bridge';
import { assertSafeId, PathSafetyError, resolveWithinBaseDir } from '$lib/server/path-safety';
import { controlQueryApiKeysAllowed, enforceRateLimit, requireControlAuth } from '$lib/server/mcp-auth';
import { hostedUiHostIsLoopback } from '$lib/server/hosted-ui-auth';
import { relayMissionControlEvent, isMissionControlMissionId } from '$lib/server/mission-control-relay';
import { providerRuntime } from '$lib/server/provider-runtime';
import { projectStoredPrdAnalysisResultForTier } from '$lib/server/prd-analysis-result-schema';
import { pendingRequestFileForRequest, readPendingRequestRecord } from '$lib/server/prd-pending-requests';
import { spawnerStateDir } from '$lib/server/spawner-state';
import { writeFileAtomic } from '$lib/server/atomic-write';
import { extractTraceRef } from '$lib/server/trace-ref';
import { logger } from '$lib/utils/logger';
import { parseJsonOrFallback } from '$lib/utils/safe-json';

import { writeFile, mkdir, appendFile, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const EVENTS_AUTH_COOKIE = 'spawner_events_api_key';
const log = logger.scope('EventBridge');
const TERMINAL_LIFECYCLE_EVENTS = new Set(['mission_completed', 'mission_failed', 'mission_cancelled']);
const TERMINAL_PROVIDER_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// Suppress duplicate fan-out when the upstream POSTer retries the same event id
// on a transient network error — without this, the same mission_completed (or
// any other event) is broadcast twice to SSE subscribers + downstream consumers.
const RECENT_EVENT_ID_TTL_MS = 5 * 60 * 1000;
const recentEventIds = new Map<string, number>();
function rememberRecentEventId(id: string, now: number): boolean {
	const previous = recentEventIds.get(id);
	if (typeof previous === 'number' && now - previous < RECENT_EVENT_ID_TTL_MS) return false;
	recentEventIds.set(id, now);
	if (recentEventIds.size > 1000) {
		const cutoff = now - RECENT_EVENT_ID_TTL_MS;
		recentEventIds.forEach((ts, key) => { if (ts < cutoff) recentEventIds.delete(key); });
	}
	return true;
}

// Resolve the EVENTS_ALLOWED_ORIGINS allowlist using the same env convention as
// mcp-auth's isOriginAllowed/allowedOriginsEnvVar('EVENTS_ALLOWED_ORIGINS'):
// prefer process.env when present, else fall back to the SvelteKit dynamic env.
function eventsAllowedOrigins(): string[] {
	const raw = (
		Object.prototype.hasOwnProperty.call(process.env, 'EVENTS_ALLOWED_ORIGINS')
			? process.env.EVENTS_ALLOWED_ORIGINS
			: env.EVENTS_ALLOWED_ORIGINS
	) || '';
	return raw
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

// CORS for the event bridge must not reflect an arbitrary origin. Loopback dev
// origins are always allowed (matches isOriginAllowed); any other origin must be
// explicitly listed in EVENTS_ALLOWED_ORIGINS, otherwise no CORS headers are sent.
function isCorsOriginAllowed(origin: string): boolean {
	try {
		if (hostedUiHostIsLoopback(new URL(origin).hostname)) return true;
	} catch {
		return false;
	}
	return eventsAllowedOrigins().includes(origin);
}

function corsHeaders(request: Request): Record<string, string> {
	const origin = request.headers.get('origin');
	if (!origin || !isCorsOriginAllowed(origin)) return {};
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-mcp-api-key',
		Vary: 'Origin'
	};
}

function getSpawnerDir(): string {
	return spawnerStateDir();
}

function getResultsDir(): string {
	return join(getSpawnerDir(), 'results');
}

function getPrdAutoTraceFile(): string {
	return join(getSpawnerDir(), 'prd-auto-trace.jsonl');
}

function extractApiKeyFromRequest(request: Request): string | null {
	const headerKey = request.headers.get('x-api-key') || request.headers.get('x-mcp-api-key');
	if (headerKey && headerKey.trim().length > 0) {
		return headerKey.trim();
	}

	const authorization = request.headers.get('authorization');
	if (authorization) {
		const match = authorization.match(/^Bearer\s+(.+)$/i);
		const bearerToken = match?.[1]?.trim() || null;
		if (bearerToken) {
			return bearerToken;
		}
	}

	if (controlQueryApiKeysAllowed()) {
		try {
			const queryKey = new URL(request.url).searchParams.get('apiKey');
			if (queryKey && queryKey.trim().length > 0) {
				return queryKey.trim();
			}
		} catch {
			// Ignore malformed URLs.
		}
	}

	return null;
}

function createAuthCookieHeader(request: Request): string | null {
	const apiKey = extractApiKeyFromRequest(request);
	if (!apiKey) {
		return null;
	}

	const isSecure = request.url.startsWith('https://');
	return `${EVENTS_AUTH_COOKIE}=${encodeURIComponent(apiKey)}; Path=/; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}`;
}

function eventStreamAuthPayload(event: Parameters<typeof requireControlAuth>[0]) {
	const openRead = requireControlAuth(event, {
		surface: 'Events',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: EVENTS_AUTH_COOKIE,
		allowLoopbackWithoutKey: true,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
	if (openRead) return { openRead, hasControlAuth: false };

	const strictRead = requireControlAuth(event, {
		surface: 'Events',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: EVENTS_AUTH_COOKIE,
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});

	return { openRead: null, hasControlAuth: strictRead === null };
}

function sanitizeBridgeEventForLoopback(event: Record<string, unknown>): Record<string, unknown> {
	return {
		...(typeof event.id === 'string' ? { id: event.id } : {}),
		type: typeof event.type === 'string' ? event.type : 'unknown',
		...(typeof event.missionId === 'string' ? { missionId: event.missionId } : {}),
		...(typeof event.taskId === 'string' ? { taskId: event.taskId } : {}),
		...(typeof event.taskName === 'string' ? { taskName: event.taskName } : {}),
		...(typeof event.progress === 'number' ? { progress: event.progress } : {}),
		...(typeof event.message === 'string' ? { message: event.message } : {}),
		timestamp: typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString(),
		source: typeof event.source === 'string' ? event.source : 'event-bridge',
		authorityBoundary: {
			payload: 'event_metadata',
			data: 'requires_control_auth'
		}
	};
}

/**
 * Store PRD analysis result to file for polling fallback
 */
async function appendPrdTrace(requestId: string, event: string, details: Record<string, unknown> = {}): Promise<void> {
	try {
		const traceRef = await traceRefForRequest(requestId, details);
		await appendFile(
			getPrdAutoTraceFile(),
			`${JSON.stringify({
				ts: new Date().toISOString(),
				requestId,
				event,
				...details,
				...(traceRef ? { traceRef, trace_ref: traceRef } : {})
			})}\n`,
			'utf-8'
		);
	} catch {
		// Trace failures are non-fatal.
	}
}

async function traceRefForRequest(requestId: string, details: Record<string, unknown>): Promise<string | null> {
	const explicit = extractTraceRef(details);
	if (explicit) return explicit;
	const pending = await pendingRequestForRequest(requestId);
	return pending ? extractTraceRef(pending) : null;
}

async function pendingRequestForRequest(requestId: string): Promise<Record<string, unknown> | null> {
	try {
		return await readPendingRequestRecord(getSpawnerDir(), requestId);
	} catch {
		return null;
	}
}

async function tierForRequest(requestId: string): Promise<string> {
	const pending = await pendingRequestForRequest(requestId);
	return typeof pending?.tier === 'string' ? pending.tier : 'base';
}

async function storePRDResult(requestId: string, result: unknown): Promise<void> {
	assertSafeId(requestId, 'requestId');
	const traceRef = await traceRefForRequest(requestId, {});
	const resultRecord = result && typeof result === 'object' && !Array.isArray(result)
		? (result as Record<string, unknown>)
		: {};
	const metadataRecord = resultRecord.metadata && typeof resultRecord.metadata === 'object' && !Array.isArray(resultRecord.metadata)
		? (resultRecord.metadata as Record<string, unknown>)
		: {};
	const storedResult = await projectStoredPrdAnalysisResultForTier(
		requestId,
		{
			...resultRecord,
			...(traceRef ? { traceRef } : {}),
			metadata: {
				...metadataRecord,
				...(traceRef ? { traceRef } : {}),
				canonical: true,
				provisional: false,
				resultAuthority: 'provider_result'
			}
		},
		await tierForRequest(requestId)
	);
	const resultsDir = getResultsDir();

	if (!existsSync(resultsDir)) {
		await mkdir(resultsDir, { recursive: true });
	}
	const resultFile = resolveWithinBaseDir(resultsDir, `${requestId}.json`);
	await writeFile(resultFile, JSON.stringify(storedResult, null, 2), 'utf-8');
	log.info(`Stored PRD result for polling: ${requestId}`);
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function terminalLifecycleTrust(event: Record<string, unknown>): {
	trusted: boolean;
	reason: string;
	providerId: string | null;
	missionId: string | null;
	matchingSessionCount: number;
} | null {
	const type = stringValue(event.type);
	if (!type || !TERMINAL_LIFECYCLE_EVENTS.has(type)) return null;
	const missionId = stringValue(event.missionId);
	if (!missionId) {
		return {
			trusted: false,
			reason: 'terminal_lifecycle_missing_mission',
			providerId: null,
			missionId: null,
			matchingSessionCount: 0
		};
	}

	const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
		? (event.data as Record<string, unknown>)
		: {};
	const providerId =
		stringValue(data.provider) ||
		stringValue(data.providerId) ||
		(typeof event.source === 'string' && event.source !== 'spawner-ui' ? event.source.trim() : null);
	const requestId = stringValue(data.requestId);
	const traceRef = extractTraceRef(data);
	let refBoundSessionRejected = false;
	const sessions = providerRuntime.getSessionsForMission(missionId).filter((session) => {
		if (providerId && session.providerId !== providerId) return false;
		if (TERMINAL_PROVIDER_STATUSES.has(session.status)) return false;
		const recordedRequestId = stringValue(session.requestId);
		const recordedTraceRef = stringValue(session.traceRef);
		if (requestId && recordedRequestId !== requestId) return false;
		if (traceRef && recordedTraceRef !== traceRef) return false;
		// When the session recorded a requestId or traceRef at dispatch, the
		// event must present a matching ref; mission+provider coincidence is
		// not enough to advance terminal state.
		if (recordedRequestId || recordedTraceRef) {
			const requestIdMatches = Boolean(requestId && recordedRequestId === requestId);
			const traceRefMatches = Boolean(traceRef && recordedTraceRef === traceRef);
			if (!requestIdMatches && !traceRefMatches) {
				refBoundSessionRejected = true;
				return false;
			}
		}
		return true;
	});

	return {
		trusted: sessions.length > 0,
		reason:
			sessions.length > 0
				? 'matched_active_provider_session'
				: refBoundSessionRejected
					? 'session_requires_request_or_trace_ref_match'
					: 'no_matching_active_provider_session',
		providerId,
		missionId,
		matchingSessionCount: sessions.length
	};
}

async function markPendingPrdResultComplete(requestId: string): Promise<void> {
	assertSafeId(requestId, 'requestId');
	const pending = await pendingRequestForRequest(requestId);
	if (!pending) return;

	const resultFile = resolveWithinBaseDir(getResultsDir(), `${requestId}.json`);
	const now = new Date().toISOString();
	const autoAnalysis =
		pending.autoAnalysis && typeof pending.autoAnalysis === 'object' && !Array.isArray(pending.autoAnalysis)
			? (pending.autoAnalysis as Record<string, unknown>)
			: {};
	const next = {
		...pending,
		status: 'processed',
		updatedAt: now,
		reason: 'Canonical provider result stored from events bridge.',
		autoAnalysis: {
			...autoAnalysis,
			status: 'complete',
			finishedAt: now,
			success: true,
			canonicalResultAvailable: true,
			resultFileName: `${requestId}.json`,
			expectedResultFile: resultFile
		}
	};
	const serialized = JSON.stringify(next, null, 2);

	// RequestId-scoped record is the source of truth; the singleton file stays
	// in sync only when it still points at this request (back-compat pointer).
	const scopedFile = pendingRequestFileForRequest(getSpawnerDir(), requestId);
	if (existsSync(scopedFile)) {
		await writeFile(scopedFile, serialized, 'utf-8');
	}
	const pendingRequestFile = join(getSpawnerDir(), 'pending-request.json');
	if (existsSync(pendingRequestFile)) {
		const singleton = parseJsonOrFallback<Record<string, unknown>>(
			await readFile(pendingRequestFile, 'utf-8'),
			{},
			'events-pending-request'
		);
		if (singleton.requestId === requestId) {
			await writeFileAtomic(pendingRequestFile, serialized);
		}
	}
}

async function relayMetadataForMission(missionId: string): Promise<Record<string, unknown>> {
	try {
		const loadFile = join(getSpawnerDir(), 'last-canvas-load.json');
		if (!existsSync(loadFile)) return {};
		const raw = await readFile(loadFile, 'utf-8');
		const load = parseJsonOrFallback<{ relay?: Record<string, unknown> }>(raw, {}, 'events-relay');
		const relay = load.relay && typeof load.relay === 'object' ? load.relay : null;
		if (!relay || relay.missionId !== missionId) return {};
		const traceRef = extractTraceRef(load, relay);
		const pipelineId =
			typeof (load as Record<string, unknown>).pipelineId === 'string'
				? ((load as Record<string, unknown>).pipelineId as string)
				: typeof relay.pipelineId === 'string'
					? relay.pipelineId
					: undefined;
		return {
			chatId: typeof relay.chatId === 'string' ? relay.chatId : undefined,
			userId: typeof relay.userId === 'string' ? relay.userId : undefined,
			requestId: typeof relay.requestId === 'string' ? relay.requestId : undefined,
			traceRef: traceRef || undefined,
			pipelineId: pipelineId || undefined,
			goal: typeof relay.goal === 'string' ? relay.goal : undefined,
			telegramRelay:
				relay.telegramRelay && typeof relay.telegramRelay === 'object'
					? relay.telegramRelay
					: undefined,
			telegramRelayPort:
				typeof relay.telegramRelayPort === 'string' || typeof relay.telegramRelayPort === 'number'
					? relay.telegramRelayPort
					: undefined,
			telegramRelayProfile:
				typeof relay.telegramRelayProfile === 'string' ? relay.telegramRelayProfile : undefined
		};
	} catch {
		return {};
	}
}


/**
 * POST handler - receives events from Claude Code
 * Claude/provider clients must send x-api-key from EVENTS_API_KEY or MCP_API_KEY.
 */
export const POST: RequestHandler = async (event) => {
	const unauthorized = requireControlAuth(event, {
		surface: 'Events',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: EVENTS_AUTH_COOKIE,
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
	if (unauthorized) return unauthorized;

	const rateLimited = enforceRateLimit(event, {
		scope: 'events_post',
		limit: 240,
		windowMs: 60_000
	});
	if (rateLimited) return rateLimited;

	try {
		const { request } = event;
		const payload = await request.json();

		// Validate required fields
		if (!payload.type) {
			return json({ error: 'Event type is required' }, { status: 400 });
		}

		// Short-circuit on caller-supplied id that's already been processed within
		// the dedup window — keeps mission_completed (and every other event) from
		// being fanned out twice when the upstream POSTer retries on a transient
		// network error. Auto-generated ids fall through to the normal path.
		const callerSuppliedId =
			typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : null;
		if (callerSuppliedId && !rememberRecentEventId(callerSuppliedId, Date.now())) {
			const headers = new Headers();
			for (const [key, value] of Object.entries(corsHeaders(event.request))) {
				headers.set(key, value);
			}
			return json({ success: true, eventId: callerSuppliedId, deduplicated: true }, { headers });
		}

		// Add metadata
		let fullEvent = {
			...payload,
			timestamp: payload.timestamp || new Date().toISOString(),
			source: payload.source || 'claude-code',
			id: payload.id || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
		};
		if (typeof fullEvent.missionId === 'string') {
			const relayMeta = await relayMetadataForMission(fullEvent.missionId);
			if (Object.keys(relayMeta).length > 0) {
				fullEvent = {
					...fullEvent,
					data: {
						...relayMeta,
						...(fullEvent.data && typeof fullEvent.data === 'object' ? fullEvent.data : {})
					}
				};
			}
		}
		const lifecycleTrust = terminalLifecycleTrust(fullEvent);
		if (lifecycleTrust && !lifecycleTrust.trusted) {
			const originalType = fullEvent.type;
			fullEvent = {
				...fullEvent,
				type: 'mission_lifecycle_untrusted',
				originalType,
				data: {
					...(fullEvent.data && typeof fullEvent.data === 'object' ? fullEvent.data : {}),
					lifecycleTrust
				}
			};
		}

		// Broadcast to all connected clients
		eventBridge.emit(fullEvent);

		if (
			(fullEvent.type === 'mission_completed' || fullEvent.type === 'mission_failed' || fullEvent.type === 'mission_cancelled') &&
			typeof fullEvent.missionId === 'string'
		) {
			const data = fullEvent.data && typeof fullEvent.data === 'object' ? fullEvent.data : {};
			const providerId =
				typeof data.provider === 'string'
					? data.provider
					: typeof data.providerId === 'string'
						? data.providerId
						: typeof fullEvent.source === 'string' && fullEvent.source !== 'spawner-ui'
							? fullEvent.source
							: null;
			providerRuntime.markMissionTerminalFromLifecycleEvent({
				missionId: fullEvent.missionId,
				status:
					fullEvent.type === 'mission_completed'
						? 'completed'
						: fullEvent.type === 'mission_cancelled'
							? 'cancelled'
							: 'failed',
				providerId,
				response: typeof data.response === 'string' ? data.response : null,
				error:
					typeof fullEvent.message === 'string' && (fullEvent.type === 'mission_failed' || fullEvent.type === 'mission_cancelled')
						? fullEvent.message
						: typeof data.error === 'string'
							? data.error
							: null,
				completedAt: typeof fullEvent.timestamp === 'string' ? fullEvent.timestamp : null
			});
		}

		// Relay mission-control events into Spark Intelligence and optional webhooks.
		void relayMissionControlEvent(fullEvent as Record<string, unknown>);

		// Store PRD results for polling fallback and trace runtime receipt
		if (fullEvent.type === 'prd_analysis_complete' && fullEvent.data?.requestId && fullEvent.data?.result) {
			await appendPrdTrace(fullEvent.data.requestId, 'events_received_complete', {
				source: fullEvent.source || 'unknown'
			});
			// Machine-origin results must bind to a governed pending request;
			// unmatched requestIds are rejected fail-closed with no state change.
			const boundPendingRequest = await pendingRequestForRequest(fullEvent.data.requestId);
			if (!boundPendingRequest) {
				await appendPrdTrace(fullEvent.data.requestId, 'events_rejected_unbound', {
					source: fullEvent.source || 'unknown',
					reason: 'no governed pending request matches requestId'
				});
				return json(
					{
						error: 'Unknown requestId: PRD analysis results must bind to a governed pending request.',
						code: 'prd_result_unbound',
						requestId: fullEvent.data.requestId
					},
					{ status: 409 }
				);
			}
			try {
				await storePRDResult(fullEvent.data.requestId, fullEvent.data.result);
				await markPendingPrdResultComplete(fullEvent.data.requestId);
				await appendPrdTrace(fullEvent.data.requestId, 'canonical_result_stored', {
					source: fullEvent.source || 'unknown'
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Invalid PRD analysis result';
				await appendPrdTrace(fullEvent.data.requestId, 'events_rejected_complete', {
					source: fullEvent.source || 'unknown',
					error: message
				});
				return json({ error: message }, { status: err instanceof PathSafetyError ? err.status : 400 });
			}
		}

		if (fullEvent.type === 'prd_analysis_error' && fullEvent.data?.requestId) {
			await appendPrdTrace(fullEvent.data.requestId, 'events_received_error', {
				source: fullEvent.source || 'unknown',
				error: fullEvent.data?.error || null
			});
		}

		const headers = new Headers();
		const authCookie = createAuthCookieHeader(event.request);
		if (authCookie) {
			headers.set('Set-Cookie', authCookie);
		}
		for (const [key, value] of Object.entries(corsHeaders(event.request))) {
			headers.set(key, value);
		}
		// boardEligible tells the caller whether their event will surface on the
		// Mission Control board views (/kanban, /trace, etc.). When false, the event
		// is still broadcast over SSE but is silently dropped by the board's
		// persistence layer because the missionId doesn't match the required shape.
		// This flag lets callers detect the mismatch at emit time instead of
		// discovering an empty board hours later.
		const boardEligible = typeof fullEvent.missionId === 'string'
			? isMissionControlMissionId(fullEvent.missionId)
			: false;
		return json({ success: true, eventId: fullEvent.id, boardEligible }, { headers });
	} catch (error) {
		console.error('[EventBridge] Error processing event:', error);
		return json({ error: 'Invalid event data' }, { status: 400, headers: corsHeaders(event.request) });
	}
};

export const OPTIONS: RequestHandler = async (event) => {
	const unauthorized = requireControlAuth(event, {
		surface: 'Events',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: EVENTS_AUTH_COOKIE,
		allowLoopbackWithoutKey: true,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
	if (unauthorized) return unauthorized;

	return new Response(null, { status: 204, headers: corsHeaders(event.request) });
};

/**
 * GET handler - Server-Sent Events stream for real-time updates
 */
export const GET: RequestHandler = async (event) => {
	const { openRead, hasControlAuth } = eventStreamAuthPayload(event);
	if (openRead) return openRead;

	const rateLimited = enforceRateLimit(event, {
		scope: 'events_stream',
		limit: 120,
		windowMs: 60_000
	});
	if (rateLimited) return rateLimited;

	const { request } = event;
	// Periodic SSE keepalive ping. Intermediary proxies (Nginx default
	// `proxy_read_timeout` 60s, Cloudflare 100s) drop idle SSE streams
	// silently when no bytes flow for ~60s. A 30s comment frame keeps the
	// stream warm so both peers observe connection health and the client
	// is not forced into the reconnect path on every quiet window.
	const SSE_KEEPALIVE_MS = 30_000;
	const stream = new ReadableStream({
		start(controller) {
			// Send initial connection message
			const encoder = new TextEncoder();
			let isClosed = false;

			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString(), source: 'event-bridge' })}\n\n`));

			// Subscribe to events
			const unsubscribe = eventBridge.subscribe((event) => {
				if (isClosed) return;
				try {
					const safeEvent = hasControlAuth ? event : sanitizeBridgeEventForLoopback(event as unknown as Record<string, unknown>);
					const data = `data: ${JSON.stringify(safeEvent)}\n\n`;
					controller.enqueue(encoder.encode(data));
				} catch (e) {
					// Client disconnected
					isClosed = true;
					logger.info('[EventBridge] Client disconnected');
				}
			});

			// SSE comment frames (lines starting with `:`) are spec-defined
			// no-ops on the client side but keep proxy idle-timers from
			// dropping the stream. EventSource ignores them; no app-level
			// handler change required.
			const keepalive = setInterval(() => {
				if (isClosed) return;
				try {
					controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
				} catch (e) {
					isClosed = true;
				}
			}, SSE_KEEPALIVE_MS);

			// Handle client disconnect
			request.signal.addEventListener('abort', () => {
				clearInterval(keepalive);
				unsubscribe();
				if (!isClosed) {
					isClosed = true;
					try {
						controller.close();
					} catch (e) {
						// Controller already closed, ignore
					}
				}
			});
		}
	});

	const headers: Record<string, string> = {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
		...corsHeaders(event.request)
	};
	const authCookie = createAuthCookieHeader(event.request);
	if (authCookie) {
		headers['Set-Cookie'] = authCookie;
	}

	return new Response(stream, { headers });
};
