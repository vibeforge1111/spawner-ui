import { env } from '$env/dynamic/private';
import { json, type RequestEvent, type RequestHandler } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import {
	recommendAccessExecutionLane,
	type AccessExecutionLane
} from '$lib/server/access-execution-lanes';
import {
	AccessExecutionPolicyError,
	listAccessExecutionActions,
	runAccessExecutionAction
} from '$lib/server/access-execution-actions';
import { hostedUiSessionIsValid } from '$lib/server/hosted-ui-auth';
import { enforceRateLimit, requireControlAuth } from '$lib/server/mcp-auth';

function accessLevelFromUrl(url: URL): 4 | 5 {
	return url.searchParams.get('accessLevel') === '5' ? 5 : 4;
}

function constantTimeEquals(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requestToken(request: Request, url: URL): string | null {
	const headerToken =
		request.headers.get('x-spawner-ui-key') ||
		request.headers.get('x-api-key') ||
		request.headers.get('x-mcp-api-key');
	if (headerToken?.trim()) return headerToken.trim();

	const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
	if (bearer) return bearer;

	const queryToken = url.searchParams.get('uiKey') || url.searchParams.get('apiKey');
	return queryToken?.trim() || null;
}

function localPathAccessIsAuthorized(event: RequestEvent): boolean {
	if (event.cookies && hostedUiSessionIsValid(event.cookies, env)) return true;

	const token = requestToken(event.request, event.url);
	if (!token) return false;

	const allowedTokens = [
		env.SPARK_UI_API_KEY,
		process.env.SPARK_UI_API_KEY,
		env.SPARK_BRIDGE_API_KEY,
		process.env.SPARK_BRIDGE_API_KEY,
		env.MCP_API_KEY,
		process.env.MCP_API_KEY
	]
		.map((value) => value?.trim())
		.filter((value): value is string => Boolean(value));
	return allowedTokens.some((allowedToken) => constantTimeEquals(allowedToken, token));
}

function redactLocalPaths(lane: AccessExecutionLane): AccessExecutionLane {
	if (!lane.workspaceRoot) return lane;
	const redacted = { ...lane };
	delete redacted.workspaceRoot;
	return {
		...redacted,
		userMessage:
			lane.id === 'spark_workspace'
				? 'I can set up a safe Spark workspace and work only inside it.'
				: redacted.userMessage
	};
}

export const GET: RequestHandler = async (event) => {
	const rateLimited = enforceRateLimit(event, {
		scope: 'access_execution_lanes',
		limit: 60,
		windowMs: 60_000
	});
	if (rateLimited) return rateLimited;

	const { url } = event;
	const accessLevel = accessLevelFromUrl(url);
	const goal = url.searchParams.get('goal') || undefined;
	const access = recommendAccessExecutionLane({
		accessLevel,
		userGoal: goal
	});
	const responseAccess = localPathAccessIsAuthorized(event)
		? access
		: {
				...access,
				recommended: redactLocalPaths(access.recommended),
				lanes: access.lanes.map(redactLocalPaths)
			};

	return json({
		success: true,
		access: responseAccess,
		actions: listAccessExecutionActions()
	});
};

export const POST: RequestHandler = async (event) => {
	const unauthorized = requireControlAuth(event, {
		surface: 'AccessExecution',
		apiKeyEnvVar: 'SPARK_BRIDGE_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		allowLoopbackWithoutKey: false
	});
	if (unauthorized) return unauthorized;

	const rateLimited = enforceRateLimit(event, {
		scope: 'access_execution',
		limit: 20,
		windowMs: 60_000
	});
	if (rateLimited) return rateLimited;

	const body = (await event.request.json().catch(() => ({}))) as {
		actionId?: string;
		confirmed?: boolean;
		explicitOptIn?: string;
	};
	const actionId = body.actionId?.trim();
	if (!actionId) {
		return json({ success: false, error: 'actionId is required' }, { status: 400 });
	}

	try {
		const result = await runAccessExecutionAction(actionId, {
			confirmed: body.confirmed === true,
			explicitOptIn: body.explicitOptIn?.trim()
		});

		return json({
			success: result.success,
			action: result.action,
			result: result.result
		});
	} catch (error) {
		if (error instanceof AccessExecutionPolicyError) {
			return json(
				{
					success: false,
					error: error.message,
					action: error.action,
					confirmationRequired: true
				},
				{ status: error.status }
			);
		}

		return json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Access execution action failed'
			},
			{ status: 400 }
		);
	}
};
