import { logger } from '$lib/utils/logger';
/**
 * MCP Tool Call API
 *
 * POST /api/mcp/call - Call a tool on a connected MCP server
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { callTool, isConnected } from '$lib/services/mcp/client';
import { requireMcpAuth } from '$lib/server/mcp-auth';
import { HarnessAuthorityError, assertNativeGovernorHarnessAuthority, resolveExecutionAuthority } from '$lib/server/harness-authority';

export const POST: RequestHandler = async (event) => {
	const unauthorized = requireMcpAuth(event);
	if (unauthorized) {
		return unauthorized;
	}

	try {
		const { request } = event;
		let body: any;
		try {
			body = await request.json();
		} catch {
			return json({ error: 'Invalid or missing JSON body' }, { status: 400 });
		}
		const { instanceId, toolName, args, requestId } = body as {
			instanceId: string;
			toolName: string;
			args?: Record<string, unknown>;
			requestId?: string;
		};

		if (!instanceId) {
			return json({ error: 'instanceId is required' }, { status: 400 });
		}

		if (!toolName) {
			return json({ error: 'toolName is required' }, { status: 400 });
		}

		const authority = assertNativeGovernorHarnessAuthority({
			authority: resolveExecutionAuthority(body.executionAuthority, body.execution_authority),
			toolName: 'spawner.mcp.call_tool',
			ownerSystem: 'spawner-ui',
			mutationClass: 'external_network',
			requestId,
			externalNetwork: true
		});

		if (!isConnected(instanceId)) {
			return json({ error: 'MCP not connected' }, { status: 400 });
		}

		logger.info(`[API] Calling tool: ${toolName} on ${instanceId}`);

		const result = await callTool(instanceId, toolName, args || {});

		return json({
			success: true,
			instanceId,
			toolName,
			authority: {
				allowed: authority.allowed,
				source: authority.source,
				traceId: authority.traceId,
				governorOutcome: authority.governorOutcome
			},
			result,
		});
	} catch (error) {
		if (error instanceof HarnessAuthorityError) {
			return json(
				{
					error: error.message,
					code: error.code,
					authority: error.verdict
				},
				{ status: error.status }
			);
		}
		console.error('[API] Tool call error:', error);
		return json(
			{
				error: error instanceof Error ? error.message : 'Tool call failed',
			},
			{ status: 500 }
		);
	}
};
