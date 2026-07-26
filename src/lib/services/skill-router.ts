/**
 * Skill Router - Intelligent skill selection based on specificity
 *
 * Routes features to the most SPECIFIC skill that owns that domain.
 * Uses collaboration index for ownership data and domain detection.
 */

import type { Skill } from '$lib/stores/skills.svelte';

// Types for collaboration index
interface SkillOwnership {
	owns: string[];
	specificity: number;
	receives_from?: string[];
}

interface DomainPack {
	triggers: string[];
	skills: string[];
}

interface SkillChain {
	description: string;
	chain: string[];
}

interface CollaborationIndex {
	version: string;
	core_skills: Record<string, SkillOwnership>;
	domain_packs: Record<string, DomainPack>;
	skill_chains: Record<string, SkillChain>;
}

// Cached collaboration index
let collaborationIndex: CollaborationIndex | null = null;

/**
 * Load the collaboration index (cached after first load)
 */
export async function loadCollaborationIndex(): Promise<CollaborationIndex> {
	if (collaborationIndex) return collaborationIndex;

	try {
		const response = await fetch('/skill-collaboration.json');
		if (!response.ok) throw new Error('Failed to load collaboration index');
		collaborationIndex = await response.json();
		return collaborationIndex!;
	} catch (e) {
		console.warn('[SkillRouter] Failed to load collaboration index:', e);
		// Return empty index as fallback
		return { version: '0', core_skills: {}, domain_packs: {}, skill_chains: {} };
	}
}

/**
 * Find the most specific skill for a feature
 *
 * @param featureName - The feature to match (e.g., "User authentication")
 * @param featureDescription - Optional description for context
 * @param availableSkills - List of available skills to choose from
 * @returns The most specific matching skill ID, or null
 */
export async function findMostSpecificSkill(
	featureName: string,
	featureDescription: string,
	availableSkills: Skill[]
): Promise<string | null> {
	const index = await loadCollaborationIndex();
	const lowerName = featureName.toLowerCase();
	const lowerDesc = (featureDescription || '').toLowerCase();
	const combined = `${lowerName} ${lowerDesc}`;

	const availableIds = new Set(availableSkills.map(s => s.id));
	const candidates: Array<{ skillId: string; score: number }> = [];

	// Score each skill based on ownership match
	for (const [skillId, ownership] of Object.entries(index.core_skills)) {
		if (!availableIds.has(skillId)) continue;

		let matchScore = 0;
		let matchCount = 0;

		// Check each "owns" keyword
		for (const owned of ownership.owns) {
			if (combined.includes(owned)) {
				matchCount++;
				// Longer matches are more specific
				matchScore += owned.length / 10;
			}
		}

		if (matchCount > 0) {
			// Apply specificity multiplier (0.5 - 1.0)
			const specificityBonus = ownership.specificity;
			const finalScore = (matchScore + matchCount * 0.3) * specificityBonus;
			candidates.push({ skillId, score: finalScore });
		}
	}

	// Sort by score descending
	candidates.sort((a, b) => b.score - a.score);

	if (candidates.length > 0) {
		return candidates[0].skillId;
	}

	return null;
}

/**
 * Detect which domain packs should be loaded based on PRD content
 */
const SCRIPTING_TASK_RE =
	/(?:\b(?:python|script|scripting|bash|shell|node\.?js|ruby|golang|rust|java)\b|\.py\b|c\+\+|hello world)/i;
const UI_TASK_RE =
	/\b(?:ui|interface|button|form|page|screen|component|react|vue|svelte|html|css)\b/i;

export function adjustScriptingDomains(domains: string[], prdContent: string): string[] {
	const adjusted = [...domains];
	if (!SCRIPTING_TASK_RE.test(prdContent)) return adjusted;
	if (!adjusted.includes('backend')) adjusted.push('backend');
	if (!UI_TASK_RE.test(prdContent)) {
		return adjusted.filter((domain) => domain !== 'frontend');
	}
	return adjusted;
}

export async function detectDomains(prdContent: string): Promise<string[]> {
	const index = await loadCollaborationIndex();
	const lowerContent = prdContent.toLowerCase();
	const detectedDomains: string[] = [];

	for (const [domain, pack] of Object.entries(index.domain_packs)) {
		const matchCount = pack.triggers.filter(t => lowerContent.includes(t)).length;
		// Need at least 2 trigger matches to activate a domain
		if (matchCount >= 2) {
			detectedDomains.push(domain);
		}
	}

	return adjustScriptingDomains(detectedDomains, prdContent);
}

/**
 * Get skills for detected domains
 */
export async function getSkillsForDomains(domains: string[]): Promise<string[]> {
	const index = await loadCollaborationIndex();
	const skills: string[] = [];

	for (const domain of domains) {
		const pack = index.domain_packs[domain];
		if (pack) {
			skills.push(...pack.skills);
		}
	}

	return [...new Set(skills)]; // Dedupe
}

/**
 * Get the recommended skill chain for a feature type
 */
export async function getSkillChain(featureType: string): Promise<string[] | null> {
	const index = await loadCollaborationIndex();

	// Try exact match first
	if (index.skill_chains[featureType]) {
		return index.skill_chains[featureType].chain;
	}

	// Try fuzzy match
	const lowerType = featureType.toLowerCase();
	for (const [chainType, chain] of Object.entries(index.skill_chains)) {
		if (lowerType.includes(chainType) || chainType.includes(lowerType)) {
			return chain.chain;
		}
	}

	return null;
}

/**
 * Determine if a feature should be decomposed into sub-tasks
 */
export async function shouldDecompose(featureName: string): Promise<boolean> {
	const complexPatterns = [
		/dashboard/i,
		/admin panel/i,
		/user interface/i,
		/full.*flow/i,
		/complete.*system/i,
		/end.?to.?end/i,
		/authentication.*system/i,
		/payment.*flow/i,
	];

	return complexPatterns.some(p => p.test(featureName));
}

/**
 * Get decomposition chain for a complex feature
 */
export async function getDecompositionChain(
	featureName: string,
	category: string
): Promise<string[] | null> {
	const index = await loadCollaborationIndex();

	// Map feature patterns to chain types
	const chainMappings: Array<{ pattern: RegExp; chain: string }> = [
		{ pattern: /ui|interface|page|view|component/i, chain: 'ui_feature' },
		{ pattern: /api|endpoint|route/i, chain: 'api_endpoint' },
		{ pattern: /auth|login|signup|session/i, chain: 'auth_system' },
		{ pattern: /payment|checkout|billing|subscription/i, chain: 'payment_flow' },
		{ pattern: /ai|llm|chat|gpt|claude|agent/i, chain: 'ai_feature' },
	];

	for (const { pattern, chain } of chainMappings) {
		if (pattern.test(featureName) || pattern.test(category)) {
			const skillChain = index.skill_chains[chain];
			if (skillChain) return skillChain.chain;
		}
	}

	return null;
}

/**
 * Score how well a skill matches a feature (0-1)
 * Higher specificity = better match for specialized work
 */
export async function scoreSkillMatch(
	skillId: string,
	featureName: string,
	featureDescription: string
): Promise<number> {
	const index = await loadCollaborationIndex();
	const ownership = index.core_skills[skillId];

	if (!ownership) return 0.3; // Default score for unknown skills

	const combined = `${featureName} ${featureDescription}`.toLowerCase();
	let matchScore = 0;

	for (const owned of ownership.owns) {
		if (combined.includes(owned)) {
			matchScore += 0.2;
		}
	}

	// Cap at 1.0, apply specificity
	return Math.min(1, matchScore) * ownership.specificity;
}
