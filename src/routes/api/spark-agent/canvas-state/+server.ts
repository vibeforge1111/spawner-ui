import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sparkAgentBridge } from '$lib/services/spark-agent-bridge';
import { enforceRateLimit, requireControlAuth } from '$lib/server/mcp-auth';

export const GET: RequestHandler = async (event) => {
	const unauthorized = requireControlAuth(event, {
		surface: 'Spark Agent',
		apiKeyEnvVar: 'SPARK_AGENT_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'SPARK_AGENT_ALLOWED_ORIGINS'
	});
	if (unauthorized) return unauthorized;

	const rateLimited = enforceRateLimit(event, {
		scope: 'spark_agent_canvas_state',
		limit: 180,
		windowMs: 60_000
	});
	if (rateLimited) return rateLimited;

	const since = event.url.searchParams.get('since') || undefined;
	const sessionId = event.url.searchParams.get('sessionId')?.trim() || undefined;
	const snapshot = sessionId ? sparkAgentBridge.getLatestCanvasSnapshot(since, sessionId) : null;

	return json({
		success: true,
		hasUpdate: !!snapshot,
		snapshot
	});
};
