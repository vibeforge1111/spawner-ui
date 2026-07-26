/**
 * Mission Store - Manages mission state for spawner-ui
 *
 * Connects to the spawner MCP server for real-time mission management.
 */

import { writable, derived, get } from 'svelte/store';
import {
	mcpClient,
	type Mission,
	type MissionAgent,
	type MissionTask,
	type MissionContext,
	type MissionLog
} from '$lib/services/mcp-client';
import { mcpState } from './mcp.svelte';

// ============================================
// State Types
// ============================================

export interface MissionsState {
	missions: Mission[];
	currentMission: Mission | null;
	logs: MissionLog[];
	loading: boolean;
	error: string | null;
	pollingInterval: number | null;
}

// ============================================
// Store
// ============================================

const initialState: MissionsState = {
	missions: [],
	currentMission: null,
	logs: [],
	loading: false,
	error: null,
	pollingInterval: null
};

export const missionsState = writable<MissionsState>(initialState);

// Derived stores
export const currentMission = derived(missionsState, ($state) => $state.currentMission);
export const missionLogs = derived(missionsState, ($state) => $state.logs);
export const isLoading = derived(missionsState, ($state) => $state.loading);
export const hasError = derived(missionsState, ($state) => $state.error !== null);

// ============================================
// Actions
// ============================================

/**
 * Load all missions from the MCP server
 */
export async function loadMissions(options?: {
	status?: Mission['status'];
	limit?: number;
}): Promise<void> {
	const mcp = get(mcpState);
	if (mcp.status !== 'connected') {
		missionsState.update((s) => ({ ...s, error: 'MCP not connected' }));
		return;
	}

	missionsState.update((s) => ({ ...s, loading: true, error: null }));

	const result = await mcpClient.listMissions(options);

	if (result.success && result.data) {
		missionsState.update((s) => ({
			...s,
			missions: result.data!.missions,
			loading: false
		}));
	} else {
		missionsState.update((s) => ({
			...s,
			loading: false,
			error: result.error || 'Failed to load missions'
		}));
	}
}

/**
 * Create a new mission
 */
export async function createMission(options: {
	name: string;
	description?: string;
	mode?: Mission['mode'];
	agents?: MissionAgent[];
	tasks?: MissionTask[];
	context?: Partial<MissionContext>;
}): Promise<Mission | null> {
	const mcp = get(mcpState);
	if (mcp.status !== 'connected') {
		missionsState.update((s) => ({ ...s, error: 'MCP not connected' }));
		return null;
	}

	missionsState.update((s) => ({ ...s, loading: true, error: null }));

	const result = await mcpClient.createMission(options);

	if (result.success && result.data) {
		const mission = result.data.mission;
		missionsState.update((s) => ({
			...s,
			missions: [mission, ...s.missions],
			currentMission: mission,
			loading: false
		}));
		return mission;
	} else {
		missionsState.update((s) => ({
			...s,
			loading: false,
			error: result.error || 'Failed to create mission'
		}));
		return null;
	}
}

/**
 * Load a specific mission by ID
 */
export async function loadMission(missionId: string): Promise<Mission | null> {
	const mcp = get(mcpState);
	if (mcp.status !== 'connected') {
		missionsState.update((s) => ({ ...s, error: 'MCP not connected' }));
		return null;
	}

	missionsState.update((s) => ({ ...s, loading: true, error: null }));

	const result = await mcpClient.getMission(missionId);

	if (result.success && result.data) {
		const mission = result.data.mission;
		missionsState.update((s) => ({
			...s,
			currentMission: mission,
			loading: false
		}));
		return mission;
	} else {
		missionsState.update((s) => ({
			...s,
			loading: false,
			error: result.error || 'Failed to load mission'
		}));
		return null;
	}
}

/**
 * Update the current mission
 */
export async function updateMission(updates: {
	name?: string;
	description?: string;
	agents?: MissionAgent[];
	tasks?: MissionTask[];
	context?: MissionContext;
}): Promise<boolean> {
	const state = get(missionsState);
	if (!state.currentMission) {
		missionsState.update((s) => ({ ...s, error: 'No mission selected' }));
		return false;
	}

	const mcp = get(mcpState);
	if (mcp.status !== 'connected') {
		missionsState.update((s) => ({ ...s, error: 'MCP not connected' }));
		return false;
	}

	missionsState.update((s) => ({ ...s, loading: true, error: null }));

	const result = await mcpClient.updateMission(state.currentMission.id, updates);

	if (result.success && result.data) {
		const mission = result.data.mission;
		missionsState.update((s) => ({
			...s,
			currentMission: mission,
			missions: s.missions.map((m) => (m.id === mission.id ? mission : m)),
			loading: false
		}));
		return true;
	} else {
		missionsState.update((s) => ({
			...s,
			loading: false,
			error: result.error || 'Failed to update mission'
		}));
		return false;
	}
}

/**
 * Start the current mission
 */
export async function startMission(): Promise<boolean> {
	const state = get(missionsState);
	if (!state.currentMission) {
		missionsState.update((s) => ({ ...s, error: 'No mission selected' }));
		return false;
	}

	const mcp = get(mcpState);
	if (mcp.status !== 'connected') {
		missionsState.update((s) => ({ ...s, error: 'MCP not connected' }));
		return false;
	}

	missionsState.update((s) => ({ ...s, loading: true, error: null }));

	const result = await mcpClient.startMission(state.currentMission.id);

	if (result.success && result.data) {
		const mission = result.data.mission;
		missionsState.update((s) => ({
			...s,
			currentMission: mission,
			missions: s.missions.map((m) => (m.id === mission.id ? mission : m)),
			loading: false
		}));

		// Start polling for logs
		startLogPolling(mission.id);

		return true;
	} else {
		missionsState.update((s) => ({
			...s,
			loading: false,
			error: result.error || 'Failed to start mission'
		}));
		return false;
	}
}

/**
 * Complete the current mission
 */
export async function completeMission(outputs?: Record<string, unknown>): Promise<boolean> {
	const state = get(missionsState);
	if (!state.currentMission) {
		missionsState.update((s) => ({ ...s, error: 'No mission selected' }));
		return false;
	}

	const mcp = get(mcpState);
	if (mcp.status !== 'connected') {
		missionsState.update((s) => ({ ...s, error: 'MCP not connected' }));
		return false;
	}

	missionsState.update((s) => ({ ...s, loading: true, error: null }));

	const result = await mcpClient.completeMission(state.currentMission.id, outputs);

	if (result.success && result.data) {
		const mission = result.data.mission;
		missionsState.update((s) => ({
			...s,
			currentMission: mission,
			missions: s.missions.map((m) => (m.id === mission.id ? mission : m)),
			loading: false
		}));

		// Stop polling
		stopLogPolling();

		return true;
	} else {
		missionsState.update((s) => ({
			...s,
			loading: false,
			error: result.error || 'Failed to complete mission'
		}));
		return false;
	}
}

/**
 * Delete a mission
 */
export async function deleteMission(missionId: string): Promise<boolean> {
	const mcp = get(mcpState);
	if (mcp.status !== 'connected') {
		missionsState.update((s) => ({ ...s, error: 'MCP not connected' }));
		return false;
	}

	missionsState.update((s) => ({ ...s, loading: true, error: null }));

	const result = await mcpClient.deleteMission(missionId);

	if (result.success) {
		missionsState.update((s) => ({
			...s,
			missions: s.missions.filter((m) => m.id !== missionId),
			currentMission: s.currentMission?.id === missionId ? null : s.currentMission,
			loading: false
		}));
		return true;
	} else {
		missionsState.update((s) => ({
			...s,
			loading: false,
			error: result.error || 'Failed to delete mission'
		}));
		return false;
	}
}

/**
 * Load logs for a mission
 */
export async function loadMissionLogs(missionId: string, since?: string): Promise<void> {
	const mcp = get(mcpState);
	if (mcp.status !== 'connected') return;

	const result = await mcpClient.getMissionLogs(missionId, { since });

	if (result.success && result.data) {
		missionsState.update((s) => {
			// If we have a "since" filter, append new logs
			if (since) {
				const existingIds = new Set(s.logs.map((l) => l.id));
				const newLogs = result.data!.logs.filter((l) => !existingIds.has(l.id));
				return { ...s, logs: [...s.logs, ...newLogs] };
			}
			// Otherwise replace all logs
			return { ...s, logs: result.data!.logs };
		});
	}
}

/**
 * Start polling for mission logs
 */
let pollingTimer: ReturnType<typeof setInterval> | null = null;

export function startLogPolling(missionId: string, intervalMs: number = 2000): void {
	stopLogPolling();

	// Initial load (rejection here would otherwise become an unhandled rejection)
	loadMissionLogs(missionId).catch((err) => {
		console.warn('[MissionLogPolling] initial load failed:', err);
	});

	// Poll for new logs
	pollingTimer = setInterval(async () => {
		try {
			const state = get(missionsState);
			const lastLog = state.logs[state.logs.length - 1];
			const since = lastLog?.created_at;

			await loadMissionLogs(missionId, since);

			// Also refresh mission status
			const result = await mcpClient.getMission(missionId);
			if (result.success && result.data) {
				missionsState.update((s) => ({
					...s,
					currentMission: result.data!.mission,
					missions: s.missions.map((m) => (m.id === result.data!.mission.id ? result.data!.mission : m))
				}));

				// Stop polling if mission is complete or failed
				if (['completed', 'failed'].includes(result.data.mission.status)) {
					stopLogPolling();
				}
			}
		} catch (err) {
			// Keep polling alive across transient failures (MCP disconnect, network blip).
			console.warn('[MissionLogPolling] tick failed:', err);
		}
	}, intervalMs);
}

/**
 * Stop polling for mission logs
 */
export function stopLogPolling(): void {
	if (pollingTimer) {
		clearInterval(pollingTimer);
		pollingTimer = null;
	}
}

/**
 * Set the current mission
 */
export function setCurrentMission(mission: Mission | null): void {
	missionsState.update((s) => ({
		...s,
		currentMission: mission,
		logs: [] // Clear logs when changing missions
	}));
}

/**
 * Clear error
 */
export function clearError(): void {
	missionsState.update((s) => ({ ...s, error: null }));
}

/**
 * Generate the Claude Code prompt for the current mission
 */
export function generateClaudeCodePrompt(mission: Mission): string {
	const agentList = mission.agents
		.map((a) => `- **${a.name}** (${a.role}): Skills: ${a.skills.join(', ')}`)
		.join('\n');

	const taskList = mission.tasks
		.map((t) => {
			const agent = mission.agents.find((a) => a.id === t.assignedTo);
			const deps = t.dependsOn?.length ? `(after: ${t.dependsOn.join(', ')})` : '';
			const status =
				t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
			return `${status} **${t.title}** -> ${agent?.name || 'Unassigned'} ${deps}\n   ${t.description}`;
		})
		.join('\n');

	return `# Mission: ${mission.name}

${mission.description || ''}

## Context
- **Project Path:** ${mission.context.projectPath || 'Not specified'}
- **Project Type:** ${mission.context.projectType}
- **Tech Stack:** ${mission.context.techStack?.join(', ') || 'Not specified'}

## Goals
${mission.context.goals?.map((g) => `- ${g}`).join('\n') || '- Not specified'}

## Team
${agentList || 'No agents assigned'}

## Tasks
${taskList || 'No tasks defined'}

## Instructions

1. Load each agent's skills using \`spawner_load({ skill_id: "skill-name" })\`
2. Execute tasks in order (respecting dependencies)
3. Log progress: \`spawner_mission({ action: "log", mission_id: "${mission.id}", log_type: "progress", message: "..." })\`
4. On handoff: \`spawner_mission({ action: "log", mission_id: "${mission.id}", log_type: "handoff", message: "..." })\`
5. When done: \`spawner_mission({ action: "complete", mission_id: "${mission.id}" })\`
`;
}
