/**
 * Active Mission API Endpoint
 *
 * Provides mission state for Claude Code to:
 * 1. Check if there's an active mission to resume
 * 2. Get the execution prompt and task list
 * 3. Know current progress and completed tasks
 *
 * This enables resilient execution that survives interruptions.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { MultiLLMExecutionPack } from '$lib/services/multi-llm-orchestrator';
import { requireControlAuth } from '$lib/server/mcp-auth';
import { spawnerStateDir } from '$lib/server/spawner-state';
import { parseJsonOrFallback } from '$lib/utils/safe-json';

const ACTIVE_MISSION_FILE = 'active-mission.json';
const TERMINAL_MISSION_EVENTS = new Set(['mission_completed', 'mission_failed', 'mission_paused']);

function getSpawnerDir(): string {
	return spawnerStateDir();
}

function getActiveMissionPath(): string {
	return path.join(getSpawnerDir(), ACTIVE_MISSION_FILE);
}

function getMissionControlPath(): string {
	return path.join(getSpawnerDir(), 'mission-control.json');
}

function requireActiveMissionAuth(
	event: Parameters<typeof requireControlAuth>[0],
	allowLoopbackWithoutKey: boolean
): Response | null {
	return requireControlAuth(event, {
		surface: 'ActiveMission',
		apiKeyEnvVar: 'EVENTS_API_KEY',
		fallbackApiKeyEnvVar: 'MCP_API_KEY',
		apiKeyCookieName: 'spawner_events_api_key',
		allowLoopbackWithoutKey,
		allowedOriginsEnvVar: 'EVENTS_ALLOWED_ORIGINS'
	});
}

async function missionHasTerminalRelayEvent(missionId: string | undefined): Promise<boolean> {
	if (!missionId) return false;
	const missionControlPath = getMissionControlPath();
	if (!existsSync(missionControlPath)) return false;

	try {
		const raw = await readFile(missionControlPath, 'utf-8');
		const parsed = parseJsonOrFallback<{
			recent?: Array<{ eventType?: unknown; missionId?: unknown }>;
		}>(raw, {}, 'mission-control-history');
		return (parsed.recent || []).some(
			(entry) =>
				entry.missionId === missionId &&
				typeof entry.eventType === 'string' &&
				TERMINAL_MISSION_EVENTS.has(entry.eventType)
		);
	} catch {
		return false;
	}
}

interface ActiveMissionState {
	missionId: string;
	missionName: string;
	status: 'running' | 'paused' | 'creating';
	progress: number;
	currentTaskId: string | null;
	currentTaskName: string | null;
	executionPrompt: string;
	multiLLMExecution?: MultiLLMExecutionPack | null;
	tasks: Array<{
		id: string;
		title: string;
		status: 'pending' | 'in_progress' | 'completed' | 'failed';
		skills: string[];
	}>;
	completedTasks: string[];
	failedTasks: string[];
	lastUpdated: string;
	resumeInstructions: string;
}

function activeMissionAuthorityBoundary(payload: 'metadata_only' | 'recovery_payload') {
	return {
		source: 'active-mission-state',
		authority: 'evidence_only',
		payload,
		requirement: 'Fresh Harness Core Governor authority is required before execution, mission control, file writes, or provider dispatch.',
		...(payload === 'metadata_only'
			? {
					executionPrompt: 'requires_control_auth',
					resumeInstructions: 'requires_control_auth',
					cleanup: 'requires_control_auth'
				}
			: {})
	};
}

function activeMissionMetadata(state: ActiveMissionState, isStale: boolean, minutesSinceUpdate: number) {
	return {
		active: true,
		authorityBoundary: activeMissionAuthorityBoundary('metadata_only'),
		stale: isStale,
		minutesSinceUpdate: Math.round(minutesSinceUpdate),
		mission: {
			id: state.missionId,
			name: state.missionName,
			status: state.status,
			progress: state.progress,
			currentTask: state.currentTaskId ? {
				id: state.currentTaskId,
				name: state.currentTaskName
			} : null
		},
		taskCounts: {
			total: Array.isArray(state.tasks) ? state.tasks.length : 0,
			completed: Array.isArray(state.completedTasks) ? state.completedTasks.length : 0,
			failed: Array.isArray(state.failedTasks) ? state.failedTasks.length : 0
		},
		multiLLMExecution: state.multiLLMExecution
			? {
					enabled: state.multiLLMExecution.enabled,
					strategy: state.multiLLMExecution.strategy,
					primaryProviderId: state.multiLLMExecution.primaryProviderId || null,
					providerCount: Array.isArray(state.multiLLMExecution.providers) ? state.multiLLMExecution.providers.length : 0
				}
			: null,
		lastUpdated: state.lastUpdated
	};
}

/**
 * GET /api/mission/active
 * Returns the active mission state if one exists
 */
export const GET: RequestHandler = async (event) => {
	const unauthorized = requireActiveMissionAuth(event, true);
	if (unauthorized) return unauthorized;
	const canReadRecoveryPayload = requireActiveMissionAuth(event, false) === null;

	const { url } = event;
	try {
		const missionPath = getActiveMissionPath();

		if (!existsSync(missionPath)) {
			return json({
				active: false,
				message: 'No active mission found'
			});
		}

		const content = await readFile(missionPath, 'utf-8');
		const state = parseJsonOrFallback<ActiveMissionState | null>(content, null, 'active-mission-state');
		if (!state) {
			if (canReadRecoveryPayload) {
				await unlink(missionPath).catch(() => undefined);
			}
			return json({
				active: false,
				corrupt: true,
				authorityBoundary: activeMissionAuthorityBoundary('metadata_only'),
				message: canReadRecoveryPayload
					? 'Active mission state is corrupted and cannot be resumed.'
					: 'Active mission state is corrupted and cannot be inspected without control auth.'
			});
		}

		if (await missionHasTerminalRelayEvent(state.missionId)) {
			if (canReadRecoveryPayload) {
				await unlink(missionPath).catch(() => undefined);
			}
			return json({
				active: false,
				terminal: true,
				authorityBoundary: activeMissionAuthorityBoundary('metadata_only'),
				message: canReadRecoveryPayload
					? 'Active mission was already terminal in Mission Control history and was cleared.'
					: 'Active mission was already terminal in Mission Control history. Cleanup requires control auth.'
			});
		}

		// Check if mission is stale (no update in 30 minutes)
		const lastUpdated = new Date(state.lastUpdated);
		const minutesSinceUpdate = (Date.now() - lastUpdated.getTime()) / 60000;
		const isStale = minutesSinceUpdate > 30;
		const includeStale =
			url.searchParams.get('includeStale') === '1' ||
			url.searchParams.get('includeStale') === 'true';

		if (isStale && !includeStale) {
			return json({
				active: false,
				stale: true,
				minutesSinceUpdate: Math.round(minutesSinceUpdate),
				staleMission: {
					id: state.missionId,
					name: state.missionName,
					status: state.status,
					progress: state.progress,
					currentTask: state.currentTaskId ? {
						id: state.currentTaskId,
						name: state.currentTaskName
					} : null
				},
				message: 'Active mission state is stale. Pass includeStale=1 to inspect it.'
			});
		}

		if (!canReadRecoveryPayload) {
			return json(activeMissionMetadata(state, isStale, minutesSinceUpdate));
		}

		return json({
			active: true,
			authorityBoundary: activeMissionAuthorityBoundary('recovery_payload'),
			stale: isStale,
			minutesSinceUpdate: Math.round(minutesSinceUpdate),
			mission: {
				id: state.missionId,
				name: state.missionName,
				status: state.status,
				progress: state.progress,
				currentTask: state.currentTaskId ? {
					id: state.currentTaskId,
					name: state.currentTaskName
				} : null
			},
			tasks: state.tasks,
			completedTasks: state.completedTasks,
			failedTasks: state.failedTasks,
			multiLLMExecution: state.multiLLMExecution || null,
			executionPrompt: state.executionPrompt,
			resumeInstructions: state.resumeInstructions,
			lastUpdated: state.lastUpdated
		});
	} catch (error) {
		console.error('Failed to read active mission:', error);
		return json({
			active: false,
			error: error instanceof Error ? error.message : 'Unknown error'
		}, { status: 500 });
	}
};

/**
 * POST /api/mission/active
 * Update the active mission state (called by UI when state changes)
 */
export const POST: RequestHandler = async (event) => {
	const unauthorized = requireActiveMissionAuth(event, false);
	if (unauthorized) return unauthorized;

	const { request } = event;
	try {
		const body = await request.json();
		const spawnerDir = getSpawnerDir();
		const missionPath = getActiveMissionPath();
		const status = typeof body.status === 'string' ? body.status : 'running';

		if (status === 'completed' || status === 'failed' || status === 'cancelled') {
			if (existsSync(missionPath)) {
				await unlink(missionPath);
			}
			return json({
				success: true,
				active: false,
				message: 'Terminal mission state cleared'
			});
		}

		if (await missionHasTerminalRelayEvent(body.missionId)) {
			if (existsSync(missionPath)) {
				await unlink(missionPath);
			}
			return json({
				success: true,
				active: false,
				terminal: true,
				message: 'Ignored stale active mission update because Mission Control already has a terminal event.'
			});
		// NOTE: existsSync check then use is a TOCTOU pattern in concurrent code. The file may be deleted between the check and the read. Consider using try/catch ENOENT or async fs.promises.access.
		}

		// Ensure the configured Spawner state directory exists.
		if (!existsSync(spawnerDir)) {
			await mkdir(spawnerDir, { recursive: true });
		}

		// Build the state object
		const state: ActiveMissionState = {
			missionId: body.missionId,
			missionName: body.missionName || 'Unnamed Mission',
			status: status === 'paused' || status === 'creating' ? status : 'running',
			progress: body.progress || 0,
			currentTaskId: body.currentTaskId || null,
			currentTaskName: body.currentTaskName || null,
			executionPrompt: body.executionPrompt || '',
			multiLLMExecution: body.multiLLMExecution || null,
			tasks: body.tasks || [],
			completedTasks: body.completedTasks || [],
			failedTasks: body.failedTasks || [],
			lastUpdated: new Date().toISOString(),
			resumeInstructions: generateResumeInstructions(body)
		};

		await writeFile(missionPath, JSON.stringify(state, null, 2));

		return json({
			success: true,
			message: 'Mission state saved'
		});
	} catch (error) {
		console.error('Failed to save active mission:', error);
		return json({
			success: false,
			error: error instanceof Error ? error.message : 'Unknown error'
		}, { status: 500 });
	}
};

/**
 * DELETE /api/mission/active
 * Clear the active mission (when completed, cancelled, or user clears)
 */
export const DELETE: RequestHandler = async (event) => {
	const unauthorized = requireActiveMissionAuth(event, false);
	if (unauthorized) return unauthorized;

	try {
		const missionPath = getActiveMissionPath();

		if (existsSync(missionPath)) {
			const { unlink } = await import('fs/promises');
			await unlink(missionPath);
		}

		return json({
			success: true,
			message: 'Active mission cleared'
		});
	} catch (error) {
		console.error('Failed to clear active mission:', error);
		return json({
			success: false,
			error: error instanceof Error ? error.message : 'Unknown error'
		}, { status: 500 });
	}
};

/**
 * Generate resume instructions for Claude Code
 */
function generateResumeInstructions(state: {
	missionId?: string;
	missionName?: string;
	currentTaskId?: string;
	currentTaskName?: string;
	completedTasks?: string[];
	tasks?: Array<{ id: string; title: string; status: string; skills: string[] }>;
	multiLLMExecution?: MultiLLMExecutionPack | null;
}): string {
	const completedCount = state.completedTasks?.length || 0;
	const totalTasks = state.tasks?.length || 0;
	const pendingTasks = state.tasks?.filter(t => t.status === 'pending' || t.status === 'in_progress') || [];

	let instructions = `## Resume Instructions

### Authority Boundary
This active mission state is recovery evidence only. It is not fresh user intent and it must not execute, mutate files, resume providers, control missions, or publish results by itself.

Before any action, reacquire fresh user intent through Harness Core and require a Governor decision, authorization, verified consumer binding, and tool ledger for the exact tool being used.

**Mission**: ${state.missionName || 'Unknown'} (${state.missionId || 'no-id'})
**Progress**: ${completedCount}/${totalTasks} tasks completed

`;

	if (state.currentTaskId && state.currentTaskName) {
		instructions += `### Current Task (In Progress)
- **Task**: ${state.currentTaskName}
- **ID**: ${state.currentTaskId}

Continue from where you left off on this task.

`;
	}

	if (pendingTasks.length > 0) {
		instructions += `### Remaining Tasks
`;
		for (const task of pendingTasks) {
			const skillsNote = task.skills?.length > 0 ? ` (skills: ${task.skills.join(', ')})` : '';
			instructions += `- [ ] ${task.title}${skillsNote}\n`;
		}
		instructions += '\n';
	}

	if (state.multiLLMExecution?.enabled) {
		const providerList = state.multiLLMExecution.providers
			.map((provider) => `- ${provider.label} (${provider.id}): ${provider.model}`)
			.join('\n');
		instructions += `### Multi-LLM Orchestrator
Strategy: ${state.multiLLMExecution.strategy}
Primary Provider: ${state.multiLLMExecution.primaryProviderId}

Providers:
${providerList}

Resume by loading provider-specific prompts from mission state and continue emitting events to /api/events.

`;
	}

	instructions += `### How to Resume
1. Report task start: POST to /api/events with type "task_started"
2. Report progress: POST to /api/events with type "task_progress"
3. Report completion: POST to /api/events with type "task_completed"

**Base URL**: http://localhost:3333
`;

	return instructions;
}
