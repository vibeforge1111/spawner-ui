import { describe, expect, it } from 'vitest';
import {
	buildDailyTopMissions,
	runMissionControlRegression,
	type MissionControlAction
} from './daily-orchestrator';
import type { Mission } from '$lib/services/mcp-client';

function mission(partial: Partial<Mission>): Mission {
	const now = new Date().toISOString();
	return {
		id: partial.id || 'm1',
		user_id: partial.user_id || 'u1',
		name: partial.name || 'Mission',
		description: partial.description || null,
		mode: partial.mode || 'multi-llm-orchestrator',
		status: partial.status || 'draft',
		agents: partial.agents || [],
		tasks: partial.tasks || [],
		context: partial.context || { projectPath: '.', projectType: 'ts', goals: ['x'] },
		current_task_id: partial.current_task_id || null,
		outputs: partial.outputs || {},
		error: partial.error || null,
		created_at: partial.created_at || now,
		updated_at: partial.updated_at || now,
		started_at: partial.started_at || null,
		completed_at: partial.completed_at || null
	};
}

describe('daily-orchestrator', () => {
	it('prioritizes running/ready missions for daily top list', () => {
		const items = buildDailyTopMissions([
			mission({ id: 'd1', status: 'draft', name: 'Draft' }),
			mission({ id: 'r1', status: 'running', name: 'Running', tasks: [{ id: 't', title: 't', description: 'd', assignedTo: 'a', status: 'pending', handoffType: 'sequential' }] }),
			mission({ id: 'r2', status: 'ready', name: 'Ready' })
		]);

		expect(items[0].id).toBe('r1');
		expect(items[1].id).toBe('r2');
		expect(items.length).toBe(3);
	});

	it('orders equal-priority missions by stable id', () => {
		const items = buildDailyTopMissions([
			mission({ id: 'mission-c', status: 'ready' }),
			mission({ id: 'mission-a', status: 'ready' }),
			mission({ id: 'mission-b', status: 'ready' })
		]);

		expect(items.map((item) => item.id)).toEqual(['mission-a', 'mission-b', 'mission-c']);
	});

	it('runs regression sequence and marks pass on known resume snapshot blocker', async () => {
		const calls: MissionControlAction[] = [];
		const result = await runMissionControlRegression({
			missionId: 'mission-123',
			execute: async ({ action }) => {
				calls.push(action);
				if (action === 'resume') {
					return { ok: false, error: 'No dispatch snapshot available to resume mission.' };
				}
				return { ok: true };
			}
		});

		expect(calls).toEqual(['status', 'pause', 'status', 'resume', 'status']);
		expect(result.pass).toBe(true);
	});
});
