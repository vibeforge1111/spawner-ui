/**
 * brief-enricher.ts — pre-generation pass that lifts vague briefs into
 * something the canvas generator can actually plan against.
 *
 * The eval suite found that vague inputs ("build me an app") plateau at
 * grade B no matter how many improver iterations run, because feedback
 * injection cannot invent missing requirements. The fix is upstream:
 * before the canvas generator runs, infer sensible defaults and flag
 * what's still ambiguous so the user can clarify.
 *
 * Output shape (the enricher always returns an enrichedContent that's
 * safe to pass downstream — it never blocks on missing info):
 *
 *   {
 *     enrichedContent: string,         // PRD with inferred defaults baked in
 *     addedAssumptions: string[],      // defaults the enricher chose
 *     openQuestions: string[],         // things the user could clarify
 *     wasEnriched: boolean             // true when defaults were added
 *   }
 *
 * Skipped (passes brief through untouched) when content is already long
 * + specific (>= 600 chars, includes ## section headers, or > 8 distinct
 * concrete keywords). Threshold tunable via env.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { resolveCliBinary } from './cli-resolver';

// Aggressive timeout: enrichment is a nice-to-have. If claude can't
// respond fast, use deterministic assumptions/questions so the user's
// request doesn't stall the bot. Override via BRIEF_ENRICH_TIMEOUT_MS.
function positiveNumericEnv(raw: string | undefined, fallback: number): number {
	const trimmed = (raw || '').trim();
	if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return fallback;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
const ENRICH_TIMEOUT_MS = positiveNumericEnv(process.env.BRIEF_ENRICH_TIMEOUT_MS, 12_000);
const ENRICH_MIN_LENGTH = positiveNumericEnv(process.env.BRIEF_ENRICH_MIN_LENGTH, 600);
const ENRICH_MIN_KEYWORDS = positiveNumericEnv(process.env.BRIEF_ENRICH_MIN_KEYWORDS, 8);
const ENRICH_PROVIDER = (process.env.SPAWNER_BRIEF_ENRICH_PROVIDER || 'deterministic').trim().toLowerCase();

export interface EnrichmentResult {
	enrichedContent: string;
	addedAssumptions: string[];
	openQuestions: string[];
	wasEnriched: boolean;
}

export function isSparseUnderstandingClarification(content: string): boolean {
	const normalized = content
		.trim()
		.toLowerCase()
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/[?.!]+$/g, '')
		.replace(/\s+/g, ' ');
	return normalized === 'did you understand what i said';
}

const KEYWORD_HINTS = [
	'auth', 'oauth', 'login', 'database', 'postgres', 'stripe', 'payment',
	'subscription', 'email', 'admin', 'dashboard', 'rate limit', 'queue',
	'realtime', 'websocket', 'api', 'mobile', 'web', 'static', 'rest',
	'graphql', 'analytics', 'ssr', 'spa', 'cdn', 'cache', 'redis', 's3',
	'arweave', 'solana', 'evm', 'nft', 'audit', 'compliance', 'rbac',
	'multi-tenant', 'tenant', 'workspace', 'org', 'role', 'mfa', 'sso',
	'webhook', 'event', 'pipeline', 'agent', 'llm', 'rag', 'retrieval',
	'classifier', 'scorer', 'feedback'
];

function estimateSpecificity(content: string): { length: number; keywords: number; hasSections: boolean } {
	const length = content.length;
	const lower = content.toLowerCase();
	let keywords = 0;
	for (const kw of KEYWORD_HINTS) if (lower.includes(kw)) keywords++;
	const hasSections = /^##\s+\w+/m.test(content);
	return { length, keywords, hasSections };
}

function shouldSkipEnrichment(content: string): boolean {
	const sig = estimateSpecificity(content);
	if (sig.length >= ENRICH_MIN_LENGTH) return true;
	if (sig.hasSections && sig.keywords >= 4) return true;
	if (sig.keywords >= ENRICH_MIN_KEYWORDS) return true;
	return false;
}

const ENRICH_PROMPT_TEMPLATE = `You are the spawner-ui brief enricher. The user submitted a project brief that may be too vague for a downstream canvas generator. Your job is to (1) infer reasonable defaults from the founder-mode software-product domain, (2) bake those defaults into a usable PRD, (3) list any remaining ambiguity as open questions.

Output strict JSON in a fenced \`\`\`json block. No prose outside the block.

Schema:
{
  "enrichedContent": "<a more complete PRD-style brief, ready for a canvas generator. Preserve user's actual phrasing where present, add inferred defaults clearly marked '(assumed)'>",
  "addedAssumptions": ["<one-line assumption you made>", ...],
  "openQuestions": ["<one-line question the user could answer to tighten the brief>", ...]
}

Guidance:
- Always output a usable enrichedContent. Never block.
- Choose defaults a sensible solo founder would pick: web app, modern stack, single-tenant v1, OAuth via managed provider, Postgres, basic analytics, deploy on Vercel/Cloudflare.
- Keep the enrichedContent under 1500 characters.
- 3-6 addedAssumptions max.
- 3-6 openQuestions max — the SHARPEST clarifications that would change the canvas materially.
- Do not invent product features the user didn't gesture at. Stay close to their wording; expand only the structural defaults around it.

USER BRIEF:
{{BRIEF}}`;

function extractJson(text: string): string | null {
	const fence = /\`\`\`json\s*([\s\S]*?)\`\`\`/i;
	const m = text.match(fence);
	if (m && m[1].trim()) return m[1].trim();
	const looseFence = /\`\`\`\s*([\s\S]*?)\`\`\`/;
	const m2 = text.match(looseFence);
	if (m2 && m2[1].trim().startsWith('{')) return m2[1].trim();
	const firstBrace = text.indexOf('{');
	const lastBrace = text.lastIndexOf('}');
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		const candidate = text.slice(firstBrace, lastBrace + 1).trim();
		try {
			JSON.parse(candidate);
			return candidate;
		} catch {
			return null;
		}
	}
	return null;
}

export function buildDeterministicEnrichment(content: string): EnrichmentResult {
	const brief = content.trim();
	if (isSparseUnderstandingClarification(brief)) {
		return {
			enrichedContent: brief,
			addedAssumptions: [],
			openQuestions: [
				'Who is this for?',
				'What concrete workflow should Spark build or change?',
				'What should be saved or remembered between sessions?',
				'What vibe should the finished experience have?'
			],
			wasEnriched: false
		};
	}

	const productName = brief.length <= 80 ? brief : `${brief.slice(0, 77)}...`;
	const lower = brief.toLowerCase();
	const isGame = /\b(game|maze|puzzle|arcade|runner|platformer|rpg|quest|level|player|score|enemy|boss)\b/.test(lower);
	const isDashboard = /\b(dashboard|analytics|metrics|monitor|report|tracker|board)\b/.test(lower);
	const isContentTool = /\b(journal|notes|writer|prompt|story|blog|content|editor)\b/.test(lower);

	let addedAssumptions: string[];
	let openQuestions: string[];
	let productDirection: string;
	let assumedScope: string[];

	if (isGame) {
		addedAssumptions = [
			'Assume this is a browser-playable game unless another platform is specified.',
			'Assume no accounts or backend in v1; keep state local to the browser.',
			'Assume the v1 should include a clear win condition, restart flow, keyboard controls, and a short smoke test.'
		];
		openQuestions = [
			'What should make this game feel surprising: shifting walls, power-ups, enemies, time pressure, or something stranger?',
			'Should it be chill and atmospheric or fast and score-chasing?',
			'Do you want generated mazes, hand-built levels, or one polished level for v1?',
			'What should count as winning?'
		];
		productDirection = `Build a small, playable browser game for: ${productName}.`;
		assumedScope = [
			'- A first screen that drops the player straight into the game.',
			'- Keyboard controls, restart, win/lose state, score or progress feedback, and responsive layout.',
			'- Local browser state only where useful, such as best time or best score.',
			'- Lightweight verification steps that prove movement, winning, restart, and persistence work.'
		];
	} else if (isDashboard) {
		addedAssumptions = [
			'Assume this is a responsive web dashboard unless another surface is specified.',
			'Assume the v1 can use local/mock data until a live source is named.',
			'Assume the dashboard should prioritize scanability, filters, empty states, and a simple verification path.'
		];
		openQuestions = [
			'What is the main decision this dashboard should help you make?',
			'Which three metrics matter most on the first screen?',
			'Should v1 use live data, imported files, or seeded sample data?',
			'Who checks this dashboard most often?'
		];
		productDirection = `Build a focused monitoring surface for: ${productName}.`;
		assumedScope = [
			'- A compact first screen with the most important status and trend information.',
			'- Filters or time range controls if they help the main decision.',
			'- Seeded data with clear seams for a live source when not specified.',
			'- Basic loading, empty, and error states plus verification steps.'
		];
	} else if (isContentTool) {
		addedAssumptions = [
			'Assume this is a local-first web tool unless another surface is specified.',
			'Assume no accounts in v1; save drafts and settings in browser storage.',
			'Assume the v1 should make the main creation loop fast, calm, and easy to verify.'
		];
		openQuestions = [
			'What should the user create or capture first?',
			'Should the experience feel focused and minimal or playful and generative?',
			'What should be saved between sessions?',
			'What is the most useful export, sharing, or history behavior for v1?'
		];
		productDirection = `Build a simple creation tool for: ${productName}.`;
		assumedScope = [
			'- A first screen centered on creating or capturing the primary item.',
			'- Local persistence for drafts, history, or settings.',
			'- Clear empty state, edit state, and saved state.',
			'- A README smoke test for creating, refreshing, restoring, and resetting.'
		];
	} else {
		addedAssumptions = [
			'Assume this is a web app unless the user specifies mobile, desktop, or another surface.',
			'Assume a focused v1 with local or lightweight persistence rather than heavy infrastructure by default.',
			'Assume the build should include basic empty/error states, responsive UI, and a simple verification path.'
		];
		openQuestions = [
			'Who should this first version be for?',
			'What is the one thing it should make satisfyingly easy?',
			'What should be saved or remembered between sessions?',
			'Should the vibe be practical, playful, premium, weird, or something else?'
		];
		productDirection = `Build a small but usable web app for: ${productName}.`;
		assumedScope = [
			'- Responsive web UI with a clear primary action.',
			'- Basic state/data persistence where the product needs memory between sessions.',
			'- Friendly empty, loading, and error states.',
			'- Minimal verification steps so the builder can prove the app works.'
		];
	}
	const enrichedContent = [
		'# Inferred Project Brief',
		`Original user request: ${brief}`,
		'',
		'## Product Direction',
		productDirection,
		'Focus on one clear user workflow, a polished first screen, and enough structure that the project can be extended after v1.',
		'',
		'## Assumed V1 Scope',
		...assumedScope,
		'',
		'## Open Questions',
		...openQuestions.map((question) => `- ${question}`)
	].join('\n');

	return {
		enrichedContent,
		addedAssumptions,
		openQuestions,
		wasEnriched: true
	};
}

export interface ClaudePrintSpawnCommand {
	command: string;
	args: string[];
	shell: boolean;
	windowsVerbatimArguments?: boolean;
}

function quoteForCmd(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

function resolveWindowsClaudeExecutable(resolvedBinary: string): string | null {
	if (!resolvedBinary.toLowerCase().endsWith('.cmd')) return null;
	const candidate = join(dirname(resolvedBinary), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
	return existsSync(candidate) ? candidate : null;
}

export function buildClaudePrintSpawnCommand(
	resolvedBinary = resolveCliBinary('claude') || 'claude',
	platform = process.platform
): ClaudePrintSpawnCommand {
	if (platform === 'win32') {
		if (!resolvedBinary.toLowerCase().endsWith('.cmd')) {
			return {
				command: resolvedBinary,
				args: ['--print'],
				shell: false
			};
		}
		const directExecutable = resolveWindowsClaudeExecutable(resolvedBinary);
		if (directExecutable) {
			return {
				command: directExecutable,
				args: ['--print'],
				shell: false
			};
		}
		return {
			command: process.env.ComSpec || 'cmd.exe',
			args: ['/d', '/c', `${quoteForCmd(resolvedBinary)} --print`],
			shell: false,
			windowsVerbatimArguments: true
		};
	}
	return {
		command: resolvedBinary,
		args: ['--print'],
		shell: false
	};
}

function runClaudePrint(prompt: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const command = buildClaudePrintSpawnCommand();
		const child = spawn(command.command, command.args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			shell: command.shell,
			windowsVerbatimArguments: command.windowsVerbatimArguments,
			env: { ...process.env }
		});
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`brief-enricher claude --print timed out after ${ENRICH_TIMEOUT_MS}ms`));
		}, ENRICH_TIMEOUT_MS);
		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString('utf-8');
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString('utf-8');
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(new Error(`brief-enricher spawn failed: ${err.message}`));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`brief-enricher exited ${code}. stderr: ${stderr.slice(0, 300)}`));
				return;
			}
			resolve(stdout);
		});
		child.stdin.write(prompt);
		child.stdin.end();
	});
}

export async function enrichBrief(content: string): Promise<EnrichmentResult> {
	if (shouldSkipEnrichment(content)) {
		return {
			enrichedContent: content,
			addedAssumptions: [],
			openQuestions: [],
			wasEnriched: false
		};
	}

	if (ENRICH_PROVIDER !== 'claude') {
		return buildDeterministicEnrichment(content);
	}

	try {
		const prompt = ENRICH_PROMPT_TEMPLATE.replace('{{BRIEF}}', content);
		const stdout = await runClaudePrint(prompt);
		const json = extractJson(stdout);
		if (!json) {
			console.warn('[brief-enricher] no JSON in claude output, falling back to deterministic brief');
			return buildDeterministicEnrichment(content);
		}
		let parsed: Partial<EnrichmentResult>;
		try {
			parsed = JSON.parse(json) as Partial<EnrichmentResult>;
		} catch {
			console.warn('[brief-enricher] JSON.parse failed on extracted JSON, falling back to deterministic brief');
			return buildDeterministicEnrichment(content);
		}
		const enrichedContent = typeof parsed.enrichedContent === 'string' && parsed.enrichedContent.trim()
			? parsed.enrichedContent
			: content;
		return {
			enrichedContent,
			addedAssumptions: Array.isArray(parsed.addedAssumptions)
				? parsed.addedAssumptions.filter((a): a is string => typeof a === 'string')
				: [],
			openQuestions: Array.isArray(parsed.openQuestions)
				? parsed.openQuestions.filter((q): q is string => typeof q === 'string')
				: [],
			wasEnriched: enrichedContent !== content
		};
	} catch (err) {
		console.warn('[brief-enricher] enrichment failed, falling back to deterministic brief:', err);
		return buildDeterministicEnrichment(content);
	}
}
