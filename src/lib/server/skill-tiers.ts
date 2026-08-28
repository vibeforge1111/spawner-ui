/**
 * Tier-aware skill registry for prompt allowlists.
 *
 * Source of truth is spark-skill-graphs:
 *  - pro:  every skill in static/skills.json.
 *  - base: the canonical open-source starter IDs in static/skill-tiers.json.
 *
 * Used by buildCodexPrompt to constrain emitted skill IDs to a tier the user
 * actually has access to. Without this, the model hallucinates IDs like
 * "vite-project-setup", "phaser-3", "vanilla-javascript" that do not exist.
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { parseJsonOrFallback } from '$lib/utils/safe-json';

export type SkillTier = 'base' | 'pro';

interface SkillRecord {
	id: string;
	name?: string;
	category?: string;
}

interface BundleYaml {
	id?: string;
	required_skills?: string[];
	optional_skills?: string[];
	load_order?: string[];
}

interface SkillTierManifest {
	open_source?: {
		canonical_starter_skill_ids?: string[];
	};
}

let cached: { base: SkillRecord[]; pro: SkillRecord[] } | null = null;

function staticDir(): string {
	return join(process.cwd(), 'static');
}

async function readJsonFile(path: string): Promise<unknown | null> {
	try {
		return parseJsonOrFallback<unknown | null>(await readFile(path, 'utf-8'), null, 'skill-tier-json');
	} catch {
		return null;
	}
}

async function loadProSkills(): Promise<SkillRecord[]> {
	const path = join(staticDir(), 'skills.json');
	if (!existsSync(path)) return [];
	const parsed = await readJsonFile(path);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((s): s is SkillRecord => {
		if (!s || typeof s !== 'object') return false;
		return typeof (s as { id?: unknown }).id === 'string';
	});
}

async function loadBaseSkills(pro: SkillRecord[]): Promise<SkillRecord[]> {
	const tiersPath = join(staticDir(), 'skill-tiers.json');
	const proById = new Map(pro.map((s) => [s.id, s]));
	if (existsSync(tiersPath)) {
		const tiers = await readJsonFile(tiersPath) as SkillTierManifest | null;
		const ids = tiers?.open_source?.canonical_starter_skill_ids;
		if (Array.isArray(ids)) {
			return ids
				.filter((id): id is string => typeof id === 'string')
				.map((id) => proById.get(id) ?? { id });
		}
	}

	const dir = join(staticDir(), 'bundles');
	if (!existsSync(dir)) return [];
	// NOTE: existsSync check then use is a TOCTOU pattern in concurrent code. The file may be deleted between the check and the read. Consider using try/catch ENOENT or async fs.promises.access.
	const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
	const out = new Map<string, SkillRecord>();
	for (const f of files) {
		const raw = await readFile(join(dir, f), 'utf-8');
		const bundle = parseYaml(raw) as BundleYaml;
		const ids = [
			...(bundle.required_skills ?? []),
			...(bundle.optional_skills ?? []),
			...(bundle.load_order ?? [])
		];
		for (const id of ids) {
			if (out.has(id)) continue;
			const enriched = proById.get(id) ?? { id };
			out.set(id, enriched);
		}
	}
	return [...out.values()];
}

export function resetSkillTierCacheForTests(): void {
	cached = null;
}

async function loadAll(): Promise<{ base: SkillRecord[]; pro: SkillRecord[] }> {
	if (cached) return cached;
	const pro = await loadProSkills();
	const base = await loadBaseSkills(pro);
	cached = { base, pro };
	return cached;
}

export async function getTierSkills(tier: SkillTier): Promise<SkillRecord[]> {
	const all = await loadAll();
	return tier === 'base' ? all.base : all.pro;
}

export function normalizeTier(value: unknown): SkillTier {
	if (value === 'pro' || value === 'premium') return 'pro';
	if (value === 'base' || value === 'free' || value === 'basic') return 'base';
	return 'base';
}

export function formatSkillsByCategory(skills: SkillRecord[]): string {
	const grouped = new Map<string, string[]>();
	for (const s of skills) {
		const cat = s.category || 'misc';
		if (!grouped.has(cat)) grouped.set(cat, []);
		grouped.get(cat)!.push(s.id);
	}
	const lines: string[] = [];
	for (const [cat, ids] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		ids.sort();
		lines.push(`- ${cat}: ${ids.join(', ')}`);
	}
	return lines.join('\n');
}
