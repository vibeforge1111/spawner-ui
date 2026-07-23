import { redirect, type Cookies } from '@sveltejs/kit';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface HostedUiAuthEnv {
	[key: string]: string | undefined;
	SPARK_UI_API_KEY?: string;
	SPARK_UI_PAIRING_CODE?: string;
	SPARK_WORKSPACE_ID?: string;
	SPARK_HOSTED_PRIVATE_PREVIEW?: string;
	SPARK_LIVE_CONTAINER?: string;
	SPARK_SPAWNER_HOST?: string;
	SPARK_ALLOWED_HOSTS?: string;
	RAILWAY_PUBLIC_DOMAIN?: string;
	RENDER_EXTERNAL_URL?: string;
	FLY_APP_NAME?: string;
	VERCEL_URL?: string;
	NETLIFY?: string;
	SPARK_BRIDGE_API_KEY?: string;
	EVENTS_API_KEY?: string;
	MCP_API_KEY?: string;
}

const EXEMPT_EXACT_PATHS = new Set(['/robots.txt', '/spark-live/login', '/api/health/live']);
const EXEMPT_PATH_PREFIXES = ['/_app/', '/favicon'];
const RELEASE_LOCK_PUBLIC_EXACT_PATHS = new Set(['/', '/api/health/live']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK_BROWSER_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const BASE_COOKIE_OPTIONS = {
	httpOnly: true,
	sameSite: 'strict' as const,
	path: '/',
	maxAge: 60 * 60 * 12
};
const SESSION_COOKIE_NAME = 'spawner_ui_session';
const LOCAL_SESSION_WORKSPACE_ID = 'local-spawner-ui';
const LEGACY_AUTH_COOKIE_NAMES = [
	'spawner_ui_api_key',
	'spawner_workspace_id',
	'spawner_control_api_key',
	'spawner_events_api_key'
];
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_FAILURES = 12;
const SESSION_IDLE_TIMEOUT_MS = 1000 * 60 * 60 * 12;
const SESSION_ABSOLUTE_TIMEOUT_MS = 1000 * 60 * 60 * 24;
const authFailures = new Map<string, { count: number; resetAt: number }>();
const consumedHostedUiPairingCodeHashes = new Set<string>();
const hostedUiSessions = new Map<
	string,
	{
		workspaceId: string;
		createdAt: number;
		lastSeenAt: number;
		expiresAt: number;
		absoluteExpiresAt: number;
	}
>();

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

function hashSessionId(sessionId: string): string {
	return createHash('sha256').update(sessionId).digest('hex');
}

function hashPairingCode(pairingCode: string): string {
	return createHash('sha256').update(pairingCode).digest('hex');
}

function loopbackValue(value: string | null | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return false;
	if (LOOPBACK_BROWSER_HOSTS.has(normalized)) return true;
	if (normalized.startsWith('::ffff:')) {
		return LOOPBACK_BROWSER_HOSTS.has(normalized.slice('::ffff:'.length));
	}
	return false;
}

export function hostedUiHostIsLoopback(value: string | null | undefined): boolean {
	return loopbackValue(value);
}

function pruneExpiredHostedUiSessions(now = Date.now()): void {
	for (const [key, session] of hostedUiSessions.entries()) {
		if (session.expiresAt <= now || session.absoluteExpiresAt <= now) {
			hostedUiSessions.delete(key);
		}
	}
}

export function hostedUiAuthEnabled(env: HostedUiAuthEnv): boolean {
	return Boolean(env.SPARK_UI_API_KEY?.trim());
}

export function hostedUiLooksHosted(env: HostedUiAuthEnv): boolean {
	return (
		env.SPARK_LIVE_CONTAINER === '1' ||
		env.SPARK_SPAWNER_HOST === '0.0.0.0' ||
		Boolean(env.SPARK_ALLOWED_HOSTS?.trim()) ||
		Boolean(env.RAILWAY_PUBLIC_DOMAIN?.trim()) ||
		Boolean(env.RENDER_EXTERNAL_URL?.trim()) ||
		Boolean(env.FLY_APP_NAME?.trim()) ||
		Boolean(env.VERCEL_URL?.trim()) ||
		env.NETLIFY === 'true'
	);
}

export function hostedUiSecurityHeaders(env: HostedUiAuthEnv): Record<string, string> {
	const headers: Record<string, string> = {
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
		'Referrer-Policy': 'no-referrer',
		'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()',
		'Cross-Origin-Opener-Policy': 'same-origin'
	};

	if (hostedUiLooksHosted(env)) {
		headers['Content-Security-Policy'] = [
			"default-src 'self'",
			"base-uri 'self'",
			"object-src 'none'",
			"frame-ancestors 'none'",
			"form-action 'self'",
			"img-src 'self' data: blob: https:",
			"font-src 'self' data:",
			"script-src 'self' 'unsafe-inline'",
			"style-src 'self' 'unsafe-inline'",
			"connect-src 'self' wss:"
		].join('; ');
	}

	return headers;
}

export function hostedUiPrivatePreviewConfigured(env: HostedUiAuthEnv): boolean {
	return (
		env.SPARK_HOSTED_PRIVATE_PREVIEW === '1' &&
		Boolean(env.SPARK_WORKSPACE_ID?.trim()) &&
		Boolean(env.SPARK_UI_API_KEY?.trim())
	);
}

export function hostedUiReleaseLocked(env: HostedUiAuthEnv): boolean {
	return hostedUiLooksHosted(env) && !hostedUiPrivatePreviewConfigured(env);
}

export function hostedUiReleaseLockPathIsExempt(pathname: string): boolean {
	return RELEASE_LOCK_PUBLIC_EXACT_PATHS.has(pathname);
}

export function hostedUiRequestHasExplicitToken(request: Request, url: URL): boolean {
	const headerToken =
		request.headers.get('x-spawner-ui-key') ||
		request.headers.get('x-api-key') ||
		request.headers.get('x-mcp-api-key');
	if (headerToken?.trim()) return true;

	const authorization = request.headers.get('authorization');
	if (authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()) return true;

	return false;
}

export function hostedUiCrossSiteMutationRejection(request: Request, url: URL): string | null {
	if (!MUTATING_METHODS.has(request.method.toUpperCase())) return null;
	if (hostedUiRequestHasExplicitToken(request, url)) return null;

	const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase();
	if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
		return 'Cross-site mutating browser request blocked.';
	}

	const origin = request.headers.get('origin');
	if (origin) {
		try {
			if (new URL(origin).origin !== url.origin) {
				return 'Mutating browser request origin is not allowed.';
			}
			return null;
		} catch {
			return 'Mutating browser request origin is malformed.';
		}
	}

	if (!fetchSite) {
		return 'Mutating browser request is missing same-origin proof.';
	}

	return null;
}

export function hostedUiIsLocalOperatorLoopbackRequest(
	request: Request,
	url: URL,
	clientAddress?: string
): boolean {
	return loopbackValue(url.hostname) && (clientAddress === undefined || loopbackValue(clientAddress));
}

export function hostedUiWorkspaceId(env: HostedUiAuthEnv): string | null {
	const value = env.SPARK_WORKSPACE_ID?.trim();
	return value || null;
}

export function hostedUiShouldBypassLocalOperatorAuth(
	request: Request,
	url: URL,
	env: HostedUiAuthEnv,
	clientAddress?: string
): boolean {
	if (!hostedUiAuthEnabled(env)) return false;
	return hostedUiIsLocalOperatorLoopbackRequest(request, url, clientAddress);
}

export function hostedUiAuthClientKey(request: Request, clientAddress?: string): string {
	const adapterAddress = clientAddress?.trim();
	if (adapterAddress) return adapterAddress;
	// Prefer x-real-ip (set by trusted reverse proxy) over x-forwarded-for.
	// x-forwarded-for first entry is client-controllable; use last entry (set by trusted proxy).
	const realIp = request.headers.get('x-real-ip')?.trim();
	if (realIp) return realIp;
	const forwardedFor = request.headers.get('x-forwarded-for');
	if (forwardedFor) {
		const parts = forwardedFor.split(',').map(p => p.trim()).filter(Boolean);
		if (parts.length > 0) return parts[parts.length - 1];
	}
	return 'unknown';
}

export function hostedUiAuthRateLimitStatus(clientKey: string, now = Date.now()): {
	blocked: boolean;
	retryAfterSeconds: number;
} {
	const current = authFailures.get(clientKey);
	if (!current || current.resetAt <= now) {
		authFailures.delete(clientKey);
		return { blocked: false, retryAfterSeconds: 0 };
	}
	return {
		blocked: current.count >= AUTH_MAX_FAILURES,
		retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
	};
}

export function recordHostedUiAuthFailure(clientKey: string, now = Date.now()): void {
	const current = authFailures.get(clientKey);
	if (!current || current.resetAt <= now) {
		authFailures.set(clientKey, { count: 1, resetAt: now + AUTH_WINDOW_MS });
		return;
	}
	current.count += 1;
}

export function clearHostedUiAuthFailures(clientKey: string): void {
	authFailures.delete(clientKey);
}

export function resetHostedUiAuthRateLimits(): void {
	authFailures.clear();
}

export function resetHostedUiSessions(): void {
	hostedUiSessions.clear();
}

export function hostedUiAuthPathIsExempt(pathname: string): boolean {
	return EXEMPT_EXACT_PATHS.has(pathname) || EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function hostedUiRequestToken(request: Request, url: URL, cookies: Cookies): string | null {
	const headerToken =
		request.headers.get('x-spawner-ui-key') ||
		request.headers.get('x-api-key') ||
		request.headers.get('x-mcp-api-key');
	if (headerToken?.trim()) return headerToken.trim();

	const authorization = request.headers.get('authorization');
	const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
	if (bearer) return bearer;

	return null;
}

export function hostedUiRequestPairingCode(url: URL): string | null {
	const pairingCode = url.searchParams.get('pairCode');
	return pairingCode?.trim() || null;
}

export function hostedUiRequestWorkspaceId(request: Request, url: URL, cookies: Cookies): string | null {
	const headerWorkspace = request.headers.get('x-spawner-workspace-id');
	if (headerWorkspace?.trim()) return headerWorkspace.trim();

	const queryWorkspace = url.searchParams.get('workspaceId') || url.searchParams.get('workspace');
	if (queryWorkspace?.trim()) return queryWorkspace.trim();

	return null;
}

export function hostedUiTokenIsValid(token: string | null, env: HostedUiAuthEnv): boolean {
	const expected = env.SPARK_UI_API_KEY?.trim();
	return Boolean(token && expected && constantTimeEquals(token, expected));
}

export function hostedUiCredentialsAreValid(
	workspaceId: string | null,
	token: string | null,
	env: HostedUiAuthEnv
): boolean {
	const expectedWorkspaceId = hostedUiWorkspaceId(env);
	if (expectedWorkspaceId && !workspaceId) return false;
	if (expectedWorkspaceId && workspaceId && !constantTimeEquals(workspaceId, expectedWorkspaceId)) return false;
	return hostedUiTokenIsValid(token, env);
}

export function consumeHostedUiPairingCode(
	workspaceId: string | null,
	pairingCode: string | null,
	env: HostedUiAuthEnv
): boolean {
	const expectedWorkspaceId = hostedUiWorkspaceId(env);
	if (expectedWorkspaceId && !workspaceId) return false;
	if (expectedWorkspaceId && workspaceId && !constantTimeEquals(workspaceId, expectedWorkspaceId)) return false;

	const expectedPairingCode = env.SPARK_UI_PAIRING_CODE?.trim();
	if (!pairingCode || !expectedPairingCode) return false;

	const pairingCodeHash = hashPairingCode(expectedPairingCode);
	if (consumedHostedUiPairingCodeHashes.has(pairingCodeHash)) return false;
	if (!constantTimeEquals(pairingCode, expectedPairingCode)) return false;

	consumedHostedUiPairingCodeHashes.add(pairingCodeHash);
	return true;
}

export function resetHostedUiPairingCodes(): void {
	consumedHostedUiPairingCodeHashes.clear();
}

export function hostedUiPathWithoutAuthQuery(url: URL): string {
	const clean = new URL(url);
	clean.searchParams.delete('uiKey');
	clean.searchParams.delete('apiKey');
	clean.searchParams.delete('pairCode');
	clean.searchParams.delete('workspaceId');
	clean.searchParams.delete('workspace');
	return clean.pathname + clean.search + clean.hash;
}

export function hostedUiSessionIsValid(cookies: Cookies, env: HostedUiAuthEnv, now = Date.now()): boolean {
	const sessionId = cookies.get(SESSION_COOKIE_NAME);
	if (!sessionId) return false;

	pruneExpiredHostedUiSessions(now);
	const session = hostedUiSessions.get(hashSessionId(sessionId));
	if (!session) return false;

	const expectedWorkspaceId = hostedUiWorkspaceId(env);
	if (expectedWorkspaceId && !constantTimeEquals(session.workspaceId, expectedWorkspaceId)) {
		hostedUiSessions.delete(hashSessionId(sessionId));
		return false;
	}

	session.lastSeenAt = now;
	session.expiresAt = Math.min(now + SESSION_IDLE_TIMEOUT_MS, session.absoluteExpiresAt);
	return session.expiresAt > now && session.absoluteExpiresAt > now;
}

export function hostedUiCookieOptions(env: HostedUiAuthEnv): typeof BASE_COOKIE_OPTIONS & { secure: boolean } {
	return {
		...BASE_COOKIE_OPTIONS,
		secure: hostedUiLooksHosted(env)
	};
}

export function persistHostedUiAuth(cookies: Cookies, env: HostedUiAuthEnv, workspaceIdOverride?: string | null): void {
	const workspaceId = hostedUiWorkspaceId(env) || workspaceIdOverride?.trim() || LOCAL_SESSION_WORKSPACE_ID;

	const now = Date.now();
	pruneExpiredHostedUiSessions(now);
	const sessionId = randomBytes(32).toString('base64url');
	hostedUiSessions.set(hashSessionId(sessionId), {
		workspaceId,
		createdAt: now,
		lastSeenAt: now,
		expiresAt: now + SESSION_IDLE_TIMEOUT_MS,
		absoluteExpiresAt: now + SESSION_ABSOLUTE_TIMEOUT_MS
	});
	cookies.set(SESSION_COOKIE_NAME, sessionId, hostedUiCookieOptions(env));
	for (const cookieName of LEGACY_AUTH_COOKIE_NAMES) {
		cookies.delete(cookieName, { path: '/' });
	}
}

export function redirectWithoutAuthQuery(url: URL): never {
	throw redirect(303, hostedUiPathWithoutAuthQuery(url));
}
