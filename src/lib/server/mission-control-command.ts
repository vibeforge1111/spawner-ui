import { eventBridge } from '$lib/services/event-bridge';
import {
	getMissionControlBoard,
	relayMissionControlEvent,
	type MissionControlBoardEntry,
	type MissionControlBridgeEvent
} from '$lib/server/mission-control-relay';
import { providerRuntime } from '$lib/server/provider-runtime';
import { mcpClient } from '$lib/services/mcp-client';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnerStateDir } from './spawner-state';
import {
	assertNativeGovernorHarnessAuthority,
	resolveExecutionAuthority,
	type HarnessAuthorityVerdict
} from './harness-authority';
import { writeFileAtomic } from './atomic-write';

export type MissionControlAction = 'pause' | 'resume' | 'kill' | 'status';

const ACTION_TO_EVENT: Record<Exclude<MissionControlAction, 'status' | 'kill'>, string> = {
	pause: 'mission_paused',
	resume: 'mission_resumed'
};

function activeMissionPath(): string {
	return path.join(spawnerStateDir(), 'active-mission.json');
}

export function isMissionControlAction(value: unknown): value is MissionControlAction {
	return value === 'pause' || value === 'resume' || value === 'kill' || value === 'status';
}

function buildBridgeEvent(missionId: string, type: string, source: string) {
	return {
		type,
		missionId,
		source,
		timestamp: new Date().toISOString(),
		id: `mc-cmd-${Date.now()}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
	};
}

function findMissionBoardEntry(missionId: string): MissionControlBoardEntry | null {
	const board = getMissionControlBoard();
	for (const entries of Object.values(board)) {
		const match = entries.find((entry) => entry.missionId === missionId);
		if (match) return match;
	}
	return null;
}

function hasRuntimeStatusSignal(status: ReturnType<typeof providerRuntime.getMissionStatus>): boolean {
	return (
		Object.keys(status.providers).length > 0 ||
		status.paused ||
		Boolean(status.pausedReason) ||
		status.snapshotAvailable
	);
}

async function syncActiveMissionFile(
	missionId: string,
	status: 'running' | 'paused' | 'failed' | 'cancelled',
	note?: string
): Promise<void> {
	const activeMissionFile = activeMissionPath();
	if (!existsSync(activeMissionFile)) return;
	try {
		const raw = await readFile(activeMissionFile, 'utf-8');
		const active = JSON.parse(raw) as Record<string, unknown>;
		if ((active.missionId as string | undefined) !== missionId) {
			return;
		}

		active.status = status;
		active.lastUpdated = new Date().toISOString();
		if (typeof note === 'string' && note.trim()) {
			active.note = note.trim();
		}
		await writeFileAtomic(activeMissionFile, JSON.stringify(active, null, 2));
	} catch (error) {
		console.warn('[MissionControl] Failed to sync active mission file:', error);
	}
}

async function syncMissionRecord(
	missionId: string,
	action: MissionControlAction,
	message?: string
): Promise<void> {
	try {
		if (action === 'resume') {
			await mcpClient.updateMission(missionId, {
				status: 'running',
				outputs: { mission_control: { resumedAt: new Date().toISOString(), note: message } }
			});
			return;
		}
		if (action === 'kill') {
			await mcpClient.updateMission(missionId, {
				status: 'cancelled',
				outputs: { mission_control: { cancelledAt: new Date().toISOString(), note: message || 'Mission killed via mission control' } }
			});
			return;
		}
		if (action === 'pause') {
			await mcpClient.updateMission(missionId, {
				status: 'paused',
				outputs: { mission_control: { pausedAt: new Date().toISOString() } }
			});
		}
	} catch (error) {
		console.warn('[MissionControl] Mission store sync failed:', error);
	}
}

export async function executeMissionControlAction(input: {
	missionId: string;
	action: MissionControlAction;
	source?: string;
	executionAuthority?: unknown;
	dispatchAuthority?: unknown;
}): Promise<Record<string, unknown>> {
	const missionId = input.missionId.trim();
	const source = input.source?.trim() || 'mission-control';
	const action = input.action;
	let authority: HarnessAuthorityVerdict | null = null;

	if (action === 'status') {
		const status = providerRuntime.getMissionStatus(missionId);
		const boardEntry = findMissionBoardEntry(missionId);
		if (!hasRuntimeStatusSignal(status) && !boardEntry) {
			return {
				ok: false,
				missionId,
				action,
				error: `Mission ${missionId} was not found. Use /board to pick a current mission ID.`
			};
		}
		return {
			ok: true,
			missionId,
			action,
			status: {
				...status,
				boardStatus: boardEntry?.status ?? null,
				lastEventType: boardEntry?.lastEventType ?? null,
				lastUpdated: boardEntry?.lastUpdated ?? null
			}
		};
	}

	authority = assertNativeGovernorHarnessAuthority({
		authority: resolveExecutionAuthority(input.executionAuthority),
		toolName: 'spawner.mission_control.command',
		ownerSystem: 'spawner-ui',
		mutationClass: 'controls_mission'
	});

	const currentStatus = providerRuntime.getMissionStatus(missionId);
	const boardEntry = findMissionBoardEntry(missionId);
	if (!hasRuntimeStatusSignal(currentStatus) && !boardEntry) {
		return {
			ok: false,
			missionId,
			action,
			error: `Mission ${missionId} was not found. Use /board to pick a current mission ID.`
		};
	}

	if (action === 'pause' && boardEntry && ['completed', 'failed'].includes(boardEntry.status)) {
		return {
			ok: false,
			missionId,
			action,
			error: `Mission ${missionId} is already ${boardEntry.status} and cannot be paused.`
		};
	}

	if (action === 'kill') {
		await providerRuntime.cancelMission(missionId, 'Mission cancelled by user', input.executionAuthority);
		await syncActiveMissionFile(missionId, 'cancelled', 'Mission cancelled from mission control');
		await syncMissionRecord(missionId, action, 'Mission cancelled from mission control');
		const bridgeEvent = buildBridgeEvent(missionId, 'mission_cancelled', source);
		eventBridge.emit(bridgeEvent);
		void relayMissionControlEvent({
			...bridgeEvent,
			message: 'Mission cancelled from mission control command endpoint'
		});
		return {
			ok: true,
			missionId,
			action,
			authority,
			message: `Mission ${missionId} cancelled.`
		};
	}

	if (action === 'pause') {
		const runtime = await providerRuntime.pauseMission(missionId, input.executionAuthority);
		if (!runtime.paused) {
			return {
				ok: false,
				missionId,
				action,
				error: runtime.reason || 'Unable to pause mission'
			};
		}
		await syncActiveMissionFile(missionId, 'paused', runtime.reason || 'Mission paused');
		await syncMissionRecord(missionId, action, runtime.reason);
	}

	if (action === 'resume') {
		const runtime = await providerRuntime.resumeMission(missionId, (event) => {
			eventBridge.emit(event);
			void relayMissionControlEvent(event as unknown as MissionControlBridgeEvent);
		}, input.executionAuthority, input.dispatchAuthority);
		if (!runtime.resumed) {
			return {
				ok: false,
				missionId,
				action,
				error: runtime.reason || 'Unable to resume mission'
			};
		}
		await syncActiveMissionFile(missionId, 'running', runtime.reason || 'Mission resumed');
		await syncMissionRecord(missionId, action, runtime.reason);
	}

	const eventType = ACTION_TO_EVENT[action as 'pause' | 'resume'];
	const bridgeEvent = buildBridgeEvent(missionId, eventType, source);
	eventBridge.emit(bridgeEvent);
	void relayMissionControlEvent({
		...bridgeEvent,
		message: action === 'pause' ? 'Mission paused by command endpoint' : 'Mission resumed by command endpoint'
	});

	return {
		ok: true,
		missionId,
		action,
		authority,
		eventType,
		message: `Mission ${missionId} ${action} command executed.`
	};
}

export function parseDiscordMissionControlCommand(text: string):
	| { ok: true; action: MissionControlAction; missionId: string }
	| { ok: false; error: string; help: string } {
	const normalized = text.trim().replace(/^\//, '');
	const parts = normalized.split(/\s+/).filter(Boolean);
	if (parts.length < 2 || parts[0].toLowerCase() !== 'mission') {
		return {
			ok: false,
			error: 'Command must start with "mission".',
			help: 'Use: mission <status|pause|resume|kill> <missionId>'
		};
	}

	const action = parts[1].toLowerCase();
	if (!isMissionControlAction(action)) {
		return {
			ok: false,
			error: `Unknown mission action "${parts[1]}".`,
			help: 'Use: mission <status|pause|resume|kill> <missionId>'
		};
	}

	const missionId = parts[2] || '';
	if (!missionId) {
		return {
			ok: false,
			error: 'Missing missionId.',
			help: 'Use: mission <status|pause|resume|kill> <missionId>'
		};
	}

	return {
		ok: true,
		action,
		missionId
	};
}
