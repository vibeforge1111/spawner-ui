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
		scope: 'spark_agent_events_stream',
		limit: 120,
		windowMs: 60_000
	});
	if (rateLimited) return rateLimited;

	const { request, url } = event;
	const sessionId = url.searchParams.get('sessionId');
	if (!sessionId) {
		return json({ error: 'sessionId is required' }, { status: 400 });
	}
	const scopedSessionHeader = request.headers.get('x-spark-agent-session-id');
	if (scopedSessionHeader && scopedSessionHeader !== sessionId) {
		return json({ error: 'Session scope mismatch between header and query' }, { status: 403 });
	}

	const session = sparkAgentBridge.getSession(sessionId);
	if (!session) {
		return json({ error: `Unknown session: ${sessionId}` }, { status: 404 });
	}

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			let closed = false;
			const push = (payload: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
				} catch {
					closed = true;
				}
			};

			const pushComment = (comment: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`: ${comment}\n\n`));
				} catch {
					closed = true;
				}
			};

			push({
				type: 'connected',
				sessionId,
				timestamp: new Date().toISOString()
			});

			for (const event of session.events) {
				push(event);
			}

			const unsubscribe = sparkAgentBridge.subscribe(sessionId, (event) => {
				push(event);
			});

			// Emit a 30s SSE comment so idle Spark Agent sessions are not severed
			// by reverse proxies (nginx/cloudflared) that close streams after ~60s
			// of silence. Mirrors the keepalive contract on /api/events.
			const keepalive = setInterval(() => {
				pushComment('keepalive');
			}, 30_000);

			request.signal.addEventListener('abort', () => {
				clearInterval(keepalive);
				unsubscribe();
				if (!closed) {
					closed = true;
					try {
						controller.close();
					} catch {
						// stream already closed
					}
				}
			});
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
