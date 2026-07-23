import { afterEach, describe, expect, it } from 'vitest';
import { skills } from '$lib/stores/skills.svelte';
import { analyzeGoal } from './goal-analyzer';
import { matchSkills } from './skill-matcher';

afterEach(() => {
	skills.set([]);
});

describe('simple file task routing', () => {
	it('routes an explicit file operation to general development', async () => {
		const goal = analyzeGoal('create a file named hello.txt containing hello world');
		const result = await matchSkills(goal, { preferLocal: true });

		expect(goal.domains).toContain('file-task');
		expect(result.skills[0]).toMatchObject({
			skillId: 'general-development',
			matchReason: 'simple file task detected'
		});
	});

	it('does not let a casual file mention override a product domain', () => {
		const goal = analyzeGoal('build a SaaS platform for managing log files');

		expect(goal.domains).toContain('saas');
		expect(goal.domains).not.toContain('file-task');
	});
});
