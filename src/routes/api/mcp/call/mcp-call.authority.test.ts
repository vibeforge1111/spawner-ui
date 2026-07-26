import { beforeEach, describe, expect, it, vi } from 'vitest';

const PRIVATE_ENV = vi.hoisted((): Record<string, string | undefined> => ({
	MCP_API_KEY: 'mcp-test-secret',
	MCP_ALLOWED_ORIGINS: ''
}));

vi.mock('$env/dynamic/private', () => ({ env: PRIVATE_ENV }));

vi.mock('$lib/services/mcp/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/services/mcp/client')>();
	return {
		...actual,
		callTool: vi.fn(),
		isConnected: vi.fn()
	};
});

import { POST } from './+server';
import { callTool, isConnected } from '$lib/services/mcp/client';
import {
	buildServerGovernorDecisionAuthority,
	buildServerTurnIntentVNextAuthority
} from '$lib/server/harness-authority';

function event(body: unknown) {
	return {
		request: new Request('http://127.0.0.1/api/mcp/call', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-test-secret' },
			body: JSON.stringify(body)
		}),
		url: new URL('http://127.0.0.1/api/mcp/call'),
		getClientAddress: () => '127.0.0.1'
	};
}

function rawEvent(body: string, authenticated = true) {
	return {
		request: new Request('http://127.0.0.1/api/mcp/call', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(authenticated ? { 'x-api-key': 'mcp-test-secret' } : {})
			},
			body
		}),
		url: new URL('http://127.0.0.1/api/mcp/call'),
		getClientAddress: () => '127.0.0.1'
	};
}

function callAuthority() {
	return buildServerGovernorDecisionAuthority({
		source: 'mcp-call.authority.test',
		reason: 'Focused MCP tool-call authority regression.',
		toolName: 'spawner.mcp.call_tool',
		mutationClass: 'external_network',
		target: 'filesystem:ping',
		externalNetwork: true
	});
}

describe('/api/mcp/call authority contract', () => {
	beforeEach(() => {
		PRIVATE_ENV.MCP_API_KEY = 'mcp-test-secret';
		vi.mocked(isConnected).mockReset();
		vi.mocked(isConnected).mockReturnValue(true);
		vi.mocked(callTool).mockReset();
		vi.mocked(callTool).mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
	});

	it('requires an MCP API key even for loopback tool calls', async () => {
		const response = await POST({
			request: new Request('http://127.0.0.1/api/mcp/call', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ instanceId: 'filesystem', toolName: 'ping', args: {} })
			}),
			url: new URL('http://127.0.0.1/api/mcp/call'),
			getClientAddress: () => '127.0.0.1'
		} as never);

		expect(response.status).toBe(401);
		expect(callTool).not.toHaveBeenCalled();
	});

	it('blocks MCP tool calls without Harness Core authority', async () => {
		const response = await POST(
			event({
				instanceId: 'filesystem',
				toolName: 'ping',
				args: { value: 1 }
			}) as never
		);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
		expect(callTool).not.toHaveBeenCalled();
	});

	it('blocks MCP tool calls with bare TurnIntentEnvelopeVNext authority', async () => {
		const response = await POST(
			event({
				instanceId: 'filesystem',
				toolName: 'ping',
				args: { value: 1 },
				executionAuthority: buildServerTurnIntentVNextAuthority({
					source: 'mcp-call.authority.test',
					reason: 'Focused MCP tool-call bare-VNext regression.',
					toolName: 'spawner.mcp.call_tool',
					mutationClass: 'external_network',
					target: 'filesystem:ping',
					externalNetwork: true
				})
			}) as never
		);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
		expect(callTool).not.toHaveBeenCalled();
	});

	it('allows MCP tool calls with native GovernorDecisionV1 authority', async () => {
		const response = await POST(
			event({
				instanceId: 'filesystem',
				toolName: 'ping',
				args: { value: 1 },
				executionAuthority: callAuthority()
			}) as never
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.success).toBe(true);
		expect(body.authority).toMatchObject({
			allowed: true,
			source: 'governor_decision',
			governorOutcome: 'execute'
		});
		expect(callTool).toHaveBeenCalledWith('filesystem', 'ping', { value: 1 });
	});

	it.each([
		['empty', ''],
		['malformed', '{not valid json'],
		['null', 'null'],
		['array', '[]']
	])('returns 400 for a rejected %s body without leaking parser details', async (_kind, body) => {
		const response = await POST(rawEvent(body) as never);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Malformed JSON body' });
		expect(isConnected).not.toHaveBeenCalled();
		expect(callTool).not.toHaveBeenCalled();
	});

	it('keeps authentication ahead of malformed-body handling', async () => {
		const response = await POST(rawEvent('{not valid json', false) as never);

		expect(response.status).toBe(401);
		expect(isConnected).not.toHaveBeenCalled();
		expect(callTool).not.toHaveBeenCalled();
	});

	it('keeps field-specific validation for an empty object', async () => {
		const response = await POST(rawEvent('{}') as never);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'instanceId is required' });
		expect(isConnected).not.toHaveBeenCalled();
		expect(callTool).not.toHaveBeenCalled();
	});
});
