import { env } from '$env/dynamic/private';
import { json, type RequestEvent } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import {
	hostedUiHostIsLoopback,
	hostedUiIsLocalOperatorLoopbackRequest,
	hostedUiSessionIsValid
} from '$lib/server/hosted-ui-auth';

const rateLimitBuckets = new Map<string, number[]>();

function constantTimeEquals(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	// Use the longer length to prevent timing leak on length comparison
	const maxLen = Math.max(leftBuffer.length, rightBuffer.length);
	const leftPadded = Buffer.alloc(maxLen, 0);
	const rightPadded = Buffer.alloc(maxLen, 0);
	leftBuffer.copy(leftPadded);
	rightBuffer.copy(rightPadded);
	return timingSafeEqual(leftPadded, rightPadded) && leftBuffer.length === rightBuffer.length;
}

interface ApiKeyExtractionOptions {
	queryParam?: string;
	cookieName?: string;
}

function getCookieValue(cookieHeader: string | null, cookieName: string | undefined): string | null {
	if (!cookieHeader || !cookieName) {
		return null;
	}

	const pairs = cookieHeader.split(';');
	for (const pair of pairs) {
		const [rawName, ...rawValue] = pair.trim().split('=');
		if (rawName === cookieName) {
			const value = rawValue.join('=').trim();
			if (value.length === 0) return null;
			try {
				return decodeURIComponent(value);
			} catch {
				return value;
			}
		}
	}

	return null;
}

function extractApiKey(event: RequestEvent, options: ApiKeyExtractionOptions = {}): string | null {
	const apiKeyHeader = event.request.headers.get('x-mcp-api-key') || event.request.headers.get('x-api-key');
	if (apiKeyHeader && apiKeyHeader.trim().length > 0) {
		return apiKeyHeader.trim();
	}

	const authorization = event.request.headers.get('authorization');
	if (authorization) {
		const match = authorization.match(/^Bearer\s+(.+)$/i);
		const bearerToken = match?.[1]?.trim() || null;
		if (bearerToken) {
			return bearerToken;
		}
	}

	// API keys in URLs leak through history, access logs, referrers, and proxies.
	// `queryParam` remains accepted in route options for compatibility but is
	// deliberately ignored as an authentication source.

	const cookieToken = getCookieValue(event.request.headers.get('cookie'), options.cookieName);
	if (cookieToken) {
		return cookieToken;
	}

	const genericCookieToken =
		getCookieValue(event.request.headers.get('cookie'), 'spawner_control_api_key') ||
		getCookieValue(event.request.headers.get('cookie'), 'spawner_events_api_key');
	if (genericCookieToken) {
		return genericCookieToken;
	}

	return null;
}

function getClientIdentity(event: RequestEvent): string {
	const apiKey = extractApiKey(event);
	if (apiKey) return `key:${apiKey}`;
	try {
		return `ip:${event.getClientAddress()}`;
	} catch {
		return 'anonymous';
	}
}

function parseCsv(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function controlEnvValue(name: string | undefined): string {
	if (!name) return '';
	if (Object.prototype.hasOwnProperty.call(process.env, name)) {
		return (process.env[name] || '').trim();
	}
	const dynamicValue = (env[name as keyof typeof env] as string | undefined)?.trim();
	if (dynamicValue) return dynamicValue;
	return '';
}

function isOriginAllowed(event: RequestEvent, allowedOriginsEnvVar?: string): boolean {
	const origin = event.request.headers.get('origin');
	if (!origin) return true;

	try {
		const requestHost = new URL(event.request.url).hostname;
		const originHost = new URL(origin).hostname;
		if (hostedUiHostIsLoopback(requestHost) && hostedUiHostIsLoopback(originHost)) {
			return true;
		}
	} catch {
		return false;
	}

	const allowedOrigins = parseCsv(controlEnvValue(allowedOriginsEnvVar));
	if (!allowedOriginsEnvVar || allowedOrigins.length === 0) {
		try {
			return new URL(origin).origin === new URL(event.request.url).origin;
		} catch {
			return false;
		}
	}
	if (allowedOrigins.length === 0) return true;
	if (allowedOrigins.includes('*')) {
		return controlEnvValue('SPAWNER_ALLOW_WILDCARD_ORIGINS') === '1';
	}
	return allowedOrigins.includes(origin);
}

export interface ControlAuthOptions {
	surface: string;
	apiKeyEnvVar?: string;
	fallbackApiKeyEnvVar?: string;
	fallbackApiKeyEnvVars?: string[];
	apiKeyQueryParam?: string;
	apiKeyCookieName?: string;
	allowLoopbackWithoutKey?: boolean;
	allowedOriginsEnvVar?: string;
}

export interface RateLimitOptions {
	scope: string;
	limit: number;
	windowMs: number;
}

export function requireControlAuth(event: RequestEvent, options: ControlAuthOptions): Response | null {
	const allowLoopback = options.allowLoopbackWithoutKey === true;
	const configuredKey = [
		options.apiKeyEnvVar,
		options.fallbackApiKeyEnvVar,
		...(options.fallbackApiKeyEnvVars || [])
	]
		.map(controlEnvValue)
		.find(Boolean);

	if (!isOriginAllowed(event, options.allowedOriginsEnvVar)) {
		return json(
			{ error: `Origin is not allowed for ${options.surface}` },
			{ status: 403 }
		);
	}

	if (allowLoopback && isLoopbackRequest(event)) {
		return null;
	}

	if (event.cookies && hostedUiSessionIsValid(event.cookies, env)) {
		return null;
	}

	if (configuredKey) {
		const incomingKey = extractApiKey(event, {
			queryParam: options.apiKeyQueryParam,
			cookieName: options.apiKeyCookieName
		});
		if (!incomingKey || !constantTimeEquals(configuredKey, incomingKey)) {
			return json({ error: `Unauthorized ${options.surface} request` }, { status: 401 });
		}
		return null;
	}

	return json(
		{
			error: `${options.surface} routes require API key for non-local requests`
		},
		{ status: 401 }
	);
}

function pruneStaleRateLimitBuckets(now: number, windowMs: number): void {
	const windowStart = now - windowMs;
	for (const [key, timestamps] of rateLimitBuckets) {
		if (timestamps.length === 0 || timestamps[timestamps.length - 1] < windowStart) {
			rateLimitBuckets.delete(key);
		}
	}
}

export function enforceRateLimit(event: RequestEvent, options: RateLimitOptions): Response | null {
	const now = Date.now();
	pruneStaleRateLimitBuckets(now, options.windowMs);
	const identity = getClientIdentity(event);
	const bucketKey = `${options.scope}:${identity}`;
	const windowStart = now - options.windowMs;
	const existing = rateLimitBuckets.get(bucketKey) || [];
	const active = existing.filter((timestamp) => timestamp >= windowStart);
	if (active.length >= options.limit) {
		return json(
			{
				error: 'Rate limit exceeded',
				scope: options.scope,
				limit: options.limit,
				windowMs: options.windowMs
			},
			{ status: 429 }
		);
	}

	active.push(now);
	rateLimitBuckets.set(bucketKey, active);
	return null;
}

function isLoopbackRequest(event: RequestEvent): boolean {
	try {
		const clientAddress = event.getClientAddress();
		return hostedUiIsLocalOperatorLoopbackRequest(
			event.request,
			new URL(event.request.url),
			clientAddress
		);
	} catch {
		// Production loopback bypass must not rely on a spoofable Host header alone.
		return (
			hostedUiHostIsLoopback(new URL(event.request.url).hostname) &&
			(import.meta.env.MODE === 'test' || process.env.NODE_ENV === 'test')
		);
	}
}

/**
 * Guard MCP routes with an API key or authenticated hosted UI session.
 */
export function requireMcpAuth(event: RequestEvent): Response | null {
	return requireControlAuth(event, {
		surface: 'MCP',
		apiKeyEnvVar: 'MCP_API_KEY',
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'MCP_ALLOWED_ORIGINS'
	});
}
