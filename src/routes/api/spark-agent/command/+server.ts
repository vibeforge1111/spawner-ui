import { rejectIfCsrfInvalid } from '$lib/server/csrf';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	sparkAgentBridge,
	SPARK_AGENT_ALLOWED_COMMANDS,
	type SparkAgentCommandName
} from '$lib/services/spark-agent-bridge';
import { enforceRateLimit, requireControlAuth } from '$lib/server/mcp-auth';
import { HarnessAuthorityError, resolveExecutionAuthority } from '$lib/server/harness-authority';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAllowedCommand(value: string): value is SparkAgentCommandName {
	return (SPARK_AGENT_ALLOWED_COMMANDS as string[]).includes(value);
}

export const POST: RequestHandler = async (event) => {
	const csrfCheck = rejectIfCsrfInvalid(event.request);
	if (csrfCheck) return csrfCheck;
	const unauthorized = requireControlAuth(event, {
		surface: 'Spark Agent',
		apiKeyEnvVar: 'SPARK_AGENT_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'SPARK_AGENT_ALLOWED_ORIGINS'
	});
	if (unauthorized) return unauthorized;

	const rateLimited = enforceRateLimit(event, {
		scope: 'spark_agent_command',
		limit: 180,
		windowMs: 60_000
	});
	if (rateLimited) return rateLimited;

	try {
		const body = (await event.request.json().catch(() => ({}))) as Record<string, unknown>;
		if (!isRecord(body)) {
			return json({ success: false, error: 'Invalid request body' }, { status: 400 });
		}

		const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
		const command = typeof body.command === 'string' ? body.command : null;
		if (!sessionId || !command) {
			return json({ success: false, error: 'sessionId and command are required' }, { status: 400 });
		}
		const scopedSessionHeader = event.request.headers.get('x-spark-agent-session-id');
		if (scopedSessionHeader && scopedSessionHeader !== sessionId) {
			return json(
				{
					success: false,
					error: 'Session scope mismatch between header and body'
				},
				{ status: 403 }
			);
		}
		if (!isAllowedCommand(command)) {
			return json(
				{
					success: false,
					error: `Unsupported command "${command}"`,
					allowedCommands: SPARK_AGENT_ALLOWED_COMMANDS
				},
				{ status: 400 }
			);
		}

		const result = await sparkAgentBridge.executeCommand({
			sessionId,
			command,
			params: isRecord(body.params) ? body.params : {},
			executionAuthority: resolveExecutionAuthority(
				body.executionAuthority,
				body.execution_authority,
				isRecord(body.params) ? body.params.executionAuthority : undefined,
				isRecord(body.params) ? body.params.execution_authority : undefined
			),
			requestId: typeof body.requestId === 'string' ? body.requestId : undefined,
			actor:
				(typeof body.actor === 'string' && body.actor) ||
				event.request.headers.get('x-spark-agent-actor') ||
				'unknown'
		});

		return json(
			{
				success: result.ok,
				sessionId: result.sessionId,
				command: result.command,
				requestId: result.requestId,
				data: result.data,
				error: result.error,
				audit: {
					sessionId,
					command,
					actor:
						(typeof body.actor === 'string' && body.actor) ||
						event.request.headers.get('x-spark-agent-actor') ||
						'unknown',
					timestamp: new Date().toISOString()
				}
			},
			{ status: result.ok ? 200 : 400 }
		);
	} catch (error) {
		if (error instanceof HarnessAuthorityError) {
			return json(
				{
					success: false,
					error: error.message,
					code: error.code,
					authority: error.verdict
				},
				{ status: error.status }
			);
		}
		return json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Command failed'
			},
			{ status: 400 }
		);
	}
};
