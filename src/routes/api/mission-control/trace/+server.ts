import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { enforceRateLimit, requireControlAuth } from '$lib/server/mcp-auth';
import { providerRuntime } from '$lib/server/provider-runtime';
import { buildMissionControlTrace, type MissionControlTrace } from '$lib/server/mission-control-trace';

function traceReadAuthPayload(event: Parameters<typeof requireControlAuth>[0]) {
	const eventRead = requireControlAuth(event, {
		surface: 'MissionControlTrace',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: true,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
	const bridgeRead = requireControlAuth(event, {
		surface: 'MissionControlTrace',
		apiKeyEnvVar: 'SPARK_BRIDGE_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: true,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
	if (eventRead && bridgeRead) return { openRead: eventRead, hasControlAuth: false };

	const strictEventRead = requireControlAuth(event, {
		surface: 'MissionControlTrace',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
	const strictBridgeRead = requireControlAuth(event, {
		surface: 'MissionControlTrace',
		apiKeyEnvVar: 'SPARK_BRIDGE_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyQueryParam: 'apiKey',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey: false,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});

	return { openRead: null, hasControlAuth: strictEventRead === null || strictBridgeRead === null };
}

function sanitizeTraceForLoopback(trace: MissionControlTrace) {
	return {
		...trace,
		authorityBoundary: {
			payload: 'progress_only',
			rawArtifacts: 'requires_control_auth',
			providerResults: 'requires_control_auth',
			telegramIdentity: 'requires_control_auth',
			dispatchReason: 'requires_control_auth',
			agentBlackBox: 'requires_control_auth',
			prdTrace: 'requires_control_auth'
		},
		surfaces: {
			...trace.surfaces,
			telegram: {
				relay: null,
				chatId: null,
				userId: null
			},
			kanban: {
				bucket: trace.surfaces.kanban.bucket,
				entry: trace.surfaces.kanban.entry
					? {
							missionId: trace.surfaces.kanban.entry.missionId,
							missionName: trace.surfaces.kanban.entry.missionName,
							status: trace.surfaces.kanban.entry.status,
							lastEventType: trace.surfaces.kanban.entry.lastEventType,
							lastUpdated: trace.surfaces.kanban.entry.lastUpdated,
							lastSummary: trace.surfaces.kanban.entry.lastSummary,
							taskName: trace.surfaces.kanban.entry.taskName,
							taskCount: trace.surfaces.kanban.entry.taskCount,
							taskStatusCounts: trace.surfaces.kanban.entry.taskStatusCounts,
							tasks: trace.surfaces.kanban.entry.tasks.map((task) => ({
								title: task.title,
								status: task.status,
								skills: []
							}))
						}
					: null
			},
			dispatch: trace.surfaces.dispatch
				? {
						allComplete: trace.surfaces.dispatch.allComplete,
						anyFailed: trace.surfaces.dispatch.anyFailed,
						paused: trace.surfaces.dispatch.paused,
						providers: trace.surfaces.dispatch.providers,
						lastReason: null
					}
				: null
		},
		artifacts: {
			pendingRequest: null,
			analysisResult: null,
			lastCanvasLoad: null
		},
		prdTrace: {
			file: trace.prdTrace.file,
			entryCount: trace.prdTrace.entryCount,
			entries: []
		},
		timeline: trace.timeline.map((entry) => ({
			eventType: entry.eventType,
			missionId: entry.missionId,
			taskName: entry.taskName,
			summary: entry.summary,
			timestamp: entry.timestamp,
			source: entry.source
		})),
		providerResults: [],
		providerSummary: trace.providerSummary ? 'Provider summary requires control auth.' : null,
		completionEvidence: trace.completionEvidence
			? {
					...trace.completionEvidence,
					hasProviderSummary: false,
					hasArtifactReference: false
				}
			: null,
		projectLineage: trace.projectLineage
			? {
					projectId: trace.projectLineage.projectId,
					projectPath: null,
					previewUrl: trace.projectLineage.previewUrl,
					parentMissionId: trace.projectLineage.parentMissionId,
					iterationNumber: trace.projectLineage.iterationNumber,
					improvementFeedback: null
				}
			: null,
		agentBlackBox: {
			...trace.agentBlackBox,
			counts: {
				entries: trace.agentBlackBox.counts.entries,
				blocker_events: trace.agentBlackBox.counts.blocker_events,
				memory_candidates: trace.agentBlackBox.counts.memory_candidates
			},
			entries: []
		}
	};
}

export const GET: RequestHandler = async (event) => {
	const { openRead, hasControlAuth } = traceReadAuthPayload(event);
	if (openRead) return openRead;

	const rateLimited = enforceRateLimit(event, {
		scope: 'mission_control_trace',
		limit: 240,
		windowMs: 60_000
	});
	if (rateLimited) return rateLimited;

	const missionId =
		event.url.searchParams.get('missionId') ||
		event.url.searchParams.get('mission');
	const requestId = event.url.searchParams.get('requestId');

	const trace = await buildMissionControlTrace({
		missionId,
		requestId,
		getProviderResults: (id) => providerRuntime.getMissionResults(id),
		getDispatchStatus: (id) => providerRuntime.getMissionStatus(id)
	});

	return json(hasControlAuth ? trace : sanitizeTraceForLoopback(trace));
};
