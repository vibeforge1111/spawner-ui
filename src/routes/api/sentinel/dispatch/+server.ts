import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { enforceRateLimit, requireControlAuth } from '$lib/server/mcp-auth';
import {
	normalizeSentinelDispatchPayload,
	type SentinelDispatchPayload,
	validateSentinelDispatchPayload
} from '$lib/server/sentinel-dispatch';
import { eventBridge } from '$lib/services/event-bridge';

interface SentinelActionEntry {
	receivedAt: string;
	kind: string;
	id: string;
	priority: string;
	title: string;
	reasons: string[];
	url?: string;
}

const recentSentinelActions: SentinelActionEntry[] = [];
const MAX_SENTINEL_ACTIONS = 100;

function sentinelReadAuthPayload(event: Parameters<typeof requireControlAuth>[0]) {
	const openRead = requireControlAuth(event, {
		surface: 'SentinelDispatch',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: true,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
	if (openRead) return { openRead, hasControlAuth: false };

	const strictRead = requireControlAuth(event, {
		surface: 'SentinelDispatch',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});

	return { openRead: null, hasControlAuth: strictRead === null };
}

export const POST: RequestHandler = async (event) => {
	const unauthorized = requireControlAuth(event, {
		surface: 'SentinelDispatch',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
	if (unauthorized) return unauthorized;

	const rateLimited = enforceRateLimit(event, {
		scope: 'sentinel_dispatch_post',
		limit: 60,
		windowMs: 60_000
	});
	if (rateLimited) return rateLimited;

	try {
		const payload = await event.request.json();
		const errors = validateSentinelDispatchPayload(payload);
		if (errors.length > 0) {
			return json({ ok: false, errors }, { status: 422 });
		}

		const normalized = normalizeSentinelDispatchPayload(payload as SentinelDispatchPayload);
		const accepted = normalized.actions.length;
		const receivedAt = new Date().toISOString();

		for (const action of normalized.actions.slice(0, 50)) {
			recentSentinelActions.unshift({
				receivedAt,
				kind: action.kind,
				id: action.id,
				priority: action.priority,
				title: action.title,
				reasons: action.reasons,
				url: typeof action.url === 'string' ? action.url : undefined
			});
			if (recentSentinelActions.length > MAX_SENTINEL_ACTIONS) {
				recentSentinelActions.length = MAX_SENTINEL_ACTIONS;
			}

			eventBridge.emit({
				type: 'sentinel_action_received',
				missionId: 'sentinel-dispatch',
				taskId: action.id,
				taskName: action.title,
				message: `${action.priority} ${action.kind}`,
				data: action,
				timestamp: receivedAt,
				source: 'spark-pr-sentinel'
			});
		}

		return json({
			ok: true,
			accepted,
			receivedAt,
			summary: normalized.summary,
			message: `Accepted ${accepted} sentinel actions`
		});
	} catch (error) {
		return json(
			{
				ok: false,
				error: error instanceof Error ? error.message : 'Sentinel dispatch failed'
			},
			{ status: 500 }
		);
	}
};

export const GET: RequestHandler = async (event) => {
	const { openRead, hasControlAuth } = sentinelReadAuthPayload(event);
	if (openRead) return openRead;

	const rateLimited = enforceRateLimit(event, {
		scope: 'sentinel_dispatch_get',
		limit: 120,
		windowMs: 60_000
	});
	if (rateLimited) return rateLimited;

	const requestedLimit = Number(new URL(event.request.url).searchParams.get('limit') || '20');
	const limit = Number.isFinite(requestedLimit)
		? Math.max(1, Math.min(100, Math.trunc(requestedLimit)))
		: 20;

	return json({
		ok: true,
		count: Math.min(limit, recentSentinelActions.length),
		total: recentSentinelActions.length,
		actions: hasControlAuth
			? recentSentinelActions.slice(0, limit)
			: recentSentinelActions.slice(0, limit).map((action) => ({
					receivedAt: action.receivedAt,
					kind: action.kind,
					id: action.id,
					priority: action.priority,
					title: action.title
				})),
		...(hasControlAuth
			? {}
			: {
					authorityBoundary: {
						payload: 'queue_summary',
						reasons: 'requires_control_auth',
						url: 'requires_control_auth'
					}
				})
	});
};
