import { rejectIfCsrfInvalid } from '$lib/server/csrf';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sparkAgentBridge } from '$lib/services/spark-agent-bridge';
import { enforceRateLimit, requireControlAuth } from '$lib/server/mcp-auth';

function parseBody(value: unknown): { sessionId?: string; actor?: string; metadata?: Record<string, unknown> } {
	if (!value || typeof value !== 'object') {
		return {};
	}
	const body = value as Record<string, unknown>;
	return {
		sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
		actor: typeof body.actor === 'string' ? body.actor : undefined,
		metadata:
			body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
				? (body.metadata as Record<string, unknown>)
				: undefined
	};
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
		scope: 'spark_agent_session_start',
		limit: 30,
		windowMs: 60_000
	});
	if (rateLimited) return rateLimited;

	try {
		const body = parseBody(await event.request.json().catch(() => ({})));
		const session = sparkAgentBridge.startSession(body);
		return json({
			success: true,
			session: {
				id: session.id,
				status: session.status,
				createdAt: session.createdAt,
				eventsEndpoint: `/api/spark-agent/events?sessionId=${encodeURIComponent(session.id)}`,
				commandEndpoint: '/api/spark-agent/command'
			}
		});
	} catch (error) {
		return json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to start session'
			},
			{ status: 400 }
		);
	}
};
