import { logger } from '$lib/utils/logger';
/**
 * PRD Bridge - Write Endpoint
 *
 * Writes PRD content to a file for runtime analysis.
 * Called by Spawner UI when user uploads a PRD.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { writeFile, mkdir, appendFile, readFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { existsSync, realpathSync } from 'fs';
import { sparkAgentBridge } from '$lib/services/spark-agent-bridge';
import { enforceRateLimit, requireControlAuth } from '$lib/server/mcp-auth';
import { resolveCliBinary } from '$lib/server/cli-resolver';
import { relayMissionControlEvent } from '$lib/server/mission-control-relay';
import { extractMissionControlProjectLineage } from '$lib/server/mission-control-lineage';
import { formatSkillsByCategory, getTierSkills, normalizeTier, type SkillTier } from '$lib/server/skill-tiers';
import { startClaudeAutoAnalysis } from '$lib/server/claude-auto-analysis';
import { classifyBrief, formatBundleForPrompt } from '$lib/server/bundle-classifier';
import { classifyMissionSize, formatMissionSizeGuidance } from '$lib/server/mission-size-classifier';
import { formatTaskQualityGuidance } from '$lib/server/task-quality-rubric';
import { formatVerificationPlanGuidance, generateVerificationPlan } from '$lib/server/verification-plan-generator';
import { enrichBrief, isSparseUnderstandingClarification } from '$lib/server/brief-enricher';
import { spawnerStateDir } from '$lib/server/spawner-state';
import {
	externalProjectPathsAllowed,
	isWithinDirectory,
	sparkWorkspaceRoot
} from '$lib/server/spark-run-workspace';
import { writeFileAtomic } from '$lib/server/atomic-write';
import {
	projectStoredPrdAnalysisResultForTier,
	type StoredPrdAnalysisResult
} from '$lib/server/prd-analysis-result-schema';
import { extractExplicitProjectPath } from '$lib/server/project-path-extraction';
import {
	capabilityProposalSummary,
	normalizeCapabilityProposalPacket
} from '$lib/server/capability-proposal-packet';
import { extractTraceRef, normalizeTraceRef, traceRefFromMissionId } from '$lib/server/trace-ref';
import {
	pendingPrdFileForRequest,
	pendingRequestFileForRequest,
	pendingRequestsDir,
	readPendingPrdContent,
	readPendingRequestRecord
} from '$lib/server/prd-pending-requests';
import { parseJsonOrFallback } from '$lib/utils/safe-json';
import {
	HarnessAuthorityError,
	assertNativeGovernorHarnessAuthority,
	resolveExecutionAuthority
} from '$lib/server/harness-authority';
import { recoverOverduePrdAutoAnalysisFromPending } from '$lib/server/prd-auto-analysis-timeout';
import { resolveSparkRunProjectPath } from '$lib/server/spark-run-workspace';

function getPrdBridgePaths() {
	const spawnerDir = spawnerStateDir();
	return {
		spawnerDir,
		resultsDir: join(spawnerDir, 'results'),
		provisionalResultsDir: join(spawnerDir, 'provisional-results'),
		pendingPrdFile: join(spawnerDir, 'pending-prd.md'),
		pendingRequestFile: join(spawnerDir, 'pending-request.json'),
		prdAutoTraceFile: join(spawnerDir, 'prd-auto-trace.jsonl')
	};
}

/**
 * Bridge paths with the pending PRD/request pointed at the requestId-scoped
 * files when they exist, so concurrent requests never read each other's
 * singleton pointer. Falls back to the singleton paths for legacy state.
 */
function scopedPrdBridgePathsForRequest(requestId: string): ReturnType<typeof getPrdBridgePaths> {
	const paths = getPrdBridgePaths();
	const scopedPrdFile = pendingPrdFileForRequest(paths.spawnerDir, requestId);
	const scopedRequestFile = pendingRequestFileForRequest(paths.spawnerDir, requestId);
	return {
		...paths,
		pendingPrdFile: existsSync(scopedPrdFile) ? scopedPrdFile : paths.pendingPrdFile,
		pendingRequestFile: existsSync(scopedRequestFile) ? scopedRequestFile : paths.pendingRequestFile
	};
}
const AUTO_ANALYSIS_BASE_URL = (process.env.SPAWNER_UI_SELF_URL || 'http://127.0.0.1:3333').replace(
	/\/+$/,
	''
);
const AUTO_ANALYSIS_ENDPOINT = `${AUTO_ANALYSIS_BASE_URL}/api/events`;
const DEFAULT_AUTO_ANALYSIS_TIMEOUT_MS = 420_000;
const configuredAnalysisTimeoutMs = Number.parseInt(process.env.SPAWNER_AUTO_ANALYSIS_TIMEOUT_MS || '', 10);
const AUTO_ANALYSIS_TIMEOUT_MS =
	Number.isFinite(configuredAnalysisTimeoutMs) && configuredAnalysisTimeoutMs > 0
		? configuredAnalysisTimeoutMs
		: DEFAULT_AUTO_ANALYSIS_TIMEOUT_MS;
const DEFAULT_PROVISIONAL_DIRECT_ANALYSIS_MS = 10_000;
const DEFAULT_PROVISIONAL_ADVANCED_ANALYSIS_MS = 45_000;

function normalizeRequestId(requestId: string): string {
	return requestId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function missionIdFromRequestId(requestId: string): string {
	const normalized = normalizeRequestId(requestId);
	const stamp = normalized.match(/(\d{10,})$/)?.[1];
	return `mission-${stamp || normalized}`;
}

async function relayCanonicalPrdAnalysisComplete(input: {
	requestId: string;
	projectName: string;
	buildMode: 'direct' | 'advanced_prd';
	buildLane?: string | null;
	traceRef?: string | null;
	provider: string;
	providerProcessSuccess?: boolean | null;
	resultFileName: string | null;
	durationMs?: number | null;
	sessionId?: string | null;
	terminal?: boolean;
}): Promise<void> {
	const missionId = missionIdFromRequestId(input.requestId);
	const completionData = {
		requestId: input.requestId,
		...traceRefDetails(input.traceRef),
		buildMode: input.buildMode,
		buildLane: input.buildLane,
		provider: input.provider,
		providerProcessSuccess: input.providerProcessSuccess ?? true,
		canonicalResultAvailable: true,
		resultFileName: input.resultFileName,
		autoAnalysisStatus: 'complete',
		durationMs: input.durationMs ?? null,
		sessionId: input.sessionId ?? null
	};
	await relayMissionControlEvent({
		type: 'task_completed',
		missionId,
		missionName: input.projectName,
		taskName: 'PRD analysis',
		message: 'Canonical PRD analysis result is available.',
		source: 'prd-bridge',
		data: completionData
	});
	if (input.terminal) {
		await relayMissionControlEvent({
			type: 'mission_completed',
			missionId,
			missionName: input.projectName,
			message: 'Spawner produced a canonical PRD analysis result.',
			source: 'prd-bridge',
			data: completionData
		});
	}
}

export function _prdAutoAnalysisWorkingDirectory(requestId: string): string {
	return resolveSparkRunProjectPath(join('prd-auto-analysis', normalizeRequestId(requestId)));
}

async function appendPrdTrace(requestId: string, event: string, details: Record<string, unknown> = {}): Promise<void> {
	try {
		const { prdAutoTraceFile } = getPrdBridgePaths();
		const row = {
			ts: new Date().toISOString(),
			requestId,
			event,
			...details
		};
		await appendFile(prdAutoTraceFile, `${JSON.stringify(row)}\n`, 'utf-8');
	} catch {
		// Never fail request flow on trace write.
	}
}

function traceRefDetails(traceRef: string | null | undefined): Record<string, string> {
	return traceRef ? { traceRef } : {};
}

async function traceRefForRequest(requestId: string, details: Record<string, unknown>): Promise<string | null> {
	const explicit = extractTraceRef(details);
	if (explicit) return explicit;
	try {
		const { spawnerDir } = getPrdBridgePaths();
		const pending = await readPendingRequestRecord(spawnerDir, requestId);
		return pending ? extractTraceRef(pending) : null;
	} catch {
		return null;
	}
}

async function pendingPrdContentForRequest(
	requestId: string,
	paths: Pick<ReturnType<typeof getPrdBridgePaths>, 'spawnerDir' | 'pendingPrdFile'>
): Promise<string> {
	const scoped = await readPendingPrdContent(paths.spawnerDir, requestId);
	if (scoped !== null) return scoped;
	return existsSync(paths.pendingPrdFile) ? await readFile(paths.pendingPrdFile, 'utf-8') : '';
}

export function _buildPrdResultArtifactVerification(
	requestId: string,
	paths: Pick<ReturnType<typeof getPrdBridgePaths>, 'resultsDir'> = getPrdBridgePaths()
): { kind: 'prd_analysis_result'; present: boolean; fileName: string } {
	const safeRequestId = normalizeRequestId(requestId);
	const fileName = `${safeRequestId}.json`;
	return {
		kind: 'prd_analysis_result',
		present: existsSync(join(paths.resultsDir, fileName)),
		fileName
	};
}

type RunnerWritableState = 'yes' | 'no' | 'unknown';

type RunnerCapability = {
	runnerWritable: RunnerWritableState;
	runnerLabel?: string;
	failureReason?: string;
	checkedAt?: string;
};

type ProjectPathEvidence = {
	requestedProjectPath: string | null;
	usedProjectPath: string | null;
	evidenceOnly: boolean;
	rejectedReason: string | null;
};

type AuthorityVerdictV1 = {
	schema_version: 'spark.authority_verdict.v1';
	traceRef?: string;
	actionFamily: 'mission_execution';
	sourcePolicy: string;
	verdict: 'allowed' | 'blocked' | 'confirmation_required';
	confirmationRequired: boolean;
	scope: string;
	expiresAt: string | null;
	sourceRepo: 'spawner-ui';
	reasonCode: string;
};

export function _buildAuthorityVerdict(input: {
	traceRef?: string | null;
	autoStarted: boolean;
	autoProvider: string;
}): AuthorityVerdictV1 {
	const provider = input.autoProvider || 'unknown';
	return {
		schema_version: 'spark.authority_verdict.v1',
		...(input.traceRef ? { traceRef: input.traceRef } : {}),
		actionFamily: 'mission_execution',
		sourcePolicy: 'spawner_prd_bridge_control_auth_rate_limit_auto_provider',
		verdict: input.autoStarted ? 'allowed' : 'blocked',
		confirmationRequired: false,
		scope: 'local_spawner_prd_auto_analysis',
		expiresAt: null,
		sourceRepo: 'spawner-ui',
		reasonCode: input.autoStarted
			? `auto_provider_${provider}_started`
			: `auto_provider_${provider}_not_started`
	};
}

export function _demoteProvisionalPrdDraftResult(
	result: StoredPrdAnalysisResult,
	reason: string
): StoredPrdAnalysisResult {
	const metadata = result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)
		? result.metadata
		: {};
	return {
		...result,
		success: false,
		metadata: {
			...metadata,
			provisional: true,
			canonical: false,
			reason,
			resultAuthority: 'provisional_canvas_draft',
			replacedByProviderResult: false
		}
	};
}

export function _isProvisionalPrdDraftResult(value: unknown): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
		? record.metadata as Record<string, unknown>
		: {};
	return (
		record.success === false &&
		metadata.provisional === true &&
		metadata.canonical === false &&
		metadata.resultAuthority === 'provisional_canvas_draft'
	);
}

function prdResultFile(paths: ReturnType<typeof getPrdBridgePaths>, requestId: string): string {
	return join(paths.resultsDir, `${normalizeRequestId(requestId)}.json`);
}

function provisionalPrdResultFile(paths: ReturnType<typeof getPrdBridgePaths>, requestId: string): string {
	return join(paths.provisionalResultsDir, `${normalizeRequestId(requestId)}.json`);
}

function normalizeRunnerCapability(input: unknown): RunnerCapability | null {
	if (!input || typeof input !== 'object') return null;
	const record = input as Record<string, unknown>;
	const rawWritable = String(record.runnerWritable ?? 'unknown').trim().toLowerCase();
	const runnerWritable: RunnerWritableState =
		rawWritable === 'yes' || rawWritable === 'no' || rawWritable === 'unknown'
			? rawWritable
			: 'unknown';
	const normalized: RunnerCapability = { runnerWritable };
	for (const key of ['runnerLabel', 'failureReason', 'checkedAt'] as const) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) {
			normalized[key] = value.trim();
		}
	}
	return normalized;
}

function normalizeProjectPathEvidence(input: unknown): ProjectPathEvidence | null {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
	const record = input as Record<string, unknown>;
	const requestedProjectPath = typeof record.requestedProjectPath === 'string' && record.requestedProjectPath.trim()
		? record.requestedProjectPath.trim()
		: null;
	const usedProjectPath = typeof record.usedProjectPath === 'string' && record.usedProjectPath.trim()
		? record.usedProjectPath.trim()
		: null;
	const rejectedReason = typeof record.rejectedReason === 'string' && record.rejectedReason.trim()
		? record.rejectedReason.trim()
		: null;
	const evidenceOnly = record.evidenceOnly === true;
	if (!requestedProjectPath && !usedProjectPath && !rejectedReason && !evidenceOnly) return null;
	return {
		requestedProjectPath,
		usedProjectPath,
		evidenceOnly,
		rejectedReason
	};
}

async function updatePendingRequestStatus(
	requestId: string,
	status: 'pending' | 'processed' | 'timeout' | 'fallback' | 'provisional' | 'error',
	extra: Record<string, unknown> = {}
): Promise<void> {
	try {
		const { spawnerDir, pendingRequestFile } = getPrdBridgePaths();
		const current = await readPendingRequestRecord(spawnerDir, requestId);
		if (!current) return;

		const currentAutoAnalysis =
			current.autoAnalysis && typeof current.autoAnalysis === 'object' && !Array.isArray(current.autoAnalysis)
				? (current.autoAnalysis as Record<string, unknown>)
				: null;
		const extraAutoAnalysis =
			extra.autoAnalysis && typeof extra.autoAnalysis === 'object' && !Array.isArray(extra.autoAnalysis)
				? (extra.autoAnalysis as Record<string, unknown>)
				: null;
		const next = {
			...current,
			status,
			updatedAt: new Date().toISOString(),
			...extra,
			...(currentAutoAnalysis || extraAutoAnalysis
				? {
						autoAnalysis: {
							...(currentAutoAnalysis ?? {}),
							...(extraAutoAnalysis ?? {})
						}
					}
				: {})
		};
		const serialized = JSON.stringify(next, null, 2);

		// RequestId-scoped record is the source of truth; the singleton file is
		// only refreshed while it still points at this request (back-compat).
		const scopedFile = pendingRequestFileForRequest(spawnerDir, requestId);
		if (existsSync(scopedFile)) {
			await writeFile(scopedFile, serialized, 'utf-8');
		}
		if (existsSync(pendingRequestFile)) {
			const singleton = parseJsonOrFallback<Record<string, unknown>>(
				await readFile(pendingRequestFile, 'utf-8'),
				{},
				'prd-bridge-write-state'
			);
			if (singleton.requestId === requestId) {
				await writeFileAtomic(pendingRequestFile, serialized);
			}
		}
	} catch {
		// Keep analysis flow alive even if status updates fail.
	}
}

function autoAnalysisDeadline(startedAt: string, timeoutMs: number): string | null {
	const parsed = Date.parse(startedAt);
	if (!Number.isFinite(parsed) || timeoutMs <= 0) return null;
	return new Date(parsed + timeoutMs).toISOString();
}

function slugifyTaskId(value: string, fallback: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return slug || fallback;
}

// Resolve through symlinks so containment comparisons are stable across platforms (e.g.
// macOS exposes os.tmpdir() as /var/folders/... which is a symlink to /private/var/...).
// The target folder usually does not exist yet, so we canonicalize the nearest existing
// ancestor and re-append the missing trailing segments — otherwise a not-yet-created
// target would compare as /var/... against a /private/var/... realpath'd root.
function canonicalize(candidatePath: string): string {
	const absolute = resolve(candidatePath);
	const missing: string[] = [];
	let cursor = absolute;
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) return absolute;
		missing.unshift(basename(cursor));
		cursor = parent;
	}
	try {
		return resolve(realpathSync(cursor), ...missing);
	} catch {
		return absolute;
	}
}

// A target folder is in-workspace when it sits under one of the Spark-controlled roots:
// the configured Spark workspace root or the spawner state directory. We intentionally do
// NOT use process.cwd() (the SvelteKit app root) — the spawner writes generated projects
// and static proofs under its own state/workspace tree, not under the server source tree.
// The SPARK_ALLOW_EXTERNAL_PROJECT_PATHS escape hatch keeps trusted local-dev flows working.
function isPathWithinWorkspace(candidatePath: string): boolean {
	if (externalProjectPathsAllowed()) return true;
	const resolvedCandidate = canonicalize(candidatePath);
	const allowedRoots = [sparkWorkspaceRoot(), spawnerStateDir()]
		.filter((root): root is string => Boolean(root && root.trim()))
		.map((root) => canonicalize(root));
	return allowedRoots.some(
		(root) => resolvedCandidate === root || isWithinDirectory(root, resolvedCandidate)
	);
}

// A Windows drive-letter path (C:\...) on a POSIX host — or a POSIX-absolute path on a
// Windows host — denotes the user's own machine build location, not a path on this server.
// It cannot reference a server file (resolve() would mangle it under cwd), so it is preserved
// verbatim as the declared OS target rather than run through the server workspace guard, which
// matches inferProjectPathFromPrdLoad's treatment of explicit project paths.
function isForeignOsAbsolutePath(candidate: string): boolean {
	const looksWindows = /^[A-Za-z]:[\\/]/.test(candidate);
	const looksPosix = candidate.startsWith('/');
	return process.platform === 'win32' ? looksPosix : looksWindows;
}

function extractTargetFolder(content: string): string | null {
	const candidate = extractExplicitProjectPath(content);
	if (!candidate) return null;
	// Explicit foreign-OS target paths are the user's declared build location; keep them as-is.
	if (isForeignOsAbsolutePath(candidate)) return candidate;
	const resolved = resolve(candidate);
	if (!isPathWithinWorkspace(resolved)) {
		logger.warn('[prd-bridge-write] Rejected target folder outside workspace', { candidate, resolved });
		return null;
	}
	return resolved;
}

function extractRequestedFiles(content: string): string[] {
	const fileNames = new Set<string>();
	const filePattern = /\b[\w.-]+\.(?:html|css|js|ts|tsx|json|md|py|svelte|vue|jsx)\b/gi;
	for (const match of content.matchAll(filePattern)) {
		fileNames.add(match[0]);
	}
	return [...fileNames].slice(0, 12);
}

function isConstrainedSingleFileStaticHtml(content: string): boolean {
	const lower = content.toLowerCase();
	const namesIndex = /\bindex\.html\b/.test(lower);
	const namesReadme = /\breadme\.md\b/.test(lower);
	const oneFileOnly = /\b(?:one|single)[-\s]?file\s+only\b|\bonly\s+(?:one|a\s+single)\s+file\b/.test(lower);
	const oneFileNamedIndex = /\b(?:one|single)[-\s]?file\s*(?:,|:|called|named|as)?\s*index\.html\b/.test(lower);
	const exactlyTwoFiles = hasExactTwoFileProofIntent(lower);
	const staticHtmlOnly = /\bstatic\s+html\s+only\b|\bkeep\s+it\s+as\s+static\s+html\b|\bstatic\s+file\s+only\b/.test(lower);
	const noPackage = /\bdo\s+not\s+(?:add|create)\s+package(?:\.json)?\b|\bno\s+package(?:\.json| files?)?\b/.test(lower);
	const forbidsFullApp = /\bdo\s+not\s+(?:make|build|create)\s+(?:a\s+)?full\s+app\b|\bdon't\s+(?:make|build|create)\s+(?:a\s+)?full\s+app\b/.test(lower);
	const forbidsExtraFiles = hasExtraFileDenial(lower);
	return namesIndex && (
		oneFileOnly ||
		oneFileNamedIndex ||
		forbidsFullApp ||
		(staticHtmlOnly && noPackage) ||
		(namesReadme && exactlyTwoFiles && forbidsExtraFiles)
	);
}

function constrainedStaticDeliverableFiles(content: string): string[] {
	const lower = content.toLowerCase();
	if (/\bindex\.html\b/.test(lower) && /\breadme\.md\b/.test(lower) && hasExactTwoFileProofIntent(lower)) {
		return ['index.html', 'README.md'];
	}
	return ['index.html'];
}

function extractStaticProofVisibleRequirements(content: string): { marker: string | null; sentence: string | null } {
	const marker =
		content.match(/\bSPARK_OS_[A-Z0-9_]+\b/)?.[0] ??
		content.match(/\b[A-Z][A-Z0-9_]{2,}_OK\b/)?.[0] ??
		null;
	const sentence =
		content.match(/\bexact\s+sentence\s+"([^"\r\n]{1,200})"/i)?.[1] ??
		content.match(/\bsentence\s+"([^"\r\n]{1,200})"/i)?.[1] ??
		null;
	return { marker, sentence };
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

async function writeConstrainedStaticProofArtifacts(content: string): Promise<number> {
	if (!isConstrainedSingleFileStaticHtml(content)) return 0;
	const targetFolder = extractTargetFolder(content);
	const deliverableFiles = constrainedStaticDeliverableFiles(content);
	if (!targetFolder || deliverableFiles.join(',') !== 'index.html,README.md') return 0;

	const { marker, sentence } = extractStaticProofVisibleRequirements(content);
	if (!marker && !sentence) return 0;

	await mkdir(targetFolder, { recursive: true });
	const markerHtml = marker ? `<p class="marker">${escapeHtml(marker)}</p>` : '';
	const sentenceHtml = sentence ? `<p class="sentence">${escapeHtml(sentence)}</p>` : '';
	const indexHtml = [
		'<!doctype html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<title>Spawner Trace Parity Proof</title>',
		'<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Arial,sans-serif;background:#101318;color:#f6f7fb}.proof{max-width:720px;padding:32px;border:1px solid #3b4252}.marker{font-family:monospace;color:#7dd3fc}.sentence{font-size:1.25rem}</style>',
		'</head>',
		'<body>',
		'<main class="proof">',
		'<h1>Spawner Trace Parity Proof</h1>',
		markerHtml,
		sentenceHtml,
		'</main>',
		'</body>',
		'</html>'
	].join('\n');
	const readme = [marker, sentence].filter(Boolean).join('\n\n') + '\n';
	await writeFile(join(targetFolder, 'index.html'), indexHtml, 'utf-8');
	await writeFile(join(targetFolder, 'README.md'), readme, 'utf-8');
	return 2;
}

function hasExactTwoFileProofIntent(lower: string): boolean {
	const saysExactly = /\bexactly\b/.test(lower);
	const saysTwo = /\b(?:two|2)\b/.test(lower);
	const saysFiles = /\bfiles?\b/.test(lower);
	return (
		/\bexactly\b[\s\S]{0,120}\b(?:two|2)\b[\s\S]{0,120}\bfiles?\b/.test(lower) ||
		/\b(?:two|2)\b[\s\S]{0,120}\bfiles?\b[\s\S]{0,120}\bno\s+(?:others|other\s+files)\b/.test(lower) ||
		(saysExactly && saysTwo && saysFiles && /\bindex\.html\b/.test(lower) && /\breadme\.md\b/.test(lower))
	);
}

function hasExtraFileDenial(lower: string): boolean {
	return (
		/\bno\s+others\b|\bno\s+other\s+files?\b|\bno\s+extra\s+files?\b/.test(lower) ||
		/\bdo\s+not\s+create\b[\s\S]{0,160}\b(?:app\.js|styles\.css|package\.json|assets|folders?|extra\s+files?)\b/.test(lower) ||
		/\bdo\s+not\s+(?:publish|deploy|install\s+packages|make\s+network\s+calls)\b/.test(lower)
	);
}

function isSingleFileStaticHtmlApp(content: string): boolean {
	const lower = content.toLowerCase();
	return (
		/\b(?:one|single)[-\s]?(?:static\s+)?html\s+file\b/.test(lower) ||
		/\bplayable\s+in\s+(?:one|a\s+single)\s+static\s+html\s+file\b/.test(lower) ||
		/\b(?:one|single)[-\s]?file\s+(?:static\s+)?(?:(?:html|web)\s+)?(?:app|game|tool|page)\b/.test(lower)
	);
}

function inferTechStack(content: string): { framework: string; language: string; styling: string; deployment: string } {
	const lower = content.toLowerCase();
	if (isSingleFileStaticHtmlApp(content)) {
		return {
			framework: 'Single-file static HTML',
			language: 'HTML with embedded CSS and JavaScript',
			styling: 'Embedded CSS in index.html',
			deployment: 'Direct browser-open static file'
		};
	}
	if (lower.includes('three.js') || lower.includes('threejs') || /\b(?:3d|webgl|three-dimensional)\b/.test(lower)) {
		return {
			framework: 'Vanilla JavaScript + Three.js',
			language: 'JavaScript',
			styling: 'CSS',
			deployment: 'Static file hosting'
		};
	}
	if (lower.includes('vanilla-js') || lower.includes('vanilla js') || lower.includes('no build step')) {
		return {
			framework: 'Vanilla JavaScript',
			language: 'JavaScript',
			styling: 'CSS',
			deployment: 'Direct static launch'
		};
	}
	if (lower.includes('svelte')) {
		return {
			framework: 'SvelteKit',
			language: 'TypeScript',
			styling: 'CSS',
			deployment: 'Node adapter or static deployment'
		};
	}
	return {
		framework: 'Web app',
		language: 'TypeScript or JavaScript',
		styling: 'CSS',
		deployment: 'Local development server'
	};
}

export async function _buildFallbackAnalysisResult(
	requestId: string,
	projectName: string,
	buildMode: 'direct' | 'advanced_prd',
	tier: SkillTier,
	paths: ReturnType<typeof getPrdBridgePaths>,
	buildLane: BuildLane = buildMode === 'advanced_prd' ? 'advanced_prd' : 'direct'
): Promise<Record<string, unknown>> {
	const content = await pendingPrdContentForRequest(requestId, paths);
	if (isSparseUnderstandingClarification(content)) {
		const validSkills = new Set((await getTierSkills(tier)).map((skill) => skill.id));
		const selectSkills = (skills: string[]) => skills.filter((skill) => validSkills.has(skill)).slice(0, 5);
		const tasks = [
			{
				id: 'task-1-acknowledge-understanding',
				title: 'Acknowledge the understanding check',
				summary: 'Confirm Spark understood the user is asking whether the previous message was understood.',
				description: 'Render a concise acknowledgement without inventing product scope or pretending missing build details were supplied.',
				skills: selectSkills(['conversation-memory', 'ux-design', 'product-discovery', 'prompt-engineer']),
				dependencies: [] as string[],
				workspaceTargets: [],
				acceptanceCriteria: [
					'The original request text is preserved exactly.',
					'The response states that Spark understood the user is asking whether the previous message was understood.',
					'No MVP, auth, payment, database, or unrelated product features are added.'
				],
				verificationCommands: ['npm run check']
			},
			{
				id: 'task-2-ask-for-actionable-details',
				title: 'Ask for the missing build details',
				summary: 'Prompt for the concrete audience, workflow, saved memory, and vibe details needed before building.',
				description: 'Keep the follow-up small and actionable so the user can continue the PRD flow.',
				skills: selectSkills(['product-discovery', 'structured-output', 'conversation-memory', 'workflow-automation']),
				dependencies: [] as string[],
				workspaceTargets: [],
				acceptanceCriteria: [
					'The user can continue by supplying audience, core workflow, saved memory, and vibe.',
					'The task remains a clarification workflow rather than a manufactured build plan.'
				],
				verificationCommands: ['npm run smoke:routes']
			}
		];
		const skills = [...new Set(tasks.flatMap((task) => task.skills))];
		return {
			requestId,
			success: true,
			projectName,
			projectType: 'clarification-understanding',
			complexity: 'simple',
			infrastructure: {
				needsAuth: false,
				authReason: 'No authentication is needed to acknowledge an understanding check.',
				needsDatabase: false,
				databaseReason: 'No new database scope was supplied.',
				needsAPI: false,
				apiReason: 'No backend API was requested.'
			},
			techStack: {
				framework: 'Existing Spawner UI',
				language: 'TypeScript',
				styling: 'Existing UI styles',
				deployment: 'Existing application'
			},
			tasks,
			skills,
			executionPrompt:
				'Original user request: did you understand what i said\n\nAcknowledge that Spark understood the user is asking whether the previous message was understood, then ask for the missing concrete build details: audience, core workflow, saved memory, and vibe. Do not invent product scope.'
		};
	}

	const targetFolder = extractTargetFolder(content);
	const requestedFiles = extractRequestedFiles(content);
	const techStack = inferTechStack(content);
	const lower = content.toLowerCase();
	if (isConstrainedSingleFileStaticHtml(content)) {
		const validSkills = new Set((await getTierSkills(tier)).map((skill) => skill.id));
		const selectSkills = (skills: string[]) => skills.filter((skill) => validSkills.has(skill)).slice(0, 5);
		const workspaceTargets = targetFolder ? [targetFolder] : [];
		const deliverableFiles = constrainedStaticDeliverableFiles(content);
		const deliverableList = deliverableFiles.join(', ');
		const tasks = [
			{
				id: 'task-1-create-static-files',
				title: 'Create Exact Static Files',
				summary: `Create exactly ${deliverableList} with the requested visible copy and minimal embedded styling.`,
				description:
					'Keep the deliverable to the explicitly requested static files. Do not add package files, app shell behavior, persistence, scripts, navigation, extra controls, or generated assets unless the brief explicitly asks for them.',
				skills: selectSkills(['frontend-engineer', 'html-css', 'accessibility']),
				dependencies: [] as string[],
				workspaceTargets,
				acceptanceCriteria: [
					`Only ${deliverableList} are required for the deliverable.`,
					'The requested heading and body text are preserved exactly.',
					'The page opens directly as static HTML without npm, a dev server, or a build step.',
					'No package.json, node_modules, JavaScript app shell, localStorage workflow, checklist UI, dashboard, navigation, or extra product features are added.'
				],
				verificationCommands: [
					...deliverableFiles.map((file) => `test -f ${file}`),
					'test ! -f package.json',
					'test ! -f app.js',
					'test ! -f styles.css',
					'test ! -d node_modules'
				]
			},
			{
				id: 'task-2-verify-static-contract',
				title: 'Verify Exact Static Contract',
				summary: `Confirm the final workspace contains exactly ${deliverableList} and no app expansion.`,
				description:
					'Run lightweight checks that prove the prompt stayed constrained: exact required files, exact visible copy, no package files, no runtime dependency, and no extra app functionality.',
				skills: selectSkills(['qa-engineering', 'testing-strategies', 'accessibility']),
				dependencies: ['task-1-create-static-files'],
				workspaceTargets,
				acceptanceCriteria: [
					`${deliverableList} exist at the workspace root.`,
					'The requested strings appear in the rendered document.',
					'No build tooling or extra project files are needed.',
					'The result is a static confirmation page rather than a full app.'
				],
				verificationCommands: [
					...deliverableFiles.map((file) => `test -f ${file}`),
					'test ! -f package.json',
					'test ! -f app.js',
					'test ! -f styles.css',
					'test ! -d node_modules',
					'grep -i "<h1" index.html',
					'grep -i "<script" index.html && exit 1 || true'
				]
			}
		];
		const skills = [...new Set(tasks.flatMap((task) => task.skills))];
		return {
			requestId,
			success: true,
			projectName,
			projectType: deliverableFiles.length === 1 ? 'static-single-file-html' : 'static-exact-file-proof',
			complexity: 'simple',
			infrastructure: {
				needsAuth: false,
				authReason: 'No authentication is needed for a static single-file page.',
				needsDatabase: false,
				databaseReason: 'The user explicitly constrained the build to static HTML.',
				needsAPI: false,
				apiReason: 'No backend API was requested.'
			},
			techStack: {
				framework: 'Static HTML',
				language: 'HTML and CSS',
				styling: 'Embedded CSS in index.html',
				deployment: 'Direct browser-open static file'
			},
			tasks,
			skills,
			executionPrompt: [
				'Implement the user request as a constrained static-file build.',
				`Create exactly these files in the workspace root: ${deliverableList}.`,
				'Preserve the requested visible copy exactly.',
				'Use minimal embedded CSS only.',
				'Do not create any other files, package files, JavaScript workflow, localStorage persistence, checklist UI, dashboard, navigation, or extra product features.',
				'Original brief:',
				content
			].join('\n')
		};
	}
	const singleFileStaticApp = isSingleFileStaticHtmlApp(content);
	const isStaticApp =
		singleFileStaticApp ||
		lower.includes('no build step') ||
		lower.includes('vanilla-js') ||
		lower.includes('vanilla js');
	const isThree = lower.includes('three.js') || lower.includes('threejs') || /\b(?:3d|webgl|three-dimensional)\b/.test(lower);
	const isGame = /\b(game|maze|puzzle|arcade|runner|platformer|rpg|quest|level|player|score|enemy|boss)\b/.test(lower);
	const isDashboard = /\b(dashboard|metrics?|analytics|monitor|tracker|report|board)\b/.test(lower);
	const isTokenOrNftLaunch = /\b(token|nft|mint|treasury|liquidity|holders?|launch|sale)\b/.test(lower);
	const isFastDirectLane = buildLane === 'fast_direct';
	const isFastStaticOrSmoke =
		isFastDirectLane &&
		!isGame &&
		!isDashboard &&
		(isStaticApp || /\b(?:tiny|small|simple|fast|smoke|one[-\s]?screen|one[-\s]?file|static\s+page)\b/.test(lower));
	const validSkills = new Set((await getTierSkills(tier)).map((skill) => skill.id));
	const selectSkills = (skills: string[]) => skills.filter((skill) => validSkills.has(skill)).slice(0, 5);
	const workspaceTargets = targetFolder ? [targetFolder] : [];
	const effectiveRequestedFiles =
		singleFileStaticApp && requestedFiles.length === 0 ? ['index.html'] : requestedFiles;
	const fileList = effectiveRequestedFiles.length > 0 ? effectiveRequestedFiles.join(', ') : 'the requested project files';
	const visibleRequirements = extractStaticProofVisibleRequirements(content);
	const visibleMarkerCriterion = visibleRequirements.marker
		? `The first screen visibly includes the exact marker "${visibleRequirements.marker}".`
		: 'The first screen opens directly and shows the requested marker or core copy.';
	const visibleMarkerSummary = visibleRequirements.marker
		? `Create only ${fileList} with embedded CSS and JavaScript, visibly render the exact marker "${visibleRequirements.marker}", wire one simple interaction, then verify the tiny file-scope checks.`
		: `Create only ${fileList} with embedded CSS and JavaScript, preserve the requested visible marker and one simple interaction, then verify the tiny file-scope checks.`;

	const shellVerification = targetFolder
		? [`Test-Path '${targetFolder}'`, `Get-ChildItem '${targetFolder}' | Select-Object -ExpandProperty Name`]
		: singleFileStaticApp
			? ['test -f index.html', 'test ! -f styles.css', 'test ! -f app.js', 'test ! -f package.json']
			: ['Inspect the created project files.'];
	const scriptVerification = targetFolder
		? [`Select-String -Path '${targetFolder}\\app.js' -Pattern 'localStorage'`]
		: singleFileStaticApp
			? ['grep -i "<script" index.html', 'grep -i "<style" index.html']
			: ['Run the project interaction smoke test.'];
	const finalVerification = targetFolder
		? [
				...(effectiveRequestedFiles.includes('app.js') ? [`node --check '${targetFolder}\\app.js'`] : []),
				`Get-ChildItem '${targetFolder}' | Select-Object -ExpandProperty Name`
			]
		: singleFileStaticApp
			? ['test -f index.html', 'test ! -f styles.css', 'test ! -f app.js', 'test ! -f package.json']
			: ['Run the repo-local verification commands.'];

	const taskSpecs = isFastStaticOrSmoke
		? [
				{
					title: singleFileStaticApp ? 'Build and check the single-file static page' : 'Build and check the focused static page',
					summary: singleFileStaticApp
						? visibleMarkerSummary
						: 'Create the requested fast static page with the smallest useful file set and one clear interaction, then verify the quick smoke checks.',
					skills: selectSkills(['frontend-engineer', 'html-css', 'qa-engineering', 'accessibility']),
					dependencies: [] as string[],
					acceptanceCriteria: [
						visibleMarkerCriterion,
						'The requested button or tiny interaction works without a framework or heavy setup.',
						'No extra product scope, dashboard sections, persistence layer, or generated feature set is added.',
						...(singleFileStaticApp
							? [
									'Only index.html is required for the runnable deliverable.',
									'CSS and JavaScript are embedded in index.html instead of split into styles.css or app.js.',
									'No package.json, styles.css, app.js, or build step is required.'
								]
							: [])
					],
					verificationCommands: [
						...finalVerification,
						...(visibleRequirements.marker ? [`grep -F "${visibleRequirements.marker}" index.html`] : [])
					]
				}
			]
		: isGame
		? [
				{
					title: singleFileStaticApp ? 'Create the playable game file' : 'Create the playable game shell',
					summary: singleFileStaticApp
						? `Create only ${fileList} with embedded CSS and JavaScript, preserving the requested game premise and controls.`
						: `Set up ${fileList} so the player lands directly in the requested game loop.`,
					skills: selectSkills(
						isThree
							? ['frontend-engineer', 'threejs-3d-graphics', 'game-development', 'game-ui-design', 'responsive-mobile-first']
							: ['frontend-engineer', 'game-development', 'game-ui-design', 'responsive-mobile-first']
					),
					dependencies: [] as string[],
					acceptanceCriteria: [
						'The first screen is playable, not a landing page or project explainer.',
						'The requested game premise, player goal, controls, and win/fail states are visible in the build.',
						'Keyboard controls and mobile-friendly controls are present when requested.',
						...(singleFileStaticApp
							? [
									'Only index.html is required for the deliverable.',
									'CSS and JavaScript are embedded in index.html instead of split into styles.css or app.js.'
								]
							: [])
					],
					verificationCommands: shellVerification
				},
				{
					title: 'Design the core play and reasoning loop',
					summary:
						'Implement the main rule system, puzzle or challenge logic, feedback loop, and the reason the game is interesting to replay.',
					skills: selectSkills(['game-design', 'game-design-core', 'puzzle-design', 'procedural-generation', 'level-design']),
					dependencies: ['task-1'],
					acceptanceCriteria: [
						'The game has a clear decision loop instead of only movement or clicking.',
						'The challenge changes or escalates enough to test player reasoning.',
						'The player can understand why they won, lost, or improved.'
					],
					verificationCommands: scriptVerification
				},
				{
					title: 'Add scoring, restart, and player feedback',
					summary:
						'Wire score/progress, timer or move count, restart, completion feedback, and any local best-score persistence requested by the brief.',
					skills: selectSkills(['state-management', 'game-ui-design', 'player-onboarding', 'accessibility']),
					dependencies: ['task-1', 'task-2'],
					acceptanceCriteria: [
						'Score, progress, or reasoning feedback updates during play.',
						'Restart works without refreshing the whole page.',
						'The player can recover from failure and replay quickly.'
					],
					verificationCommands: scriptVerification
				},
				{
					title: 'Verify the playable loop',
					summary:
						'Prove movement, challenge logic, win/fail, restart, responsive controls, and static-file constraints where applicable.',
					skills: selectSkills(['qa-engineering', 'testing-strategies', 'accessibility']),
					dependencies: ['task-2', 'task-3'],
					acceptanceCriteria: [
						'The full game can be completed manually from a fresh load.',
						'The failure or retry path works.',
						'Desktop and mobile input paths are both usable.',
						...(singleFileStaticApp ? ['The final workspace does not require styles.css, app.js, package.json, or a build step.'] : [])
					],
					verificationCommands: finalVerification
				}
			]
		: isDashboard && isTokenOrNftLaunch
			? [
					{
						title: 'Model the token and NFT launch signals',
						summary:
							'Define seeded launch data for token-only mint ideas, treasury split notes, utility perks, timing, and health states.',
						skills: selectSkills(['tokenomics-design', 'nft-systems', 'analytics', 'product-strategy', 'data-dashboard-design']),
						dependencies: [] as string[],
						acceptanceCriteria: [
							'The dashboard data model includes token demand, NFT mint, treasury, utility, and timing signals.',
							'Sample data is clearly marked when live data is not supplied.',
							'The first-screen metrics answer a real launch decision, not generic dashboard filler.'
						],
						verificationCommands: shellVerification
					},
					{
						title: 'Build the launch decision dashboard',
						summary:
							'Create the main scan surface with metric cards, scenario sections, filters, and clear status for launch readiness.',
						skills: selectSkills(['frontend-engineer', 'data-dashboard-design', 'ui-design', 'responsive-mobile-first']),
						dependencies: ['task-1'],
						acceptanceCriteria: [
							'The top summary makes the fastest launch decision obvious.',
							'Token-only mint, treasury split, utility perks, and post-launch timing each have a readable section.',
							'The layout stays dense but calm on desktop and mobile.'
						],
						verificationCommands: scriptVerification
					},
					{
						title: 'Add scenario controls and warning states',
						summary:
							'Implement filters, scenario notes, verification states, and warnings for risky claims such as guaranteed price impact.',
						skills: selectSkills(['state-management', 'product-analytics-engineering', 'risk-management-trading', 'copywriting']),
						dependencies: ['task-1', 'task-2'],
						acceptanceCriteria: [
							'Users can compare at least two launch scenarios or timing states.',
							'Risky financial/price-impact framing is softened into decision support.',
							'Empty or unknown data states are visible instead of pretending certainty.'
						],
						verificationCommands: scriptVerification
					},
					{
						title: 'Verify launch dashboard quality',
						summary:
							'Check data labels, responsive layout, scenario controls, warning states, and the documented manual smoke path.',
						skills: selectSkills(['qa-engineering', 'testing-strategies', 'accessibility', 'technical-writer']),
						dependencies: ['task-2', 'task-3'],
						acceptanceCriteria: [
							'Every visible metric maps back to seeded or live data.',
							'The dashboard never presents sample data as live financial proof.',
							'Manual smoke steps cover filters, scenario changes, responsive layout, and warning states.'
						],
						verificationCommands: finalVerification
					}
				]
			: [
					{
						title: singleFileStaticApp
							? 'Create the single-file static app'
							: isStaticApp
								? 'Create the static app shell'
								: 'Create the app shell and project structure',
						summary: singleFileStaticApp
							? `Create only ${fileList} with embedded CSS and JavaScript, preserving the requested product, domain, and interaction constraints.`
							: `Set up ${fileList} and make the first screen match the requested product direction.`,
						skills: selectSkills(['frontend-engineer', 'html-css', 'ui-design', 'responsive-mobile-first']),
						dependencies: [] as string[],
						acceptanceCriteria: [
							'The project opens to a usable first screen.',
							'Requested files and local project structure are present.',
							'No unrelated framework or build tooling is added when the brief says no build step.',
							...(singleFileStaticApp
								? [
										'Only index.html is required for the deliverable.',
										'CSS and JavaScript are embedded in index.html instead of split into styles.css or app.js.',
										'The explicit product/game/tool concept in the original brief is preserved.'
									]
								: [])
						],
						verificationCommands: shellVerification
					},
					{
						title: isThree ? 'Implement the interactive 3D scene and controls' : 'Implement the core interaction and state',
						summary: isThree
							? 'Build the animated Three.js experience, primary controls, and responsive fallback behavior.'
							: 'Build the main user flow, controls, live status/progress, persistence, and reset or completion behavior.',
						skills: selectSkills(
							isThree
								? ['frontend-engineer', 'threejs-3d-graphics', 'ui-design', 'responsive-mobile-first']
								: ['frontend-engineer', 'ui-design', 'responsive-mobile-first', 'state-management']
						),
						dependencies: ['task-1'],
						acceptanceCriteria: [
							'The core workflow can be completed from the first screen.',
							'Interactive state updates immediately and persists where requested.',
							'Controls remain usable on desktop and mobile widths.',
							...(singleFileStaticApp ? ['The requested interaction is implemented inside index.html.'] : [])
						],
						verificationCommands: scriptVerification
					},
					{
						title: 'Polish the visual system and documentation',
						summary: 'Finish the dark operational UI, responsive details, accessibility basics, and README smoke test.',
						skills: selectSkills(['ui-design', 'accessibility', 'technical-writer', 'documentation-that-slaps']),
						dependencies: ['task-1'],
						acceptanceCriteria: [
							'The UI is readable, responsive, and visually consistent.',
							'README explains direct launch and a manual smoke test.',
							'The implementation documents any fallback or browser requirement.',
							...(singleFileStaticApp ? ['Any README is optional; the runnable app remains self-contained in index.html.'] : [])
						],
						verificationCommands: targetFolder
							? [`Test-Path '${targetFolder}\\README.md'`, `Get-Content '${targetFolder}\\README.md'`]
							: ['Read the README and perform the documented smoke test.']
					},
					{
						title: 'Verify the completed build',
						summary: 'Run the requested lightweight checks and confirm the finished project matches the brief.',
						skills: selectSkills(['qa-engineering', 'testing-strategies', 'test-architect']),
						dependencies: ['task-2', 'task-3'],
						acceptanceCriteria: [
							'Static syntax checks pass where applicable.',
							'The requested completion state or primary success path works.',
							'The final project can be opened locally.',
							...(singleFileStaticApp ? ['The final workspace does not require styles.css, app.js, package.json, or a build step.'] : [])
						],
						verificationCommands: finalVerification
					}
				];

	const tasks = taskSpecs.map((task, index) => {
		const id = slugifyTaskId(task.title, `task-${index + 1}`);
		const dependencyIds = task.dependencies.map((dependency, depIndex) => {
			if (dependency === 'task-1') return slugifyTaskId(taskSpecs[0].title, 'task-1');
			if (dependency === 'task-2') return slugifyTaskId(taskSpecs[1].title, 'task-2');
			if (dependency === 'task-3') return slugifyTaskId(taskSpecs[2].title, 'task-3');
			return slugifyTaskId(dependency, `task-${depIndex + 1}`);
		});
		return {
			id,
			title: task.title,
			summary: task.summary,
			description: task.summary,
			skills: task.skills.length > 0 ? task.skills : selectSkills(['frontend-engineer']),
			dependencies: dependencyIds,
			workspaceTargets,
			acceptanceCriteria: task.acceptanceCriteria,
			verificationCommands: task.verificationCommands
		};
	});

	const skills = [...new Set(tasks.flatMap((task) => task.skills as string[]))];

	return {
		requestId,
		success: true,
		projectName,
		projectType: singleFileStaticApp ? 'single-file-static-web-app' : isStaticApp ? 'static-web-app' : 'web-app',
		complexity: buildMode === 'advanced_prd' ? 'moderate' : 'simple',
		infrastructure: {
			needsAuth: false,
			authReason: 'Not requested for v1.',
			needsDatabase: false,
			databaseReason: 'Use local files/browser persistence for v1 unless the brief requires a backend.',
			needsAPI: false,
			apiReason: 'No backend API required by the brief.'
		},
		techStack,
		tasks,
		skills,
		executionPrompt: [
			`Build ${projectName} from the original user brief.`,
			'Preserve explicit product/domain requirements, named title, file constraints, gameplay or workflow details, no-build requirements, persistence requirements, and smoke-test requirements.',
			singleFileStaticApp
				? 'Hard file constraint: create only index.html as the runnable deliverable; embed CSS and JavaScript in that file and do not split into styles.css or app.js unless the original brief explicitly asks for separate files.'
				: '',
			'Original brief:',
			content
		]
			.filter(Boolean)
			.join('\n')
	};
}

async function writeFallbackAnalysisResult(
	requestId: string,
	projectName: string,
	buildMode: 'direct' | 'advanced_prd',
	tier: SkillTier,
	reason: string,
	traceRef?: string | null,
	buildLane?: BuildLane,
	options: { provisional?: boolean } = {}
): Promise<void> {
	const paths = getPrdBridgePaths();
	const canonicalResultFile = prdResultFile(paths, requestId);
	const outputFile = options.provisional ? provisionalPrdResultFile(paths, requestId) : canonicalResultFile;
	if (existsSync(canonicalResultFile)) return;
	if (options.provisional && existsSync(outputFile)) return;

	const outputDir = options.provisional ? paths.provisionalResultsDir : paths.resultsDir;
	if (!existsSync(outputDir)) {
		await mkdir(outputDir, { recursive: true });
	}

	const result = await _buildFallbackAnalysisResult(requestId, projectName, buildMode, tier, paths, buildLane);
	if (options.provisional && existsSync(canonicalResultFile)) return;
	const resolvedTraceRef = traceRef || await traceRefForRequest(requestId, {});
	const resultWithTrace = resolvedTraceRef
		? { ...result, traceRef: resolvedTraceRef, metadata: { ...((result as Record<string, unknown>).metadata as Record<string, unknown> | undefined), traceRef: resolvedTraceRef } }
		: result;
	const stored = await projectStoredPrdAnalysisResultForTier(requestId, resultWithTrace, tier);
	const output = options.provisional ? _demoteProvisionalPrdDraftResult(stored, reason) : stored;
	await writeFile(outputFile, JSON.stringify(output, null, 2), 'utf-8');
	const staticArtifactCount = options.provisional
		? 0
		: await writeConstrainedStaticProofArtifacts(await pendingPrdContentForRequest(requestId, paths).catch(() => ''));
	if (!options.provisional && staticArtifactCount > 0) {
		await appendPrdTrace(requestId, 'deterministic_static_artifacts_written', {
			...traceRefDetails(resolvedTraceRef),
			fileCount: staticArtifactCount
		});
	}
	await appendPrdTrace(requestId, options.provisional ? 'provisional_analysis_written' : 'fallback_analysis_written', {
		...traceRefDetails(resolvedTraceRef),
		reason,
		resultFile: outputFile,
		taskCount: Array.isArray(result.tasks) ? result.tasks.length : 0
	});
}

function scheduleProvisionalPrdDraft(input: {
	requestId: string;
	missionId: string;
	projectName: string;
	buildMode: 'direct' | 'advanced_prd';
	buildLane: BuildLane;
	constrainedStaticSingleFile?: boolean;
	tier: SkillTier;
	traceRef?: string | null;
}): void {
	const delayMs = _provisionalPrdDraftDelayMs({
		buildMode: input.buildMode,
		buildLane: input.buildLane,
		constrainedStaticSingleFile: input.constrainedStaticSingleFile === true
	});
	if (delayMs === null) return;

	const timer = setTimeout(async () => {
		const paths = getPrdBridgePaths();
		const resultFile = prdResultFile(paths, input.requestId);
		if (existsSync(resultFile)) {
			await appendPrdTrace(input.requestId, 'provisional_canvas_skipped', {
				...traceRefDetails(input.traceRef),
				reason: 'analysis result already exists',
				delayMs
			});
			return;
		}

		await updatePendingRequestStatus(input.requestId, 'provisional', {
			reason: 'Canonical PRD analysis is still running; provisional canvas draft is advisory and non-executable.',
			provisionalCanvasAt: new Date().toISOString(),
			provisionalDelayMs: delayMs
		});
		await appendPrdTrace(input.requestId, 'provisional_canvas_due', {
			...traceRefDetails(input.traceRef),
			delayMs,
			buildMode: input.buildMode,
			buildLane: input.buildLane
		});
		await writeFallbackAnalysisResult(
			input.requestId,
			input.projectName,
			input.buildMode,
			input.tier,
			`advisory provisional canvas draft after ${delayMs}ms while canonical PRD analysis continues`,
			input.traceRef,
			input.buildLane,
			{ provisional: true }
		);
		await relayMissionControlEvent({
			type: 'log',
			missionId: input.missionId,
			missionName: input.projectName,
			taskName: 'PRD draft',
			message: 'Advisory PRD draft ready; waiting for canonical provider result before execution.',
			source: 'prd-bridge',
			data: {
				requestId: input.requestId,
				...traceRefDetails(input.traceRef),
				buildMode: input.buildMode,
				buildLane: input.buildLane,
				provisional: true
			}
		});
	}, delayMs);

	if (typeof timer.unref === 'function') {
		timer.unref();
	}
}

export async function _runAutoAnalysisWatchdog(input: {
	requestId: string;
	projectName: string;
	buildMode: 'direct' | 'advanced_prd';
	tier: SkillTier;
	cancelAutoAnalysis?: () => void;
	traceRef?: string | null;
	buildLane?: BuildLane;
	timeoutMs?: number;
}): Promise<void> {
	const {
		requestId,
		projectName,
		buildMode,
		tier,
		cancelAutoAnalysis,
		traceRef,
		buildLane,
		timeoutMs = AUTO_ANALYSIS_TIMEOUT_MS
	} = input;
	const paths = getPrdBridgePaths();
	const resultFile = prdResultFile(paths, requestId);
	const provisionalResultFile = provisionalPrdResultFile(paths, requestId);
	const hasResult = existsSync(resultFile);
	const provisionalDraftAvailable = existsSync(provisionalResultFile);
	if (hasResult) {
		await updatePendingRequestStatus(requestId, 'processed', {
			reason: 'Canonical provider result is available.',
			autoAnalysis: {
				status: 'complete',
				finishedAt: new Date().toISOString(),
				success: true,
				canonicalResultAvailable: true,
				resultFileName: `${normalizeRequestId(requestId)}.json`,
				expectedResultFile: resultFile,
				provisionalResultFile,
				provisionalDraftAvailable
			}
		});
		await relayCanonicalPrdAnalysisComplete({
			requestId,
			projectName,
			buildMode,
			buildLane,
			traceRef,
			provider: 'codex',
			resultFileName: `${normalizeRequestId(requestId)}.json`
		});
		await appendPrdTrace(requestId, 'watchdog_result_found', {
			...traceRefDetails(traceRef)
		});
		return;
	}

	if (_shouldKeepSlowCanonicalAnalysisRunning({ provisionalDraftAvailable })) {
		await updatePendingRequestStatus(requestId, 'provisional', {
			timeoutMs,
			canonicalStillRunning: true,
			provisionalDraftAvailable,
			reason: 'Canonical runtime analysis is still running; provisional draft remains non-canonical.'
		});
		await appendPrdTrace(requestId, 'watchdog_slow_continue', {
			...traceRefDetails(traceRef),
			timeoutMs,
			expectedResultFile: resultFile,
			provisionalResultFile,
			provisionalDraftAvailable,
			buildMode,
			buildLane,
			projectName,
			tier
		});
		await relayMissionControlEvent({
			type: 'log',
			missionId: missionIdFromRequestId(requestId),
			missionName: projectName,
			taskName: 'Canonical analysis',
			message: 'Full PRD analysis is still running; keeping the provider alive.',
			source: 'prd-bridge',
			data: {
				requestId,
				...traceRefDetails(traceRef),
				buildMode,
				buildLane,
				provisional: true,
				canonicalStillRunning: true
			}
		});
		return;
	}

	cancelAutoAnalysis?.();
	await updatePendingRequestStatus(requestId, 'timeout', {
		timeoutMs,
		canonicalTimedOut: true,
		provisionalDraftAvailable,
		reason: 'No canonical runtime analysis result written before timeout; provisional draft remains non-canonical.',
		autoAnalysis: {
			status: 'timeout',
			timedOutAt: new Date().toISOString(),
			timeoutMs,
			expectedResultFile: resultFile,
			provisionalResultFile,
			provisionalDraftAvailable,
			canonicalResultAvailable: false
		}
	});
	await appendPrdTrace(requestId, 'watchdog_timeout', {
		...traceRefDetails(traceRef),
		timeoutMs,
		expectedResultFile: resultFile,
		provisionalResultFile,
		provisionalDraftAvailable,
		buildMode,
		buildLane,
		projectName,
		tier
	});
	const missionId = missionIdFromRequestId(requestId);
	const failureData = {
		requestId,
		...traceRefDetails(traceRef),
		buildMode,
		buildLane,
		timeoutMs,
		expectedResultFile: resultFile,
		provisionalDraftAvailable,
		canonicalResultAvailable: false,
		autoAnalysisStatus: 'timeout'
	};
	await relayMissionControlEvent({
		type: 'task_failed',
		missionId,
		missionName: projectName,
		taskName: 'PRD analysis',
		message: 'Canonical PRD analysis timed out before a provider result was written.',
		source: 'prd-bridge',
		data: failureData
	});
	await relayMissionControlEvent({
		type: 'mission_failed',
		missionId,
		missionName: projectName,
		message: 'Spawner could not produce a canonical PRD analysis result before timeout.',
		source: 'prd-bridge',
		data: failureData
	});
}

function scheduleAutoAnalysisWatchdog(
	requestId: string,
	projectName: string,
	buildMode: 'direct' | 'advanced_prd',
	tier: SkillTier,
	cancelAutoAnalysis?: () => void,
	traceRef?: string | null,
	buildLane?: BuildLane
): void {
	if (AUTO_ANALYSIS_TIMEOUT_MS <= 0) return;
	const timer = setTimeout(() => {
		void _runAutoAnalysisWatchdog({
			requestId,
			projectName,
			buildMode,
			tier,
			cancelAutoAnalysis,
			traceRef,
			buildLane
		});
	}, AUTO_ANALYSIS_TIMEOUT_MS);

	if (typeof timer.unref === 'function') {
		timer.unref();
	}
}

export function _shouldKeepSlowCanonicalAnalysisRunning(input: {
	provisionalDraftAvailable: boolean;
}): boolean {
	return input.provisionalDraftAvailable;
}

function resolveCodexBinary(): string | null {
	return resolveCliBinary('codex');
}

function normalizeBuildMode(value: unknown): 'direct' | 'advanced_prd' {
	return value === 'advanced_prd' ? 'advanced_prd' : 'direct';
}

type BuildLane = 'fast_direct' | 'direct' | 'advanced_prd';

function normalizeBuildLane(value: unknown, buildMode: 'direct' | 'advanced_prd', options: unknown): BuildLane {
	const optionRecord = options && typeof options === 'object' ? (options as Record<string, unknown>) : null;
	if (optionRecord?.fastLane === true) return 'fast_direct';
	if (value === 'fast_direct' || value === 'direct' || value === 'advanced_prd') return value;
	return buildMode === 'advanced_prd' ? 'advanced_prd' : 'direct';
}

export function _shouldUseDeterministicPrdFallback(input: {
	buildLane: BuildLane;
	constrainedStaticSingleFile: boolean;
}): boolean {
	return input.constrainedStaticSingleFile;
}

// positiveEnvMs honours a clean non-negative integer env value (0 means
// "no delay") and falls through to fallbackMs otherwise. The earlier
// `Number.parseInt(env[key] || '', 10)` form silently accepted suffixed
// inputs ('30s' -> 30, '5m' -> 5) because parseInt strips the suffix and
// the resulting integer passes Number.isFinite && >= 0. Gate with a
// regex over the trimmed value before parseInt is consulted.
function positiveEnvMs(env: NodeJS.ProcessEnv, key: string, fallbackMs: number): number {
	const raw = (env[key] ?? '').trim();
	if (!/^\d+$/.test(raw)) return fallbackMs;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMs;
}

export function _provisionalPrdDraftDelayMs(
	input: { buildMode: 'direct' | 'advanced_prd'; buildLane: BuildLane; constrainedStaticSingleFile?: boolean },
	env: NodeJS.ProcessEnv = process.env
): number | null {
	if (env.SPAWNER_PRD_PROVISIONAL_DRAFTS === '0') return null;
	const isAdvanced = input.buildMode === 'advanced_prd' || input.buildLane === 'advanced_prd';
	if (!isAdvanced && env.SPAWNER_PRD_DIRECT_PROVISIONAL_DRAFTS !== '1') return null;
	const key = isAdvanced ? 'SPAWNER_PRD_PROVISIONAL_ADVANCED_MS' : 'SPAWNER_PRD_PROVISIONAL_DIRECT_MS';
	const fallback = isAdvanced ? DEFAULT_PROVISIONAL_ADVANCED_ANALYSIS_MS : DEFAULT_PROVISIONAL_DIRECT_ANALYSIS_MS;
	return positiveEnvMs(env, key, fallback);
}

function isConcreteDirectStaticBuild(content: string): boolean {
	const lower = content.toLowerCase();
	const hasStaticSurface = /\b(?:static|vanilla|single[- ]page|landing\s+page|html|css|javascript|no build step)\b/.test(lower);
	const hasDeliverable = /\b(?:build|create|make|ship|scaffold|generate)\b/.test(lower) && /\b(?:page|site|app|website)\b/.test(lower);
	const hasFeatureSignal = /\b(?:menu|section|hero|gallery|contact|pricing|form|cards?|responsive|button|navigation|localstorage)\b/.test(lower);
	return hasStaticSurface && hasDeliverable && hasFeatureSignal;
}

export function _shouldRequestBriefClarification(input: {
	content: string;
	buildMode: 'direct' | 'advanced_prd';
	openQuestions: string[];
	forceDispatch?: boolean;
}): boolean {
	if (input.forceDispatch) return false;
	if (input.openQuestions.length === 0) return false;
	if (input.content.length >= 400) return false;
	if (isConstrainedSingleFileStaticHtml(input.content)) return false;
	if (input.buildMode === 'direct' && isConcreteDirectStaticBuild(input.content)) return false;
	return true;
}

export function _shouldBypassBriefEnrichment(input: {
	content: string;
	buildMode: 'direct' | 'advanced_prd';
	buildLane: BuildLane;
	forceDispatch?: boolean;
}): { bypass: boolean; reason: string | null } {
	if (isConstrainedSingleFileStaticHtml(input.content)) {
		return { bypass: true, reason: 'constrained_static_single_file' };
	}
	if (input.forceDispatch) {
		return { bypass: true, reason: 'forced_dispatch_preserves_owner_brief' };
	}
	if (input.buildMode === 'direct' && input.buildLane !== 'advanced_prd') {
		return { bypass: true, reason: 'governed_direct_build_preserves_owner_brief' };
	}
	return { bypass: false, reason: null };
}

function normalizeTelegramRelay(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const raw = value as Record<string, unknown>;
	const relay: Record<string, unknown> = {};
	if (typeof raw.profile === 'string' && raw.profile.trim()) {
		relay.profile = raw.profile.trim();
	}
	if (typeof raw.url === 'string' && raw.url.trim()) {
		relay.url = raw.url.trim();
	}
	const port = typeof raw.port === 'number' ? raw.port : typeof raw.port === 'string' ? Number(raw.port.trim()) : NaN;
	if (Number.isFinite(port) && port > 0) {
		relay.port = Math.trunc(port);
	}
	return Object.keys(relay).length > 0 ? relay : undefined;
}

export function _extractPrdBridgeProjectLineage(content: string, projectName?: string) {
	return extractMissionControlProjectLineage({
		data: { goal: content },
		missionName: projectName || 'Untitled Project'
	});
}

async function buildPromptParts(
	buildMode: 'direct' | 'advanced_prd',
	tier: SkillTier,
	briefBody?: string,
	buildLane: BuildLane = buildMode === 'advanced_prd' ? 'advanced_prd' : 'direct'
): Promise<{
	planningContract: string;
	tierBlock: string;
	workflowGuidance: string;
	bundleBlock: string;
	missionSizeBlock: string;
}> {
	const planningContract =
		buildMode === 'advanced_prd'
			? [
					'Advanced build contract:',
					'- Treat the PRD content as the source request and turn it into a compact PRD before tasking.',
					'- Use the Founder UI pattern: summary, objective, scope, non-goals, target UX, technical constraints, phased task plan, exit criteria.',
					'- Convert the PRD into TAS-style tasks: each task needs acceptance criteria, dependencies, file/workspace targets, and verification commands.',
					'- Choose task count from the actual work. Tiny builds may use 3-4 tasks, normal apps usually need 5-8, and substantial projects may need 8-14.',
					'- Do not default to four tasks. Split work by distinct skill sets, real dependencies, and verification boundaries.',
					'- Preserve explicit user constraints such as "No build step" or exact file lists.'
				].join('\n')
			: [
					'Direct build contract:',
					`- Build lane: ${buildLane}.`,
					'- Preserve the user request as-is and create only the tasks needed to execute it.',
					'- Do not inflate small explicit builds into a broad product plan.',
					'- Prefer 3-5 concrete tasks for small direct apps and dashboards; use more only when the brief names genuinely separate surfaces or verification boundaries.',
					'- Every task title must name the artifact, route, or surface it changes. Avoid generic titles like "Create app shell" unless the brief itself is only an app shell.',
					'- Include workspaceTargets whenever a file, route, package, README, test, or project folder can be inferred from the brief.',
					'- Do not insert generic open questions into the execution plan. If a detail is unknown, choose the smallest reversible assumption and mark it in acceptance criteria.',
					'- If the request is exactly "did you understand what i said", classify it as a clarification-understanding workflow, preserve that request text exactly, acknowledge understanding, and ask for missing audience, workflow, saved memory, and vibe details. Do not create MVP/auth/payment/database tasks.'
				].join('\n');

	const tierSkills = await getTierSkills(tier);
	const tierIds = tierSkills.map((s) => s.id).sort();
	const tierBlock =
		tier === 'base'
			? [
					`User skill tier: BASE (${tierIds.length} skills available)`,
					'',
					'Each task\'s "skills" array MUST contain only IDs from this allowlist:',
					tierIds.join(', '),
					'',
					'If no listed skill fits a task, pick the closest match. Do NOT invent IDs.',
					'Do NOT use pro-only IDs like "phaser-3", "vite-project-setup", "smart-contract-auditor", or "react-native-specialist" on a base build — they are not licensed for this user.'
				].join('\n')
			: [
					`User skill tier: PRO (${tierIds.length} skills available, full spark-skill-graphs catalog)`,
					'',
					'Each task\'s "skills" array MUST contain only valid IDs from spark-skill-graphs.',
					'Pick 1-5 specific skills per task — prefer specialists over generalists.',
					'Available IDs grouped by category:',
					formatSkillsByCategory(tierSkills),
					'',
					'Do NOT invent IDs. Do NOT use shorthand like "frontend" when "frontend-engineer" or a more specific specialist exists.'
				].join('\n');

	const workflowGuidance = [
		'Workflow shape requirements:',
		'- Tasks must form a DAG. Set dependencies only when a task TRULY blocks another.',
		'- Independent tasks must run in parallel — do NOT add a dependency just to make the graph linear.',
		'- A 6-task plan should usually have 2-3 dependency layers, not 6.',
		'- Each task needs at least one acceptance criterion and one verification command.',
		'',
		formatTaskQualityGuidance()
	].join('\n');

	let bundleBlock = '';
	let missionSizeBlock = '';
	if (briefBody) {
		const missionSizeClassification = classifyMissionSize(briefBody);
		missionSizeBlock = [
			formatMissionSizeGuidance(missionSizeClassification),
			'',
			formatVerificationPlanGuidance(generateVerificationPlan(missionSizeClassification))
		].join('\n');
		try {
			const classification = await classifyBrief(briefBody);
			if (classification.bestMatch) {
				bundleBlock = formatBundleForPrompt(classification.bestMatch);
				logger.info(
					`[PRDBridge] bundle classifier: ${classification.bestMatch.id} confidence=${classification.confidence.toFixed(2)}`
				);
			} else {
				logger.info('[PRDBridge] bundle classifier: no match above threshold');
			}
		} catch (err) {
			console.warn('[PRDBridge] bundle classifier failed:', err);
		}
	}

	return { planningContract, tierBlock, workflowGuidance, bundleBlock, missionSizeBlock };
}

async function buildCodexPrompt(
	requestId: string,
	traceRef: string | null,
	projectName: string,
	buildMode: 'direct' | 'advanced_prd',
	buildLane: BuildLane,
	tier: SkillTier,
	paths: ReturnType<typeof getPrdBridgePaths>,
	bundleBlock?: string,
	missionSizeBlock?: string
): Promise<string> {
	const planningContract =
		buildMode === 'advanced_prd'
			? [
					'Advanced build contract:',
					'- Treat the configured pending PRD file as the source request and turn it into a compact PRD before tasking.',
					'- Use the Founder UI pattern: summary, objective, scope, non-goals, target UX, technical constraints, phased task plan, exit criteria.',
					'- Convert the PRD into TAS-style tasks: each task needs acceptance criteria, dependencies, file/workspace targets, and verification commands.',
					'- Choose task count from the actual work. Tiny builds may use 3-4 tasks, normal apps usually need 5-8, and substantial projects may need 8-14.',
					'- Do not default to four tasks. Split work by distinct skill sets, real dependencies, and verification boundaries.',
					'- Preserve explicit user constraints such as "No build step" or exact file lists.'
				].join('\n')
			: [
					'Direct build contract:',
					`- Build lane: ${buildLane}.`,
					'- Preserve the user request as-is and create only the tasks needed to execute it.',
					'- Do not inflate small explicit builds into a broad product plan.',
					'- Prefer 3-5 concrete tasks for small direct apps and dashboards; use more only when the brief names genuinely separate surfaces or verification boundaries.',
					'- Every task title must name the artifact, route, or surface it changes. Avoid generic titles like "Create app shell" unless the brief itself is only an app shell.',
					'- Include workspaceTargets whenever a file, route, package, README, test, or project folder can be inferred from the brief.',
					'- Do not insert generic open questions into the execution plan. If a detail is unknown, choose the smallest reversible assumption and mark it in acceptance criteria.',
					'- If the request is exactly "did you understand what i said", classify it as a clarification-understanding workflow, preserve that request text exactly, acknowledge understanding, and ask for missing audience, workflow, saved memory, and vibe details. Do not create MVP/auth/payment/database tasks.'
				].join('\n');

	const tierSkills = await getTierSkills(tier);
	const tierIds = tierSkills.map((s) => s.id).sort();
	const tierBlock =
		tier === 'base'
			? [
					`User skill tier: BASE (${tierIds.length} skills available)`,
					'',
					'Each task\'s "skills" array MUST contain only IDs from this allowlist:',
					tierIds.join(', '),
					'',
					'If no listed skill fits a task, pick the closest match. Do NOT invent IDs.',
					'Do NOT use pro-only IDs like "phaser-3", "vite-project-setup", "smart-contract-auditor", or "react-native-specialist" on a base build — they are not licensed for this user.'
				].join('\n')
			: [
					`User skill tier: PRO (${tierIds.length} skills available, full spark-skill-graphs catalog)`,
					'',
					'Each task\'s "skills" array MUST contain only valid IDs from spark-skill-graphs.',
					'Pick 1-5 specific skills per task — prefer specialists over generalists.',
					'Available IDs grouped by category:',
					formatSkillsByCategory(tierSkills),
					'',
					'Do NOT invent IDs. Do NOT use shorthand like "frontend" when "frontend-engineer" or a more specific specialist exists.'
				].join('\n');

	const workflowGuidance = [
		'Workflow shape requirements:',
		'- Tasks must form a DAG. Set dependencies only when a task TRULY blocks another.',
		'- Independent tasks must run in parallel — do NOT add a dependency just to make the graph linear.',
		'- A 6-task plan should usually have 2-3 dependency layers, not 6.',
		'- Each task needs at least one acceptance criterion and one verification command.',
		'',
		formatTaskQualityGuidance()
	].join('\n');

	return [
		'You are running inside spawner-ui and must complete PRD analysis autonomously.',
		`Request ID: ${requestId}`,
		...(traceRef ? [`Trace Ref: ${traceRef}`] : []),
		`Project Name Hint: ${projectName}`,
		`Build Mode: ${buildMode}`,
		`Build Lane: ${buildLane}`,
		'',
		planningContract,
		'',
		tierBlock,
		'',
		workflowGuidance,
		'',
		...(missionSizeBlock ? [missionSizeBlock, ''] : []),
		...(bundleBlock ? [bundleBlock, ''] : []),
		'Configured bridge paths:',
		`- State directory: ${paths.spawnerDir}`,
		`- Pending request metadata: ${paths.pendingRequestFile}`,
		`- Pending PRD: ${paths.pendingPrdFile}`,
		`- Results directory: ${paths.resultsDir}`,
		'',
		'Execution steps (strict):',
		'1) Read the pending request metadata path above and confirm requestId matches.',
		'2) Read the pending PRD path above completely.',
		'3) Produce a valid PRD analysis result JSON with:',
		'   requestId, traceRef, success, projectName, projectType, complexity, infrastructure, techStack, tasks, skills, executionPrompt.',
		'4) Include actionable tasks with skills, dependencies, and verification criteria. For advanced_prd, make these TAS-style tasks with acceptance criteria.',
		'5) Validate every skill ID before emitting — if it is not in the allowlist above, replace it with the closest valid ID or omit the task.',
		'6) POST result event to Spawner API via PowerShell Invoke-RestMethod. Build headers from the local environment without printing secrets:',
		'   $SparkEventsApiKey = $env:EVENTS_API_KEY',
		'   if (-not $SparkEventsApiKey) { $SparkEventsApiKey = $env:MCP_API_KEY }',
		'   $SparkEventsHeaders = @{ "Content-Type" = "application/json" }',
		'   if ($SparkEventsApiKey) { $SparkEventsHeaders["x-api-key"] = $SparkEventsApiKey }',
		'   Use -Headers $SparkEventsHeaders on the Invoke-RestMethod call.',
		'   Do not print, log, write, or include $SparkEventsApiKey in the result JSON.',
		'   POST body shape:',
		`   {"type":"prd_analysis_complete","data":{"requestId":"${requestId}","result":<analysis>},"source":"codex-auto"}`,
		`   URL: ${AUTO_ANALYSIS_ENDPOINT}`,
		'7) If any failure happens, POST {"type":"prd_analysis_error", ...} with the same requestId.',
		'',
		'Hard constraints:',
		'- Do not wait for human input.',
		'- Do not leave placeholders.',
		'- Ensure posted JSON is complete and parseable.',
		'- Skill IDs MUST come from the allowlist. This is non-negotiable.',
		buildMode === 'direct'
			? '- For direct builds, keep task count small enough to execute reliably in one provider run unless the brief requires otherwise.'
			: '- Choose task count from project complexity. Do not default to four tasks when distinct skill sets or verification boundaries justify more.',
		'',
		'When finished successfully, print exactly: PRD_ANALYSIS_SENT'
	].join('\n');
}

export function _resolvePrdCodexModel(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.SPAWNER_PRD_CODEX_MODEL ||
		env.SPARK_CODEX_EXECUTOR_MODEL ||
		env.CODEX_MODEL ||
		'gpt-5.5'
	).trim() || 'gpt-5.5';
}

export function _resolvePrdCodexCommandTemplate(
	model: string,
	env: NodeJS.ProcessEnv = process.env
): string {
	const explicit = env.SPAWNER_PRD_CODEX_COMMAND_TEMPLATE?.trim();
	if (explicit) return explicit.includes('{model}') ? explicit.replace('{model}', model) : explicit;
	const profile = (env.SPAWNER_PRD_CODEX_PROFILE || 'speed').trim();
	const profileArg = profile ? ` --profile ${profile}` : '';
	return `codex exec --model ${model}${profileArg} --sandbox workspace-write`;
}

async function startAutoAnalysis(
	requestId: string,
	projectName: string,
	buildMode: 'direct' | 'advanced_prd',
	buildLane: BuildLane,
	tier: SkillTier,
	traceRef: string | null,
	executionAuthority: unknown
): Promise<{ started: boolean; provider: string; cancel?: () => void }> {
	const provider = (
		process.env.SPAWNER_PRD_AUTO_PROVIDER ||
		process.env.SPARK_MISSION_LLM_PROVIDER ||
		process.env.DEFAULT_MISSION_PROVIDER ||
		'codex'
	).trim().toLowerCase();
	if (provider === 'none') {
		await appendPrdTrace(requestId, 'auto_disabled', { provider, ...traceRefDetails(traceRef) });
		return { started: false, provider };
	}

	if (provider === 'claude') {
		const paths = scopedPrdBridgePathsForRequest(requestId);
		const briefBody = existsSync(paths.pendingPrdFile)
			? await readFile(paths.pendingPrdFile, 'utf-8')
			: undefined;
		const parts = await buildPromptParts(buildMode, tier, briefBody, buildLane);
		const started = await startClaudeAutoAnalysis({
			requestId,
			projectName,
			buildMode,
			tier,
			paths,
			...parts,
			appendTrace: (event, details) => appendPrdTrace(requestId, event, { ...details, ...traceRefDetails(traceRef) })
		});
		return { started, provider: 'claude' };
	}

	if (provider !== 'codex') {
		await appendPrdTrace(requestId, 'auto_unsupported_provider', { provider, ...traceRefDetails(traceRef) });
		return { started: false, provider };
	}

	try {
		const codexBinary = resolveCodexBinary();
		if (!codexBinary) {
			await appendPrdTrace(requestId, 'auto_binary_missing', { provider: 'codex', ...traceRefDetails(traceRef) });
			return { started: false, provider: 'codex' };
		}

		const paths = scopedPrdBridgePathsForRequest(requestId);
		const briefBody = existsSync(paths.pendingPrdFile)
			? await readFile(paths.pendingPrdFile, 'utf-8')
			: undefined;
		const parts = await buildPromptParts(buildMode, tier, briefBody, buildLane);
		const prompt = await buildCodexPrompt(
			requestId,
			traceRef,
			projectName,
			buildMode,
			buildLane,
			tier,
			paths,
			parts.bundleBlock,
			parts.missionSizeBlock
		);
		const missionId = `prd-auto-${normalizeRequestId(requestId)}`;
		const workingDirectory = _prdAutoAnalysisWorkingDirectory(requestId);

		await appendPrdTrace(requestId, 'auto_worker_dispatch', {
			...traceRefDetails(traceRef),
			provider: 'codex',
			missionId,
			workingDirectory,
			stateDirectory: paths.spawnerDir
		});
		const startedAt = new Date().toISOString();
		await updatePendingRequestStatus(requestId, 'pending', {
			autoAnalysis: {
				provider: 'codex',
				status: 'running',
				startedAt,
				timeoutMs: AUTO_ANALYSIS_TIMEOUT_MS,
				deadlineAt: autoAnalysisDeadline(startedAt, AUTO_ANALYSIS_TIMEOUT_MS),
				missionId,
				expectedResultFile: prdResultFile(paths, requestId),
				expectedProvisionalResultFile: provisionalPrdResultFile(paths, requestId)
			}
		});
		void relayMissionControlEvent({
			type: 'task_started',
			missionId: missionIdFromRequestId(requestId),
			missionName: projectName,
			taskName: 'PRD analysis',
			message: 'Canonical PRD analysis started.',
			source: 'prd-bridge',
			data: {
				requestId,
				...traceRefDetails(traceRef),
				buildMode,
				buildLane,
				provider: 'codex',
				timeoutMs: AUTO_ANALYSIS_TIMEOUT_MS,
				autoAnalysisStatus: 'running'
			}
		});

		const controller = new AbortController();
		const codexModel = _resolvePrdCodexModel();
		const commandTemplate = _resolvePrdCodexCommandTemplate(codexModel);
			void sparkAgentBridge
				.executeProviderTask({
					providerId: 'codex',
					missionId,
					prompt,
					executionAuthority,
					authorityPolicy: {
						toolName: 'spawner.prd.write',
						mutationClass: 'writes_files'
					},
					model: codexModel,
					requestId,
					traceRef: traceRef || undefined,
					commandTemplate,
					workingDirectory,
					signal: controller.signal
				})
			.then(async (result) => {
				const artifact = _buildPrdResultArtifactVerification(requestId, paths);
				const effectiveSuccess = result.success === true && artifact.present;
				const failureReason = effectiveSuccess
					? null
					: result.error ||
						(artifact.present
							? 'Auto-analysis worker did not report success.'
							: 'Auto-analysis worker finished without a canonical result artifact.');
				const watchdogCancelled = result.error === 'Cancelled' && !artifact.present;
				if (!watchdogCancelled) {
					await updatePendingRequestStatus(requestId, effectiveSuccess ? 'processed' : 'error', {
						reason: effectiveSuccess ? 'Canonical provider result is available.' : failureReason,
						autoAnalysis: {
							status: effectiveSuccess ? 'complete' : 'error',
							finishedAt: new Date().toISOString(),
							success: effectiveSuccess,
							providerProcessSuccess: result.success,
							error: failureReason,
							durationMs: result.durationMs || null,
							sessionId: result.sparkAgentSessionId,
							canonicalResultAvailable: artifact.present,
							resultFileName: artifact.fileName
						}
					});
					if (!effectiveSuccess) {
						const failureData = {
							requestId,
							...traceRefDetails(traceRef),
							buildMode,
							buildLane,
							provider: 'codex',
							providerProcessSuccess: result.success,
							providerError: result.error || null,
							canonicalResultAvailable: artifact.present,
							resultFileName: artifact.fileName,
							autoAnalysisStatus: 'error'
						};
						await relayMissionControlEvent({
							type: 'task_failed',
							missionId: missionIdFromRequestId(requestId),
							missionName: projectName,
							taskName: 'PRD analysis',
							message: failureReason || 'Canonical PRD analysis failed.',
							source: 'prd-bridge',
							data: failureData
						});
						await relayMissionControlEvent({
							type: 'mission_failed',
							missionId: missionIdFromRequestId(requestId),
							missionName: projectName,
							message: 'Spawner could not produce a canonical PRD analysis result.',
							source: 'prd-bridge',
							data: failureData
						});
					}
					if (effectiveSuccess) {
						await relayCanonicalPrdAnalysisComplete({
							requestId,
							projectName,
							buildMode,
							buildLane,
							traceRef,
							provider: 'codex',
							providerProcessSuccess: result.success,
							resultFileName: artifact.fileName,
							durationMs: result.durationMs || null,
							sessionId: result.sparkAgentSessionId
						});
					}
				}
				await appendPrdTrace(requestId, 'auto_worker_finished', {
					...traceRefDetails(traceRef),
					success: effectiveSuccess,
					providerProcessSuccess: result.success,
					error: failureReason,
					providerError: result.error || null,
					durationMs: result.durationMs || null,
					sessionId: result.sparkAgentSessionId,
					resultArtifact: artifact
				});
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				void updatePendingRequestStatus(requestId, 'error', {
					reason: message,
					autoAnalysis: {
						status: 'error',
						finishedAt: new Date().toISOString(),
						error: message,
						canonicalResultAvailable: _buildPrdResultArtifactVerification(requestId, paths).present
					}
				});
				void appendPrdTrace(requestId, 'auto_worker_error', {
					...traceRefDetails(traceRef),
					error: message
				});
			});

		return {
			started: true,
			provider: 'codex',
			cancel: () => controller.abort()
		};
	} catch (error) {
		await appendPrdTrace(requestId, 'auto_start_failed', {
			...traceRefDetails(traceRef),
			provider: 'codex',
			error: error instanceof Error ? error.message : String(error)
		});
		return { started: false, provider: 'codex' };
	}
}

export const POST: RequestHandler = async (event) => {
	try {
		const unauthorized = requireControlAuth(event, {
			surface: 'PRDBridgeWrite',
			apiKeyEnvVar: 'SPARK_BRIDGE_API_KEY',
			fallbackApiKeyEnvVars: ['SPAWNER_PRD_API_KEY', 'MCP_API_KEY'],
			apiKeyQueryParam: 'apiKey',
			apiKeyCookieName: 'spawner_events_api_key',
			allowedOriginsEnvVar: 'SPAWNER_ALLOWED_ORIGINS'
		});
		if (unauthorized) return unauthorized;

		const rateLimited = enforceRateLimit(event, {
			scope: 'prd_bridge_write',
			limit: 20,
			windowMs: 60_000
		});
		if (rateLimited) return rateLimited;

		await recoverOverduePrdAutoAnalysisFromPending({ recoverySource: 'prd_bridge_write' });

		const body = await event.request.json().catch(() => null);
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			return json({ error: 'Malformed JSON body' }, { status: 400 });
		}
		const { content, requestId, projectName, options, chatId, userId, buildMode, buildModeReason, buildLane, build_lane, buildLaneReason, build_lane_reason, telegramRelay, tier, forceDispatch, runnerCapability, runner_capability, projectPathEvidence, project_path_evidence, capabilityProposalPacket, capability_proposal_packet, traceRef, trace_ref, executionAuthority, execution_authority } =
			body as Record<string, any>;
		const normalizedBuildMode = normalizeBuildMode(buildMode);
		const normalizedBuildLane = normalizeBuildLane(buildLane ?? build_lane, normalizedBuildMode, options);
		const normalizedTier = normalizeTier(tier);
		const normalizedTelegramRelay = normalizeTelegramRelay(telegramRelay);
		const normalizedRunnerCapability = normalizeRunnerCapability(runnerCapability ?? runner_capability);
		const normalizedProjectPathEvidence = normalizeProjectPathEvidence(projectPathEvidence ?? project_path_evidence);
		const normalizedCapabilityProposalPacket = normalizeCapabilityProposalPacket(
			capabilityProposalPacket ?? capability_proposal_packet
		);
		const normalizedCapabilityProposalSummary = capabilityProposalSummary(normalizedCapabilityProposalPacket);
		const skipClarification = forceDispatch === true;
		const paths = getPrdBridgePaths();

		if (!content || !requestId) {
			return json({ error: 'Content and requestId are required' }, { status: 400 });
		}
		const missionId = missionIdFromRequestId(requestId);
		const normalizedTraceRef = normalizeTraceRef(traceRef ?? trace_ref) || traceRefFromMissionId(missionId);
		const resolvedExecutionAuthority = resolveExecutionAuthority(executionAuthority, execution_authority);
		const authority = assertNativeGovernorHarnessAuthority({
			authority: resolvedExecutionAuthority,
			toolName: 'spawner.prd.write',
			ownerSystem: 'spawner-ui',
			mutationClass: 'writes_files',
			requestId
		});

		// Ensure the configured Spawner state directory exists.
		if (!existsSync(paths.spawnerDir)) {
			await mkdir(paths.spawnerDir, { recursive: true });
		}
		if (!existsSync(paths.resultsDir)) {
			await mkdir(paths.resultsDir, { recursive: true });
		}

		// Brief enrichment: lift a vague brief into something the canvas
		// generator can actually plan against. Skipped when the input is
		// already specific enough (length / keyword density / has section
		// headers). Always returns a safe enrichedContent — never blocks.
		const constrainedStaticSingleFileInput = isConstrainedSingleFileStaticHtml(content);
		const enrichmentBypass = _shouldBypassBriefEnrichment({
			content,
			buildMode: normalizedBuildMode,
			buildLane: normalizedBuildLane,
			forceDispatch: skipClarification
		});
		const enrichment = enrichmentBypass.bypass
			? {
					wasEnriched: false,
					enrichedContent: content,
					addedAssumptions: [] as string[],
					openQuestions: [] as string[]
				}
			: await enrichBrief(content);
		const finalContent = enrichment.enrichedContent;
		if (enrichmentBypass.bypass) {
			await appendPrdTrace(requestId, 'brief_enrichment_bypassed', {
				...(normalizedTraceRef ? { traceRef: normalizedTraceRef } : {}),
				reason: enrichmentBypass.reason,
				buildMode: normalizedBuildMode,
				buildLane: normalizedBuildLane
			});
		}
		if (enrichment.wasEnriched) {
			await appendPrdTrace(requestId, 'brief_enriched', {
				...(normalizedTraceRef ? { traceRef: normalizedTraceRef } : {}),
				originalLength: content.length,
				enrichedLength: finalContent.length,
				addedAssumptions: enrichment.addedAssumptions,
				openQuestions: enrichment.openQuestions
			});
		}

		// Clarification gate: if the enricher surfaced open questions on a
		// short brief, return needsClarification:true so the caller (bot)
		// can ask the user before we burn an LLM dispatch on a vague input.
		// forceDispatch:true bypasses (used when the bot re-dispatches with
		// answers).
		if (_shouldRequestBriefClarification({
			content,
			buildMode: normalizedBuildMode,
			openQuestions: enrichment.openQuestions || [],
			forceDispatch: skipClarification || normalizedBuildLane === 'fast_direct'
		})) {
			await appendPrdTrace(requestId, 'clarification_requested', {
				...(normalizedTraceRef ? { traceRef: normalizedTraceRef } : {}),
				questionCount: enrichment.openQuestions.length,
				briefLength: content.length
			});
			// Persist the original + enriched content so the bot can re-dispatch
			// with answers later via forceDispatch.
			const pendingClarFile = join(paths.spawnerDir, 'pending-clarifications', `${normalizeRequestId(requestId)}.json`);
			await mkdir(join(paths.spawnerDir, 'pending-clarifications'), { recursive: true });
			await writeFile(
				pendingClarFile,
				JSON.stringify({
					requestId,
					projectName: projectName || 'Untitled Project',
					originalContent: content,
					enrichedContent: finalContent,
					addedAssumptions: enrichment.addedAssumptions,
					openQuestions: enrichment.openQuestions,
					tier: normalizedTier,
					buildMode: normalizedBuildMode,
					buildLane: normalizedBuildLane,
					...(normalizedTraceRef ? { traceRef: normalizedTraceRef } : {}),
					...(normalizedRunnerCapability ? { runnerCapability: normalizedRunnerCapability } : {}),
					...(normalizedCapabilityProposalPacket ? { capabilityProposalPacket: normalizedCapabilityProposalPacket } : {}),
					...(normalizedCapabilityProposalSummary ? { capabilityProposalSummary: normalizedCapabilityProposalSummary } : {}),
					timestamp: new Date().toISOString()
				}, null, 2),
				'utf-8'
			);
			return json({
				success: true,
				needsClarification: true,
				requestId,
				openQuestions: enrichment.openQuestions,
				addedAssumptions: enrichment.addedAssumptions,
				message: 'Brief is too thin to plan against confidently. Answer the questions and re-submit with forceDispatch:true to bypass.'
			});
		}

		// Write the (possibly enriched) PRD content to requestId-scoped storage
		// first (source of truth), then refresh the singleton back-compat
		// pointer. Concurrent requests each keep their own scoped PRD; the
		// contended singleton is written atomically so it never tears.
		await mkdir(pendingRequestsDir(paths.spawnerDir), { recursive: true });
		await writeFile(pendingPrdFileForRequest(paths.spawnerDir, requestId), finalContent, 'utf-8');
		await writeFileAtomic(paths.pendingPrdFile, finalContent);
		const projectLineage = _extractPrdBridgeProjectLineage(finalContent, projectName);
		const rawBuildLaneReason = buildLaneReason ?? build_lane_reason;
		const normalizedBuildLaneReason =
			typeof rawBuildLaneReason === 'string' && rawBuildLaneReason.trim()
				? rawBuildLaneReason.trim()
				: normalizedBuildLane === 'fast_direct'
					? 'Fast direct lane requested; use deterministic lightweight planning.'
					: 'Build lane inferred from build mode.';

		// Write request metadata
		const requestMeta = {
			requestId,
			missionId,
			projectName: projectName || 'Untitled Project',
			buildMode: normalizedBuildMode,
			buildLane: normalizedBuildLane,
			tier: normalizedTier,
			buildLaneReason: normalizedBuildLaneReason,
			buildModeReason:
				typeof buildModeReason === 'string' && buildModeReason.trim()
					? buildModeReason.trim()
					: normalizedBuildMode === 'advanced_prd'
						? 'Advanced PRD planning requested.'
						: 'Direct build requested.',
			timestamp: new Date().toISOString(),
			prdPath: paths.pendingPrdFile,
			status: 'pending',
			...(normalizedTraceRef ? { traceRef: normalizedTraceRef } : {}),
			options: {
				includeSkills: options?.includeSkills !== false,
				includeMCPs: options?.includeMCPs !== false
			},
			projectLineage,
			...(normalizedRunnerCapability ? { runnerCapability: normalizedRunnerCapability } : {}),
			...(normalizedProjectPathEvidence ? { projectPathEvidence: normalizedProjectPathEvidence } : {}),
			...(normalizedCapabilityProposalPacket ? { capabilityProposalPacket: normalizedCapabilityProposalPacket } : {}),
			...(normalizedCapabilityProposalSummary ? { capabilityProposalSummary: normalizedCapabilityProposalSummary } : {}),
			relay:
				typeof chatId === 'string' && chatId.trim()
					? {
							chatId: chatId.trim(),
							userId: typeof userId === 'string' && userId.trim() ? userId.trim() : 'telegram',
							missionId,
							requestId,
							tier: normalizedTier,
							...(normalizedTraceRef ? { traceRef: normalizedTraceRef } : {}),
							goal: content.slice(0, 500),
							...(projectLineage ? { projectLineage } : {}),
							...(normalizedRunnerCapability ? { runnerCapability: normalizedRunnerCapability } : {}),
							...(normalizedProjectPathEvidence ? { projectPathEvidence: normalizedProjectPathEvidence } : {}),
							...(normalizedTelegramRelay ? { telegramRelay: normalizedTelegramRelay } : {})
						}
					: undefined
		};
		const requestMetaSerialized = JSON.stringify(requestMeta, null, 2);
		await writeFile(pendingRequestFileForRequest(paths.spawnerDir, requestId), requestMetaSerialized, 'utf-8');
		await writeFileAtomic(paths.pendingRequestFile, requestMetaSerialized);
		await appendPrdTrace(requestId, 'request_written', {
			...(normalizedTraceRef ? { traceRef: normalizedTraceRef } : {}),
			projectName: requestMeta.projectName,
			buildMode: requestMeta.buildMode,
			buildLane: requestMeta.buildLane,
			authority,
			...(normalizedRunnerCapability ? { runnerCapability: normalizedRunnerCapability } : {}),
			...(normalizedProjectPathEvidence
				? {
						projectPathEvidence: {
							hasRequestedProjectPath: Boolean(normalizedProjectPathEvidence.requestedProjectPath),
							usedProjectPath: Boolean(normalizedProjectPathEvidence.usedProjectPath),
							evidenceOnly: normalizedProjectPathEvidence.evidenceOnly,
							rejectedReason: normalizedProjectPathEvidence.rejectedReason
						}
					}
				: {}),
			...(normalizedCapabilityProposalSummary
				? { capabilityProposal: normalizedCapabilityProposalSummary }
				: {})
		});
		void relayMissionControlEvent({
			type: 'mission_created',
			missionId,
			missionName: requestMeta.projectName,
			taskName: 'Preparing canvas',
			message: 'Spark is shaping the PRD and preparing the canvas.',
			source: 'prd-bridge',
			data: {
				requestId,
				...(normalizedTraceRef ? { traceRef: normalizedTraceRef } : {}),
				buildMode: requestMeta.buildMode,
				buildLane: requestMeta.buildLane,
				buildLaneReason: requestMeta.buildLaneReason,
				buildModeReason: requestMeta.buildModeReason,
				...(projectLineage ? { projectLineage } : {}),
				...(normalizedRunnerCapability ? { runnerCapability: normalizedRunnerCapability } : {}),
				...(normalizedProjectPathEvidence ? { projectPathEvidence: normalizedProjectPathEvidence } : {}),
				...(normalizedCapabilityProposalSummary ? { capabilityProposal: normalizedCapabilityProposalSummary } : {}),
				...(normalizedTelegramRelay ? { telegramRelay: normalizedTelegramRelay } : {})
			}
		});

		const constrainedStaticSingleFile = constrainedStaticSingleFileInput || isConstrainedSingleFileStaticHtml(finalContent);
		const deterministicFallback = _shouldUseDeterministicPrdFallback({
			buildLane: normalizedBuildLane,
			constrainedStaticSingleFile
		});
		const auto = deterministicFallback
			? { started: false, provider: normalizedBuildLane === 'fast_direct' ? 'deterministic-fast-lane' : 'deterministic-static' }
			: await startAutoAnalysis(
					requestId,
					requestMeta.projectName,
					requestMeta.buildMode,
					normalizedBuildLane,
					normalizedTier,
					normalizedTraceRef,
					resolvedExecutionAuthority
				);
		await appendPrdTrace(requestId, 'authority_verdict_evaluated', {
			...(normalizedTraceRef ? { traceRef: normalizedTraceRef } : {}),
			authorityVerdict: _buildAuthorityVerdict({
				traceRef: normalizedTraceRef,
				autoStarted: auto.started,
				autoProvider: auto.provider
			})
		});
		if (deterministicFallback) {
			await updatePendingRequestStatus(requestId, 'fallback', {
				reason:
					normalizedBuildLane === 'fast_direct'
						? 'Fast direct lane request; deterministic lightweight analysis queued.'
						: 'Constrained static file request; deterministic analysis queued to avoid app-scope expansion.'
			});
			await writeFallbackAnalysisResult(
				requestId,
				requestMeta.projectName,
				requestMeta.buildMode,
				normalizedTier,
				normalizedBuildLane === 'fast_direct' ? 'fast direct lane request' : 'constrained static file request',
				normalizedTraceRef,
				normalizedBuildLane
			);
			await relayCanonicalPrdAnalysisComplete({
				requestId,
				projectName: requestMeta.projectName,
				buildMode: requestMeta.buildMode,
				buildLane: normalizedBuildLane,
				traceRef: normalizedTraceRef,
				provider: auto.provider,
				providerProcessSuccess: true,
				resultFileName: `${normalizeRequestId(requestId)}.json`,
				terminal: true
			});
		} else if (auto.started) {
			scheduleProvisionalPrdDraft({
				requestId,
				missionId,
				projectName: requestMeta.projectName,
				buildMode: requestMeta.buildMode,
				buildLane: requestMeta.buildLane,
				constrainedStaticSingleFile,
				tier: normalizedTier,
				traceRef: normalizedTraceRef
			});
			scheduleAutoAnalysisWatchdog(
				requestId,
				requestMeta.projectName,
				requestMeta.buildMode,
				normalizedTier,
				auto.cancel,
				normalizedTraceRef,
				normalizedBuildLane
			);
		} else if (auto.provider !== 'none') {
			await updatePendingRequestStatus(requestId, 'fallback', {
				reason: `No ${auto.provider} auto-analysis worker started; deterministic fallback queued`
			});
			await writeFallbackAnalysisResult(
				requestId,
				requestMeta.projectName,
				requestMeta.buildMode,
				normalizedTier,
				`auto-analysis not started for provider ${auto.provider}`,
				normalizedTraceRef
			);
			await relayCanonicalPrdAnalysisComplete({
				requestId,
				projectName: requestMeta.projectName,
				buildMode: requestMeta.buildMode,
				buildLane: normalizedBuildLane,
				traceRef: normalizedTraceRef,
				provider: auto.provider,
				providerProcessSuccess: false,
				resultFileName: `${normalizeRequestId(requestId)}.json`
			});
		}

		logger.info(`[PRDBridge] PRD written to ${paths.pendingPrdFile}`);
		logger.info(`[PRDBridge] Request ID: ${requestId}`);
		logger.info(`[PRDBridge] Auto-analysis (${auto.provider}): ${auto.started ? 'started' : 'not-started'}`);

		return json({
			success: true,
			path: paths.pendingPrdFile,
			requestId,
			...(normalizedTraceRef ? { traceRef: normalizedTraceRef } : {}),
			autoAnalysis: {
				provider: auto.provider,
				started: auto.started
			},
			authority,
			enrichment: {
				wasEnriched: enrichment.wasEnriched,
				addedAssumptions: enrichment.addedAssumptions,
				openQuestions: enrichment.openQuestions
			}
		});
	} catch (error) {
		if (error instanceof HarnessAuthorityError) {
			return json(
				{ error: error.message, code: error.code, authority: error.verdict },
				{ status: error.status }
			);
		}
		console.error('[PRDBridge] Error writing PRD:', error);
		return json({ error: 'Failed to write PRD file' }, { status: 500 });
	}
};
