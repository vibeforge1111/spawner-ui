import { describe, expect, it } from 'vitest';
import {
	formatH70SkillContent,
	getCondensedSkillContent,
	getH70SkillLabPath,
	getSkillsLabPath,
	type H70Skill,
} from './h70-skills';

const minimalSkill: H70Skill = {
	id: 'skill-1',
	name: 'Demo Skill',
	description: 'A short description.',
};

const fullSkill: H70Skill = {
	id: 'skill-2',
	name: 'Full Skill',
	description: 'Covers every section.',
	identity: 'You are a senior demo engineer.\n\nYou keep things simple.',
	owns: ['testing', 'verification'],
	delegates: [
		{ skill: 'other', when: 'when out of scope' },
		{ skill: 'noop', when: 'never' },
	],
	disasters: [
		{ title: 'lost-state', story: 'I dropped state once.', lesson: 'persist early.' },
	],
	anti_patterns: [
		{ name: 'silent-catch', why_bad: 'swallows errors', instead: 'log and rethrow', code_smell: 'catch {}' },
		{ name: 'no-tests', why_bad: 'no regression net', instead: 'add tests' },
	],
	patterns: [
		{ name: 'unit-cover', when: 'pure helpers', implementation: 'add 3-6 cases', gotchas: ['watch fixtures'] },
		{ name: 'snapshot', when: 'stable shapes', implementation: 'use vitest snapshot' },
	],
	triggers: ['demo', 'test'],
	tags: ['demo'],
};

describe('formatH70SkillContent', () => {
	it('renders a header with name and quoted description', () => {
		const md = formatH70SkillContent(minimalSkill, '');
		expect(md.startsWith('# Demo Skill')).toBe(true);
		expect(md).toMatch(/> A short description\./);
	});

	it('omits optional sections when the skill does not declare them', () => {
		const md = formatH70SkillContent(minimalSkill, '');
		expect(md).not.toMatch(/## Identity/);
		expect(md).not.toMatch(/## Expertise Areas/);
		expect(md).not.toMatch(/## When to Delegate/);
		expect(md).not.toMatch(/## Anti-Patterns/);
		expect(md).not.toMatch(/## Recommended Patterns/);
		expect(md).not.toMatch(/## Critical Lessons/);
	});

	it('renders every documented section when the skill is fully populated', () => {
		const md = formatH70SkillContent(fullSkill, '');
		expect(md).toMatch(/## Identity/);
		expect(md).toMatch(/## Expertise Areas/);
		expect(md).toMatch(/## When to Delegate/);
		expect(md).toMatch(/## Critical Lessons \(From Real Disasters\)/);
		expect(md).toMatch(/## Anti-Patterns to Avoid/);
		expect(md).toMatch(/## Recommended Patterns/);
		expect(md).toMatch(/## Activation Triggers/);
	});

	it('numbers disasters starting from 1', () => {
		const md = formatH70SkillContent(fullSkill, '');
		expect(md).toMatch(/### 1\. lost-state/);
	});

	it('includes anti-pattern code_smell line when provided', () => {
		const md = formatH70SkillContent(fullSkill, '');
		expect(md).toMatch(/\*\*Code smell:\*\* `catch \{\}`/);
	});

	it('renders pattern gotchas as a bullet list', () => {
		const md = formatH70SkillContent(fullSkill, '');
		expect(md).toMatch(/\*\*Gotchas:\*\*/);
		expect(md).toMatch(/- watch fixtures/);
	});
});

describe('getCondensedSkillContent', () => {
	it('always renders the name header', () => {
		expect(getCondensedSkillContent(minimalSkill).startsWith('## Demo Skill')).toBe(true);
	});

	it('omits Key Patterns and Avoid sections when there are none', () => {
		const md = getCondensedSkillContent(minimalSkill);
		expect(md).not.toMatch(/Key Patterns/);
		expect(md).not.toMatch(/Avoid/);
	});

	it('caps Key Patterns to the first three entries', () => {
		const many: H70Skill = {
			...minimalSkill,
			patterns: Array.from({ length: 5 }, (_, i) => ({
				name: `p${i}`,
				when: `when-${i}`,
				implementation: `imp-${i}`,
			})),
		};
		const md = getCondensedSkillContent(many);
		expect(md).toMatch(/- \*\*p0\*\*: when-0/);
		expect(md).toMatch(/- \*\*p2\*\*: when-2/);
		expect(md).not.toMatch(/p3/);
	});

	it('caps Avoid to the first three anti-patterns and uses only the first line of why_bad', () => {
		const many: H70Skill = {
			...minimalSkill,
			anti_patterns: Array.from({ length: 5 }, (_, i) => ({
				name: `ap${i}`,
				why_bad: `first-line-${i}\nsecond-line`,
				instead: `instead-${i}`,
			})),
		};
		const md = getCondensedSkillContent(many);
		expect(md).toMatch(/- \*\*ap0\*\*: first-line-0/);
		expect(md).not.toMatch(/second-line/);
		expect(md).not.toMatch(/ap3/);
	});

	it('keeps the first two paragraphs of identity only', () => {
		const skill: H70Skill = {
			...minimalSkill,
			identity: 'para 1\n\npara 2\n\npara 3',
		};
		const md = getCondensedSkillContent(skill);
		expect(md).toMatch(/para 1/);
		expect(md).toMatch(/para 2/);
		expect(md).not.toMatch(/para 3/);
	});
});

describe('getSkillsLabPath / getH70SkillLabPath alias', () => {
	it('returns the same string from both names', () => {
		expect(getSkillsLabPath()).toBe(getH70SkillLabPath());
	});

	it('returns a non-empty path string', () => {
		expect(getSkillsLabPath()).toMatch(/.+/);
	});
});
