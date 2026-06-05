import type { Mission } from '$lib/services/mcp-client';
import type { MissionControlAction } from '$lib/server/mission-control-command';
export type { MissionControlAction };

export interface DailyTopMission {
	id: string;
	name: string;
	status: Mission['status'];
	score: number;
	reason: string;
}

export interface MissionControlRegressionStep {
	action: MissionControlAction;
	ok: boolean;
	message?: string;
	error?: string;
	status?: Record<string, unknown>;
}

export interface MissionControlRegressionResult {
	missionId: string;
	steps: MissionControlRegressionStep[];
	pass: boolean;
	notes: string[];
}

export function scoreMissionForDailyPriority(mission: Mission): { score: number; reason: string } {
	const now = Date.now();
	const updatedAt = Date.parse(mission.updated_at || mission.created_at || new Date().toISOString());
	const ageMinutes = Number.isFinite(updatedAt) ? Math.max(0, (now - updatedAt) / 60000) : 9999;
	const recencyBonus = Math.max(0, 30 - Math.floor(ageMinutes / 30));

	const base =
		mission.status === 'running'
			? 100
			: mission.status === 'ready'
				? 80
				: mission.status === 'draft'
					? 65
					: mission.status === 'paused'
						? 55
						: mission.status === 'failed'
							? 50
							: 10;

	const taskCountBonus = Math.min(20, mission.tasks.length * 2);
	const score = base + recencyBonus + taskCountBonus;

	const reason =
		mission.status === 'running'
			? 'Active mission: keep momentum'
			: mission.status === 'ready'
				? 'Ready to execute now'
				: mission.status === 'draft'
					? 'Near-ready draft worth finalizing'
					: mission.status === 'paused'
						? 'Paused work can be resumed'
						: mission.status === 'failed'
							? 'Needs recovery / unblock'
							: 'Low immediate priority';

	return { score, reason };
}

export function buildDailyTopMissions(missions: Mission[], limit = 3): DailyTopMission[] {
	return missions
		.map((mission) => {
			const scored = scoreMissionForDailyPriority(mission);
			return {
				id: mission.id,
				name: mission.name,
				status: mission.status,
				score: scored.score,
				reason: scored.reason
			};
		})
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, limit);
}

export async function runMissionControlRegression(options: {
	missionId: string;
	execute: (input: {
		missionId: string;
		action: MissionControlAction;
		source?: string;
		executionAuthority?: unknown;
	}) => Promise<Record<string, unknown>>;
	source?: string;
	includeKill?: boolean;
	executionAuthority?: unknown;
}): Promise<MissionControlRegressionResult> {
	const sequence: MissionControlAction[] = ['status', 'pause', 'status', 'resume', 'status'];
	if (options.includeKill) {
		sequence.push('kill', 'status');
	}

	const notes: string[] = [];
	const steps: MissionControlRegressionStep[] = [];
	for (const action of sequence) {
		const result = await options.execute({
			missionId: options.missionId,
			action,
			source: options.source || 'daily-orchestrator',
			...(action === 'status'
				? {}
				: {
						executionAuthority: options.executionAuthority
					})
		});

		const ok = Boolean(result.ok);
		const step: MissionControlRegressionStep = {
			action,
			ok,
			message: typeof result.message === 'string' ? result.message : undefined,
			error: typeof result.error === 'string' ? result.error : undefined,
			status:
				typeof result.status === 'object' && result.status
					? (result.status as Record<string, unknown>)
					: undefined
		};
		steps.push(step);

		if (!ok && step.error) {
			notes.push(`${action} failed: ${step.error}`);
		}
	}

	const pass = steps.every((step) => step.ok || (step.action === 'resume' && (step.error || '').includes('snapshot')));
	if (!pass && notes.length === 0) {
		notes.push('Regression failed without explicit error details');
	}

	return {
		missionId: options.missionId,
		steps,
		pass,
		notes
	};
}
