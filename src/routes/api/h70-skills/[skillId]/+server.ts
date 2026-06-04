/**
 * H70 Skills API Route
 *
 * Serves skill content directly from the local vibeship-h70 skill-lab.
 * GET /api/h70-skills/[skillId] - Get skill content
 * HEAD /api/h70-skills/[skillId] - Check if skill exists
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import { assertSafeId, PathSafetyError, resolveWithinBaseDir } from '$lib/server/path-safety';
import { getTierSkills } from '$lib/server/skill-tiers';
import { verifyH70SkillAccessToken } from '$lib/server/h70-skill-access-token';
import { verifySparkProSkillAccess, type SparkProEntitlementVerdict } from '$lib/server/spark-pro-entitlements';
import { parseJsonOrFallback } from '$lib/utils/safe-json';

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths.map((candidate) => path.resolve(candidate)))];
}

function getSkillsLabPathFallbacks(): string[] {
	return uniquePaths([
		path.resolve(process.cwd(), 'skills-lab'),
		path.resolve(process.cwd(), '..', 'spark-skill-graphs'),
		path.resolve(process.cwd(), '..', '..', 'spark-skill-graphs'),
		path.resolve(process.cwd(), '..', '..', 'spark-skill-graphs', 'source'),
		path.resolve(os.homedir(), 'Desktop', 'spark-skill-graphs'),
		path.resolve(os.homedir(), '.spark', 'modules', 'spark-skill-graphs', 'source'),
		path.resolve(process.cwd(), '..', 'vibeship-skills-lab')
	]);
}

function getStaticSkillsJsonFallbacks(): string[] {
	return uniquePaths([
		path.resolve(process.cwd(), 'static', 'skills.json'),
		path.resolve(os.homedir(), '.spark', 'modules', 'spawner-ui', 'source', 'static', 'skills.json'),
		path.resolve(os.homedir(), 'Desktop', 'spawner-ui', 'static', 'skills.json')
	]);
}

// Categories to search — sourced from spark-skill-graphs skills-registry.
// Canonical 33 from skills-registry-summary.md + 4 historical aliases
// (architecture, enterprise, performance, mcp-server) so pre-rename
// skill files still resolve during transitions.
const SKILL_CATEGORIES = [
	'ai', 'ai-agents', 'architecture', 'backend',
	'biotech', 'blockchain', 'business', 'climate', 'communications', 'community',
	'creative', 'data', 'design', 'development', 'devops',
	'ecommerce', 'education', 'engineering', 'enterprise', 'finance', 'frameworks',
	'frontend', 'game-dev', 'infrastructure',
	'integrations', 'marketing', 'mcp', 'mcp-server',
	'methodology', 'performance', 'product',
	'security', 'space', 'startup', 'strategy',
	'testing', 'trading'
];

interface H70Skill {
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

interface SparkSkillGraphMetadata {
	id: string;
	name?: string;
	description?: string;
	category?: string;
	tier?: string;
	tags?: string[];
	triggers?: string[];
	handoffs?: string[];
	pairsWell?: string[];
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function resolveSkillsLabPath(): string | null {
	const configuredPath =
		process.env.SPAWNER_H70_SKILLS_DIR ||
		process.env.H70_SKILLS_LAB_DIR ||
		process.env.SKILLS_LAB_PATH;

	if (configuredPath) {
		const resolvedPath = path.resolve(configuredPath);
		if (isDirectory(resolvedPath)) {
			return resolvedPath;
		}

		console.warn(`[Skills API] Configured skills directory not found: ${resolvedPath}`);
		return null;
	}

	for (const candidate of getSkillsLabPathFallbacks()) {
		if (isDirectory(candidate)) {
			return candidate;
		}
	}

	return null;
}

function getSkillsSourceName(skillsLabPath: string): string {
	return path.basename(skillsLabPath) || 'local-skills';
}

function resolveStaticSkillsJsonPath(): string | null {
	const configuredPath = process.env.SPAWNER_SKILLS_JSON || process.env.SPARK_SKILLS_JSON;
	const candidates = configuredPath ? [configuredPath, ...getStaticSkillsJsonFallbacks()] : getStaticSkillsJsonFallbacks();
	for (const candidate of candidates) {
		const resolved = path.resolve(candidate);
		if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
			return resolved;
		}
	}
	return null;
}

// Process-lifetime cache for the parsed skills JSON, keyed by path + mtime.
// findStaticSkillMetadata runs on every /api/h70-skills/[skillId] request and
// today re-reads + re-parses the entire JSON (potentially MB-sized) each call.
// Mtime check picks up edits without forcing a re-read.
interface StaticSkillsCacheEntry {
	skillsPath: string;
	mtimeMs: number;
	size: number;
	byId: Map<string, SparkSkillGraphMetadata>;
}
let _staticSkillsCache: StaticSkillsCacheEntry | null = null;

function findStaticSkillMetadata(skillId: string): { skill: SparkSkillGraphMetadata; path: string } | null {
	const skillsPath = resolveStaticSkillsJsonPath();
	if (!skillsPath) return null;
	try {
		const stats = fs.statSync(skillsPath);
		const cached = _staticSkillsCache;
		if (
			cached &&
			cached.skillsPath === skillsPath &&
			cached.mtimeMs === stats.mtimeMs &&
			cached.size === stats.size
		) {
			const skill = cached.byId.get(skillId);
			return skill ? { skill, path: skillsPath } : null;
		}
		const parsed = parseJsonOrFallback<SparkSkillGraphMetadata[]>(
			fs.readFileSync(skillsPath, 'utf-8'),
			[],
			'h70-skills'
		);
		const byId = new Map<string, SparkSkillGraphMetadata>();
		for (const candidate of parsed) {
			if (candidate && typeof candidate.id === 'string') {
				byId.set(candidate.id, candidate);
			}
		}
		_staticSkillsCache = { skillsPath, mtimeMs: stats.mtimeMs, size: stats.size, byId };
		const skill = byId.get(skillId);
		return skill ? { skill, path: skillsPath } : null;
	} catch (e) {
		console.warn(`[Skills API] Failed to read static skills graph metadata: ${skillsPath}`, e);
		return null;
	}
}

function formatStaticSkillContent(skill: SparkSkillGraphMetadata): string {
	const lines = [
		`# ${skill.name || skill.id}`,
		'',
		`> ${skill.description || 'Spark skill graph metadata skill.'}`,
		'',
		`**Skill ID:** ${skill.id}`,
		'**Source:** spark-skill-graphs static metadata',
		''
	];

	if (skill.category) lines.push(`**Category:** ${skill.category}`);
	if (skill.tier) lines.push(`**Tier:** ${skill.tier}`);
	if (skill.tags?.length) lines.push(`**Tags:** ${skill.tags.join(', ')}`);
	if (skill.triggers?.length) lines.push(`**Triggers:** ${skill.triggers.join(', ')}`);
	if (skill.handoffs?.length) lines.push(`**Handoffs:** ${skill.handoffs.join(', ')}`);
	if (skill.pairsWell?.length) lines.push(`**Pairs well with:** ${skill.pairsWell.join(', ')}`);

	lines.push(
		'',
		'## Usage',
		'Use this Spark skill graph entry as the task-specific capability signal. Full YAML skill bodies are preferred when a local spark-skill-graphs checkout is available; this metadata fallback prevents missions from losing skill context when only the bundled graph is installed.'
	);

	return lines.join('\n');
}

async function isOpenSourceSkill(skillId: string): Promise<boolean> {
	const baseSkills = await getTierSkills('base');
	return baseSkills.some((skill) => skill.id === skillId);
}

function lockedSkillResponse(verdict: SparkProEntitlementVerdict, head = false): Response | null {
	if (verdict === 'ok') return null;

	const status = verdict === 'missing' || verdict === 'unauthorized' ? 401 : verdict === 'forbidden' ? 403 : 503;
	const code =
		verdict === 'missing'
			? 'spark_pro_proof_required'
			: verdict === 'unauthorized'
				? 'spark_pro_proof_invalid'
				: verdict === 'forbidden'
					? 'spark_pro_skill_not_entitled'
					: 'spark_pro_entitlements_unavailable';
	const message =
		verdict === 'missing'
			? 'This Pro skill requires Spark Pro member proof.'
			: verdict === 'unauthorized'
				? 'Spark Pro member proof is invalid or expired.'
				: verdict === 'forbidden'
					? 'Spark Pro membership must include spark_pro or drop.skills.'
					: 'Spark Pro entitlements could not be verified.';
	const headers: Record<string, string> = {};
	if (status === 401 || status === 403) {
		headers['WWW-Authenticate'] =
			status === 403
				? 'Bearer realm="spawner-h70-skills", scope="drop.skills", error="insufficient_scope"'
				: 'Bearer realm="spawner-h70-skills", scope="drop.skills"';
	}

	if (head) return new Response(null, { status, headers });
	return json({ error: { code, message } }, { status, headers });
}

async function requireSkillAccess(skillId: string, request: Request, head = false): Promise<Response | null> {
	if (await isOpenSourceSkill(skillId)) return null;
	if (await verifyH70SkillAccessToken(request, skillId)) return null;
	return lockedSkillResponse(await verifySparkProSkillAccess(request), head);
}

function formatH70SkillContent(skill: H70Skill & { id: string }, rawYaml: string): string {
	const lines: string[] = [];

	// Header
	lines.push(`# ${skill.name}`);
	lines.push('');
	lines.push(`> ${skill.description}`);
	lines.push('');
	lines.push(`**Skill ID:** ${skill.id}`);
	lines.push(`**Source:** H70 Skill Lab (Local)`);
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
			lines.push(`### ${ap.name}`);
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
			lines.push(`### ${p.name}`);
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
 * Find skill file across all categories
 * New format: {skillsLabPath}/{category}/{skillId}.yaml
 */
function findSkillPath(skillsLabPath: string, skillId: string): string | null {
	// Try exact match first
	for (const category of SKILL_CATEGORIES) {
		const skillPath = resolveWithinBaseDir(skillsLabPath, path.join(category, `${skillId}.yaml`));
		if (fs.existsSync(skillPath)) {
			return skillPath;
		}
	}

	// Try with common name variations (e.g., supabase-backend vs supabase_backend)
	const variations = [
		skillId,
		skillId.replace(/-/g, '_'),
		skillId.replace(/_/g, '-'),
		skillId.toLowerCase(),
		skillId.replace(/specialist$/i, ''),
		skillId.replace(/-specialist$/i, ''),
	];

	for (const variant of variations) {
		for (const category of SKILL_CATEGORIES) {
			const skillPath = resolveWithinBaseDir(skillsLabPath, path.join(category, `${variant}.yaml`));
			if (fs.existsSync(skillPath)) {
				return skillPath;
			}
		}
	}

	return null;
}

export const GET: RequestHandler = async ({ params, request }) => {
	const { skillId } = params;

	if (!skillId) {
		throw error(400, 'Skill ID is required');
	}

	try {
		assertSafeId(skillId, 'skillId');
	} catch (e) {
		if (e instanceof PathSafetyError) {
			throw error(e.status, e.message);
		}
		throw e;
	}

	const accessResponse = await requireSkillAccess(skillId, request);
	if (accessResponse) return accessResponse;

	const skillsLabPath = resolveSkillsLabPath();
	if (!skillsLabPath) {
		const metadata = findStaticSkillMetadata(skillId);
		if (!metadata) {
			throw error(
				500,
				'Spark skill graph source not found. Set SPAWNER_H70_SKILLS_DIR, H70_SKILLS_LAB_DIR, or SPAWNER_SKILLS_JSON.'
			);
		}
		return json({
			skill: metadata.skill,
			rawYaml: JSON.stringify(metadata.skill, null, 2),
			formattedContent: formatStaticSkillContent(metadata.skill),
			source: 'spark-skill-graphs-static',
			path: metadata.path,
			category: metadata.skill.category || null
		});
	}

	// Find skill across categories
	let skillPath: string | null;
	try {
		skillPath = findSkillPath(skillsLabPath, skillId);
	} catch (e) {
		if (e instanceof PathSafetyError) {
			throw error(e.status, e.message);
		}
		throw e;
	}

	// Check if skill exists
	if (!skillPath) {
		const metadata = findStaticSkillMetadata(skillId);
		if (metadata) {
			return json({
				skill: metadata.skill,
				rawYaml: JSON.stringify(metadata.skill, null, 2),
				formattedContent: formatStaticSkillContent(metadata.skill),
				source: 'spark-skill-graphs-static',
				path: metadata.path,
				category: metadata.skill.category || null
			});
		}
		throw error(404, `Skill not found: ${skillId}`);
	}

	try {
		// Read and parse the skill YAML
		const rawYaml = fs.readFileSync(skillPath, 'utf-8');
		const skill = yaml.parse(rawYaml) as H70Skill;

		// Extract category from path
		const pathParts = skillPath.split(/[/\\]/);
		const category = pathParts[pathParts.length - 2];

		// Add ID from filename (without .yaml)
		const skillWithId = {
			...skill,
			id: skillId,
			category
		};

		// Format the content for Claude Code
		const formattedContent = formatH70SkillContent(skillWithId, rawYaml);

		return json({
			skill: skillWithId,
			rawYaml,
			formattedContent,
			source: getSkillsSourceName(skillsLabPath),
			path: skillPath,
			category
		});
	} catch (e) {
		console.error(`[Skills API] Error reading skill ${skillId}:`, e);
		throw error(500, `Failed to read skill: ${skillId}`);
	}
};

export const HEAD: RequestHandler = async ({ params, request }) => {
	const { skillId } = params;

	if (!skillId) {
		throw error(400, 'Skill ID is required');
	}

	try {
		assertSafeId(skillId, 'skillId');
		const accessResponse = await requireSkillAccess(skillId, request, true);
		if (accessResponse) return accessResponse;
		const skillsLabPath = resolveSkillsLabPath();
		if (!skillsLabPath) {
			if (findStaticSkillMetadata(skillId)) {
				return new Response(null, { status: 200 });
			}
			throw error(
				500,
				'Spark skill graph source not found. Set SPAWNER_H70_SKILLS_DIR, H70_SKILLS_LAB_DIR, or SPAWNER_SKILLS_JSON.'
			);
		}
		const skillPath = findSkillPath(skillsLabPath, skillId);

		if (!skillPath) {
			if (findStaticSkillMetadata(skillId)) {
				return new Response(null, { status: 200 });
			}
			throw error(404, `Skill not found: ${skillId}`);
		}
	} catch (e) {
		if (e instanceof PathSafetyError) {
			throw error(e.status, e.message);
		}
		throw e;
	}

	return new Response(null, { status: 200 });
};
