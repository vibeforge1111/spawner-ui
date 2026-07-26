import { describe, expect, it } from 'vitest';
import { publicSkillSourcePath } from './skill-source-path';

describe('publicSkillSourcePath', () => {
	it('returns a stable source-relative path for an H70 skill', () => {
		expect(
			publicSkillSourcePath('/srv/private/skills/security/gitleaks.yaml', '/srv/private/skills')
		).toBe('security/gitleaks.yaml');
	});

	it('returns only the filename when no safe source root applies', () => {
		expect(publicSkillSourcePath('/Users/operator/private/skill-catalog.json')).toBe(
			'skill-catalog.json'
		);
		expect(publicSkillSourcePath('/outside/private.yaml', '/srv/skills')).toBe('private.yaml');
	});
});
