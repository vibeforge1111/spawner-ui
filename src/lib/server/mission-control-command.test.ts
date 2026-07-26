import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	executeMissionControlAction,
	parseDiscordMissionControlCommand
} from './mission-control-command';
import {
	buildServerGovernorDecisionAuthority,
	buildServerTurnIntentVNextAuthority
} from './harness-authority';
import { eventBridge } from '$lib/services/event-bridge';
import { relayMissionControlEvent } from './mission-control-relay';
import { providerRuntime } from './provider-runtime';
import { mcpClient, type Mission } from '$lib/services/mcp-client';

function missionRecord(id: string): Mission {
	return {
		id,
		user_id: 'test-user',
		name: 'Orphan Pause Mission',
		description: 'Mission exists in storage but has no live provider sessions',
		mode: 'multi-llm-orchestrator',
		status: 'running',
		agents: [{ id: 'agent-1', name: 'Agent', role: 'builder', skills: ['code_analysis'], model: 'sonnet' }],
		tasks: [{
			id: 'task-1',
			title: 'Continue work',
			description: 'Resume from mission store',
			assignedTo: 'agent-1',
			status: 'pending',
			handoffType: 'sequential'
		}],
		context: { projectPath: process.cwd(), projectType: 'typescript', goals: ['pause orphan mission'] },
		current_task_id: null,
		outputs: {},
		error: null,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		started_at: new Date().toISOString(),
		completed_at: null
	};
}

function missionControlAuthority() {
	return buildServerGovernorDecisionAuthority({
		source: 'mission-control-command-test',
		reason: 'Focused mission-control authority regression.',
		toolName: 'spawner.mission_control.command',
		mutationClass: 'controls_mission',
		requestId: 'mission-control-command-test',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

function bareVNextMissionControlAuthority() {
	return buildServerTurnIntentVNextAuthority({
		source: 'mission-control-command-test',
		reason: 'Focused mission-control authority regression.',
		toolName: 'spawner.mission_control.command',
		mutationClass: 'controls_mission',
		requestId: 'mission-control-command-test',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

function legacyMissionControlAuthority() {
	return {
		schema: 'spark.machine_origin_policy.v1',
		origin: 'spawner-ui.test',
		source: 'mission-control-command-test',
		reason: 'Legacy mission-control compatibility fixture.',
		allowedTools: ['spawner.mission_control.command'],
		mutationClassesAllowed: ['controls_mission'],
		networkPolicy: 'local_only'
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	providerRuntime.cleanup('mission-command-orphan-pause');
});

describe('mission-control-command parser', () => {
	it('parses standard mission command', () => {
		const parsed = parseDiscordMissionControlCommand('mission status mission-123');
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.action).toBe('status');
			expect(parsed.missionId).toBe('mission-123');
		}
	});

	it('parses slash command form', () => {
		const parsed = parseDiscordMissionControlCommand('/mission pause abc');
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.action).toBe('pause');
			expect(parsed.missionId).toBe('abc');
		}
	});

	it('returns help when mission id is missing', () => {
		const parsed = parseDiscordMissionControlCommand('mission kill');
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.help).toContain('mission <status|pause|resume|kill> <missionId>');
		}
	});

	it('does not invent status for an unknown mission id', async () => {
		const result = await executeMissionControlAction({
			action: 'status',
			missionId: 'spark-definitely-not-real-status',
			source: 'test'
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain('not found');
	});

	it('does not pause an unknown mission id', async () => {
		const result = await executeMissionControlAction({
			action: 'pause',
			missionId: 'spark-definitely-not-real-pause',
			source: 'test',
			executionAuthority: missionControlAuthority()
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain('not found');
	});

	it('blocks mutating mission-control actions without Harness authority', async () => {
		await expect(
			executeMissionControlAction({
				action: 'pause',
				missionId: 'mission-command-no-authority',
				source: 'test'
			})
		).rejects.toMatchObject({
			code: 'harness_authority_blocked',
			verdict: expect.objectContaining({
				reasonCodes: expect.arrayContaining(['missing_harness_authority'])
			})
		});
	});

	it('blocks bare VNext authority for mutating mission-control actions', async () => {
		await expect(
			executeMissionControlAction({
				action: 'pause',
				missionId: 'mission-command-vnext-authority',
				source: 'test',
				executionAuthority: bareVNextMissionControlAuthority()
			})
		).rejects.toMatchObject({
			code: 'harness_authority_blocked',
			verdict: expect.objectContaining({
				reasonCodes: expect.arrayContaining(['native_governor_required'])
			})
		});
	});

	it('blocks legacy machine-origin policy for mutating mission-control actions', async () => {
		await expect(
			executeMissionControlAction({
				action: 'pause',
				missionId: 'mission-command-legacy-authority',
				source: 'test',
				executionAuthority: legacyMissionControlAuthority()
			})
		).rejects.toMatchObject({
			code: 'harness_authority_blocked',
			verdict: expect.objectContaining({
				reasonCodes: expect.arrayContaining(['legacy_machine_origin_demoted'])
			})
		});
	});

	it('pauses a board-visible orphan mission by confirming the stored mission record', async () => {
		const missionId = 'mission-command-orphan-pause';
		const getMission = vi.spyOn(mcpClient, 'getMission').mockResolvedValue({
			success: true,
			data: {
				mission: missionRecord(missionId),
				execution_prompt: 'Mission ID: mission-command-orphan-pause',
				_instruction: ''
			}
		});
		const updateMission = vi.spyOn(mcpClient, 'updateMission').mockResolvedValue({ success: true });
		const emit = vi.spyOn(eventBridge, 'emit');

		await relayMissionControlEvent({
			type: 'mission_started',
			missionId,
			source: 'spawner-ui',
			data: { mission: { name: 'Orphan Pause Mission' } }
		});

		const result = await executeMissionControlAction({
			action: 'pause',
			missionId,
			source: 'spawner-ui',
			executionAuthority: missionControlAuthority()
		});

		expect(result.ok).toBe(true);
		expect(result.eventType).toBe('mission_paused');
		expect(result.authority).toMatchObject({ source: 'governor_decision' });
		expect(getMission).toHaveBeenCalledWith(missionId);
		expect(updateMission).toHaveBeenCalledWith(missionId, expect.objectContaining({ status: 'paused' }));
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({
			id: expect.stringMatching(/^mc-cmd-\d+-[0-9a-f]{8}$/)
		}));

		const status = providerRuntime.getMissionStatus(missionId);
		expect(status.paused).toBe(true);
		expect(status.snapshotAvailable).toBe(false);
	});

	it('marks killed board-visible missions as cancelled without legacy MCP fail execution', async () => {
		const missionId = 'mission-command-cancelled';
		const failMission = vi.spyOn(mcpClient, 'failMission');
		const updateMission = vi.spyOn(mcpClient, 'updateMission').mockResolvedValue({ success: true });

		await relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: 'Cancel Me',
			source: 'spawner-ui'
		});

		const result = await executeMissionControlAction({
			action: 'kill',
			missionId,
			source: 'spawner-ui',
			executionAuthority: missionControlAuthority()
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain('cancelled');
		expect(result.authority).toMatchObject({ source: 'governor_decision' });
		expect(failMission).not.toHaveBeenCalled();
		expect(updateMission).toHaveBeenCalledWith(missionId, expect.objectContaining({ status: 'cancelled' }));
	});

	it('syncs governed resume through status update rather than legacy MCP start execution', async () => {
		const missionId = 'mission-command-resume-sync';
		const startMission = vi.spyOn(mcpClient, 'startMission');
		const updateMission = vi.spyOn(mcpClient, 'updateMission').mockResolvedValue({ success: true });
		const resumeMission = vi.spyOn(providerRuntime, 'resumeMission').mockResolvedValue({
			resumed: true,
			reason: 'Mission resumed'
		});

		await relayMissionControlEvent({
			type: 'mission_paused',
			missionId,
			missionName: 'Resume Me',
			source: 'spawner-ui'
		});

		const result = await executeMissionControlAction({
			action: 'resume',
			missionId,
			source: 'spawner-ui',
			executionAuthority: missionControlAuthority()
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain('resume command executed');
		expect(result.authority).toMatchObject({ source: 'governor_decision' });
		expect(resumeMission).toHaveBeenCalledWith(missionId, expect.any(Function), expect.any(Object), undefined);
		expect(startMission).not.toHaveBeenCalled();
		expect(updateMission).toHaveBeenCalledWith(missionId, expect.objectContaining({ status: 'running' }));
	});

	it('syncs active mission status through a temp-and-rename write', async () => {
		const previousStateDir = process.env.SPAWNER_STATE_DIR;
		const stateDir = await mkdtemp(path.join(tmpdir(), 'spawner-mission-control-command-'));
		process.env.SPAWNER_STATE_DIR = stateDir;
		const missionId = 'mission-command-active-sync';
		const activeMissionFile = path.join(stateDir, 'active-mission.json');
		try {
			vi.spyOn(mcpClient, 'getMission').mockResolvedValue({
				success: true,
				data: {
					mission: missionRecord(missionId),
					execution_prompt: `Mission ID: ${missionId}`,
					_instruction: ''
				}
			});
			vi.spyOn(mcpClient, 'updateMission').mockResolvedValue({ success: true });
			await writeFile(activeMissionFile, JSON.stringify({ missionId, status: 'running' }, null, 2), 'utf-8');
			await relayMissionControlEvent({
				type: 'mission_created',
				missionId,
				missionName: 'Active Sync',
				source: 'spawner-ui'
			});

			const result = await executeMissionControlAction({
				action: 'pause',
				missionId,
				source: 'spawner-ui',
				executionAuthority: missionControlAuthority()
			});

			expect(result.ok).toBe(true);
			expect(result.authority).toMatchObject({ source: 'governor_decision' });
			const active = JSON.parse(await readFile(activeMissionFile, 'utf-8')) as Record<string, unknown>;
			expect(active.status).toBe('paused');
			expect(active.note).toBe('Mission paused');
			expect((await readdir(stateDir)).filter((file) => file.includes('.tmp'))).toEqual([]);
		} finally {
			if (previousStateDir === undefined) {
				delete process.env.SPAWNER_STATE_DIR;
			} else {
				process.env.SPAWNER_STATE_DIR = previousStateDir;
			}
			providerRuntime.cleanup(missionId);
			await rm(stateDir, { recursive: true, force: true });
		}
	});
});
