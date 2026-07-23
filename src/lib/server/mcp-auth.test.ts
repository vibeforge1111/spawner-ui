import { describe, expect, it, vi } from 'vitest';

const PRIVATE_ENV = vi.hoisted((): Record<string, string | undefined> => ({
	MCP_API_KEY: '',
	MCP_ALLOWED_ORIGINS: ''
}));

vi.mock('$env/dynamic/private', () => ({ env: PRIVATE_ENV }));

import { enforceRateLimit, requireControlAuth, requireMcpAuth } from './mcp-auth';

function event(url = 'http://127.0.0.1/api/mcp', init?: RequestInit, clientAddress = '127.0.0.1') {
	return {
		request: new Request(url, init),
		getClientAddress: () => clientAddress
	} as never;
}

describe('MCP control auth', () => {
	it('does not allow loopback requests by default', async () => {
		PRIVATE_ENV.MCP_API_KEY = '';

		const response = requireControlAuth(event(), {
			surface: 'unit-test',
			apiKeyEnvVar: 'MCP_API_KEY'
		});

		expect(response?.status).toBe(401);
		await expect(response?.json()).resolves.toMatchObject({
			error: 'unit-test routes require API key for non-local requests'
		});
	});

	it('allows loopback only when the route explicitly opts in', () => {
		PRIVATE_ENV.MCP_API_KEY = '';

		const response = requireControlAuth(event(), {
			surface: 'unit-test',
			apiKeyEnvVar: 'MCP_API_KEY',
			allowLoopbackWithoutKey: true
		});

		expect(response).toBeNull();
	});

	it('uses the same local operator loopback classifier as hosted UI auth', () => {
		PRIVATE_ENV.MCP_API_KEY = '';

		const boundAllInterfaces = requireControlAuth(
			event('http://0.0.0.0:3333/api/mission-control/board', undefined, '127.0.0.1'),
			{
				surface: 'unit-test',
				apiKeyEnvVar: 'MCP_API_KEY',
				allowLoopbackWithoutKey: true
			}
		);
		const ipv4MappedLoopback = requireControlAuth(
			event('http://127.0.0.1:3333/api/mission-control/board', undefined, '::ffff:127.0.0.1'),
			{
				surface: 'unit-test',
				apiKeyEnvVar: 'MCP_API_KEY',
				allowLoopbackWithoutKey: true
			}
		);

		expect(boundAllInterfaces).toBeNull();
		expect(ipv4MappedLoopback).toBeNull();
	});

	it('requires an API key for MCP routes even on loopback', async () => {
		PRIVATE_ENV.MCP_API_KEY = 'mcp-secret';

		const missing = requireMcpAuth(event());
		expect(missing?.status).toBe(401);

		const authorized = requireMcpAuth(
			event('http://127.0.0.1/api/mcp', {
				headers: { 'x-api-key': 'mcp-secret' }
			})
		);
		expect(authorized).toBeNull();
	});

	it('never accepts configured API keys from URL query parameters', async () => {
		PRIVATE_ENV.MCP_API_KEY = 'mcp-secret';

		const response = requireMcpAuth(
			event('http://127.0.0.1/api/mcp?apiKey=mcp-secret')
		);

		expect(response?.status).toBe(401);
	});

	it('does not let unresolvable clients bypass limits by rotating Host values', () => {
		const first = {
			request: new Request('https://first.example/api/events'),
			getClientAddress: () => {
				throw new Error('address unavailable');
			}
		};
		const second = {
			request: new Request('https://second.example/api/events'),
			getClientAddress: () => {
				throw new Error('address unavailable');
			}
		};

		expect(enforceRateLimit(first as never, { scope: 'host-rotation-proof', limit: 1, windowMs: 60_000 })).toBeNull();
		expect(enforceRateLimit(second as never, { scope: 'host-rotation-proof', limit: 1, windowMs: 60_000 })?.status).toBe(429);
	});
});
