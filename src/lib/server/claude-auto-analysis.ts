/**
 * claude-auto-analysis.ts — Run PRD analysis via the local Claude CLI.
 *
 * Designed as a drop-in alternative to startCodexAutoAnalysis when:
 *  - codex CLI is rate-limited (the immediate trigger)
 *  - the user prefers Claude Pro for analysis
 *  - we want one less hosted-model dependency in the loop
 *
 * Unlike codex (which runs as an agent and posts back to /api/events),
 * claude runs in --print mode: receive the full prompt + PRD content on
 * stdin, emit a single JSON block to stdout. We capture that, parse it,
 * and write directly to results/<requestId>.json under the configured
 * Spawner state root. The watchdog
 * already polls that path, so the rest of the pipeline (load-to-canvas,
 * mission-control-relay, eval suite) is unchanged.
 *
 * Selected when SPAWNER_PRD_AUTO_PROVIDER=claude.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { SkillTier } from './skill-tiers';
import { resolveCliBinary } from './cli-resolver';
import { spawnHidden } from './hidden-process';
import { claudeAutoAnalysisTimeoutMs } from './timeout-config';
import { BoundedProcessOutput } from './bounded-process-output';
import { stripProviderDeterministicArtifactProof } from './prd-deterministic-artifact-proof';

const CLAUDE_TIMEOUT_MS = claudeAutoAnalysisTimeoutMs();

interface PrdBridgePaths {
	spawnerDir: string;
	resultsDir: string;
	pendingPrdFile: string;
	pendingRequestFile: string;
	prdAutoTraceFile: string;
}

function normalizeRequestId(requestId: string): string {
	return requestId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildClaudePrompt(
	requestId: string,
	projectName: string,
	buildMode: 'direct' | 'advanced_prd',
	tierBlock: string,
	workflowGuidance: string,
	planningContract: string,
	prdContent: string,
	bundleBlock?: string,
	missionSizeBlock?: string
): string {
	return [
		'You are the spawner-ui PRD analyzer. Convert a PRD into a structured JSON canvas plan.',
		`Request ID: ${requestId}`,
		`Project Name Hint: ${projectName}`,
		`Build Mode: ${buildMode}`,
		'',
		planningContract,
		'',
		tierBlock,
		'',
		workflowGuidance,
		'',
		...(missionSizeBlock ? [missionSizeBlock, ''] : []),
		...(bundleBlock ? [bundleBlock, ''] : []),
		'## PRD content',
		prdContent,
		'',
		'## Output format (strict)',
		'Emit exactly one fenced ```json``` block with no prose before or after. The JSON object must have:',
		'  requestId, success (true), projectName, projectType, complexity (simple|moderate|complex),',
		'  infrastructure (object), techStack (object),',
		'  tasks: array of { id, title, summary, skills: string[], dependencies: string[], targets: string[],',
		'    acceptanceCriteria: string[], verificationCommands: string[] },',
		'  skills: union of skills across tasks,',
		'  executionPrompt: a short one-paragraph hand-off.',
		'',
		'Hard constraints:',
		'- Skill IDs MUST come from the tier allowlist above. Non-negotiable.',
		'- Form a DAG. Independent tasks must NOT depend on each other.',
		'- Choose task count from project complexity. Tiny builds may use 3-4 tasks, normal apps usually need 5-8, and substantial projects may need 8-14.',
		'- Do not default to four tasks when distinct skill sets or verification boundaries justify more.',
		'- Every task: at least one acceptance criterion, at least one verification command.',
		'- No placeholders, no TODOs, no prose outside the fenced block.'
	].join('\n');
}

function extractJson(text: string): string | null {
	const fence = /```json\s*([\s\S]*?)```/i;
	const m = text.match(fence);
	if (m && m[1].trim()) return m[1].trim();

	const looseFence = /```\s*([\s\S]*?)```/;
	const m2 = text.match(looseFence);
	if (m2 && m2[1].trim().startsWith('{')) return m2[1].trim();

	const firstBrace = text.indexOf('{');
	const lastBrace = text.lastIndexOf('}');
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		// The brace-search fallback used to JSON.parse the candidate just to
		// validate, then the caller parsed it again. The caller already
		// handles the parse error path, so return the candidate string and
		// let the caller's single JSON.parse do double duty (validate +
		// extract). One parse pass instead of two on a payload that can
		// easily be several KB of model output.
		return text.slice(firstBrace, lastBrace + 1).trim();
	}
	return null;
}

function runClaude(prompt: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const claudeBinary = resolveCliBinary('claude') || 'claude';
		const child = spawnHidden(claudeBinary, ['--print'], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env }
		});

		const stdout = new BoundedProcessOutput('OUTPUT');
		const stderr = new BoundedProcessOutput('STDERR');
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`claude --print timed out after ${CLAUDE_TIMEOUT_MS}ms`));
		}, CLAUDE_TIMEOUT_MS);

		child.stdout?.on('data', (chunk) => {
			stdout.append(chunk.toString('utf-8'));
		});
		child.stderr?.on('data', (chunk) => {
			stderr.append(chunk.toString('utf-8'));
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(new Error(`claude spawn failed: ${err.message}`));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code: code ?? -1 });
		});

		if (!child.stdin) {
			clearTimeout(timer);
			reject(new Error('claude stdin unavailable'));
			return;
		}
		child.stdin.write(prompt);
		child.stdin.end();
	});
}

export async function startClaudeAutoAnalysis(opts: {
	requestId: string;
	projectName: string;
	buildMode: 'direct' | 'advanced_prd';
	tier: SkillTier;
	paths: PrdBridgePaths;
	tierBlock: string;
	workflowGuidance: string;
	planningContract: string;
	bundleBlock?: string;
	missionSizeBlock?: string;
	appendTrace: (event: string, details?: Record<string, unknown>) => Promise<void>;
}): Promise<boolean> {
	const { requestId, projectName, buildMode, paths, tierBlock, workflowGuidance, planningContract, bundleBlock, missionSizeBlock, appendTrace } =
		opts;

	if (!existsSync(paths.pendingPrdFile)) {
		await appendTrace('claude_auto_skipped', { reason: 'pending-prd missing' });
		return false;
	}
	const prdContent = await readFile(paths.pendingPrdFile, 'utf-8');

	const prompt = buildClaudePrompt(
		requestId,
		projectName,
		buildMode,
		tierBlock,
		workflowGuidance,
		planningContract,
		prdContent,
		bundleBlock,
		missionSizeBlock
	);

	const missionId = `prd-auto-${normalizeRequestId(requestId)}`;
	await appendTrace('auto_worker_dispatch', {
		provider: 'claude',
		missionId,
		stateDirectory: paths.spawnerDir
	});

	const t0 = Date.now();
	void runClaude(prompt)
		.then(async ({ stdout, stderr, code }) => {
			const durationMs = Date.now() - t0;
			if (code !== 0) {
				await appendTrace('auto_worker_error', {
					provider: 'claude',
					code,
					stderr: stderr.slice(0, 400),
					durationMs
				});
				return;
			}

			const json = extractJson(stdout);
			if (!json) {
				await appendTrace('auto_worker_error', {
					provider: 'claude',
					reason: 'no JSON in stdout',
					stdoutPreview: stdout.slice(0, 400),
					durationMs
				});
				return;
			}

			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(json) as Record<string, unknown>;
			} catch (err) {
				await appendTrace('auto_worker_error', {
					provider: 'claude',
					reason: 'JSON parse failed',
					message: err instanceof Error ? err.message : String(err),
					durationMs
				});
				return;
			}

			parsed.requestId = requestId;
			parsed.success = true;
			delete parsed.deterministicArtifactProof;
			parsed.metadata = stripProviderDeterministicArtifactProof(parsed.metadata);

			const safe = normalizeRequestId(requestId);
			const resultPath = join(paths.resultsDir, `${safe}.json`);
			await writeFile(resultPath, JSON.stringify(parsed, null, 2), 'utf-8');

			await appendTrace('auto_worker_finished', {
				provider: 'claude',
				success: true,
				durationMs,
				resultPath
			});
		})
		.catch(async (err: unknown) => {
			await appendTrace('auto_worker_error', {
				provider: 'claude',
				error: err instanceof Error ? err.message : String(err)
			});
		});

	return true;
}
