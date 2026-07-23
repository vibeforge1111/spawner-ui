import { logger } from '$lib/utils/logger';
import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import { mcpClient, type McpSkill } from '$lib/services/mcp-client';
import { mcpState } from './mcp.svelte';
import { StoredSkillArraySchema, safeJsonParse } from '$lib/types/schemas';

const GENERATED_SKILLS_KEY = 'spawner-generated-skills';

export type SkillTier = 'free' | 'premium';

export type SkillCategory =
	| 'development'
	| 'frameworks'
	| 'integrations'
	| 'ai-ml'
	| 'agents'
	| 'data'
	| 'design'
	| 'marketing'
	| 'strategy'
	| 'enterprise'
	| 'finance'
	| 'legal'
	| 'science'
	| 'startup';

export interface Skill {
	id: string;
	name: string;
	description: string;
	category: SkillCategory;
	tier: SkillTier;
	tags: string[];
	triggers: string[];
	tokenEstimate?: number;
	version?: string;
	handoffs?: { trigger: string; to: string }[];
	pairsWell?: string[];
	/** Skill chain for complex features (specialist sequence) */
	skillChain?: string[];
	/** Human-readable description of the chain */
	chainDescription?: string;
}

export interface SkillFilters {
	search: string;
	category: SkillCategory | 'all';
	tier: SkillTier | 'all';
	tags: string[];
}

export type SkillSource = 'static' | 'mcp';

// Raw skill data from skills.json (before validation)
interface RawSkillData {
	id: string;
	name: string;
	description?: string;
	category?: string;
	tier?: string;
	tags?: string[];
	triggers?: string[];
	handoffs?: { trigger: string; to: string }[];
	pairsWell?: string[];
}

// State
export const skills = writable<Skill[]>([]);
export const loading = writable(false);
export const error = writable<string | null>(null);
export const skillSource = writable<SkillSource>('static');

export const filters = writable<SkillFilters>({
	search: '',
	category: 'all',
	tier: 'all',
	tags: []
});

// Grammatical filler dropped from multi-word search queries so a project
// description like "a landing page with stripe payments" matches on its
// meaningful terms instead of requiring the whole sentence as a substring.
const SEARCH_STOPWORDS = new Set([
	'a', 'an', 'the', 'and', 'or', 'with', 'for', 'my', 'our', 'your',
	'of', 'to', 'in', 'on', 'i', 'we', 'me', 'it', 'this', 'that'
]);

export function tokenizeSkillSearchQuery(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9+#]+/)
		.filter((token) => token.length >= 2 && !SEARCH_STOPWORDS.has(token));
}

function skillMatchesTerm(skill: Skill, term: string): boolean {
	return (
		skill.name.toLowerCase().includes(term) ||
		skill.description.toLowerCase().includes(term) ||
		skill.tags.some((tag) => tag.toLowerCase().includes(term))
	);
}

/**
 * Search the catalog with graceful widening:
 * 1. exact-substring match on the whole query (previous behavior, unchanged
 *    whenever it produces results)
 * 2. if the phrase matches nothing, require every meaningful token to match
 * 3. if no skill matches all tokens, surface skills matching any token
 * Widening only engages when the previous behavior returned zero results.
 */
export function searchSkills(skillList: Skill[], query: string): Skill[] {
	const phrase = query.toLowerCase().trim();
	if (!phrase) return skillList;
	const phraseMatches = skillList.filter((skill) => skillMatchesTerm(skill, phrase));
	if (phraseMatches.length > 0) return phraseMatches;
	const tokens = tokenizeSkillSearchQuery(phrase);
	if (tokens.length === 0) return [];
	const allTokenMatches = skillList.filter((skill) =>
		tokens.every((token) => skillMatchesTerm(skill, token))
	);
	if (allTokenMatches.length > 0) return allTokenMatches;
	return skillList.filter((skill) => tokens.some((token) => skillMatchesTerm(skill, token)));
}

// Derived stores
export const filteredSkills = derived([skills, filters], ([$skills, $filters]) => {
	const searchPool = $filters.search ? searchSkills($skills, $filters.search) : $skills;
	return searchPool.filter((skill) => {
		// Category filter
		if ($filters.category !== 'all' && skill.category !== $filters.category) {
			return false;
		}

		// Tier filter
		if ($filters.tier !== 'all' && skill.tier !== $filters.tier) {
			return false;
		}

		// Tags filter
		if ($filters.tags.length > 0) {
			const hasAllTags = $filters.tags.every((tag) => skill.tags.includes(tag));
			if (!hasAllTags) return false;
		}

		return true;
	});
});

export const skillsByCategory = derived(skills, ($skills) => {
	const grouped: Record<string, Skill[]> = {};
	for (const skill of $skills) {
		if (!grouped[skill.category]) {
			grouped[skill.category] = [];
		}
		grouped[skill.category].push(skill);
	}
	return grouped;
});

export const allTags = derived(skills, ($skills) => {
	const tagSet = new Set<string>();
	for (const skill of $skills) {
		for (const tag of skill.tags) {
			tagSet.add(tag);
		}
	}
	return Array.from(tagSet).sort();
});

export const skillCounts = derived(skills, ($skills) => {
	return {
		total: $skills.length,
		free: $skills.filter((s) => s.tier === 'free').length,
		premium: $skills.filter((s) => s.tier === 'premium').length
	};
});

export const categoryCounts = derived(skills, ($skills) => {
	const counts: Record<string, number> = {};
	for (const skill of $skills) {
		const cat = skill.category || 'uncategorized';
		counts[cat] = (counts[cat] || 0) + 1;
	}
	return counts;
});

// ============================================
// localStorage Persistence for Generated Skills
// ============================================

/**
 * Save generated skills to localStorage
 */
function saveGeneratedSkills(generatedSkills: Skill[]): void {
	if (!browser) return;
	try {
		localStorage.setItem(GENERATED_SKILLS_KEY, JSON.stringify(generatedSkills));
		logger.info(`[Skills] Saved ${generatedSkills.length} generated skills to localStorage`);
	} catch (e) {
		console.error('[Skills] Failed to save generated skills:', e);
	}
}

/**
 * Load generated skills from localStorage
 * @deprecated No longer used - kept for reference
 */
function loadGeneratedSkills(): Skill[] {
	if (!browser) return [];
	try {
		const saved = localStorage.getItem(GENERATED_SKILLS_KEY);
		if (saved) {
			// SECURITY: Validate JSON with Zod schema
			const parsedSkills = safeJsonParse(saved, StoredSkillArraySchema, 'generated-skills');
			if (!parsedSkills) {
				console.warn('[Skills] Invalid generated skills data, returning empty');
				return [];
			}
			// Cast to Skill[] since we've validated the structure
			const skills = parsedSkills as unknown as Skill[];
			logger.info(`[Skills] Loaded ${skills.length} generated skills from localStorage`);
			return skills;
		}
	} catch (e) {
		console.error('[Skills] Failed to load generated skills:', e);
	}
	return [];
}

/**
 * Get all generated skills from the current store
 */
function getGeneratedSkillsFromStore(): Skill[] {
	return get(skills).filter(s => s.id.startsWith('generated-'));
}

// Helper to convert MCP skill to our Skill interface
function mapMcpSkill(s: McpSkill): Skill {
	return {
		id: s.id,
		name: s.name,
		description: s.description || '',
		category: s.category as SkillCategory,
		tier: (s.layer === 1 ? 'free' : 'premium') as SkillTier,
		tags: s.tags || [],
		triggers: s.triggers || [],
		handoffs: s.handoffs || [],
		pairsWell: s.pairs_with || []
	};
}

// Actions

/**
 * Load skills from static JSON (fallback)
 *
 * IMPORTANT: Clears old generated skills to ensure each PRD analysis starts
 * with a fresh skill pool. Previously, old generated skills from localStorage
 * polluted the skill matcher, causing worse results on subsequent PRD uploads.
 */
export async function loadSkillsStatic() {
	loading.set(true);
	error.set(null);
	skillSource.set('static');

	try {
		const response = await fetch('/skills.json');
		if (!response.ok) {
			throw new Error('Failed to load skills.json');
		}
		const data = await response.json();

		const loadedSkills: Skill[] = (data as RawSkillData[]).map((s) => ({
			id: s.id,
			name: s.name,
			description: s.description || '',
			category: (s.category as SkillCategory) || 'development',
			tier: (s.tier as SkillTier) || 'free',
			tags: s.tags || [],
			triggers: s.triggers || [],
			handoffs: s.handoffs || [],
			pairsWell: s.pairsWell || []
		}));

		// Clear old generated skills from localStorage to prevent pollution
		// Each PRD analysis should start fresh with only real H70 skills
		// FIX: Previously, old generated skills polluted the skill matcher
		if (browser) {
			localStorage.removeItem(GENERATED_SKILLS_KEY);
			logger.info('[Skills] Cleared old generated skills for fresh analysis');
		}

		// Set only the freshly loaded skills - no old generated skills
		skills.set(loadedSkills);
	} catch (e) {
		error.set(e instanceof Error ? e.message : 'Failed to load skills');
		console.error('Error loading skills:', e);
	} finally {
		loading.set(false);
	}
}

/**
 * Load skills from MCP server
 *
 * IMPORTANT: Clears old generated skills to ensure each PRD analysis starts
 * with a fresh skill pool.
 */
export async function loadSkillsMcp() {
	loading.set(true);
	error.set(null);
	skillSource.set('mcp');

	try {
		const result = await mcpClient.listSkills();

		if (!result.success) {
			throw new Error(result.error || 'Failed to load skills from MCP');
		}

		const mcpSkills = result.data?.skills || [];
		const loadedSkills: Skill[] = mcpSkills.map(mapMcpSkill);

		// Clear old generated skills from localStorage to prevent pollution
		// Each PRD analysis should start fresh with only real H70 skills
		if (browser) {
			localStorage.removeItem(GENERATED_SKILLS_KEY);
			logger.info('[Skills] Cleared old generated skills for fresh analysis');
		}

		// Set only the freshly loaded skills - no old generated skills
		skills.set(loadedSkills);
	} catch (e) {
		error.set(e instanceof Error ? e.message : 'Failed to load skills from MCP');
		console.error('Error loading skills from MCP:', e);
		// Fall back to static
		await loadSkillsStatic();
	} finally {
		loading.set(false);
	}
}

/**
 * Search skills via MCP
 */
export async function searchSkillsMcp(query: string) {
	loading.set(true);
	error.set(null);

	try {
		const result = await mcpClient.searchSkills(query);

		if (!result.success) {
			throw new Error(result.error || 'Failed to search skills');
		}

		const mcpSkills = result.data?.skills || [];
		const loadedSkills: Skill[] = mcpSkills.map(mapMcpSkill);

		// Preserve generated/custom skills (from PRD analysis) when searching
		const existingSkills = get(skills);
		const generatedSkills = existingSkills.filter(s => s.id.startsWith('generated-'));
		const loadedIds = new Set(loadedSkills.map(s => s.id));
		const toPreserve = generatedSkills.filter(s => !loadedIds.has(s.id));

		skills.set([...loadedSkills, ...toPreserve]);
		skillSource.set('mcp');
	} catch (e) {
		error.set(e instanceof Error ? e.message : 'Failed to search skills');
		console.error('Error searching skills:', e);
	} finally {
		loading.set(false);
	}
}

/**
 * Load skills - automatically uses MCP if connected, otherwise static
 */
export async function loadSkills() {
	const state = get(mcpState);
	if (state.status === 'connected') {
		await loadSkillsMcp();
	} else {
		await loadSkillsStatic();
	}
}

export function setFilter<K extends keyof SkillFilters>(key: K, value: SkillFilters[K]) {
	filters.update((f) => ({ ...f, [key]: value }));
}

export function resetFilters() {
	filters.set({
		search: '',
		category: 'all',
		tier: 'all',
		tags: []
	});
}

export function getSkillById(id: string): Skill | undefined {
	let found: Skill | undefined;
	skills.subscribe((s) => {
		found = s.find((skill) => skill.id === id);
	})();
	return found;
}

/**
 * Add skills to the store (used for generated/placeholder skills from PRD)
 * Only adds skills that don't already exist (by ID)
 * Automatically persists generated skills to localStorage
 */
export function addSkills(newSkills: Skill[]) {
	skills.update((existing) => {
		// Filter out any skills with undefined/null ids
		const validNewSkills = newSkills.filter(s => s && s.id);
		const existingIds = new Set(existing.filter(s => s && s.id).map(s => s.id));
		const toAdd = validNewSkills.filter(s => !existingIds.has(s.id));
		const updated = [...existing, ...toAdd];

		// Auto-save generated skills to localStorage
		const generatedSkills = updated.filter(s => s && s.id && s.id.startsWith('generated-'));
		if (generatedSkills.length > 0) {
			saveGeneratedSkills(generatedSkills);
		}

		return updated;
	});
}

/**
 * Remove a generated skill
 */
export function removeGeneratedSkill(skillId: string) {
	if (!skillId.startsWith('generated-')) {
		console.warn('[Skills] Can only remove generated skills');
		return;
	}

	skills.update((existing) => {
		const updated = existing.filter(s => s.id !== skillId);

		// Update localStorage
		const generatedSkills = updated.filter(s => s.id.startsWith('generated-'));
		saveGeneratedSkills(generatedSkills);

		return updated;
	});
}

/**
 * Clear all generated skills
 */
export function clearGeneratedSkills() {
	skills.update((existing) => {
		const nonGenerated = existing.filter(s => !s.id.startsWith('generated-'));
		saveGeneratedSkills([]); // Clear localStorage
		return nonGenerated;
	});
}

/**
 * Get count of generated skills
 */
export function getGeneratedSkillsCount(): number {
	return getGeneratedSkillsFromStore().length;
}
