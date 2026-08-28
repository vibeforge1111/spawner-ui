import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import {
	hostedUiAuthEnabled,
	hostedUiCredentialsAreValid,
	hostedUiAuthClientKey,
	hostedUiAuthPathIsExempt,
	hostedUiAuthRateLimitStatus,
	hostedUiCrossSiteMutationRejection,
	hostedUiPrivatePreviewConfigured,
	hostedUiSecurityHeaders,
	hostedUiRequestHasExplicitToken,
	hostedUiReleaseLockPathIsExempt,
	hostedUiReleaseLocked,
	hostedUiRequestToken,
	hostedUiRequestWorkspaceId,
	hostedUiSessionIsValid,
	hostedUiTokenIsValid,
	hostedUiPathWithoutAuthQuery,
	hostedUiCookieOptions,
	consumeHostedUiPairingCode,
	hostedUiIsLocalOperatorLoopbackRequest,
	hostedUiShouldBypassLocalOperatorAuth,
	persistHostedUiAuth,
	recordHostedUiAuthFailure,
	resetHostedUiAuthRateLimits,
	resetHostedUiPairingCodes,
	resetHostedUiSessions
} from './hosted-ui-auth';

type FakeCookies = Cookies & {
	get: ReturnType<typeof vi.fn>;
	set: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
};

function fakeCookies(initial: Record<string, string> = {}): FakeCookies {
	const values = new Map(Object.entries(initial));
	return {
		get: vi.fn((name: string) => values.get(name)),
		getAll: vi.fn(() => Array.from(values, ([name, value]) => ({ name, value }))),
		set: vi.fn((name: string, value: string) => {
			values.set(name, value);
		}),
		delete: vi.fn((name: string) => {
			values.delete(name);
		}),
		serialize: vi.fn((name: string, value: string) => `${name}=${value}`)
	} as unknown as FakeCookies;
}

describe('hosted UI auth', () => {
	afterEach(() => {
		resetHostedUiSessions();
		resetHostedUiPairingCodes();
		vi.useRealTimers();
	});

	it('is enabled only when a UI key is configured', () => {
		expect(hostedUiAuthEnabled({})).toBe(false);
		expect(hostedUiAuthEnabled({ SPARK_UI_API_KEY: 'secret' })).toBe(true);
	});

	it('locks hosted deployments unless private preview is explicit', () => {
		expect(hostedUiReleaseLocked({})).toBe(false);
		expect(hostedUiReleaseLocked({ SPARK_LIVE_CONTAINER: '1' })).toBe(true);
		expect(hostedUiReleaseLocked({ SPARK_SPAWNER_HOST: '0.0.0.0' })).toBe(true);
		expect(hostedUiReleaseLocked({ SPARK_ALLOWED_HOSTS: 'spark.example.com' })).toBe(true);
		expect(hostedUiReleaseLocked({ RAILWAY_PUBLIC_DOMAIN: 'spawner.example.up.railway.app' })).toBe(true);
		expect(hostedUiReleaseLocked({ RENDER_EXTERNAL_URL: 'https://spawner.example.com' })).toBe(true);
		expect(hostedUiReleaseLocked({ FLY_APP_NAME: 'spawner-ui' })).toBe(true);
		expect(hostedUiReleaseLocked({ VERCEL_URL: 'spawner.example.com' })).toBe(true);
		expect(hostedUiReleaseLocked({ NETLIFY: 'true' })).toBe(true);
		expect(hostedUiReleaseLocked({ SPARK_LIVE_CONTAINER: '1', SPARK_HOSTED_PRIVATE_PREVIEW: '1' })).toBe(true);
		expect(
			hostedUiReleaseLocked({
				SPARK_LIVE_CONTAINER: '1',
				SPARK_HOSTED_PRIVATE_PREVIEW: '1',
				SPARK_WORKSPACE_ID: 'private-workspace',
				SPARK_UI_API_KEY: 'secret'
			})
		).toBe(false);
	});

	it('requires workspace identity and a UI key before private preview opens', () => {
		expect(hostedUiPrivatePreviewConfigured({ SPARK_HOSTED_PRIVATE_PREVIEW: '1' })).toBe(false);
		expect(hostedUiPrivatePreviewConfigured({ SPARK_HOSTED_PRIVATE_PREVIEW: '1', SPARK_UI_API_KEY: 'secret' })).toBe(false);
		expect(
			hostedUiPrivatePreviewConfigured({
				SPARK_HOSTED_PRIVATE_PREVIEW: '1',
				SPARK_WORKSPACE_ID: 'private-workspace',
				SPARK_UI_API_KEY: 'secret'
			})
		).toBe(true);
	});

	it('adds a hosted CSP and baseline security headers', () => {
		const localHeaders = hostedUiSecurityHeaders({});
		expect(localHeaders['X-Frame-Options']).toBe('DENY');
		expect(localHeaders['X-Content-Type-Options']).toBe('nosniff');
		expect(localHeaders['Content-Security-Policy']).toBeUndefined();

		const hostedHeaders = hostedUiSecurityHeaders({ SPARK_LIVE_CONTAINER: '1' });
		expect(hostedHeaders['Content-Security-Policy']).toContain("frame-ancestors 'none'");
		expect(hostedHeaders['Permissions-Policy']).toContain('camera=()');
	});

	it('lets only the public landing page through the release lock', () => {
		expect(hostedUiReleaseLockPathIsExempt('/')).toBe(true);
		expect(hostedUiReleaseLockPathIsExempt('/api/health/live')).toBe(true);
		expect(hostedUiReleaseLockPathIsExempt('/api/health')).toBe(true);
		expect(hostedUiReleaseLockPathIsExempt('/canvas')).toBe(false);
		expect(hostedUiReleaseLockPathIsExempt('/kanban')).toBe(false);
		expect(hostedUiReleaseLockPathIsExempt('/api/mission-control/board')).toBe(false);
		expect(hostedUiReleaseLockPathIsExempt('/spark-live/login')).toBe(false);
	});

	it('exempts static assets', () => {
		expect(hostedUiAuthPathIsExempt('/_app/immutable/app.js')).toBe(true);
		expect(hostedUiAuthPathIsExempt('/favicon.png')).toBe(true);
		expect(hostedUiAuthPathIsExempt('/robots.txt')).toBe(true);
		expect(hostedUiAuthPathIsExempt('/spark-live/login')).toBe(true);
		expect(hostedUiAuthPathIsExempt('/api/health/live')).toBe(true);
		expect(hostedUiAuthPathIsExempt('/api/health')).toBe(true);
		expect(hostedUiAuthPathIsExempt('/spark-live/login-extra')).toBe(false);
		expect(hostedUiAuthPathIsExempt('/spark-live/setup')).toBe(false);
		expect(hostedUiAuthPathIsExempt('/api/providers')).toBe(false);
	});

	it('accepts header and bearer tokens but not static UI query tokens', () => {
		const cookies = fakeCookies({ spawner_ui_api_key: 'cookie-key' });
		expect(hostedUiRequestToken(new Request('https://x.test/?uiKey=query-key'), new URL('https://x.test/?uiKey=query-key'), cookies)).toBeNull();
		expect(hostedUiRequestToken(new Request('https://x.test/?apiKey=query-key'), new URL('https://x.test/?apiKey=query-key'), cookies)).toBeNull();
		expect(hostedUiRequestToken(new Request('https://x.test/', { headers: { 'x-spawner-ui-key': 'header-key' } }), new URL('https://x.test/'), cookies)).toBe('header-key');
		expect(hostedUiRequestToken(new Request('https://x.test/', { headers: { authorization: 'Bearer bearer-key' } }), new URL('https://x.test/'), cookies)).toBe('bearer-key');
		expect(hostedUiRequestToken(new Request('https://x.test/'), new URL('https://x.test/'), cookies)).toBeNull();
	});

	it('distinguishes explicit API tokens from cookie-only browser auth', () => {
		expect(
			hostedUiRequestHasExplicitToken(
				new Request('https://x.test/', { headers: { 'x-spawner-ui-key': 'header-key' } }),
				new URL('https://x.test/')
			)
		).toBe(true);
		expect(hostedUiRequestHasExplicitToken(new Request('https://x.test/?uiKey=query-key'), new URL('https://x.test/?uiKey=query-key'))).toBe(false);
		expect(hostedUiRequestHasExplicitToken(new Request('https://x.test/?apiKey=query-key'), new URL('https://x.test/?apiKey=query-key'))).toBe(false);
		expect(hostedUiRequestHasExplicitToken(new Request('https://x.test/', { headers: { cookie: 'spawner_ui_api_key=cookie-key' } }), new URL('https://x.test/'))).toBe(false);
	});

	it('keeps local operator access as request classification, not browser session auth', () => {
		expect(
			hostedUiIsLocalOperatorLoopbackRequest(
				new Request('http://127.0.0.1:3333/kanban', { headers: { accept: 'text/html' } }),
				new URL('http://127.0.0.1:3333/kanban'),
				'127.0.0.1'
			)
		).toBe(true);
		expect(
			hostedUiIsLocalOperatorLoopbackRequest(
				new Request('http://0.0.0.0:3333/kanban', { headers: { accept: 'text/html' } }),
				new URL('http://0.0.0.0:3333/kanban'),
				'127.0.0.1'
			)
		).toBe(true);
		expect(
			hostedUiIsLocalOperatorLoopbackRequest(
				new Request('http://192.168.1.20:3333/kanban', { headers: { accept: 'text/html' } }),
				new URL('http://192.168.1.20:3333/kanban'),
				'192.168.1.20'
			)
		).toBe(false);
		expect(
			hostedUiIsLocalOperatorLoopbackRequest(
				new Request('https://spawner.example.com/kanban', { headers: { accept: 'text/html' } }),
				new URL('https://spawner.example.com/kanban'),
				'127.0.0.1'
			)
		).toBe(false);
	});

	it('classifies local operator loopback from the request, not broad bind env flags', () => {
		expect(
			hostedUiIsLocalOperatorLoopbackRequest(
				new Request('http://127.0.0.1:3333/kanban'),
				new URL('http://127.0.0.1:3333/kanban'),
				'127.0.0.1'
			)
		).toBe(true);
		expect(
			hostedUiIsLocalOperatorLoopbackRequest(
				new Request('http://0.0.0.0:3333/kanban'),
				new URL('http://0.0.0.0:3333/kanban'),
				'127.0.0.1'
			)
		).toBe(true);
		expect(
			hostedUiIsLocalOperatorLoopbackRequest(
				new Request('https://spawner.example.com/kanban'),
				new URL('https://spawner.example.com/kanban'),
				'127.0.0.1'
			)
		).toBe(false);
		expect(
			hostedUiIsLocalOperatorLoopbackRequest(
				new Request('http://127.0.0.1:3333/kanban'),
				new URL('http://127.0.0.1:3333/kanban'),
				'203.0.113.10'
			)
		).toBe(false);
	});

	it('bypasses the hosted access wall for local operator loopback API calls only', () => {
		const localEnv = { SPARK_UI_API_KEY: 'ui-key', SPARK_WORKSPACE_ID: 'private-workspace' };
		expect(
			hostedUiShouldBypassLocalOperatorAuth(
				new Request('http://127.0.0.1:3333/api/providers', { headers: { accept: 'application/json' } }),
				new URL('http://127.0.0.1:3333/api/providers'),
				localEnv,
				'127.0.0.1'
			)
		).toBe(true);
		expect(
			hostedUiShouldBypassLocalOperatorAuth(
				new Request('http://127.0.0.1:3333/api/providers', { headers: { accept: 'application/json' } }),
				new URL('http://127.0.0.1:3333/api/providers'),
				{ ...localEnv, SPARK_ALLOWED_HOSTS: 'spawner.example.com' },
				'127.0.0.1'
			)
		).toBe(true);
		expect(
			hostedUiShouldBypassLocalOperatorAuth(
				new Request('http://127.0.0.1:3333/api/providers', { headers: { accept: 'application/json' } }),
				new URL('http://127.0.0.1:3333/api/providers'),
				localEnv,
				'203.0.113.10'
			)
		).toBe(false);
		expect(
			hostedUiShouldBypassLocalOperatorAuth(
				new Request('https://spawner.example.com/api/providers', { headers: { accept: 'application/json' } }),
				new URL('https://spawner.example.com/api/providers'),
				localEnv,
				'127.0.0.1'
			)
		).toBe(false);
	});

	it('allows a configured hosted UI pairing code once', () => {
		const env = {
			SPARK_WORKSPACE_ID: 'private-workspace',
			SPARK_UI_API_KEY: 'ui-key',
			SPARK_UI_PAIRING_CODE: 'one-time-code'
		};
		expect(consumeHostedUiPairingCode('wrong-workspace', 'one-time-code', env)).toBe(false);
		expect(consumeHostedUiPairingCode('private-workspace', 'wrong-code', env)).toBe(false);
		expect(consumeHostedUiPairingCode('private-workspace', 'one-time-code', env)).toBe(true);
		expect(consumeHostedUiPairingCode('private-workspace', 'one-time-code', env)).toBe(false);
	});

	it('strips auth query values from hosted UI redirect targets', () => {
		const url = new URL('https://x.test/canvas?uiKey=secret&apiKey=api-secret&pairCode=pair&workspaceId=workspace&keep=1#section');
		expect(hostedUiPathWithoutAuthQuery(url)).toBe('/canvas?keep=1#section');
	});

	it('blocks cross-site mutating browser requests unless an explicit API token is used', () => {
		const url = new URL('https://spawner.example.com/api/mission-control/command');
		expect(
			hostedUiCrossSiteMutationRejection(
				new Request(url, { method: 'POST', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }),
				url
			)
		).toMatch(/Cross-site/);
		expect(
			hostedUiCrossSiteMutationRejection(
				new Request(url, { method: 'POST', headers: { origin: 'https://evil.example' } }),
				url
			)
		).toMatch(/origin/);
		expect(
			hostedUiCrossSiteMutationRejection(
				new Request(url, { method: 'POST', headers: { origin: 'https://spawner.example.com', 'sec-fetch-site': 'same-origin' } }),
				url
			)
		).toBeNull();
		expect(
			hostedUiCrossSiteMutationRejection(
				new Request(url, { method: 'POST', headers: { 'x-spawner-ui-key': 'api-key' } }),
				url
			)
		).toBeNull();
	});

	it('accepts workspace id from query, header, and cookie', () => {
		const cookies = fakeCookies({ spawner_workspace_id: 'cookie-workspace' });
		expect(hostedUiRequestWorkspaceId(new Request('https://x.test/?workspaceId=query-workspace'), new URL('https://x.test/?workspaceId=query-workspace'), cookies)).toBe('query-workspace');
		expect(hostedUiRequestWorkspaceId(new Request('https://x.test/', { headers: { 'x-spawner-workspace-id': 'header-workspace' } }), new URL('https://x.test/'), cookies)).toBe('header-workspace');
		expect(hostedUiRequestWorkspaceId(new Request('https://x.test/'), new URL('https://x.test/'), cookies)).toBeNull();
	});

	it('persists an opaque server-side session without exposing keys to JavaScript', () => {
		const cookies = fakeCookies({
			spawner_ui_api_key: 'old-ui-key',
			spawner_workspace_id: 'old-workspace',
			spawner_control_api_key: 'old-control',
			spawner_events_api_key: 'old-events'
		});
		persistHostedUiAuth(cookies, {
			SPARK_WORKSPACE_ID: 'private-workspace',
			SPARK_UI_API_KEY: 'ui-key',
			SPARK_BRIDGE_API_KEY: 'bridge-key',
			EVENTS_API_KEY: 'events-key'
		});

		expect(cookies.set).toHaveBeenCalledWith('spawner_ui_session', expect.any(String), expect.objectContaining({ httpOnly: true, sameSite: 'strict', secure: false }));
		expect(cookies.delete).toHaveBeenCalledWith('spawner_workspace_id', { path: '/' });
		expect(cookies.delete).toHaveBeenCalledWith('spawner_ui_api_key', { path: '/' });
		expect(cookies.delete).toHaveBeenCalledWith('spawner_control_api_key', { path: '/' });
		expect(cookies.delete).toHaveBeenCalledWith('spawner_events_api_key', { path: '/' });
		expect(hostedUiSessionIsValid(cookies, { SPARK_WORKSPACE_ID: 'private-workspace' })).toBe(true);
		expect(hostedUiSessionIsValid(cookies, { SPARK_WORKSPACE_ID: 'other-workspace' })).toBe(false);
	});

	it('keeps hosted browser sessions secure while allowing local loopback sessions', () => {
		expect(hostedUiCookieOptions({ SPARK_UI_API_KEY: 'ui-key' })).toMatchObject({ secure: false });
		expect(hostedUiCookieOptions({ SPARK_UI_API_KEY: 'ui-key', SPARK_LIVE_CONTAINER: '1' })).toMatchObject({ secure: true });
		expect(hostedUiCookieOptions({ SPARK_UI_API_KEY: 'ui-key', SPARK_ALLOWED_HOSTS: 'mission.example.com' })).toMatchObject({ secure: true });
	});

	it('persists token-only local sessions when no workspace id is configured', () => {
		const cookies = fakeCookies();
		persistHostedUiAuth(cookies, { SPARK_UI_API_KEY: 'ui-key' }, 'operator-workspace');

		expect(cookies.set).toHaveBeenCalledWith('spawner_ui_session', expect.any(String), expect.objectContaining({ secure: false }));
		expect(hostedUiSessionIsValid(cookies, { SPARK_UI_API_KEY: 'ui-key' })).toBe(true);
	});

	it('expires private preview sessions on idle and absolute timeouts', () => {
		const cookies = fakeCookies();
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		persistHostedUiAuth(cookies, { SPARK_WORKSPACE_ID: 'private-workspace', SPARK_UI_API_KEY: 'ui-key' });
		expect(hostedUiSessionIsValid(cookies, { SPARK_WORKSPACE_ID: 'private-workspace' }, 1_000)).toBe(true);
		expect(hostedUiSessionIsValid(cookies, { SPARK_WORKSPACE_ID: 'private-workspace' }, 1000 + 1000 * 60 * 60 * 13)).toBe(false);
	});

	it('compares tokens exactly', () => {
		expect(hostedUiTokenIsValid('secret', { SPARK_UI_API_KEY: 'secret' })).toBe(true);
		expect(hostedUiTokenIsValid('wrong', { SPARK_UI_API_KEY: 'secret' })).toBe(false);
	});

	it('requires matching workspace id when configured', () => {
		const env = { SPARK_WORKSPACE_ID: 'my-private-spawner', SPARK_UI_API_KEY: 'secret' };
		expect(hostedUiCredentialsAreValid('my-private-spawner', 'secret', env)).toBe(true);
		expect(hostedUiCredentialsAreValid('other-workspace', 'secret', env)).toBe(false);
		expect(hostedUiCredentialsAreValid(null, 'secret', env)).toBe(false);
		expect(hostedUiCredentialsAreValid('my-private-spawner', 'wrong', env)).toBe(false);
	});

	it('uses the trusted-proxy (last) forwarded-for hop as the hosted auth rate-limit key', () => {
		// The leftmost x-forwarded-for entry is client-controllable and can be spoofed to
		// dodge the rate limiter. The hardened key derivation trusts only the last hop,
		// which is appended by our reverse proxy.
		const request = new Request('https://x.test/', { headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' } });
		expect(hostedUiAuthClientKey(request)).toBe('10.0.0.1');
	});

	it('prefers the adapter-provided client address over spoofable request headers', () => {
		const request = new Request('https://x.test/', {
			headers: {
				'x-real-ip': '198.51.100.50',
				'x-forwarded-for': '203.0.113.10, 10.0.0.1'
			}
		});
		expect(hostedUiAuthClientKey(request, '192.0.2.25')).toBe('192.0.2.25');
	});

	it('rate-limits repeated hosted auth failures within the window', () => {
		resetHostedUiAuthRateLimits();
		for (let i = 0; i < 12; i += 1) {
			recordHostedUiAuthFailure('client-a', 1_000);
		}
		expect(hostedUiAuthRateLimitStatus('client-a', 2_000)).toEqual({ blocked: true, retryAfterSeconds: 59 });
		expect(hostedUiAuthRateLimitStatus('client-a', 62_000)).toEqual({ blocked: false, retryAfterSeconds: 0 });
	});
});
