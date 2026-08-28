/**
 * Tests for requireControlAuth middleware
 *
 * Covers 14 PRs (#244, #243, #242, #241, #240, #239, #238, #237, #236,
 * #171, #170, #147, #144, #114) that require auth on various routes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// Storage for env variables shared across tests
const testEnv: Record<string, string> = {};

// Mock $env/dynamic/private so the module returns our test env
vi.mock('$env/dynamic/private', () => ({
	env: new Proxy(testEnv, {
		get(target, prop) { return target[prop as string]; },
		has(target, prop) { return prop in target; },
		ownKeys(target) { return Reflect.ownKeys(target); },
		getOwnPropertyDescriptor(target, prop) {
			return { configurable: true, enumerable: true, value: target[prop as string] };
		}
	})
}));

// Mock hosted-ui-auth
vi.mock('$lib/server/hosted-ui-auth', () => ({
	hostedUiLooksHosted: vi.fn(() => false),
	hostedUiSessionIsValid: vi.fn(() => false)
}));

// Dynamic import after mocks are in place
const { requireControlAuth } = await import('$lib/server/mcp-auth');

/** Helper: read the body of a SvelteKit Response as text */
async function readBody(res: Response): Promise<string> {
	const text = await res.text();
	return text;
}

function mockRequestEvent(): RequestEvent {
	return {
		request: {
			headers: new Headers(),
			url: 'http://localhost:3333/api/test',
			method: 'GET'
		} as Request,
		getClientAddress: vi.fn(() => '127.0.0.1'),
		cookies: {} as unknown,
		locals: {},
		params: {},
		route: { id: '/api/test' },
		isDataRequest: false,
		isSubRequest: false,
		url: new URL('http://localhost:3333/api/test'),
		setHeaders: vi.fn()
	} as unknown as RequestEvent;
}

function setHeader(event: RequestEvent, name: string, value: string): void {
	(event.request.headers as Headers).set(name, value);
}

function setNonLoopback(event: RequestEvent): void {
	Object.defineProperty(event.request, 'url', { value: 'https://api.example.com/test' });
	Object.defineProperty(event, 'url', { value: new URL('https://api.example.com/test') });
	(event.getClientAddress as ReturnType<typeof vi.fn>).mockReturnValue('10.0.0.1');
}

describe('requireControlAuth', () => {
	beforeEach(() => {
		// Clear all env vars between tests
		for (const key of Object.keys(testEnv)) {
			delete testEnv[key];
		}
	});

	// === Loopback ===

	it('returns null for loopback requests without API key (default allowLoopback)', () => {
		const event = mockRequestEvent();
		const result = requireControlAuth(event, { surface: 'test' });
		expect(result).toBeNull();
	});

	it('rejects loopback when allowLoopbackWithoutKey is false and no key', () => {
		testEnv.TEST_API_KEY = 'secret123';
		const event = mockRequestEvent();
		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY',
			allowLoopbackWithoutKey: false
		});
		expect(result).not.toBeNull();
		expect(result!.status).toBe(401);
	});

	it('returns null when allowLoopbackWithoutKey is false but valid key is provided', () => {
		testEnv.TEST_API_KEY = 'secret123';
		const event = mockRequestEvent();
		setHeader(event, 'x-mcp-api-key', 'secret123');
		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY',
			allowLoopbackWithoutKey: false
		});
		expect(result).toBeNull();
	});

	// === Origin ===

	it('returns 403 when origin is not allowed', async () => {
		testEnv.TEST_API_KEY = 'secret123';
		const event = mockRequestEvent();
		setHeader(event, 'x-mcp-api-key', 'secret123');
		setHeader(event, 'origin', 'https://evil.com');
		setNonLoopback(event);

		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY',
			allowedOriginsEnvVar: 'TEST_ALLOWED_ORIGINS'
		});
		expect(result).not.toBeNull();
		expect(result!.status).toBe(403);
		const body = await readBody(result!);
		expect(body).toContain('Origin is not allowed');
	});

	it('allows request when origin matches the request host (same-origin, with API key)', () => {
		testEnv.TEST_API_KEY = 'secret123';
		const event = mockRequestEvent();
		setHeader(event, 'origin', 'https://api.example.com');
		setHeader(event, 'x-mcp-api-key', 'secret123');
		setNonLoopback(event);

		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY'
		});
		expect(result).toBeNull();
	});

	it('allows request from allowed origin with valid API key', () => {
		testEnv.TEST_ALLOWED_ORIGINS = 'https://trusted.com';
		testEnv.TEST_API_KEY = 'secret123';
		const event = mockRequestEvent();
		setHeader(event, 'origin', 'https://trusted.com');
		setHeader(event, 'x-mcp-api-key', 'secret123');
		setNonLoopback(event);

		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY',
			allowedOriginsEnvVar: 'TEST_ALLOWED_ORIGINS'
		});
		expect(result).toBeNull();
	});

	// === API key: configured + incoming ===

	it('returns 401 when configured key is present but no incoming key', async () => {
		testEnv.TEST_API_KEY = 'secret123';
		const event = mockRequestEvent();
		setNonLoopback(event);

		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY'
		});
		expect(result).not.toBeNull();
		expect(result!.status).toBe(401);
		const body = await readBody(result!);
		expect(body).toContain('Unauthorized');
	});

	it('returns null when valid API key is provided via x-mcp-api-key header', () => {
		testEnv.TEST_API_KEY = 'secret123';
		const event = mockRequestEvent();
		setHeader(event, 'x-mcp-api-key', 'secret123');
		setNonLoopback(event);

		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY'
		});
		expect(result).toBeNull();
	});

	it('returns null when valid API key is provided via x-api-key header', () => {
		testEnv.TEST_API_KEY = 'secret123';
		const event = mockRequestEvent();
		setHeader(event, 'x-api-key', 'secret123');
		setNonLoopback(event);

		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY'
		});
		expect(result).toBeNull();
	});

	it('returns null when valid API key is provided via Bearer token', () => {
		testEnv.TEST_API_KEY = 'secret123';
		const event = mockRequestEvent();
		setHeader(event, 'authorization', 'Bearer secret123');
		setNonLoopback(event);

		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY'
		});
		expect(result).toBeNull();
	});

	it('returns 401 when API key does not match', () => {
		testEnv.TEST_API_KEY = 'secret123';
		const event = mockRequestEvent();
		setHeader(event, 'x-mcp-api-key', 'wrongkey');
		setNonLoopback(event);

		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY'
		});
		expect(result).not.toBeNull();
		expect(result!.status).toBe(401);
	});

	it('uses fallbackApiKeyEnvVar when apiKeyEnvVar is not set', () => {
		testEnv.FALLBACK_KEY = 'fallback123';
		const event = mockRequestEvent();
		setHeader(event, 'x-mcp-api-key', 'fallback123');
		setNonLoopback(event);

		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY',
			fallbackApiKeyEnvVar: 'FALLBACK_KEY'
		});
		expect(result).toBeNull();
	});

	it('prioritizes apiKeyEnvVar over fallbackApiKeyEnvVar', () => {
		testEnv.TEST_API_KEY = 'primary';
		testEnv.FALLBACK_KEY = 'fallback';
		const event = mockRequestEvent();
		setHeader(event, 'x-mcp-api-key', 'primary');
		setNonLoopback(event);

		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY',
			fallbackApiKeyEnvVar: 'FALLBACK_KEY'
		});
		expect(result).toBeNull();

		// Wrong primary key should fail even if fallback is correct
		const event2 = mockRequestEvent();
		setHeader(event2, 'x-mcp-api-key', 'fallback');
		setNonLoopback(event2);
		const result2 = requireControlAuth(event2, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY',
			fallbackApiKeyEnvVar: 'FALLBACK_KEY'
		});
		expect(result2).not.toBeNull();
		expect(result2!.status).toBe(401);
	});

	// === No configured key ===

	it('returns 401 when no API key configured and request is not loopback', async () => {
		const event = mockRequestEvent();
		setNonLoopback(event);

		const result = requireControlAuth(event, { surface: 'test' });
		expect(result).not.toBeNull();
		expect(result!.status).toBe(401);
		const body = await readBody(result!);
		expect(body).toContain('require API key for non-local requests');
	});

	// === Edge cases ===

	it('rejects requests with empty API key header', () => {
		testEnv.TEST_API_KEY = 'secret123';
		const event = mockRequestEvent();
		setHeader(event, 'x-mcp-api-key', '');
		setNonLoopback(event);

		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY'
		});
		expect(result).not.toBeNull();
		expect(result!.status).toBe(401);
	});

	it('rejects requests with whitespace-only API key header', () => {
		testEnv.TEST_API_KEY = 'secret123';
		const event = mockRequestEvent();
		setHeader(event, 'x-mcp-api-key', '   ');
		setNonLoopback(event);

		const result = requireControlAuth(event, {
			surface: 'test',
			apiKeyEnvVar: 'TEST_API_KEY'
		});
		expect(result).not.toBeNull();
		expect(result!.status).toBe(401);
	});
});
