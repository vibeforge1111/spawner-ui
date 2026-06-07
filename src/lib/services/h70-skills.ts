/**
 * H70 Skills Service
 *
 * Reads skills directly from the local vibeship-h70 skill-lab directory.
 * This is the PRIMARY source for skill content in spawner-ui.
 *
 * Features:
 * - Single skill fetching via API
 * - Bulk skill loading for missions
 * - Caching for performance
 * - Formatted skill content for Claude Code
 */

import { browser } from '$app/environment';

const SKILLS_LAB_PATH =
	(import.meta.env.PUBLIC_H70_SKILLS_LAB_PATH as string | undefined) ||
	(import.meta.env.PUBLIC_SKILLS_LAB_PATH as string | undefined) ||
	'h70-skills-lab';

// Cache for loaded skills (browser-side)
const skillCache = new Map<string, H70SkillContent>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cacheTimestamps = new Map<string, number>();

export interface H70Skill {
	id: string;
	name: string;
	description: string;
	version?: string;
	identity?: string;
	owns?: string[];
	delegates_version?: number;
	delegates?: Array<{
		skill: string;
		when: string;
		pass_context?: string[];
		expect_back?: string[];
		sla?: string;
	}>;
	disasters?: Array<{ title: string; story: string; lesson: string }>;
	anti_patterns?: Array<{ name: string; why_bad: string; instead: string; code_smell?: string }>;
	patterns?: Array<{ name: string; when: string; implementation: string; gotchas?: string[] }>;
	triggers?: string[];
	tags?: string[];
}

export interface H70SkillContent {
	skill: H70Skill;
	rawYaml: string;
	formattedContent: string;
}

/**
 * Format H70 skill into comprehensive instructions for Claude Code
 */
export function formatH70SkillContent(skill: H70Skill, rawYaml: string): string {
	const lines: string[] = [];

	// Header
	lines.push(`# ${skill.name}`);
	lines.push('');
	lines.push(`> ${skill.description}`);
	lines.push('');

	// Identity (the expert persona)
	if (skill.identity) {
		lines.push('## Identity');
		lines.push('');
		lines.push(skill.identity.trim());
		lines.push('');
	}

	// What this skill owns/handles
	if (skill.owns && skill.owns.length > 0) {
		lines.push('## Expertise Areas');
		lines.push('');
		skill.owns.forEach(own => {
			lines.push(`- ${own}`);
		});
		lines.push('');
	}

	// Delegates (when to hand off to other skills)
	if (skill.delegates && skill.delegates.length > 0) {
		lines.push('## When to Delegate');
		lines.push('');
		skill.delegates.forEach(d => {
			lines.push(`- **${d.skill}**: ${d.when}`);
		});
		lines.push('');
	}

	// Disasters (war stories and lessons)
	if (skill.disasters && skill.disasters.length > 0) {
		lines.push('## Critical Lessons (From Real Disasters)');
		lines.push('');
		skill.disasters.forEach((disaster, i) => {
			lines.push(`### ${i + 1}. ${disaster.title}`);
			lines.push('');
			lines.push(`**What happened:** ${disaster.story}`);
			lines.push('');
			lines.push(`**Lesson:** ${disaster.lesson}`);
			lines.push('');
		});
	}

	// Anti-patterns
	if (skill.anti_patterns && skill.anti_patterns.length > 0) {
		lines.push('## Anti-Patterns to Avoid');
		lines.push('');
		skill.anti_patterns.forEach(ap => {
			lines.push(`### ❌ ${ap.name}`);
			lines.push('');
			lines.push(`**Why it's bad:** ${ap.why_bad}`);
			lines.push('');
			lines.push(`**Instead:** ${ap.instead}`);
			if (ap.code_smell) {
				lines.push('');
				lines.push(`**Code smell:** \`${ap.code_smell}\``);
			}
			lines.push('');
		});
	}

	// Patterns
	if (skill.patterns && skill.patterns.length > 0) {
		lines.push('## Recommended Patterns');
		lines.push('');
		skill.patterns.forEach(p => {
			lines.push(`### ✅ ${p.name}`);
			lines.push('');
			lines.push(`**When:** ${p.when}`);
			lines.push('');
			lines.push('**Implementation:**');
			lines.push('');
			lines.push(p.implementation);
			if (p.gotchas && p.gotchas.length > 0) {
				lines.push('');
				lines.push('**Gotchas:**');
				p.gotchas.forEach(g => lines.push(`- ${g}`));
			}
			lines.push('');
		});
	}

	// Triggers
	if (skill.triggers && skill.triggers.length > 0) {
		lines.push('## Activation Triggers');
		lines.push('');
		lines.push(`This skill activates on: ${skill.triggers.join(', ')}`);
		lines.push('');
	}

	// Tags
	if (skill.tags && skill.tags.length > 0) {
		lines.push('---');
		lines.push(`**Tags:** ${skill.tags.join(', ')}`);
	}

	return lines.join('\n');
}

/**
 * Fetch H70 skill content via API (browser-side)
 */
export async function getH70Skill(skillId: string): Promise<H70SkillContent | null> {
	if (!browser) return null;

	try {
		const response = await fetch(`/api/h70-skills/${skillId}`);
		if (!response.ok) {
			console.warn(`[H70] Skill not found: ${skillId}`);
			return null;
		}

		const data = await response.json();
		return data as H70SkillContent;
	} catch (e) {
		console.error(`[H70] Error fetching skill ${skillId}:`, e);
		return null;
	}
}

/**
 * Check if H70 skill exists
 */
export async function h70SkillExists(skillId: string): Promise<boolean> {
	if (!browser) return false;

	try {
		const response = await fetch(`/api/h70-skills/${skillId}`, { method: 'HEAD' });
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Get the local skills lab path
 */
export function getSkillsLabPath(): string {
	return SKILLS_LAB_PATH;
}

// Alias for backward compatibility
export const getH70SkillLabPath = getSkillsLabPath;

/**
 * Check if cached skill is still valid
 */
function isCacheValid(skillId: string): boolean {
	const timestamp = cacheTimestamps.get(skillId);
	if (timestamp === undefined) return false;
	if (Date.now() - timestamp < CACHE_TTL_MS) return true;
	// Expired. Evict both maps in one place so they stay in sync. Without
	// this, an expired skillCache entry persists when the next fetch fails
	// (network error or skill removed from the lab), and downstream callers
	// that bypass isCacheValid would read the stale row. It also bounds
	// growth of cacheTimestamps for skills that get queried once and never
	// re-requested.
	skillCache.delete(skillId);
	cacheTimestamps.delete(skillId);
	return false;
}

/**
 * Fetch H70 skill with caching
 */
export async function getH70SkillCached(skillId: string): Promise<H70SkillContent | null> {
	// Check cache first
	if (isCacheValid(skillId)) {
		const cached = skillCache.get(skillId);
		if (cached) return cached;
	}

	// Fetch from API
	const skill = await getH70Skill(skillId);
	if (skill) {
		skillCache.set(skillId, skill);
		cacheTimestamps.set(skillId, Date.now());
	}

	return skill;
}

/**
 * Bulk load multiple H70 skills
 * Returns a map of skillId -> H70SkillContent
 */
export async function getH70SkillsBulk(
	skillIds: string[]
): Promise<Map<string, H70SkillContent>> {
	if (!browser) return new Map();

	const result = new Map<string, H70SkillContent>();
	const toFetch: string[] = [];

	// Check cache first
	for (const skillId of skillIds) {
		if (isCacheValid(skillId)) {
			const cached = skillCache.get(skillId);
			if (cached) {
				result.set(skillId, cached);
				continue;
			}
		}
		toFetch.push(skillId);
	}

	// Fetch remaining skills in parallel
	if (toFetch.length > 0) {
		const fetchPromises = toFetch.map(async (skillId) => {
			try {
				const skill = await getH70Skill(skillId);
				if (skill) {
					skillCache.set(skillId, skill);
					cacheTimestamps.set(skillId, Date.now());
					result.set(skillId, skill);
				}
			} catch (e) {
				console.warn(`[H70] Failed to load skill ${skillId}:`, e);
			}
		});

		await Promise.all(fetchPromises);
	}

	return result;
}

/**
 * Load skills and format them for inclusion in a mission prompt
 */
export async function loadSkillsForMission(
	skillIds: string[]
): Promise<{ skills: Map<string, H70SkillContent>; formattedPrompt: string }> {
	const skills = await getH70SkillsBulk(skillIds);

	// Build formatted prompt section
	const sections: string[] = [];
	sections.push('## H70 Skills Reference\n');
	sections.push('The following expert skills have been loaded to guide this mission:\n');

	for (const [skillId, skillContent] of skills) {
		sections.push(`### ${skillContent.skill.name}\n`);
		sections.push(skillContent.formattedContent);
		sections.push('\n---\n');
	}

	return {
		skills,
		formattedPrompt: sections.join('\n')
	};
}

/**
 * Get a condensed version of skills (identity + patterns only)
 * For when full skill content would be too long
 */
export function getCondensedSkillContent(skill: H70Skill): string {
	const lines: string[] = [];

	lines.push(`## ${skill.name}`);
	lines.push('');

	if (skill.identity) {
		// Take first 2 paragraphs of identity
		const paragraphs = skill.identity.trim().split('\n\n').slice(0, 2);
		lines.push(paragraphs.join('\n\n'));
		lines.push('');
	}

	// Key patterns only
	if (skill.patterns && skill.patterns.length > 0) {
		lines.push('### Key Patterns');
		skill.patterns.slice(0, 3).forEach(p => {
			lines.push(`- **${p.name}**: ${p.when}`);
		});
		lines.push('');
	}

	// Key anti-patterns only
	if (skill.anti_patterns && skill.anti_patterns.length > 0) {
		lines.push('### Avoid');
		skill.anti_patterns.slice(0, 3).forEach(ap => {
			lines.push(`- **${ap.name}**: ${ap.why_bad.split('\n')[0]}`);
		});
	}

	return lines.join('\n');
}

/**
 * Load condensed skills for mission (smaller prompt size)
 */
export async function loadCondensedSkillsForMission(
	skillIds: string[]
): Promise<{ skills: Map<string, H70SkillContent>; formattedPrompt: string }> {
	const skills = await getH70SkillsBulk(skillIds);

	const sections: string[] = [];
	sections.push('## H70 Skills Reference (Condensed)\n');

	for (const [skillId, skillContent] of skills) {
		sections.push(getCondensedSkillContent(skillContent.skill));
		sections.push('\n---\n');
	}

	return {
		skills,
		formattedPrompt: sections.join('\n')
	};
}

/**
 * Clear skill cache
 */
export function clearSkillCache(): void {
	skillCache.clear();
	cacheTimestamps.clear();
}
