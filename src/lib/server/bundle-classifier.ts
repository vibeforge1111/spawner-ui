/**
 * bundle-classifier.ts — pre-classify a brief against the curated bundles
 * in spark-skill-graphs (mirrored to static/bundles/) so the canvas
 * generator can use a known-good load_order as its phasing template.
 *
 * Deterministic keyword-overlap classifier. Each bundle has:
 *   - name (e.g. "SaaS with auth and billing")
 *   - task_pattern (one-line description of what it builds)
 *   - required_skills, optional_skills, load_order
 *   - notes (often the why and the most-common-mistake)
 *
 * Score = sum of normalized term hits across (name, task_pattern, skills, notes).
 * Embed only when confidence > THRESHOLD (default 0.18) — otherwise the
 * model is free to compose without bias toward a wrong template.
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

export interface BundleSpec {
	id: string;
	name: string;
	task_pattern: string;
	required_skills: string[];
	optional_skills: string[];
	load_order: string[];
	notes: string;
}

export interface ClassificationResult {
	bestMatch: BundleSpec | null;
	confidence: number;
	alternatives: Array<{ bundle: BundleSpec; score: number }>;
}

const STOPWORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
	'has', 'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
	'the', 'this', 'to', 'was', 'were', 'will', 'with', 'we', 'i', 'you',
	'they', 'them', 'their', 'each', 'should', 'must', 'can', 'all', 'any',
	'build', 'using', 'use', 'app', 'project', 'user', 'users'
]);

const DEFAULT_CONFIDENCE_THRESHOLD = 0.18;

function parseFloatInRangeEnv(raw: string | undefined, fallback: number, max = 1): number {
	const trimmed = (raw ?? '').trim();
	if (!/^\d*\.?\d+$/.test(trimmed)) return fallback;
	const n = Number(trimmed);
	return Number.isFinite(n) && n > 0 && n <= max ? n : fallback;
}

const CONFIDENCE_THRESHOLD = parseFloatInRangeEnv(process.env.BUNDLE_CLASSIFIER_THRESHOLD, DEFAULT_CONFIDENCE_THRESHOLD);

function bundlesDir(): string {
	return join(process.cwd(), 'static', 'bundles');
}

let cachedBundles: BundleSpec[] | null = null;

async function loadBundles(): Promise<BundleSpec[]> {
	if (cachedBundles) return cachedBundles;
	const dir = bundlesDir();
	if (!existsSync(dir)) return [];
	const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
	const out: BundleSpec[] = [];
	for (const f of files) {
		try {
			const raw = await readFile(join(dir, f), 'utf-8');
			const parsed = parseYaml(raw) as Partial<BundleSpec>;
			out.push({
				id: parsed.id || f.replace(/\.ya?ml$/, ''),
				name: parsed.name || parsed.id || f,
				task_pattern: parsed.task_pattern || '',
				required_skills: parsed.required_skills || [],
				optional_skills: parsed.optional_skills || [],
				load_order: parsed.load_order || [],
				notes: parsed.notes || ''
			});
		} catch {
			// Skip malformed bundle, keep classifier robust.
		}
	}
	cachedBundles = out;
	return out;
}

function tokenize(text: string): Set<string> {
	const tokens = text
		.toLowerCase()
		.replace(/[^a-z0-9\s/-]/g, ' ')
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 2 && !STOPWORDS.has(t));
	return new Set(tokens);
}

function bundleSearchText(b: BundleSpec): string {
	return [
		b.name,
		b.task_pattern,
		b.required_skills.join(' '),
		b.optional_skills.join(' '),
		b.notes
	].join(' ');
}

function scoreBundle(briefTokens: Set<string>, bundle: BundleSpec): number {
	const bundleTokens = tokenize(bundleSearchText(bundle));
	if (bundleTokens.size === 0 || briefTokens.size === 0) return 0;
	let hits = 0;
	for (const t of bundleTokens) if (briefTokens.has(t)) hits++;
	// Normalize by sqrt(|bundleTokens|) so longer-text bundles don't dominate.
	return hits / Math.sqrt(bundleTokens.size);
}

export async function classifyBrief(briefBody: string): Promise<ClassificationResult> {
	const bundles = await loadBundles();
	if (bundles.length === 0) {
		return { bestMatch: null, confidence: 0, alternatives: [] };
	}

	const briefTokens = tokenize(briefBody);
	const scored = bundles
		.map((bundle) => ({ bundle, score: scoreBundle(briefTokens, bundle) }))
		.sort((a, b) => b.score - a.score);

	const top = scored[0];
	const second = scored[1];
	// Margin between best and second-best as a confidence proxy. If the top
	// is barely better than the next one, we're not really matching anything.
	const margin = top && second ? top.score - second.score : top?.score ?? 0;
	const confidence = top ? Math.min(1, top.score) : 0;

	const useMatch = top && top.score >= CONFIDENCE_THRESHOLD && margin >= 0.05;

	return {
		bestMatch: useMatch ? top.bundle : null,
		confidence,
		alternatives: scored.slice(0, 3)
	};
}

export function formatBundleForPrompt(bundle: BundleSpec): string {
	const lines: string[] = [];
	lines.push(`## Reference template — closest curated bundle: ${bundle.name}`);
	lines.push('');
	lines.push(`Task pattern: ${bundle.task_pattern}`);
	lines.push('');
	lines.push('Suggested load order (use as a phasing baseline; deviate when the brief calls for it):');
	bundle.load_order.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
	lines.push('');
	lines.push(`Required skills: ${bundle.required_skills.join(', ')}`);
	if (bundle.optional_skills.length > 0) {
		lines.push(`Optional skills (consider when relevant): ${bundle.optional_skills.join(', ')}`);
	}
	if (bundle.notes) {
		lines.push('');
		lines.push('Notes from the bundle author:');
		for (const line of bundle.notes.split('\n')) {
			if (line.trim()) lines.push(`  ${line.trim()}`);
		}
	}
	lines.push('');
	lines.push(
		'IMPORTANT: This is a starting template, NOT a strict requirement. You can add tasks, reorder, or skip steps that do not match the brief. The load_order encodes proven dependencies (e.g. schema before auth before payments). Respect that ordering unless the brief says otherwise.'
	);
	return lines.join('\n');
}
