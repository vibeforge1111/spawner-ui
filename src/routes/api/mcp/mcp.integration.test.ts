import { beforeEach, describe, expect, it, vi } from 'vitest';

const { PRIVATE_ENV } = vi.hoisted(() => ({
	PRIVATE_ENV: {
		MCP_API_KEY: 'mcp-test-secret',
		MCP_ALLOWED_ORIGINS: '',
		MCP_ALLOW_CUSTOM_CONFIG: ''
	}
}));

vi.mock('$env/dynamic/private', () => ({ env: PRIVATE_ENV }));

vi.mock('$lib/services/mcp/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/services/mcp/client')>();
	return {
		...actual,
		connectMCP: vi.fn()
	};
});

import { POST } from './+server';
import { connectMCP } from '$lib/services/mcp/client';
import {
	buildClientGovernorDecisionAuthority,
	buildClientTurnIntentVNextAuthority
} from '$lib/services/harness-authority-client';

function event(body: unknown) {
	return {
		request: new Request('http://127.0.0.1/api/mcp', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-test-secret' },
			body: JSON.stringify(body)
		}),
		url: new URL('http://127.0.0.1/api/mcp'),
		getClientAddress: () => '127.0.0.1'
	};
}

function connectAuthority() {
	return buildClientGovernorDecisionAuthority({
		source: 'mcp.integration.test',
		reason: 'Focused MCP connect authority regression.',
		toolName: 'spawner.mcp.connect',
		mutationClass: 'external_network',
		target: 'filesystem',
		externalNetwork: true
	});
}

describe('/api/mcp', () => {
	beforeEach(() => {
		PRIVATE_ENV.MCP_API_KEY = 'mcp-test-secret';
		PRIVATE_ENV.MCP_ALLOW_CUSTOM_CONFIG = '';
		vi.mocked(connectMCP).mockReset();
		vi.mocked(connectMCP).mockResolvedValue({
			client: {} as never,
			transport: {} as never,
			serverInfo: { name: 'filesystem', version: '1.0.0' },
			tools: []
		});
	});

	it('requires an MCP API key even for loopback requests', async () => {
		const response = await POST({
			request: new Request('http://127.0.0.1/api/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ instanceId: 'filesystem', mcpId: 'filesystem' })
			}),
			url: new URL('http://127.0.0.1/api/mcp'),
			getClientAddress: () => '127.0.0.1'
		} as never);

		expect(response.status).toBe(401);
		expect(connectMCP).not.toHaveBeenCalled();
	});

	it('blocks explicit MCP commands unless custom config is enabled', async () => {
		const response = await POST(event({
			instanceId: 'custom-command',
			command: 'npx',
			args: ['-y', 'unreviewed-mcp-package']
		}) as never);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: expect.stringContaining('Custom MCP commands and npm packages are disabled')
		});
		expect(connectMCP).not.toHaveBeenCalled();
	});

	it('blocks registry npm package fallbacks unless custom config is enabled', async () => {
		const response = await POST(event({
			instanceId: 'registry-package',
			mcpId: 'community-server',
			npmPackage: 'unreviewed-mcp-package'
		}) as never);

		expect(response.status).toBe(403);
		expect(connectMCP).not.toHaveBeenCalled();
	});

	it('still allows preconfigured MCP ids without custom package input', async () => {
		const response = await POST(event({
			instanceId: 'filesystem',
			mcpId: 'filesystem',
			executionAuthority: connectAuthority()
		}) as never);

		expect(response.status).toBe(200);
		expect(connectMCP).toHaveBeenCalledWith(
			'filesystem',
			expect.objectContaining({ command: 'npx' })
		);
	});

	it('blocks preconfigured MCP connect without Harness Core authority', async () => {
		const response = await POST(event({
			instanceId: 'filesystem',
			mcpId: 'filesystem'
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
		expect(connectMCP).not.toHaveBeenCalled();
	});

	it('blocks preconfigured MCP connect with bare TurnIntentEnvelopeVNext authority', async () => {
		const response = await POST(event({
			instanceId: 'filesystem',
			mcpId: 'filesystem',
			executionAuthority: buildClientTurnIntentVNextAuthority({
				source: 'mcp.integration.test',
				reason: 'Focused MCP connect bare-VNext regression.',
				toolName: 'spawner.mcp.connect',
				mutationClass: 'external_network',
				target: 'filesystem',
				externalNetwork: true
			})
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
		expect(connectMCP).not.toHaveBeenCalled();
	});

	it('returns 400 for empty request body instead of 500', async () => {
		const response = await POST({
			request: new Request('http://127.0.0.1/api/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-test-secret' },
				body: ''
			}),
			url: new URL('http://127.0.0.1/api/mcp'),
			getClientAddress: () => '127.0.0.1'
		} as never);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: expect.stringContaining('JSON body') });
		expect(connectMCP).not.toHaveBeenCalled();
	});

	it('returns 400 for malformed JSON body instead of 500', async () => {
		const response = await POST({
			request: new Request('http://127.0.0.1/api/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-test-secret' },
				body: '{not valid json'
			}),
			url: new URL('http://127.0.0.1/api/mcp'),
			getClientAddress: () => '127.0.0.1'
		} as never);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: expect.stringContaining('JSON body') });
		expect(connectMCP).not.toHaveBeenCalled();
	});
});
