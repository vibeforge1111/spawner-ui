import { beforeEach, describe, expect, it, vi } from 'vitest';

const mcpClientMocks = vi.hoisted(() => ({
	callTool: vi.fn(),
	isConnected: vi.fn(() => true)
}));

const PRIVATE_ENV = vi.hoisted(() => ({
	MCP_API_KEY: 'mcp-call-integration-test-secret',
	MCP_ALLOWED_ORIGINS: ''
}));

vi.mock('$env/dynamic/private', () => ({ env: PRIVATE_ENV }));
vi.mock('$lib/services/mcp/client', () => mcpClientMocks);

import { POST } from './+server';
import { buildServerGovernorDecisionAuthority } from '$lib/server/harness-authority';

function event(body: unknown) {
	return {
		request: new Request('http://127.0.0.1/api/mcp/call', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': 'mcp-call-integration-test-secret'
			},
			body: JSON.stringify(body)
		}),
		url: new URL('http://127.0.0.1/api/mcp/call'),
		getClientAddress: () => '127.0.0.1'
	};
}

describe('/api/mcp/call', () => {
	beforeEach(() => {
		PRIVATE_ENV.MCP_API_KEY = 'mcp-call-integration-test-secret';
		mcpClientMocks.callTool.mockReset();
		mcpClientMocks.isConnected.mockReturnValue(true);
	});

	it('bounds tool call failures without returning or logging local paths', async () => {
		const localPath = '/Users/alice/private/mcp-result-cache.json';
		const errorMessages: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			errorMessages.push(args.map(String).join(' '));
		};

		try {
			mcpClientMocks.callTool.mockRejectedValueOnce(new Error(`tool failed while reading ${localPath}`));

			const response = await POST(event({
				instanceId: 'filesystem',
				toolName: 'read_file',
				args: { path: 'README.md' },
				executionAuthority: buildServerGovernorDecisionAuthority({
					source: 'mcp-call.integration.test',
					reason: 'Exercise the bounded MCP tool-call failure.',
					toolName: 'spawner.mcp.call_tool',
					mutationClass: 'external_network',
					target: 'filesystem:read_file',
					externalNetwork: true
				})
			}) as never);

			expect(response.status).toBe(500);
			await expect(response.json()).resolves.toEqual({ error: 'MCP tool call failed' });
		} finally {
			console.error = originalError;
		}

		expect(errorMessages.join('\n')).toContain('<local-path>');
		expect(errorMessages.join('\n')).not.toContain(localPath);
	});
});
