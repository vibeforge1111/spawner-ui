import { afterEach, describe, expect, it, vi } from 'vitest';
import { _h70SkillCacheForTests, clearSkillCache } from './h70-skills';

afterEach(() => {
	clearSkillCache();
	vi.useRealTimers();
});

describe('H70 cache expiry', () => {
	it('evicts both the cached skill and its timestamp', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-23T12:00:00Z'));
		const skillId = 'packet-204-expired';
		_h70SkillCacheForTests.seed(
			skillId,
			{
				skill: {
					id: skillId,
					name: 'Expired proof',
					description: 'Expired proof',
					tags: [],
					triggers: []
				},
				rawYaml: 'proof',
				formattedContent: 'proof'
			},
			Date.now() - 6 * 60 * 1000
		);

		expect(_h70SkillCacheForTests.isValid(skillId)).toBe(false);
		expect(_h70SkillCacheForTests.hasSkill(skillId)).toBe(false);
		expect(_h70SkillCacheForTests.hasTimestamp(skillId)).toBe(false);
	});
});
