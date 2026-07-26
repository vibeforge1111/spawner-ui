import { env } from '$env/dynamic/private';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import os from 'os';
import path from 'node:path';
import { promisify } from 'node:util';
import { autoDispatchPrdCanvasLoad, type PrdAutoDispatchResult } from './prd-auto-dispatch';
import { spawnerStateDir as resolveSpawnerStateDir } from './spawner-state';
import { assertNativeGovernorHarnessAuthority, resolveExecutionAuthority } from './harness-authority';
import { writeFileAtomic } from './atomic-write';
import { stripAuthorityResidue } from './authority-residue';

const execFileAsync = promisify(execFile);

export const CREATOR_TRACE_SCHEMA_VERSION = 'spark-creator-trace.v1';
export const CREATOR_INTENT_SCHEMA_VERSION = 'spark-creator-intent.v1';
export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 'spark-artifact-manifest.v1';

export type CreatorPrivacyMode = 'local_only' | 'github_pr' | 'swarm_shared';
export type CreatorRiskLevel = 'low' | 'medium' | 'high';
export type CreatorStageStatus = 'queued' | 'running' | 'blocked' | 'validated' | 'failed' | 'published';
export type CreatorExecutionPolicy = 'manual_run' | 'read_only';
export type CreatorMode = 'domain_chip' | 'specialization_path' | 'benchmark' | 'autoloop' | 'full_path';
export type CreatorPublishReadiness =
	| 'private_draft'
	| 'workspace_validated'
	| 'pr_ready'
	| 'pr_submitted'
	| 'reviewed_candidate'
	| 'network_absorbable'
	| 'canonical';
export type CreatorArtifactType =
	| 'domain_chip'
	| 'benchmark_pack'
	| 'specialization_path'
	| 'autoloop_policy'
	| 'tool_integration'
	| 'swarm_publish_packet'
	| 'creator_report';

export interface CreatorTelegramRelayTarget {
	port?: number | null;
	profile?: string | null;
	url?: string | null;
}

export type CreatorValidationGateId =
	| 'schema_gate'
	| 'lineage_gate'
	| 'benchmark_gate'
	| 'benchmark_proof_gate'
	| 'complexity_gate'
	| 'transfer_gate'
	| 'memory_hygiene_gate'
	| 'publish_review_gate';

export interface CreatorValidationGate {
	id: CreatorValidationGateId;
	title: string;
	status: 'pending' | 'pass' | 'warn' | 'fail';
	blocks_promotion: boolean;
	description: string;
}

export interface CreatorMissionTask {
	id: string;
	title: string;
	artifact: string;
	description: string;
	skills: string[];
	dependencies: string[];
	acceptance_criteria: string[];
	verification_commands: string[];
	validation_gates: CreatorValidationGateId[];
}

export interface CreatorIntentPacket {
	schema_version: typeof CREATOR_INTENT_SCHEMA_VERSION;
	user_goal: string;
	target_domain: string;
	target_operator_surface: string;
	expected_agent_capability: string;
	success_examples: string[];
	failure_examples: string[];
	tools_in_scope: string[];
	data_sources_allowed: string[];
	risk_level: CreatorRiskLevel;
	privacy_mode: CreatorPrivacyMode;
	desired_outputs: {
		domain_chip: boolean;
		specialization_path: boolean;
		benchmark_pack: boolean;
		autoloop_policy: boolean;
		telegram_flow: boolean;
		spawner_mission: boolean;
		swarm_publish_packet: boolean;
	};
	intent_id?: string;
	artifact_targets?: string[];
	usage_surfaces?: string[];
	success_claim?: string;
	capabilities_to_prove?: string[];
	benchmark_requirements?: Record<string, boolean | number>;
	network_contribution_policy?: 'workspace_only' | 'github_pr_required' | 'manual_review_required';
}

export interface CreatorValidationIssue {
	path: string;
	message: string;
	severity: 'error' | 'warning' | string;
}

export interface CreatorArtifactManifest {
	schema_version: typeof ARTIFACT_MANIFEST_SCHEMA_VERSION;
	artifact_id: string;
	artifact_type: CreatorArtifactType;
	repo: string;
	inputs: string[];
	outputs: string[];
	validation_commands: string[];
	promotion_gates: string[];
	rollback_plan: string;
}

export interface CreatorArtifactBundle {
	intent_packet: CreatorIntentPacket;
	artifact_manifests: CreatorArtifactManifest[];
	validation_issues: CreatorValidationIssue[];
}

export interface CreatorValidationCommandResult {
	artifact_id: string;
	artifact_type: CreatorArtifactType;
	repo: string;
	command: string;
	cwd: string;
	status: 'passed' | 'failed' | 'skipped';
	exit_code: number | null;
	stdout_tail: string;
	stderr_tail: string;
	error: string | null;
}

export interface CreatorValidationRun {
	schema_version: 'spark-creator-validation-run.v1';
	run_id: string;
	mission_id: string;
	started_at: string;
	completed_at: string;
	status: 'passed' | 'failed' | 'blocked';
	results: CreatorValidationCommandResult[];
}

export interface CreatorSpecializationEntry {
	agent_entrypoint: string;
	telegram_command: string;
	required_artifacts: CreatorArtifactType[];
	evaluation_loop: {
		preflight: string;
		baseline: string;
		candidate: string;
		held_out: string;
		autoloop: string;
		keep_rule: string;
		reject_rule: string;
	};
	telemetry_surfaces: string[];
}

export interface CreatorImprovementEvidence {
	status: 'missing' | 'recorded';
	baseline_score: number | null;
	candidate_score: number | null;
	delta: number | null;
	held_out_required: boolean;
	held_out_pass: boolean;
	validation_run_id: string | null;
	benchmark_refs: string[];
	notes: string[];
}

export interface CreatorMissionCanonicalStatus {
	verdict?: string;
	stage_status?: string;
	evidence_tier?: string;
	evidence_mode?: string;
	automation_blocked?: boolean;
	blocking_checks?: string[];
	warning_checks?: string[];
	missing_paths?: string[];
	recommended_next_command?: string | null;
}

export interface CreatorMissionPublicationStatus {
	publish_mode?: CreatorPrivacyMode;
	local_display_allowed?: boolean;
	github_pr_allowed?: boolean;
	swarm_shared_allowed?: boolean;
	network_absorbable: false;
	requested_network_absorption?: boolean;
	blocked_reason?: string | null;
	required_gates?: string[];
	missing_gates?: string[];
	gate_status?: Record<string, boolean>;
	unsafe_claim_blocked?: boolean;
}

export interface CreatorValidationCommandProgress {
	phase: 'started' | 'completed';
	index: number;
	total: number;
	manifest: CreatorArtifactManifest;
	command: string;
	result?: CreatorValidationCommandResult;
}

export interface CreatorMissionTrace {
	schema_version: typeof CREATOR_TRACE_SCHEMA_VERSION;
	trace_id: string;
	intent_id: string;
	mission_id: string;
	request_id: string;
	creator_mode: CreatorMode;
	user_goal: string;
	repo_root: string | null;
	artifacts: string[];
	artifact_manifests: CreatorArtifactManifest[];
	artifact_manifest_validation_issues: CreatorValidationIssue[];
	repo_changes: string[];
	benchmarks: string[];
	publish_readiness: CreatorPublishReadiness;
	validation_runs: CreatorValidationRun[];
	tasks: CreatorMissionTask[];
	validation_gates: CreatorValidationGate[];
	current_stage: string;
	stage_status: CreatorStageStatus;
	execution_policy: CreatorExecutionPolicy;
	intent_packet: CreatorIntentPacket;
	specialization_entry: CreatorSpecializationEntry;
	benchmark_summary: {
		baseline_score: number | null;
		candidate_score: number | null;
		delta: number | null;
		held_out_pass: boolean;
	};
	improvement_evidence: CreatorImprovementEvidence;
	creator_mission_status?: Record<string, unknown> | null;
	canonical?: CreatorMissionCanonicalStatus;
	publication?: CreatorMissionPublicationStatus;
	swarm: {
		payload_ready: boolean;
		api_ready: boolean;
		publish_mode: CreatorPrivacyMode | 'none';
	};
	telegram_relay?: CreatorTelegramRelayTarget | null;
	telegram_chat_id?: string | null;
	telegram_user_id?: string | null;
	blockers: string[];
	links: {
		canvas: string;
		kanban: string;
		repo: string;
		pull_request: string;
	};
	created_at: string;
	updated_at: string;
}

export interface CreateCreatorMissionInput {
	brief: string;
	requestId?: string;
	missionId?: string;
	chatId?: string;
	userId?: string;
	telegramRelay?: CreatorTelegramRelayTarget | null;
	privacyMode?: CreatorPrivacyMode;
	riskLevel?: CreatorRiskLevel;
	executionPolicy?: CreatorExecutionPolicy;
	baseUrl?: string;
}

export interface CreatorPlanOptions {
	builderRepo?: string;
	pythonCommand?: string;
	timeoutMs?: number;
	envRecord?: Record<string, string | undefined>;
	cwd?: string;
	homedir?: () => string;
}

interface CreateCreatorMissionOptions extends CreatorPlanOptions {
	stateDir?: string;
	now?: () => Date;
	runPlanner?: (input: CreateCreatorMissionInput) => Promise<CreatorIntentPacket>;
	runManifestPlanner?: (input: CreateCreatorMissionInput) => Promise<CreatorArtifactBundle>;
	queueCanvas?: boolean;
}

export interface ExecuteCreatorMissionInput {
	missionId?: string | null;
	requestId?: string | null;
}

export interface ValidateCreatorMissionInput {
	missionId?: string | null;
	requestId?: string | null;
	maxCommands?: number | null;
}

interface ExecuteCreatorMissionOptions {
	stateDir?: string;
	now?: () => Date;
	dispatchRunner?: CreatorDispatchRunner;
	executionAuthority?: unknown;
}

interface ValidateCreatorMissionOptions {
	stateDir?: string;
	now?: () => Date;
	timeoutMs?: number;
	maxCommands?: number;
	commandRunner?: CreatorValidationCommandRunner;
	executionAuthority?: unknown;
	onCommandProgress?: (progress: CreatorValidationCommandProgress) => void | Promise<void>;
}

type CreatorPlanRunner = (
	input: CreateCreatorMissionInput,
	options?: CreatorPlanOptions
) => Promise<CreatorIntentPacket>;
type CreatorManifestRunner = (
	input: CreateCreatorMissionInput,
	options?: CreatorPlanOptions
) => Promise<CreatorArtifactBundle>;

type CreatorMissionCanvasLoad = ReturnType<typeof creatorMissionCanvasLoad>;
type CreatorDispatchRunner = (load: CreatorMissionCanvasLoad) => Promise<PrdAutoDispatchResult>;
type CreatorValidationCommandRunner = (
	executable: string,
	args: string[],
	options: { cwd: string; timeoutMs: number }
) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

let activeCreatorPlanRunner: CreatorPlanRunner | null = null;
let activeCreatorManifestRunner: CreatorManifestRunner | null = null;
let activeCreatorDispatchRunner: CreatorDispatchRunner | null = null;
let activeCreatorValidationCommandRunner: CreatorValidationCommandRunner | null = null;

export function setCreatorPlanRunnerForTests(runner: CreatorPlanRunner | null): void {
	activeCreatorPlanRunner = runner;
}

export function setCreatorManifestRunnerForTests(runner: CreatorManifestRunner | null): void {
	activeCreatorManifestRunner = runner;
}

export function setCreatorDispatchRunnerForTests(runner: CreatorDispatchRunner | null): void {
	activeCreatorDispatchRunner = runner;
}

export function setCreatorValidationCommandRunnerForTests(runner: CreatorValidationCommandRunner | null): void {
	activeCreatorValidationCommandRunner = runner;
}

function spawnerStateDir(): string {
	return resolveSpawnerStateDir(env);
}

function creatorMissionDir(stateDir = spawnerStateDir()): string {
	return path.join(stateDir, 'creator-missions');
}

/**
 * Validates that a missionId contains only safe characters and cannot be used for path traversal.
 * Mission IDs should be alphanumeric with hyphens/underscores only.
 */
function validateMissionId(missionId: string): boolean {
	return /^[a-zA-Z0-9_-]+$/.test(missionId);
}

function pendingLoadPath(stateDir = spawnerStateDir()): string {
	return path.join(stateDir, 'pending-load.json');
}

function lastCanvasLoadPath(stateDir = spawnerStateDir()): string {
	return path.join(stateDir, 'last-canvas-load.json');
}

function creatorWorkspaceRoot(): string {
	const envRecord = env as Record<string, string | undefined>;
	return path.resolve(
		envRecord.SPARK_CREATOR_WORKSPACE_ROOT ||
			process.env.SPARK_CREATOR_WORKSPACE_ROOT ||
			path.resolve(process.cwd(), '..')
	);
}

export function creatorMissionPath(missionId: string, stateDir = spawnerStateDir()): string {
	return path.join(creatorMissionDir(stateDir), `${missionId}.json`);
}

export function defaultBuilderRepo(
	envRecord: Record<string, string | undefined> = env,
	options: { homedir?: () => string; cwd?: string } = {}
): string {
	const explicit = envRecord.SPARK_BUILDER_REPO || process.env.SPARK_BUILDER_REPO;
	if (explicit) {
		return path.resolve(explicit);
	}
	const homeDir = options.homedir ? options.homedir() : os.homedir();
	const cwd = options.cwd ?? process.cwd();
	const candidates = [
		// Installed layout: `spark setup` places modules as siblings under ~/.spark/modules.
		path.join(homeDir, '.spark', 'modules', 'spark-intelligence-builder', 'source'),
		// Dev checkout layout: spawner-ui and spark-intelligence-builder cloned side by side.
		path.resolve(cwd, '..', 'spark-intelligence-builder')
	];
	for (const candidate of candidates) {
		if (existsSync(path.join(candidate, 'src', 'spark_intelligence', 'cli.py'))) {
			return candidate;
		}
	}
	// No valid candidate found; return the first installed-layout path so the
	// error message points at the location the user is most likely to need to fix.
	return candidates[0];
}

function defaultPythonCommand(envRecord: Record<string, string | undefined> = env): string {
	return envRecord.SPARK_BUILDER_PYTHON || process.env.SPARK_BUILDER_PYTHON || 'python';
}

function buildPlannerArgs(input: CreateCreatorMissionInput): string[] {
	const args = [
		'-m',
		'spark_intelligence.cli',
		'creator',
		'plan',
		'--brief',
		input.brief,
		'--json'
	];
	if (input.privacyMode) {
		args.push('--privacy-mode', input.privacyMode);
	}
	if (input.riskLevel) {
		args.push('--risk-level', input.riskLevel);
	}
	return args;
}

function buildManifestPlannerArgs(input: CreateCreatorMissionInput): string[] {
	const args = [
		'-m',
		'spark_intelligence.cli',
		'creator',
		'manifests',
		'--brief',
		input.brief,
		'--json'
	];
	if (input.privacyMode) {
		args.push('--privacy-mode', input.privacyMode);
	}
	if (input.riskLevel) {
		args.push('--risk-level', input.riskLevel);
	}
	return args;
}

function withBuilderPythonPath(baseEnv: NodeJS.ProcessEnv, builderRepo: string): NodeJS.ProcessEnv {
	const srcPath = path.join(builderRepo, 'src');
	const delimiter = path.delimiter;
	const existing = baseEnv.PYTHONPATH;
	return {
		...baseEnv,
		PYTHONIOENCODING: 'utf-8',
		PYTHONPATH: existsSync(srcPath) ? (existing ? `${srcPath}${delimiter}${existing}` : srcPath) : existing
	};
}

function validateCreatorIntentPacket(value: unknown): CreatorIntentPacket {
	if (!value || typeof value !== 'object') {
		throw new Error('creator plan returned non-object JSON');
	}
	const packet = value as CreatorIntentPacket;
	if (packet.schema_version !== CREATOR_INTENT_SCHEMA_VERSION) {
		throw new Error(`creator plan returned unexpected schema: ${String((value as Record<string, unknown>).schema_version)}`);
	}
	if (!packet.user_goal || !packet.target_domain || !packet.desired_outputs) {
		throw new Error('creator plan returned incomplete intent packet');
	}
	return packet;
}

function validateCreatorArtifactBundle(value: unknown): CreatorArtifactBundle {
	if (!value || typeof value !== 'object') {
		throw new Error('creator manifests returned non-object JSON');
	}
	const record = value as Partial<CreatorArtifactBundle>;
	const intentPacket = validateCreatorIntentPacket(record.intent_packet);
	const manifests = Array.isArray(record.artifact_manifests) ? record.artifact_manifests : [];
	if (manifests.length === 0) {
		throw new Error('creator manifests returned no artifact manifests');
	}
	for (const manifest of manifests) {
		validateCreatorArtifactManifest(manifest);
	}
	const validationIssues = Array.isArray(record.validation_issues) ? record.validation_issues : [];
	return {
		intent_packet: intentPacket,
		artifact_manifests: manifests,
		validation_issues: validationIssues
	};
}

function validateCreatorArtifactManifest(value: unknown): CreatorArtifactManifest {
	if (!value || typeof value !== 'object') {
		throw new Error('creator manifests returned a non-object artifact manifest');
	}
	const manifest = value as CreatorArtifactManifest;
	if (manifest.schema_version !== ARTIFACT_MANIFEST_SCHEMA_VERSION) {
		throw new Error(`creator manifests returned unexpected artifact schema: ${String((value as Record<string, unknown>).schema_version)}`);
	}
	if (!manifest.artifact_id || !manifest.artifact_type || !manifest.repo) {
		throw new Error('creator manifests returned incomplete artifact manifest');
	}
	if (!Array.isArray(manifest.outputs) || !Array.isArray(manifest.validation_commands) || !Array.isArray(manifest.promotion_gates)) {
		throw new Error('creator manifests returned malformed artifact arrays');
	}
	return manifest;
}

export async function runCreatorPlan(
	input: CreateCreatorMissionInput,
	options: CreatorPlanOptions = {}
): Promise<CreatorIntentPacket> {
	const envRecord = options.envRecord || env;
	const builderRepoExplicitlySelected = Boolean(
		options.builderRepo || envRecord.SPARK_BUILDER_REPO || process.env.SPARK_BUILDER_REPO
	);
	const builderRepo = path.resolve(options.builderRepo || defaultBuilderRepo(envRecord, options));
	if (
		!existsSync(builderRepo) ||
		(!builderRepoExplicitlySelected &&
			!existsSync(path.join(builderRepo, 'src', 'spark_intelligence', 'cli.py')))
	) {
		const homeDir = options.homedir ? options.homedir() : os.homedir();
		const cwd = options.cwd ?? process.cwd();
		const installedPath = path.join(
			homeDir,
			'.spark',
			'modules',
			'spark-intelligence-builder',
			'source'
		);
		const devPath = path.resolve(cwd, '..', 'spark-intelligence-builder');
		throw new Error(
			`Builder repo not found: ${builderRepo}. Set SPARK_BUILDER_REPO to the absolute path of your spark-intelligence-builder checkout. The expected install location is ${installedPath}; the dev-checkout location is ${devPath}. Run \`spark setup\` if the module is missing.`
		);
	}
	const pythonCommand = options.pythonCommand || defaultPythonCommand(envRecord);
	let stdout: string;
	try {
		({ stdout } = await execFileAsync(pythonCommand, buildPlannerArgs(input), {
			cwd: builderRepo,
			env: withBuilderPythonPath(process.env, builderRepo),
			timeout: options.timeoutMs ?? 30_000,
			windowsHide: true,
			maxBuffer: 1024 * 1024
		}));
	} catch (error) {
		const stderr = String((error as { stderr?: unknown })?.stderr ?? '').trim();
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Creator planner subprocess failed: ${message}${stderr ? ` | stderr: ${stderr.slice(0, 500)}` : ''}`,
			{ cause: error }
		);
	}
	let plannerJson: unknown;
	try {
		plannerJson = JSON.parse(stdout);
	} catch (err) {
		throw new Error(
			`Creator planner returned non-JSON output (length=${stdout.length}). ${(err as Error).message}`
		);
	}
	return validateCreatorIntentPacket(plannerJson);
}

export async function runCreatorArtifactBundle(
	input: CreateCreatorMissionInput,
	options: CreatorPlanOptions = {}
): Promise<CreatorArtifactBundle> {
	const envRecord = options.envRecord || env;
	const builderRepoExplicitlySelected = Boolean(
		options.builderRepo || envRecord.SPARK_BUILDER_REPO || process.env.SPARK_BUILDER_REPO
	);
	const builderRepo = path.resolve(options.builderRepo || defaultBuilderRepo(envRecord, options));
	if (
		!existsSync(builderRepo) ||
		(!builderRepoExplicitlySelected &&
			!existsSync(path.join(builderRepo, 'src', 'spark_intelligence', 'cli.py')))
	) {
		const homeDir = options.homedir ? options.homedir() : os.homedir();
		const cwd = options.cwd ?? process.cwd();
		const installedPath = path.join(
			homeDir,
			'.spark',
			'modules',
			'spark-intelligence-builder',
			'source'
		);
		const devPath = path.resolve(cwd, '..', 'spark-intelligence-builder');
		throw new Error(
			`Builder repo not found: ${builderRepo}. Set SPARK_BUILDER_REPO to the absolute path of your spark-intelligence-builder checkout. The expected install location is ${installedPath}; the dev-checkout location is ${devPath}. Run \`spark setup\` if the module is missing.`
		);
	}
	const pythonCommand = options.pythonCommand || defaultPythonCommand(envRecord);
	let stdout: string;
	try {
		({ stdout } = await execFileAsync(pythonCommand, buildManifestPlannerArgs(input), {
			cwd: builderRepo,
			env: withBuilderPythonPath(process.env, builderRepo),
			timeout: options.timeoutMs ?? 30_000,
			windowsHide: true,
			maxBuffer: 1024 * 1024
		}));
	} catch (error) {
		const stderr = String((error as { stderr?: unknown })?.stderr ?? '').trim();
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Creator artifact planner subprocess failed: ${message}${stderr ? ` | stderr: ${stderr.slice(0, 500)}` : ''}`,
			{ cause: error }
		);
	}
	let plannerJson: unknown;
	try {
		plannerJson = JSON.parse(stdout);
	} catch (err) {
		throw new Error(
			`Creator artifact planner returned non-JSON output (length=${stdout.length}). ${(err as Error).message}`
		);
	}
	return validateCreatorArtifactBundle(plannerJson);
}

export function creatorModeFromIntent(packet: CreatorIntentPacket): CreatorMode {
	const outputs = packet.desired_outputs;
	if (outputs.domain_chip && outputs.specialization_path && outputs.benchmark_pack && outputs.autoloop_policy) {
		return 'full_path';
	}
	if (outputs.autoloop_policy) return 'autoloop';
	if (outputs.specialization_path) return 'specialization_path';
	if (outputs.benchmark_pack && !outputs.domain_chip) return 'benchmark';
	return 'domain_chip';
}

export function artifactPlanFromIntent(packet: CreatorIntentPacket): string[] {
	if (Array.isArray(packet.artifact_targets) && packet.artifact_targets.length > 0) {
		return [...packet.artifact_targets];
	}
	const outputs = packet.desired_outputs;
	const artifacts: string[] = [];
	if (outputs.domain_chip) artifacts.push('domain_chip');
	if (outputs.benchmark_pack) artifacts.push('benchmark_pack');
	if (outputs.specialization_path) artifacts.push('specialization_path');
	if (outputs.autoloop_policy) artifacts.push('autoloop_policy');
	if (outputs.telegram_flow) artifacts.push('telegram_flow');
	if (outputs.spawner_mission) artifacts.push('spawner_mission');
	if (outputs.swarm_publish_packet) artifacts.push('swarm_publish_packet');
	return artifacts;
}

function intentIdFromPacket(packet: CreatorIntentPacket, requestId: string): string {
	return packet.intent_id?.trim() || `creator-intent-${requestId}`;
}

function traceIdFromMissionId(missionId: string): string {
	return `creator-trace-${missionId}`;
}

export function validationGatesForCreatorIntent(packet: CreatorIntentPacket): CreatorValidationGate[] {
	const gates: CreatorValidationGate[] = [
		{
			id: 'schema_gate',
			title: 'Schema compatibility',
			status: 'pending',
			blocks_promotion: true,
			description: 'Generated packets, manifests, hooks, benchmarks, and Swarm payloads must match their active runtime schemas.'
		},
		{
			id: 'lineage_gate',
			title: 'Causal lineage',
			status: 'pending',
			blocks_promotion: true,
			description: 'Any recursive improvement rule must name the failure pattern, counterfactual, and evidence that it is not formatting-only gain.'
		},
		{
			id: 'benchmark_gate',
			title: 'Benchmark evidence',
			status: 'pending',
			blocks_promotion: true,
			description: 'Baseline and held-out cases must exist before a skill, path, or autoloop policy can be called improved.'
		},
		{
			id: 'benchmark_proof_gate',
			title: 'Before/after proof',
			status: 'pending',
			blocks_promotion: true,
			description: 'A specialized agent must beat the baseline on visible, held-out, and trap-style checks before Spark claims the path made the agent better.'
		},
		{
			id: 'complexity_gate',
			title: 'Complexity budget',
			status: 'pending',
			blocks_promotion: true,
			description: 'The implementation must avoid adding branches, fields, or prompt mass unless measured capability improves.'
		},
		{
			id: 'memory_hygiene_gate',
			title: 'Memory hygiene',
			status: 'pending',
			blocks_promotion: true,
			description: 'Operational residue, logs, and one-off tool chatter must not become long-lived doctrine or Swarm advice.'
		}
	];

	if (packet.desired_outputs.specialization_path || packet.desired_outputs.autoloop_policy) {
		gates.push({
			id: 'transfer_gate',
			title: 'Transfer shadow test',
			status: 'pending',
			blocks_promotion: false,
			description: 'Domain logic should include an explicit label map before it is reused by another specialization path.'
		});
	}

	if (packet.desired_outputs.swarm_publish_packet || packet.privacy_mode === 'swarm_shared') {
		gates.push({
			id: 'publish_review_gate',
			title: 'GitHub PR publish review',
			status: 'pending',
			blocks_promotion: true,
			description: 'Network-bound contributions must be reviewable through a repo/PR path before Swarm-wide absorption.'
		});
	}

	return gates;
}

export function creatorDomainDisplayLabel(domain: string | undefined): string {
	const raw = domain?.trim() || '';
	if (!raw) return 'Target Domain';
	return raw
		.replace(/[_/]+/g, '-')
		.split(/-|\s+/)
		.map((word) => word.trim())
		.filter(Boolean)
		.map((word) => {
			const lower = word.toLowerCase();
			if (['ai', 'api', 'llm', 'qa', 'ui', 'ux', 'yc'].includes(lower)) return lower.toUpperCase();
			return lower.charAt(0).toUpperCase() + lower.slice(1);
		})
		.join(' ');
}

function compactDomainLabel(packet: CreatorIntentPacket): string {
	return creatorDomainDisplayLabel(packet.target_domain);
}

function task(
	input: Omit<CreatorMissionTask, 'skills' | 'dependencies' | 'acceptance_criteria' | 'verification_commands' | 'validation_gates'> &
		Partial<Pick<CreatorMissionTask, 'skills' | 'dependencies' | 'acceptance_criteria' | 'verification_commands' | 'validation_gates'>>
): CreatorMissionTask {
	return {
		...input,
		skills: input.skills || [],
		dependencies: input.dependencies || [],
		acceptance_criteria: input.acceptance_criteria || [],
		verification_commands: input.verification_commands || [],
		validation_gates: input.validation_gates || []
	};
}

export function buildCreatorMissionTasks(packet: CreatorIntentPacket): CreatorMissionTask[] {
	const domain = compactDomainLabel(packet);
	const outputs = packet.desired_outputs;
	const tasks: CreatorMissionTask[] = [
		task({
			id: 'creator-intent-plan',
			title: `Lock ${domain} creator intent and task graph`,
			artifact: 'intent_packet',
			description: 'Normalize the user goal into a creator intent packet, artifact plan, privacy mode, risk level, and executable task graph.',
			skills: ['spark-intelligence-builder', 'creator-system'],
			acceptance_criteria: [
				'Intent packet names the target domain, operator surface, desired outputs, privacy mode, and risk level.',
				'Task graph contains explicit dependencies and validation gates.',
				'No network publish action is implied by local-only or GitHub-PR modes.'
			],
			verification_commands: ['GET /api/creator/mission?missionId=<mission-id>'],
			validation_gates: ['schema_gate', 'memory_hygiene_gate']
		})
	];

	if (outputs.domain_chip) {
		tasks.push(task({
			id: 'domain-chip-contract',
			title: `Create ${domain} domain chip contract`,
			artifact: 'domain_chip',
			description: 'Design the chip manifest, routing boundaries, hook inputs/outputs, doctrine packet shape, and focused tests for the domain.',
			skills: ['domain-chip-creator', 'spark-intelligence-builder'],
			dependencies: ['creator-intent-plan'],
			acceptance_criteria: [
				'Manifest has precise routing keywords and avoids generic keyword hijacking.',
				'Hook contracts are invokable by the active Spark runtime.',
				'Tests include positive routing and unrelated fallthrough cases.'
			],
			verification_commands: ['npm test or pytest for generated chip router/hook tests'],
			validation_gates: ['schema_gate', 'memory_hygiene_gate']
		}));
	}

	if (outputs.benchmark_pack) {
		tasks.push(task({
			id: 'benchmark-pack',
			title: `Build ${domain} benchmark pack`,
			artifact: 'benchmark_pack',
			description: 'Create a baseline plus held-out evaluation set that tests whether the agent makes better domain decisions instead of producing nicer wording.',
			skills: ['benchmark-designer', 'evaluation-engineer'],
			dependencies: ['creator-intent-plan'],
			acceptance_criteria: [
				'Benchmark contains scenario variety, expected good decisions, and explicit failure modes.',
				'Scoring separates doctrine accuracy, tool-use quality, evidence quality, and outcome reasoning.',
				'Held-out cases are not used as mutation prompts.'
			],
			verification_commands: ['Run benchmark baseline and record score artifact'],
			validation_gates: ['benchmark_gate', 'benchmark_proof_gate', 'schema_gate']
		}));
	}

	if (outputs.specialization_path) {
		const deps = ['creator-intent-plan'];
		if (outputs.domain_chip) deps.push('domain-chip-contract');
		if (outputs.benchmark_pack) deps.push('benchmark-pack');
		tasks.push(task({
			id: 'specialization-path',
			title: `Assemble ${domain} specialization path`,
			artifact: 'specialization_path',
			description: 'Turn chip behavior, benchmark cases, operator playbooks, and proof-of-work criteria into a reusable path an agent can enter and climb.',
			skills: ['specialization-path-architect', 'docs-engineer'],
			dependencies: deps,
			acceptance_criteria: [
				'Path defines novice to mastery stages with evidence required at each step.',
				'Agent-facing instructions say what to learn, what to avoid, and how to prove improvement.',
				'The path can be read by Spark without relying on private chat context.'
			],
			verification_commands: ['Review generated path docs against benchmark and chip artifacts'],
			validation_gates: ['schema_gate', 'transfer_gate', 'memory_hygiene_gate']
		}));
	}

	if (outputs.autoloop_policy) {
		const deps = ['creator-intent-plan'];
		if (outputs.benchmark_pack) deps.push('benchmark-pack');
		if (outputs.specialization_path) deps.push('specialization-path');
		tasks.push(task({
			id: 'autoloop-policy',
			title: `Define ${domain} benchmark-gated autoloop`,
			artifact: 'autoloop_policy',
			description: 'Specify mutation surface, keep/reject rules, rollback rules, round history, and when a discovered pattern may become durable doctrine.',
			skills: ['recursive-evolution-protocol', 'autoloop-engineer'],
			dependencies: deps,
			acceptance_criteria: [
				'Every keep requires benchmark delta, held-out check, and anti-drift explanation.',
				'No score-only mutation is promoted without a useful agent-facing lesson.',
				'Rollback condition and round-history clearing policy are explicit.'
			],
			verification_commands: ['Run a short dry-run autoloop against fixture cases'],
			validation_gates: ['lineage_gate', 'benchmark_gate', 'benchmark_proof_gate', 'complexity_gate']
		}));
	}

	if (outputs.telegram_flow || outputs.spawner_mission) {
		const deps = ['creator-intent-plan'];
		if (outputs.specialization_path) deps.push('specialization-path');
		tasks.push(task({
			id: 'telegram-spawner-flow',
			title: `Wire ${domain} Telegram, Builder, and Spawner flow`,
			artifact: 'telegram_flow',
			description: 'Expose the creator path through Telegram and Spawner so a user can request, inspect, pause, and resume work without manual token juggling.',
			skills: ['telegram-bot', 'spawner-ui', 'spark-intelligence-builder'],
			dependencies: deps,
			acceptance_criteria: [
				'Telegram command creates a creator mission with stable mission and request ids.',
				'Kanban shows all creator tasks with queued/running/completed states.',
				'Canvas opens the mission-scoped task graph for inspection.'
			],
			verification_commands: ['/creator plan private risk medium <brief>', '/mission status <mission-id>'],
			validation_gates: ['schema_gate']
		}));
	}

	const validationDeps = tasks
		.map((candidate) => candidate.id)
		.filter((id) => id !== 'creator-intent-plan');
	tasks.push(task({
		id: 'creator-validation',
		title: `Validate ${domain} creator artifacts`,
		artifact: 'validation_report',
		description: 'Run anti-drift checks before treating the generated chip, path, benchmark, or autoloop as intelligence rather than scaffolding.',
		skills: ['recursive-evolution-protocol', 'test-architect'],
		dependencies: validationDeps.length > 0 ? validationDeps : ['creator-intent-plan'],
		acceptance_criteria: [
			'Schema, lineage, benchmark, complexity, memory hygiene, and publish gates are recorded.',
			'Benchmark evidence includes baseline, candidate, delta, and held-out verdict where applicable.',
			'Open blockers are attached to the trace instead of being hidden in prose.'
		],
		verification_commands: ['Read creator trace and benchmark artifacts; fail closed when evidence is missing'],
		validation_gates: validationGatesForCreatorIntent(packet).map((gate) => gate.id)
	}));

	if (outputs.swarm_publish_packet) {
		tasks.push(task({
			id: 'swarm-publish-packet',
			title: `Prepare ${domain} Swarm publish packet`,
			artifact: 'swarm_publish_packet',
			description: packet.privacy_mode === 'swarm_shared'
				? 'Prepare the reviewed packet that can be published to Spark Swarm after benchmark and safety gates pass.'
				: 'Prepare a local or GitHub PR review packet without publishing directly to Spark Swarm.',
			skills: ['spark-swarm', 'github-pr-review'],
			dependencies: ['creator-validation'],
			acceptance_criteria: [
				'Publish packet includes provenance, benchmark evidence, intended consumers, and rollback note.',
				'GitHub PR or local review mode is respected before network contribution.',
				'Swarm payload is not marked ready until validation gates pass.'
			],
			verification_commands: ['Review Swarm packet JSON/Markdown before publish'],
			validation_gates: ['publish_review_gate', 'memory_hygiene_gate']
		}));
	}

	return tasks;
}

function buildTaskDescription(taskRecord: CreatorMissionTask): string {
	const lines = [taskRecord.description];
	if (taskRecord.dependencies.length > 0) {
		lines.push('', 'Dependencies:', ...taskRecord.dependencies.map((dependency) => `- ${dependency}`));
	}
	if (taskRecord.acceptance_criteria.length > 0) {
		lines.push('', 'Acceptance criteria:', ...taskRecord.acceptance_criteria.map((criterion) => `- ${criterion}`));
	}
	if (taskRecord.validation_gates.length > 0) {
		lines.push('', 'Validation gates:', ...taskRecord.validation_gates.map((gate) => `- ${gate}`));
	}
	if (taskRecord.verification_commands.length > 0) {
		lines.push('', 'Verification:', ...taskRecord.verification_commands.map((command) => `- ${command}`));
	}
	return lines.join('\n');
}

function taskToCanvasNode(taskRecord: CreatorMissionTask, index: number) {
	const row = Math.floor(index / 3);
	const col = index % 3;
	return {
		skill: {
			id: `creator-${taskRecord.id}`,
			name: `${taskRecord.id}: ${taskRecord.title}`,
			description: buildTaskDescription(taskRecord),
			category: 'creator-system',
			tier: 'free',
			tags: taskRecord.skills,
			triggers: ['creator-mission', taskRecord.artifact]
		},
		position: { x: 160 + col * 360, y: 140 + row * 240 }
	};
}

function taskConnections(tasks: CreatorMissionTask[]): Array<{ sourceIndex: number; targetIndex: number }> {
	const indexById = new Map<string, number>();
	tasks.forEach((candidate, index) => indexById.set(candidate.id, index));
	const connections: Array<{ sourceIndex: number; targetIndex: number }> = [];
	for (const [targetIndex, candidate] of tasks.entries()) {
		for (const dependency of candidate.dependencies) {
			const sourceIndex = indexById.get(dependency);
			if (sourceIndex !== undefined) {
				connections.push({ sourceIndex, targetIndex });
			}
		}
	}
	return connections;
}

function creatorPipelineId(requestId: string): string {
	return `creator-${requestId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function creatorCanvasPath(trace: Pick<CreatorMissionTrace, 'request_id' | 'mission_id'>): string {
	return `/canvas?pipeline=${encodeURIComponent(creatorPipelineId(trace.request_id))}&mission=${encodeURIComponent(trace.mission_id)}`;
}

function creatorExecutionPrompt(trace: CreatorMissionTrace): string {
	const domainLabel = creatorDomainDisplayLabel(trace.intent_packet.target_domain);
	return [
		`Creator mission for ${domainLabel}.`,
		'Build the requested Spark creator artifacts as a gated, benchmarkable system.',
		`User goal: ${trace.user_goal}`,
		`Target operating-system folder: ${creatorWorkspaceRoot()}`,
		`Creator mode: ${trace.creator_mode}`,
		`Privacy mode: ${trace.intent_packet.privacy_mode}`,
		`Risk level: ${trace.intent_packet.risk_level}`,
		`Artifact manifests: ${trace.artifact_manifests.map((manifest) => `${manifest.artifact_type}:${manifest.repo}`).join(', ') || 'none'}`,
		'Promotion rule: do not publish to Spark Swarm until validation gates pass and review mode allows it.'
	].join('\n');
}

function fallbackArtifactManifestsFromIntent(packet: CreatorIntentPacket): CreatorArtifactManifest[] {
	const domain = packet.target_domain || 'custom-domain';
	const intentId = packet.intent_id || `creator-intent-${domain}`;
	return fallbackManifestArtifactTypes(packet).map((artifact) => ({
		schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
		artifact_id: `${domain}-${artifact.replace(/_/g, '-')}-v1`,
		artifact_type: artifact as CreatorArtifactType,
		repo: artifact === 'swarm_publish_packet' ? 'spark-swarm' : domain,
		inputs: [intentId],
		outputs: [`scaffolds/${artifact}.json`],
		validation_commands: ['manual validation required'],
		promotion_gates: ['schema_gate', 'rollback_gate'],
		rollback_plan: 'Revert generated scaffold artifacts and remove local creator trace references.'
	}));
}

function fallbackManifestArtifactTypes(packet: CreatorIntentPacket): CreatorArtifactType[] {
	const seen = new Set<CreatorArtifactType>();
	const artifactTypes: CreatorArtifactType[] = [];
	for (const artifact of artifactPlanFromIntent(packet)) {
		const normalized = artifact === 'telegram_flow' || artifact === 'spawner_mission'
			? 'tool_integration'
			: artifact;
		if (!isCreatorArtifactType(normalized) || seen.has(normalized)) continue;
		seen.add(normalized);
		artifactTypes.push(normalized);
	}
	return artifactTypes;
}

function isSparkQaOperatorCreatorBrief(brief: string): boolean {
	const lower = brief.toLowerCase();
	return (
		/\b(?:spark\s+qa\s+operator|qa\s+operator|qa\s+tester|quality\s+tester|tester\s+for\s+spark|spark\s+tester)\b/.test(lower) ||
		lower.includes('canonical target domain: spark-qa-operator')
	);
}

function isSparkQaOperatorBenchmarkOnlyBrief(brief: string, packet: CreatorIntentPacket): boolean {
	const lower = brief.toLowerCase();
	if (lower.includes('artifact focus: benchmark pack')) return true;
	if (packet.artifact_targets?.length === 1 && packet.artifact_targets[0] === 'benchmark_pack') return true;

	const benchmarkAsk = /\b(?:benchmark pack|benchmark cases?|held-?out|trap cases?|adversarial|no-?op regression|route drift|creator mission evidence)\b/.test(lower);
	const broaderCreatorAsk = /\b(?:full creator system|full path|specialization path|specialisation path|gated autoloop|domain chip contract)\b/.test(lower);
	return benchmarkAsk && !broaderCreatorAsk;
}

function sparkQaOperatorRepoForArtifact(artifactType: CreatorArtifactType): string {
	if (artifactType === 'domain_chip') return 'domain-chip-spark-qa-operator';
	if (artifactType === 'benchmark_pack') return 'spark-qa-operator-bench';
	if (artifactType === 'tool_integration') return 'spark-telegram-bot';
	if (artifactType === 'swarm_publish_packet') return 'spark-swarm';
	return 'specialization-path-spark-qa-operator';
}

function normalizeSparkQaOperatorManifest(
	manifest: CreatorArtifactManifest,
	benchmarkOnly: boolean
): CreatorArtifactManifest {
	const artifactType = manifest.artifact_type;
	const normalized: CreatorArtifactManifest = {
		...manifest,
		artifact_id: `spark-qa-operator-${artifactType.replace(/_/g, '-')}-v1`,
		repo: sparkQaOperatorRepoForArtifact(artifactType),
		inputs: Array.from(new Set(['creator-intent-spark-qa-operator', ...manifest.inputs]))
	};

	if (benchmarkOnly && artifactType === 'benchmark_pack') {
		return {
			...normalized,
			outputs: [
				'benchmarks/spark-qa-operator.cases.json',
				'benchmarks/spark-qa-operator.scoring.json',
				'docs/BENCHMARK_CALIBRATION.md'
			],
			validation_commands: [
				'python -m pytest tests',
				'python scripts/run_spark_qa_operator_benchmark.py --suite smoke'
			]
		};
	}

	return normalized;
}

function normalizeSparkQaOperatorBundle(input: CreateCreatorMissionInput, bundle: CreatorArtifactBundle): CreatorArtifactBundle {
	if (!isSparkQaOperatorCreatorBrief(input.brief)) return bundle;

	const benchmarkOnly = isSparkQaOperatorBenchmarkOnlyBrief(input.brief, bundle.intent_packet);
	const artifactTargets = benchmarkOnly
		? ['benchmark_pack']
		: ['domain_chip', 'benchmark_pack', 'specialization_path', 'autoloop_policy', 'tool_integration', 'swarm_publish_packet'];
	const packet: CreatorIntentPacket = {
		...bundle.intent_packet,
		user_goal: input.brief,
		target_domain: 'spark-qa-operator',
		target_operator_surface: 'telegram+workspace+spawner-ui+canvas+kanban+auth-pairing+recursive-reports',
		expected_agent_capability: benchmarkOnly
			? 'Measure Spark QA Operator with held-out, trap, no-op, route-drift, and evidence-backed benchmark cases.'
			: 'Improve Spark QA Operator through private benchmarked practice on Spark-built products before general user-app transfer.',
		tools_in_scope: [
			'spark-telegram-bot',
			'spark-swarm-workspace',
			'spawner-ui',
			'canvas-kanban-panels',
			'mission-control-trace',
			'auth-pairing',
			'spark-intelligence-builder'
		],
		data_sources_allowed: ['local_repo', 'local_spawner_state', 'operator_supplied_telegram_context'],
		risk_level: input.riskLevel || bundle.intent_packet.risk_level || 'medium',
		privacy_mode: input.privacyMode || bundle.intent_packet.privacy_mode || 'local_only',
		desired_outputs: {
			...bundle.intent_packet.desired_outputs,
			domain_chip: !benchmarkOnly,
			specialization_path: !benchmarkOnly,
			benchmark_pack: true,
			autoloop_policy: !benchmarkOnly,
			telegram_flow: !benchmarkOnly,
			spawner_mission: !benchmarkOnly,
			swarm_publish_packet: !benchmarkOnly
		},
		intent_id: 'creator-intent-spark-qa-operator',
		artifact_targets: artifactTargets,
		usage_surfaces: ['telegram', 'spark-swarm-workspace', 'spawner-ui', 'canvas', 'kanban', 'auth-pairing', 'recursive-reports'],
		success_claim: benchmarkOnly
			? 'Spark QA Operator benchmark cases separate real evidence-backed QA gains from formatting-only improvements.'
			: 'Spark QA Operator measurably catches more Spark-product regressions before its rules transfer to user apps.',
		capabilities_to_prove: benchmarkOnly
			? [
				'route drift detection',
				'creator mission evidence verification',
				'pretty Telegram message but wrong evidence rejection',
				'no-op regression handling',
				'held-out Workspace evidence checks'
			]
			: [
				'telegram natural-language creator QA',
				'spark workspace sync and report truthfulness',
				'recursive keep/revert report verification',
				'spawner canvas and kanban execution QA',
				'auth pairing abuse and recovery QA',
				'autoloop mutation review'
			],
		benchmark_requirements: {
			visible_cases: 24,
			fixed_suite: true,
			held_out_cases: true,
			trap_cases: true,
			simulator_transfer: true,
			fresh_agent_absorption: true,
			human_calibration: false
		},
		network_contribution_policy: 'workspace_only'
	};

	const manifestsByType = new Map<CreatorArtifactType, CreatorArtifactManifest>();
	const allowedManifestTypes = new Set<CreatorArtifactType>(fallbackManifestArtifactTypes(packet));
	for (const manifest of bundle.artifact_manifests) {
		const artifactType = manifest.artifact_type;
		if (!isCreatorArtifactType(artifactType)) continue;
		if (!allowedManifestTypes.has(artifactType)) continue;
		manifestsByType.set(artifactType, normalizeSparkQaOperatorManifest(manifest, benchmarkOnly));
	}
	for (const fallback of fallbackArtifactManifestsFromIntent(packet)) {
		if (manifestsByType.has(fallback.artifact_type)) continue;
		manifestsByType.set(fallback.artifact_type, normalizeSparkQaOperatorManifest(fallback, benchmarkOnly));
	}

	return {
		intent_packet: packet,
		artifact_manifests: Array.from(manifestsByType.values()),
		validation_issues: bundle.validation_issues
	};
}

function isCreatorArtifactType(value: string): value is CreatorArtifactType {
	return [
		'domain_chip',
		'benchmark_pack',
		'specialization_path',
		'autoloop_policy',
		'tool_integration',
		'swarm_publish_packet',
		'creator_report'
	].includes(value);
}

function creatorTelemetrySurfaces(packet: CreatorIntentPacket): string[] {
	const explicit = Array.isArray(packet.usage_surfaces) ? packet.usage_surfaces : [];
	const inferred = packet.target_operator_surface
		.split(/[+,/|\s]+/)
		.map((surface) => surface.trim())
		.filter(Boolean);
	return Array.from(new Set([...explicit, ...inferred, 'telegram', 'canvas', 'kanban', 'trace']));
}

function buildSpecializationEntry(packet: CreatorIntentPacket): CreatorSpecializationEntry {
	const domain = packet.target_domain || 'custom-domain';
	const domainLabel = creatorDomainDisplayLabel(domain);
	const requiredArtifacts = fallbackManifestArtifactTypes(packet);
	return {
		agent_entrypoint:
			`Enter the ${domainLabel} specialization only after loading the domain chip, benchmark pack, specialization path, and autoloop policy; use the benchmark to prove better tool use, reasoning, and decisions before keeping changes.`,
		telegram_command: `/creator plan --domain ${domain} --surface telegram --benchmark held-out`,
		required_artifacts: requiredArtifacts,
		evaluation_loop: {
			preflight: 'Confirm domain chip hooks, specialization instructions, benchmark fixtures, and rollback rules are present before practice starts.',
			baseline: 'Run the benchmark pack before specialization practice and record the baseline score.',
			candidate: 'Run the same visible benchmark after applying the domain chip and specialization path, then compare tool-use and reasoning deltas.',
			held_out: 'Run held-out cases that were not used as mutation prompts before any keep or publish decision.',
			autoloop: 'suggest -> evaluate -> keep/reject -> record evidence -> repeat only when capability improves.',
			keep_rule: 'Keep a mutation only when candidate score beats baseline, held-out passes, and the lesson improves agent-facing behavior rather than wording alone.',
			reject_rule: 'Reject or roll back score-only, formatting-only, non-transferable, or unverified mutations.'
		},
		telemetry_surfaces: creatorTelemetrySurfaces(packet)
	};
}

function boolFromHeldOut(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') return value.trim().toLowerCase() === 'pass';
	return false;
}

function numberOrNull(value: unknown): number | null {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.map((item) => String(item || '').trim()).filter(Boolean)
		: [];
}

function initialImprovementEvidence(packet: CreatorIntentPacket): CreatorImprovementEvidence {
	const requirements = packet.benchmark_requirements || {};
	const heldOutRequired = requirements.held_out_cases !== false && packet.desired_outputs.benchmark_pack;
	return {
		status: 'missing',
		baseline_score: null,
		candidate_score: null,
		delta: null,
		held_out_required: heldOutRequired,
		held_out_pass: false,
		validation_run_id: null,
		benchmark_refs: [],
		notes: ['Awaiting validation ledger with baseline, candidate, delta, and held-out evidence.']
	};
}

interface CreatorValidationLedger {
	benchmark_evidence?: {
		baseline_score?: unknown;
		candidate_score?: unknown;
		delta?: unknown;
		held_out_verdict?: unknown;
		held_out_pass?: unknown;
		benchmark_refs?: unknown;
		notes?: unknown;
		reasoning_delta?: unknown;
		tool_usage_delta?: unknown;
		ability_delta?: unknown;
	};
	held_out_verdict?: unknown;
	held_out_pass?: unknown;
	benchmark_refs?: unknown;
	notes?: unknown;
	gate_results?: unknown;
	gate_ledger?: unknown;
	missing_evidence_count?: unknown;
}

const CREATOR_MISSION_STATUS_SCHEMA_VERSION = 'adaptive_creator_loop.creator_mission_status.v1';
const SPARK_CREATOR_MISSION_STATUS_SCHEMA_VERSION = 'spark-creator-mission-status.v1';

async function readJsonIfPresent(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		if (!existsSync(filePath)) return null;
		return JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function findCreatorValidationLedger(trace: CreatorMissionTrace, stateDir?: string): Promise<CreatorValidationLedger | null> {
	const local = await findCreatorLocalArtifactManifest(trace, stateDir);
	if (local) {
		const ledger = await readJsonIfPresent(path.join(local.root, 'validation-ledger.json'));
		if (ledger) return ledger as CreatorValidationLedger;
	}
	for (const manifest of trace.artifact_manifests || []) {
		if (!manifest.repo) continue;
		const ledger = await readJsonIfPresent(path.join(resolveCreatorRepoRoot(manifest.repo), 'validation-ledger.json'));
		if (ledger) return ledger as CreatorValidationLedger;
	}
	return null;
}

async function findCreatorMissionStatusPacket(trace: CreatorMissionTrace, stateDir?: string): Promise<Record<string, unknown> | null> {
	const local = await findCreatorLocalArtifactManifest(trace, stateDir);
	if (local) {
		const packet = await readJsonIfPresent(path.join(local.root, 'creator-mission-status.json'));
		if (packet) return packet;
	}
	const seen = new Set<string>();
	for (const manifest of trace.artifact_manifests || []) {
		if (!manifest.repo) continue;
		const repoRoot = resolveCreatorRepoRoot(manifest.repo);
		if (seen.has(repoRoot)) continue;
		seen.add(repoRoot);
		for (const candidate of [
			path.join(repoRoot, 'reports', 'creator-mission-status.json'),
			path.join(repoRoot, 'creator-mission-status.json')
		]) {
			const packet = await readJsonIfPresent(candidate);
			if (packet) return packet;
		}
	}
	return null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boolOrUndefined(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return stringOrUndefined(value);
}

function publicationMode(value: unknown): CreatorPrivacyMode | undefined {
	return value === 'local_only' || value === 'github_pr' || value === 'swarm_shared' ? value : undefined;
}

function booleanRecord(value: unknown): Record<string, boolean> | undefined {
	const record = recordOrNull(value);
	if (!record) return undefined;
	const output: Record<string, boolean> = {};
	for (const [key, raw] of Object.entries(record)) {
		if (typeof raw === 'boolean') output[key] = raw;
	}
	return output;
}

function blockerLabelFromPacket(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) return value.trim();
	const record = recordOrNull(value);
	const source = stringOrUndefined(record?.source);
	const message = stringOrUndefined(record?.message);
	if (source && message) return `${source}: ${message}`;
	return source || message || null;
}

function addCreatorBlocker(trace: CreatorMissionTrace, blocker: string): void {
	if (blocker && !trace.blockers.includes(blocker)) trace.blockers.push(blocker);
}

function clearValidationCommandFailureBlockers(trace: CreatorMissionTrace): void {
	trace.blockers = trace.blockers.filter((blocker) =>
		!/^(?:One or more validation commands failed\.|Creator validation failed:)/i.test(blocker)
	);
}

function applyCreatorMissionStatusPacket(trace: CreatorMissionTrace, packet: Record<string, unknown> | null): void {
	if (!packet) return;
	if (
		packet.schema_version !== CREATOR_MISSION_STATUS_SCHEMA_VERSION &&
		packet.schema_version !== SPARK_CREATOR_MISSION_STATUS_SCHEMA_VERSION
	) return;
	if (packet.read_only !== undefined && packet.read_only !== true) {
		const blocker = 'Creator mission status packet was ignored because it was not read-only.';
		addCreatorBlocker(trace, blocker);
		return;
	}
	if (packet.read_only === true || boolOrUndefined(packet.automation_blocked) === true) {
		trace.execution_policy = 'read_only';
	}

	const canonical = recordOrNull(packet.canonical) || packet;
	const publication = recordOrNull(packet.publication) || {};

	const canonicalStatus: CreatorMissionCanonicalStatus = {
		verdict: stringOrUndefined(canonical.verdict),
		stage_status: stringOrUndefined(canonical.stage_status),
		evidence_tier: stringOrUndefined(canonical.evidence_tier),
		evidence_mode: stringOrUndefined(canonical.evidence_mode),
		automation_blocked: boolOrUndefined(canonical.automation_blocked),
		blocking_checks: stringArray(canonical.blocking_checks),
		warning_checks: stringArray(canonical.warning_checks),
		missing_paths: stringArray(canonical.missing_paths),
		recommended_next_command: nullableString(canonical.recommended_next_command)
	};
	const publicationStatus: CreatorMissionPublicationStatus = {
		publish_mode: publicationMode(publication.publish_mode),
		local_display_allowed: boolOrUndefined(publication.local_display_allowed),
		github_pr_allowed: boolOrUndefined(publication.github_pr_allowed),
		swarm_shared_allowed: boolOrUndefined(publication.swarm_shared_allowed),
		network_absorbable: false,
		requested_network_absorption: boolOrUndefined(publication.requested_network_absorption),
		blocked_reason: nullableString(publication.blocked_reason),
		required_gates: stringArray(publication.required_gates),
		missing_gates: stringArray(publication.missing_gates),
		gate_status: booleanRecord(publication.gate_status),
		unsafe_claim_blocked: boolOrUndefined(publication.unsafe_claim_blocked)
	};

	trace.creator_mission_status = packet;
	trace.canonical = canonicalStatus;
	trace.publication = publicationStatus;
	if (publicationStatus.publish_mode) {
		trace.swarm.publish_mode = publicationStatus.publish_mode;
	}
	trace.swarm.payload_ready = false;
	trace.swarm.api_ready = false;

	if (publication.network_absorbable !== false || publication.swarm_shared_allowed !== false) {
		const blocker = 'Creator mission status kept network absorption blocked for product surfaces.';
		addCreatorBlocker(trace, blocker);
	}
	for (const blocker of stringArray(canonicalStatus.blocking_checks)) {
		addCreatorBlocker(trace, blocker);
	}
	if (Array.isArray(packet.blockers)) {
		for (const rawBlocker of packet.blockers) {
			const blocker = blockerLabelFromPacket(rawBlocker);
			if (blocker) addCreatorBlocker(trace, blocker);
		}
	}
}

function resolveCreatorExecutionPolicy(input: CreateCreatorMissionInput, _brief: string): CreatorExecutionPolicy {
	if (input.executionPolicy === 'read_only' || input.executionPolicy === 'manual_run') return input.executionPolicy;
	return 'manual_run';
}

function creatorMissionExecutionBlockedReason(trace: CreatorMissionTrace): string | null {
	if (trace.execution_policy === 'read_only') return 'creator mission is read-only/stage-only and cannot be executed';
	const statusPacket = recordOrNull(trace.creator_mission_status);
	if (statusPacket?.read_only === true) return 'creator mission status packet is read-only and cannot be executed';
	return null;
}

function applyImprovementEvidenceFromLedger(
	trace: CreatorMissionTrace,
	ledger: CreatorValidationLedger | null,
	run: CreatorValidationRun
): void {
	const evidence = recordOrNull(ledger?.benchmark_evidence);
	if (!ledger && !evidence) return;

	const baselineScore = numberOrNull(evidence?.baseline_score);
	const candidateScore = numberOrNull(evidence?.candidate_score);
	const delta = numberOrNull(evidence?.delta);
	const heldOutPass = boolFromHeldOut(evidence?.held_out_verdict ?? evidence?.held_out_pass ?? ledger?.held_out_verdict ?? ledger?.held_out_pass);
	const benchmarkRefs = Array.from(new Set([
		...stringArray(evidence?.benchmark_refs),
		...stringArray(ledger?.benchmark_refs)
	]));
	const notes = [
		...stringArray(evidence?.notes),
		...stringArray(ledger?.notes),
		...stringArray([evidence?.reasoning_delta, evidence?.tool_usage_delta, evidence?.ability_delta])
	];

	trace.benchmark_summary = {
		baseline_score: baselineScore,
		candidate_score: candidateScore,
		delta,
		held_out_pass: heldOutPass
	};
	trace.improvement_evidence = {
		...trace.improvement_evidence,
		status: baselineScore !== null && candidateScore !== null && delta !== null ? 'recorded' : 'missing',
		baseline_score: baselineScore,
		candidate_score: candidateScore,
		delta,
		held_out_pass: heldOutPass,
		validation_run_id: run.run_id,
		benchmark_refs: benchmarkRefs,
		notes
	};
	for (const ref of benchmarkRefs) {
		if (!trace.benchmarks.includes(ref)) trace.benchmarks.push(ref);
	}

	const gateResults = recordOrNull(ledger?.gate_results) || recordOrNull(ledger?.gate_ledger);
	if (gateResults) {
		for (const [gate, rawStatus] of Object.entries(gateResults)) {
			const status = typeof rawStatus === 'string'
				? rawStatus
				: stringOrUndefined(recordOrNull(rawStatus)?.status) || '';
			if (/\b(?:blocked|failed|fail)\b|blocked_until|missing/i.test(status)) {
				addCreatorBlocker(trace, `${gate}: ${status}`);
			}
		}
	}
	const missingEvidenceCount = numberOrNull(ledger?.missing_evidence_count);
	if (missingEvidenceCount && missingEvidenceCount > 0) {
		addCreatorBlocker(trace, `Benchmark promotion evidence is incomplete (${missingEvidenceCount} missing item${missingEvidenceCount === 1 ? '' : 's'}).`);
	}
}

function creatorMissionRequiresBenchmarkProof(trace: CreatorMissionTrace): boolean {
	return Boolean(
		trace.intent_packet.desired_outputs.benchmark_pack ||
		trace.validation_gates.some((gate) => gate.id === 'benchmark_gate' || gate.id === 'benchmark_proof_gate') ||
		trace.artifact_manifests.some((manifest) => manifest.artifact_type === 'benchmark_pack')
	);
}

function creatorMissionHasPromotionEvidence(trace: CreatorMissionTrace): boolean {
	if (!creatorMissionRequiresBenchmarkProof(trace)) return true;
	const evidence = trace.improvement_evidence;
	const hasScores = evidence.baseline_score !== null && evidence.candidate_score !== null && evidence.delta !== null;
	const hasBenchmarkRefs = evidence.benchmark_refs.length > 0;
	const heldOutOk = !evidence.held_out_required || evidence.held_out_pass;
	return hasScores && hasBenchmarkRefs && heldOutOk;
}

function applyCreatorValidationReadiness(trace: CreatorMissionTrace, runStatus: CreatorValidationRun['status']): void {
	if (runStatus === 'failed') {
		trace.current_stage = 'validation_failed';
		trace.stage_status = 'failed';
		return;
	}
	if (runStatus === 'blocked') {
		trace.current_stage = 'validation_blocked';
		trace.stage_status = 'blocked';
		return;
	}

	if (creatorMissionHasPromotionEvidence(trace)) {
		trace.current_stage = 'validation_completed';
		trace.stage_status = 'validated';
		trace.publish_readiness = 'workspace_validated';
		return;
	}

	trace.current_stage = 'validation_completed_promotion_blocked';
	trace.stage_status = 'blocked';
	if (trace.publish_readiness === 'workspace_validated') trace.publish_readiness = 'private_draft';
	addCreatorBlocker(
		trace,
		'Fresh benchmark runner evidence is required before this Creator Mission can be considered scored or promotion-ready.'
	);
}

async function resolveCreatorArtifactBundle(
	input: CreateCreatorMissionInput,
	options: CreateCreatorMissionOptions
): Promise<CreatorArtifactBundle> {
	const manifestRunner = options.runManifestPlanner || activeCreatorManifestRunner;
	if (manifestRunner) {
		return manifestRunner(input, options);
	}
	if (options.runPlanner || activeCreatorPlanRunner) {
		const planner = options.runPlanner || activeCreatorPlanRunner || runCreatorPlan;
		const intentPacket = await planner(input, options);
		return {
			intent_packet: intentPacket,
			artifact_manifests: fallbackArtifactManifestsFromIntent(intentPacket),
			validation_issues: []
		};
	}
	return runCreatorArtifactBundle(input, options);
}

export function creatorMissionCanvasLoad(trace: CreatorMissionTrace, now = new Date()) {
	const pipelineId = creatorPipelineId(trace.request_id);
	const domainLabel = creatorDomainDisplayLabel(trace.intent_packet.target_domain);
	return {
		requestId: trace.request_id,
		missionId: trace.mission_id,
		pipelineId,
		pipelineName: `Creator Mission: ${domainLabel}`,
		nodes: trace.tasks.map(taskToCanvasNode),
		connections: taskConnections(trace.tasks),
		source: 'creator-mission' as const,
		autoRun: false,
		buildMode: 'advanced_prd' as const,
		buildModeReason: 'Creator missions require explicit validation gates before execution or Swarm publication.',
		executionPrompt: creatorExecutionPrompt(trace),
		relay: {
			missionId: trace.mission_id,
			requestId: trace.request_id,
			goal: trace.user_goal,
			...(trace.telegram_relay ? { telegramRelay: trace.telegram_relay } : {}),
			...(trace.telegram_chat_id ? { chatId: trace.telegram_chat_id } : {}),
			...(trace.telegram_user_id ? { userId: trace.telegram_user_id } : {}),
			autoRun: false,
			buildMode: 'advanced_prd' as const,
			buildModeReason: 'Creator missions require explicit validation gates before execution or Swarm publication.'
		},
		timestamp: now.toISOString()
	};
}

async function writeCreatorMissionCanvasLoad(load: CreatorMissionCanvasLoad, stateDir = spawnerStateDir()): Promise<CreatorMissionCanvasLoad> {
	await mkdir(stateDir, { recursive: true });
	const payload = JSON.stringify(stripAuthorityResidue(load), null, 2);
	await writeFileAtomic(pendingLoadPath(stateDir), payload);
	await writeFileAtomic(lastCanvasLoadPath(stateDir), payload);
	return load;
}

export async function queueCreatorMissionCanvasLoad(trace: CreatorMissionTrace, stateDir = spawnerStateDir()): Promise<ReturnType<typeof creatorMissionCanvasLoad>> {
	const load = creatorMissionCanvasLoad(trace);
	return writeCreatorMissionCanvasLoad(load, stateDir);
}

export async function createCreatorMission(
	input: CreateCreatorMissionInput,
	options: CreateCreatorMissionOptions = {}
): Promise<CreatorMissionTrace> {
	const brief = input.brief?.trim();
	if (!brief) {
		throw new Error('brief is required');
	}
	const now = options.now?.() ?? new Date();
	const createdAt = now.toISOString();
	const missionId = input.missionId?.trim() || `mission-creator-${Date.now()}`;
	const requestId = input.requestId?.trim() || missionId;
	const executionPolicy = resolveCreatorExecutionPolicy(input, brief);
	const bundle = normalizeSparkQaOperatorBundle(
		{ ...input, brief },
		await resolveCreatorArtifactBundle({ ...input, brief }, options)
	);
	const intentPacket = bundle.intent_packet;
	const baseUrl = input.baseUrl?.replace(/\/+$/, '') || '';
	const canvasPath = creatorCanvasPath({ request_id: requestId, mission_id: missionId });
	const trace: CreatorMissionTrace = {
		schema_version: CREATOR_TRACE_SCHEMA_VERSION,
		trace_id: traceIdFromMissionId(missionId),
		intent_id: intentIdFromPacket(intentPacket, requestId),
		mission_id: missionId,
		request_id: requestId,
		creator_mode: creatorModeFromIntent(intentPacket),
		user_goal: brief,
		repo_root: null,
		artifacts: artifactPlanFromIntent(intentPacket),
		artifact_manifests: bundle.artifact_manifests,
		artifact_manifest_validation_issues: bundle.validation_issues,
		repo_changes: [],
		benchmarks: [],
		publish_readiness: 'private_draft',
		validation_runs: [],
		tasks: buildCreatorMissionTasks(intentPacket),
		validation_gates: validationGatesForCreatorIntent(intentPacket),
		current_stage: 'task_graph_created',
		stage_status: 'queued',
		execution_policy: executionPolicy,
		intent_packet: intentPacket,
		specialization_entry: buildSpecializationEntry(intentPacket),
		benchmark_summary: {
			baseline_score: null,
			candidate_score: null,
			delta: null,
			held_out_pass: false
		},
		improvement_evidence: initialImprovementEvidence(intentPacket),
		swarm: {
			payload_ready: false,
			api_ready: false,
			publish_mode: intentPacket.privacy_mode === 'swarm_shared' ? 'swarm_shared' : intentPacket.privacy_mode
		},
		telegram_relay: input.telegramRelay ?? null,
		telegram_chat_id: input.chatId?.trim() || null,
		telegram_user_id: input.userId?.trim() || null,
		blockers: [],
		links: {
			canvas: baseUrl ? `${baseUrl}${canvasPath}` : canvasPath,
			kanban: baseUrl ? `${baseUrl}/kanban?mission=${encodeURIComponent(missionId)}` : '',
			repo: '',
			pull_request: ''
		},
		created_at: createdAt,
		updated_at: createdAt
	};
	if (options.queueCanvas !== false) {
		await queueCreatorMissionCanvasLoad(trace, options.stateDir);
	}
	await saveCreatorMissionTrace(trace, options.stateDir);
	return trace;
}

export async function saveCreatorMissionTrace(trace: CreatorMissionTrace, stateDir = spawnerStateDir()): Promise<void> {
	const dir = creatorMissionDir(stateDir);
	await mkdir(dir, { recursive: true });
	const filePath = creatorMissionPath(trace.mission_id, stateDir);
	const tempPath = `${filePath}.${randomUUID()}.tmp`;
	await writeFile(tempPath, JSON.stringify(trace, null, 2), 'utf-8');
	await rename(tempPath, filePath);
}

function parseCreatorMissionTraceFile(raw: string): CreatorMissionTrace | null {
	try {
		return JSON.parse(raw) as CreatorMissionTrace;
	} catch {
		return null;
	}
}

export async function readCreatorMissionTrace(
	input: { missionId?: string | null; requestId?: string | null },
	stateDir = spawnerStateDir()
): Promise<CreatorMissionTrace | null> {
	const missionId = input.missionId?.trim();
	if (missionId) {
		if (!validateMissionId(missionId)) {
			console.error(`Invalid missionId format: ${missionId}`);
			return null;
		}
		const filePath = creatorMissionPath(missionId, stateDir);
		if (!existsSync(filePath)) return null;
		return parseCreatorMissionTraceFile(await readFile(filePath, 'utf-8'));
	}
	const requestId = input.requestId?.trim();
	if (!requestId) return null;
	const dir = creatorMissionDir(stateDir);
	if (!existsSync(dir)) return null;
	for (const file of await readdir(dir)) {
		if (!file.endsWith('.json')) continue;
		const trace = parseCreatorMissionTraceFile(await readFile(path.join(dir, file), 'utf-8'));
		if (trace && trace.request_id === requestId) return trace;
	}
	return null;
}

function executableCreatorMissionCanvasLoad(trace: CreatorMissionTrace, executionAuthority: unknown): CreatorMissionCanvasLoad {
	const load = creatorMissionCanvasLoad(trace);
	return {
		...load,
		autoRun: true,
		executionAuthority,
		relay: {
			...(load.relay as Record<string, unknown>),
			autoRun: true,
			executionAuthority
		}
	} as unknown as CreatorMissionCanvasLoad;
}

export async function executeCreatorMission(
	input: ExecuteCreatorMissionInput,
	options: ExecuteCreatorMissionOptions = {}
): Promise<{ trace: CreatorMissionTrace; load: CreatorMissionCanvasLoad; dispatch: PrdAutoDispatchResult }> {
	const trace = await readCreatorMissionTrace(input, options.stateDir);
	if (!trace) {
		throw new Error('creator mission trace not found');
	}
	if (trace.stage_status === 'published') {
		throw new Error('creator mission is already published');
	}
	const blockedReason = creatorMissionExecutionBlockedReason(trace);
	if (blockedReason) {
		throw new Error(blockedReason);
	}
	assertNativeGovernorHarnessAuthority({
		authority: resolveExecutionAuthority(options.executionAuthority),
		toolName: 'spawner.dispatch',
		ownerSystem: 'spawner-ui',
		mutationClass: 'launches_mission',
		requestId: trace.request_id
	});

	const now = options.now?.() ?? new Date();
	const load = await writeCreatorMissionCanvasLoad(executableCreatorMissionCanvasLoad(trace, options.executionAuthority), options.stateDir);
	const runner = options.dispatchRunner || activeCreatorDispatchRunner || ((candidate: CreatorMissionCanvasLoad) =>
		autoDispatchPrdCanvasLoad(candidate, { allowExistingNonTerminalMission: true }));
	const dispatch = await runner(load);

	trace.current_stage = dispatch.started
		? 'execution_started'
		: dispatch.skipped
			? 'execution_skipped'
			: 'execution_failed';
	trace.stage_status = dispatch.started || dispatch.skipped ? 'running' : 'failed';
	trace.updated_at = now.toISOString();
	if (dispatch.error && !trace.blockers.includes(dispatch.error)) {
		trace.blockers.push(dispatch.error);
	}
	await saveCreatorMissionTrace(trace, options.stateDir);

	return { trace, load, dispatch };
}

const VALIDATION_EXECUTABLE_ALLOWLIST = new Set(['node', 'python', 'python3', 'py', 'npm', 'npx', 'pnpm', 'spark-intelligence']);

// Interpreters that accept flags to execute arbitrary code snippets.
const INTERPRETER_EXECUTABLES = new Set(['node', 'python', 'python3', 'py']);
// Flags that cause interpreters to evaluate an arbitrary code string from the argument
// line (or read a program from stdin).
// A command like `python -c "os.system('rm -rf /')"` would pass the allowlist
// because only the executable name is checked. These inline-eval flags must be rejected.
// Covers node (-e/--eval, -p/--print), python (-c/--command) and the bare `-`
// stdin-program form. This list must include every interpreter flag that evaluates an
// argument string or stdin program rather than naming a script/module on disk.
//
// NOTE: `-m`/`--module` is intentionally NOT listed. `python -m <module>` runs a named,
// importable module (e.g. `python -m pytest tests`) — it executes installed code on disk,
// exactly like running a script file, and never evaluates an arbitrary inline string. It
// is a first-class validation pattern here (the default manifest validation command is
// `python -m pytest tests`, and the planner shells out `python -m spark_intelligence.cli`),
// so blocking it would break legitimate runs.
const DANGEROUS_INTERPRETER_FLAGS = new Set([
	'-c',
	'--command',
	'-e',
	'--eval',
	'-p',
	'--print',
	'-'
]);

function splitCommandLine(command: string): string[] {
	const parts: string[] = [];
	let current = '';
	let quote: '"' | "'" | null = null;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				parts.push(current);
				current = '';
			}
			continue;
		}
		current += char;
	}
	if (quote) {
		throw new Error(`Unclosed quote in validation command: ${command}`);
	}
	if (current) parts.push(current);
	return parts;
}

function tailText(value: unknown, maxLength = 6000): string {
	const text = String(value ?? '');
	return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

interface ResolvedValidationCommand {
	executable: string;
	args: string[];
}

function packageManagerCliPath(executable: string): string | null {
	const npmExecPath = process.env.npm_execpath;
	if (!npmExecPath || !existsSync(npmExecPath)) return null;
	const execName = path.basename(npmExecPath).toLowerCase();
	const execDir = path.dirname(npmExecPath);
	if (executable === 'npm' && execName === 'npm-cli.js') return npmExecPath;
	if (executable === 'npx') {
		const npxCliPath = path.join(execDir, 'npx-cli.js');
		return existsSync(npxCliPath) ? npxCliPath : null;
	}
	if (executable === 'pnpm' && execName.includes('pnpm')) return npmExecPath;
	return null;
}

function resolveValidationCommand(executable: string, args: string[]): ResolvedValidationCommand {
	if (process.platform !== 'win32') return { executable, args };
	if (executable === 'npm' || executable === 'npx' || executable === 'pnpm') {
		const cliPath = packageManagerCliPath(executable);
		if (cliPath) {
			return { executable: process.execPath, args: [cliPath, ...args] };
		}
	}
	return { executable, args };
}

function resolveCreatorRepoRoot(repo: string): string {
	return path.isAbsolute(repo) ? repo : path.join(creatorWorkspaceRoot(), repo);
}

function creatorArtifactSlug(value: string | undefined): string {
	return (value || 'target-domain')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '') || 'target-domain';
}

async function candidateCreatorArtifactRoots(
	trace: CreatorMissionTrace,
	stateDir?: string
): Promise<string[]> {
	const slug = creatorArtifactSlug(trace.intent_packet?.target_domain || trace.intent_id || trace.mission_id);
	const candidateBases = [
		trace.repo_root ? path.join(trace.repo_root, 'creator-artifacts') : null,
		stateDir ? path.join(stateDir, 'creator-artifacts') : null,
		path.join(process.cwd(), 'creator-artifacts'),
		path.join(creatorWorkspaceRoot(), 'source', 'creator-artifacts'),
		path.join(creatorWorkspaceRoot(), 'creator-artifacts')
	].filter((entry): entry is string => Boolean(entry));
	const roots: string[] = [];
	const seen = new Set<string>();
	const addRoot = (root: string) => {
		const resolved = path.resolve(root);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		roots.push(resolved);
	};

	for (const base of candidateBases) {
		addRoot(path.join(base, `${slug}-benchmark`));
		addRoot(path.join(base, slug));
		try {
			for (const entry of await readdir(base, { withFileTypes: true })) {
				if (entry.isDirectory()) addRoot(path.join(base, entry.name));
			}
		} catch {
			// Candidate roots are opportunistic; absence just means no local artifact bundle is attached.
		}
	}
	return roots;
}

async function findCreatorLocalArtifactManifest(
	trace: CreatorMissionTrace,
	stateDir?: string
): Promise<{ root: string; manifest: Record<string, unknown> } | null> {
	for (const root of await candidateCreatorArtifactRoots(trace, stateDir)) {
		const manifest = await readJsonIfPresent(path.join(root, 'artifact_manifest.json'));
		if (!manifest) continue;
		const missionId = stringOrUndefined(manifest.mission_id);
		if (missionId && missionId !== trace.mission_id) continue;
		return { root, manifest };
	}
	return null;
}

async function localArtifactValidationManifests(
	trace: CreatorMissionTrace,
	stateDir?: string
): Promise<CreatorArtifactManifest[]> {
	const local = await findCreatorLocalArtifactManifest(trace, stateDir);
	if (!local) return [];
	const commands = stringArray(local.manifest.validation_commands);
	if (commands.length === 0) return [];
	const artifacts = Array.isArray(local.manifest.artifacts)
		? local.manifest.artifacts
			.map((artifact) => recordOrNull(artifact))
			.filter((artifact): artifact is Record<string, unknown> => Boolean(artifact))
		: [];
	const outputs = artifacts
		.map((artifact) => stringOrUndefined(artifact.path))
		.filter((item): item is string => Boolean(item));
	return [{
		schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
		artifact_id: stringOrUndefined(local.manifest.artifact_set_id) || `${trace.mission_id}-creator-artifact-bundle`,
		artifact_type: 'creator_report',
		repo: process.cwd(),
		inputs: [trace.intent_id],
		outputs: outputs.length > 0 ? outputs : ['artifact_manifest.json'],
		validation_commands: commands,
		promotion_gates: stringArray(local.manifest.promotion_gates),
		rollback_plan: stringOrUndefined(local.manifest.rollback_plan) || 'Remove the local creator artifact bundle.'
	}];
}

async function defaultCreatorValidationCommandRunner(
	executable: string,
	args: string[],
	options: { cwd: string; timeoutMs: number }
): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
	try {
		const { stdout, stderr } = await execFileAsync(executable, args, {
			cwd: options.cwd,
			timeout: options.timeoutMs,
			windowsHide: true,
			maxBuffer: 1024 * 1024
		});
		return { exitCode: 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
	} catch (error) {
		const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
		const code = typeof failure.code === 'number' ? failure.code : 1;
		return {
			exitCode: code,
			stdout: String(failure.stdout || ''),
			stderr: String(failure.stderr || failure.message || '')
		};
	}
}

async function runCreatorValidationCommand(
	manifest: CreatorArtifactManifest,
	command: string,
	options: Required<Pick<ValidateCreatorMissionOptions, 'timeoutMs'>> & Pick<ValidateCreatorMissionOptions, 'commandRunner'>
): Promise<CreatorValidationCommandResult> {
	const cwd = resolveCreatorRepoRoot(manifest.repo);
	if (!existsSync(cwd)) {
		return {
			artifact_id: manifest.artifact_id,
			artifact_type: manifest.artifact_type,
			repo: manifest.repo,
			command,
			cwd,
			status: 'failed',
			exit_code: null,
			stdout_tail: '',
			stderr_tail: '',
			error:
				`Repository path not found: ${cwd}. ` +
				`Set SPARK_CREATOR_WORKSPACE_ROOT to the absolute path of the directory that holds your creator-mission repo checkouts ` +
				`(or place '${manifest.repo}' one directory up from the spawner-ui working directory).`
		};
	}
	let parts: string[];
	try {
		parts = splitCommandLine(command);
	} catch (error) {
		return {
			artifact_id: manifest.artifact_id,
			artifact_type: manifest.artifact_type,
			repo: manifest.repo,
			command,
			cwd,
			status: 'failed',
			exit_code: null,
			stdout_tail: '',
			stderr_tail: '',
			error: error instanceof Error ? error.message : 'Unable to parse validation command'
		};
	}
	const executable = parts[0];
	const args = parts.slice(1);
	if (!VALIDATION_EXECUTABLE_ALLOWLIST.has(executable)) {
		return {
			artifact_id: manifest.artifact_id,
			artifact_type: manifest.artifact_type,
			repo: manifest.repo,
			command,
			cwd,
			status: 'skipped',
			exit_code: null,
			stdout_tail: '',
			stderr_tail: '',
			error: `Validation executable is not allowlisted: ${executable}`
		};
	}
	// Reject interpreters invoked with flags that execute arbitrary code snippets.
	if (INTERPRETER_EXECUTABLES.has(executable)) {
		const hasDangerousFlag = args.some((arg) => DANGEROUS_INTERPRETER_FLAGS.has(arg));
		if (hasDangerousFlag) {
			return {
				artifact_id: manifest.artifact_id,
				artifact_type: manifest.artifact_type,
				repo: manifest.repo,
				command,
				cwd,
				status: 'skipped',
				exit_code: null,
				stdout_tail: '',
				stderr_tail: '',
				error: `Interpreter executable '${executable}' is not permitted with code-execution flags. Use a script file instead.`
			};
		}
	}
	const runner = options.commandRunner || activeCreatorValidationCommandRunner || defaultCreatorValidationCommandRunner;
	const resolved = options.commandRunner ? { executable, args } : resolveValidationCommand(executable, args);
	const result = await runner(resolved.executable, resolved.args, { cwd, timeoutMs: options.timeoutMs });
	return {
		artifact_id: manifest.artifact_id,
		artifact_type: manifest.artifact_type,
		repo: manifest.repo,
		command,
		cwd,
		status: result.exitCode === 0 ? 'passed' : 'failed',
		exit_code: result.exitCode,
		stdout_tail: tailText(result.stdout),
		stderr_tail: tailText(result.stderr),
		error: result.exitCode === 0 ? null : 'Validation command exited non-zero'
	};
}

export async function validateCreatorMission(
	input: ValidateCreatorMissionInput,
	options: ValidateCreatorMissionOptions = {}
): Promise<{ trace: CreatorMissionTrace; run: CreatorValidationRun }> {
	const trace = await readCreatorMissionTrace(input, options.stateDir);
	if (!trace) {
		throw new Error('creator mission trace not found');
	}
	const now = options.now?.() ?? new Date();
	const startedAt = now.toISOString();
	const maxCommands = Math.max(1, input.maxCommands ?? options.maxCommands ?? 20);
	const timeoutMs = options.timeoutMs ?? 120_000;
	const commandRunner = options.commandRunner || activeCreatorValidationCommandRunner || undefined;
	const pendingCommands: Array<{ manifest: CreatorArtifactManifest; command: string }> = [];
	const results: CreatorValidationCommandResult[] = [];
	const localValidationManifests = await localArtifactValidationManifests(trace, options.stateDir);
	const validationManifests = localValidationManifests.length > 0 ? localValidationManifests : trace.artifact_manifests || [];

	for (const manifest of validationManifests) {
		for (const command of manifest.validation_commands || []) {
			if (pendingCommands.length >= maxCommands) break;
			pendingCommands.push({ manifest, command });
		}
		if (pendingCommands.length >= maxCommands) break;
	}

	assertNativeGovernorHarnessAuthority({
		authority: resolveExecutionAuthority(options.executionAuthority),
		toolName: 'spawner.creator.validate',
		ownerSystem: 'spawner-ui',
		mutationClass: 'writes_files'
	});

	for (const [index, item] of pendingCommands.entries()) {
		const commandIndex = index + 1;
		await options.onCommandProgress?.({
			phase: 'started',
			index: commandIndex,
			total: pendingCommands.length,
			manifest: item.manifest,
			command: item.command
		});
		const result = await runCreatorValidationCommand(item.manifest, item.command, { timeoutMs, commandRunner });
		results.push(result);
		await options.onCommandProgress?.({
			phase: 'completed',
			index: commandIndex,
			total: pendingCommands.length,
			manifest: item.manifest,
			command: item.command,
			result
		});
	}

	const completedAt = (options.now?.() ?? new Date()).toISOString();
	const hasFailure = results.some((result) => result.status === 'failed');
	const hasSkipped = results.some((result) => result.status === 'skipped');
	const runStatus: CreatorValidationRun['status'] = hasFailure ? 'failed' : hasSkipped ? 'blocked' : 'passed';
	const run: CreatorValidationRun = {
		schema_version: 'spark-creator-validation-run.v1',
		run_id: `creator-validation-${trace.mission_id}-${Date.now()}`,
		mission_id: trace.mission_id,
		started_at: startedAt,
		completed_at: completedAt,
		status: runStatus,
		results
	};

	trace.validation_runs = [...(trace.validation_runs || []), run];
	if (runStatus === 'passed') {
		applyImprovementEvidenceFromLedger(trace, await findCreatorValidationLedger(trace, options.stateDir), run);
	}
	applyCreatorMissionStatusPacket(trace, await findCreatorMissionStatusPacket(trace, options.stateDir));
	applyCreatorValidationReadiness(trace, runStatus);
	trace.updated_at = completedAt;
	if (runStatus === 'passed') {
		clearValidationCommandFailureBlockers(trace);
	} else {
		const blocker = runStatus === 'blocked' ? 'One or more validation commands were skipped.' : 'One or more validation commands failed.';
		addCreatorBlocker(trace, blocker);
	}
	await saveCreatorMissionTrace(trace, options.stateDir);
	return { trace, run };
}
