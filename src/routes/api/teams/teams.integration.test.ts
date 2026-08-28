import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET, POST } from './+server';

const TEST_API_KEY = 'teams-route-test-secret';
let originalMcpApiKey: string | undefined;

function event(url: string, init: RequestInit = {}, clientAddress = '127.0.0.1') {
	return {
		request: new Request(url, init),
		url: new URL(url),
		getClientAddress: () => clientAddress,
		cookies: { get: () => undefined }
	};
}

describe('/api/teams integration', () => {
	beforeEach(() => {
		originalMcpApiKey = process.env.MCP_API_KEY;
		process.env.MCP_API_KEY = TEST_API_KEY;
	});

	afterEach(() => {
		if (originalMcpApiKey === undefined) delete process.env.MCP_API_KEY;
		else process.env.MCP_API_KEY = originalMcpApiKey;
	});

	it('keeps local team registry observation open', async () => {
		const response = await GET(event('http://127.0.0.1:3333/api/teams', { method: 'GET' }) as never);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(Array.isArray(body.teams)).toBe(true);
		expect(typeof body.active_team_id === 'string' || body.active_team_id === null).toBe(true);
	});

	it('rejects unauthenticated local team POST queries', async () => {
		const response = await POST(
			event('http://192.168.1.100:3333/api/teams', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'list_teams' })
			}, '192.168.1.100') as never
		);

		expect(response.status).toBe(401);
	});

	it('allows keyed local team POST queries without mutating team registry truth', async () => {
		const response = await POST(
			event('http://127.0.0.1:3333/api/teams', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-api-key': TEST_API_KEY },
				body: JSON.stringify({ action: 'list_teams' })
			}) as never
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(Array.isArray(body.teams)).toBe(true);
	});
});
