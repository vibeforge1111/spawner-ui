import type { SkillCategory } from '$lib/stores/skills.svelte';

export interface CategoryDef {
	id: SkillCategory | string;
	label: string;
}

export interface CategoryGroupDef {
	name: string;
	icon: string;
	categories: CategoryDef[];
}

// Category ids that should render fully uppercased instead of title-cased.
const CATEGORY_ACRONYMS = new Set(['mcp', 'ai', 'api', 'llm']);

export function labelForCategoryId(id: string): string {
	return id
		.split('-')
		.map((part) =>
			CATEGORY_ACRONYMS.has(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
		)
		.join(' ');
}

/**
 * Derive a trailing browse group for categories that exist in the live
 * category counts but are missing from the curated taxonomy. Keeps every
 * skill reachable through Browse by Category even as skills.json gains
 * categories the static group definitions don't know about.
 * Returns null when the taxonomy already covers everything.
 */
export function buildExtraCategoryGroup(
	categoryCounts: Record<string, number>,
	knownCategoryIds: ReadonlySet<string>
): CategoryGroupDef | null {
	const extraIds = Object.keys(categoryCounts)
		.filter((id) => id && categoryCounts[id] > 0 && !knownCategoryIds.has(id))
		.sort();
	if (extraIds.length === 0) return null;
	return {
		name: 'More Categories',
		icon: 'grid',
		categories: extraIds.map((id) => ({ id, label: labelForCategoryId(id) }))
	};
}
