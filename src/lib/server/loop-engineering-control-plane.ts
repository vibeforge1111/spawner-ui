import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { env as privateEnv } from '$env/dynamic/private';
import { spawnerStateDir } from './spawner-state';
import { writeFileAtomic } from './atomic-write';
import { relayMissionControlEvent } from './mission-control-relay';
import {
	missionControlPathForMission,
	resolveMissionControlAccess
} from './mission-control-access';
import { providerRuntime, type ProviderMissionResultSnapshot } from './provider-runtime';
import { applyProviderEnvOverrides, isConfiguredApiKey } from './provider-config';
import {
	DEFAULT_MULTI_LLM_PROVIDERS,
	type MultiLLMExecutionPack,
	type MultiLLMProviderConfig
} from '$lib/services/multi-llm-orchestrator';
import type {
	LoopEngineeringEvent,
	LoopEngineeringEventStatus,
	LoopEngineeringEventType
} from './loop-engineering-registry';

type JsonRecord = Record<string, unknown>;

export class LoopEngineeringProviderProofError extends Error {
	public readonly publicMessage: string;

	constructor(publicMessage: string, internalMessage?: string) {
		super(internalMessage || publicMessage);
		this.name = 'LoopEngineeringProviderProofError';
		this.publicMessage = publicMessage;
	}
}

export function publicLoopEngineeringErrorMessage(error: unknown, fallback: string): string {
	return error instanceof LoopEngineeringProviderProofError ? error.publicMessage : fallback;
}

export type BenchmarkCaseKind = 'visible' | 'held_out' | 'trap' | 'no_op' | 'regression';
export type BenchmarkCaseStatus = 'active' | 'paused' | 'retired';
export type LoopScheduleMode = 'once' | 'interval' | 'fixed_time' | 'continuous' | 'round_count';
export type LoopScheduleStatus = 'staged' | 'paused' | 'blocked' | 'cancelled' | 'deactivated';
export type LoopScheduleLifecycleAction = 'pause' | 'resume' | 'cancel' | 'deactivate';
export type ActivationMode = 'manual' | 'suggested' | 'local_fast_path';
export type ActivationRuleStatus = 'staged' | 'paused' | 'blocked';
export type LoopEngineeringRunKind = 'benchmark' | 'loop';
export type LoopEngineeringDistillationStatus = 'staged' | 'accepted' | 'blocked';
export type LoopEngineeringEvidenceProvenance = 'synthetic' | 'computed' | 'seeded';
export type LoopEngineeringExecutionMode = 'synthetic' | 'computed';

export interface LoopEngineeringBenchmarkCase {
	id: string;
	chipKey: string;
	kind: BenchmarkCaseKind;
	prompt: string;
	expectedBehavior: string;
	scoringRubricRef: string | null;
	createdBy: 'user' | 'reviewer' | 'evaluator' | 'import';
	status: BenchmarkCaseStatus;
	evidenceRefs: string[];
	createdAt: string;
	updatedAt: string;
}

export interface LoopEngineeringSchedule {
	id: string;
	chipKey: string;
	name: string;
	mode: LoopScheduleMode;
	benchmarkCaseIds?: string[];
	generatorProviderId?: string | null;
	evaluatorProviderId?: string | null;
	waitForCompletionMs?: number | null;
	intervalMinutes: number | null;
	fixedLocalTime: string | null;
	timezone: string | null;
	roundLimit: number;
	stopConditions: string[];
	active: boolean;
	status: LoopScheduleStatus;
	createdAt: string;
	updatedAt: string;
	nextRunAt: string | null;
	lastRunAt: string | null;
	runCount: number;
	lastEventId: string | null;
}

export interface LoopEngineeringActivationRule {
	id: string;
	chipKey: string;
	useCase: string;
	surfaces: Array<'telegram' | 'spawner' | 'builder' | 'codex' | 'scheduler'>;
	mode: ActivationMode;
	triggerPatterns: string[];
	nonTriggerPatterns: string[];
	riskPolicy: 'low_only' | 'review_packet' | 'loop_mode_required';
	approvalRequired: boolean;
	rollbackRef: string | null;
	status: ActivationRuleStatus;
	createdAt: string;
	updatedAt: string;
	lastEventId: string | null;
}

export interface LoopEngineeringDistillation {
	id: string;
	chipKey: string;
	sourceEvaluatorEventId: string;
	lessons: string[];
	runtimeNotes: string;
	tokenBudgetHint: string | null;
	status: LoopEngineeringDistillationStatus;
	evidenceRefs: string[];
	createdAt: string;
	updatedAt: string;
	lastEventId: string | null;
}

export interface LoopEngineeringCommandResult {
	action: string;
	chipKey?: string;
	changed: boolean;
	launchedMission: boolean;
	missionId?: string;
	eventId?: string;
	inspectUrl?: string;
	blockedReason?: string;
	benchmarkRunId?: string;
	loopRunId?: string;
	evaluatorVerdictRef?: string;
	provenance?: LoopEngineeringEvidenceProvenance;
	previousScore?: number;
	candidateScore?: number;
	utilityDelta?: number;
	caseCount?: number;
	roundsObserved?: number;
	userMessage: string;
}

export interface LoopEngineeringComputedRunOptions {
	mode?: LoopEngineeringExecutionMode;
	generatorProviderId?: string | null;
	evaluatorProviderId?: string | null;
	dispatchExecutionAuthority?: unknown;
	waitForCompletionMs?: number | null;
}

export interface LoopEngineeringProviderProofPreview {
	mode: 'computed';
	generator: {
		id: string;
		label: string;
		model: string;
	};
	evaluator: {
		id: string;
		label: string;
		model: string;
	};
	waitForCompletionMs: number;
}

interface ListBenchmarkCasesOptions {
	includeArtifactCases?: boolean;
	chipRoot?: string | null;
}

interface ArtifactBenchmarkCaseInput {
	id: string;
	kind: BenchmarkCaseKind;
	prompt: string;
	expectedBehavior: string;
	evidenceRefs: string[];
}

export interface LoopEngineeringBenchmarkCaseScore {
	caseId: string;
	kind: BenchmarkCaseKind;
	prompt: string;
	expectedBehavior: string;
	baselineScore: number;
	candidateScore: number;
	utilityDelta: number;
	baselineMatchedSignals: string[];
	candidateMatchedSignals: string[];
	verdict: 'candidate_wins' | 'baseline_wins' | 'tie';
}

export interface LoopEngineeringBenchmarkRunPacket {
	runId: string;
	chipKey: string;
	eventId: string;
	missionId: string;
	createdAt: string;
	status: 'passed' | 'failed' | 'blocked';
	blindComparison: boolean;
	evaluatorSeparated: boolean;
	provenance?: LoopEngineeringEvidenceProvenance;
	evaluatorModel: string;
	evaluatorProvider?: string;
	generatorProvider?: string;
	sourceRef: string;
	evaluatorVerdictRef: string;
	generatorOutputRef: string;
	sourceKeyRef: string;
	previousScore: number;
	candidateScore: number;
	utilityDelta: number;
	caseResults: LoopEngineeringBenchmarkCaseScore[];
	claimBoundary: string;
	nextAction: string;
}

export interface LoopEngineeringLoopRunPacket {
	runId: string;
	chipKey: string;
	eventId: string;
	missionId: string;
	createdAt: string;
	status: 'passed' | 'failed' | 'blocked';
	blindComparison: boolean;
	evaluatorSeparated: boolean;
	provenance?: LoopEngineeringEvidenceProvenance;
	evaluatorModel: string;
	evaluatorProvider?: string;
	generatorProvider?: string;
	roundsObserved: number;
	sourceRef: string;
	evaluatorVerdictRef: string;
	generatorOutputRef: string;
	sourceKeyRef: string;
	loopPlanRef: string;
	previousScore: number;
	candidateScore: number;
	utilityDelta: number;
	caseResults: LoopEngineeringBenchmarkCaseScore[];
	acceptedLessons: string[];
	claimBoundary: string;
	nextAction: string;
}

export type LoopEngineeringCompletionStatus = Extract<LoopEngineeringEventStatus, 'passed' | 'failed' | 'blocked'>;

interface LoopEngineeringControlPlaneState {
	schema_version: 'spark.loop_engineering_control_plane.v1';
	updated_at: string;
	events: LoopEngineeringEvent[];
	benchmark_cases: LoopEngineeringBenchmarkCase[];
	schedules: LoopEngineeringSchedule[];
	activation_rules: LoopEngineeringActivationRule[];
	distillations: LoopEngineeringDistillation[];
}

function stateFilePath(): string {
	return path.join(spawnerStateDir(), 'loop-engineering', 'control-plane.json');
}

function nowIso(): string {
	return new Date().toISOString();
}

function nextId(prefix: string): string {
	return `${prefix}-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

function cleanString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function isSafeEvidencePath(value: string, prefix: 'reports' | 'distilled-runtime' | 'benchmark'): boolean {
	if (!value.startsWith(`${prefix}/`)) return false;
	if (value.includes('..') || value.includes('\\') || value.includes('//')) return false;
	return new RegExp(`^${prefix}/[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._-]+)?$`).test(value);
}

function isSafeEvidenceId(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{1,160}$/.test(value);
}

function isValidLoopEngineeringEvidenceRef(value: string): boolean {
	const ref = value.trim();
	if (!ref) return false;
	if (ref === 'spark-chip.json') return true;
	if (
		isSafeEvidencePath(ref, 'reports') ||
		isSafeEvidencePath(ref, 'distilled-runtime') ||
		isSafeEvidencePath(ref, 'benchmark')
	) return true;
	if (ref.startsWith('mission-control:') || ref.startsWith('trace:')) {
		const [, id = ''] = ref.split(':');
		return isSafeEvidenceId(id);
	}
	if (!ref.startsWith('control-plane:')) return false;
	const [, collection = '', ...rest] = ref.split(':');
	const allowedCollections = new Set([
		'benchmark_cases',
		'benchmark_runs',
		'loop_runs',
		'schedules',
		'activation_rules',
		'distillations'
	]);
	if (!allowedCollections.has(collection)) return false;
	if (collection === 'benchmark_runs' || collection === 'loop_runs') {
		const [runId = '', fileName = ''] = rest;
		return rest.length === 2 && isSafeEvidenceId(runId) && /^[A-Za-z0-9._-]+\.json$/.test(fileName);
	}
	const [id = ''] = rest;
	return rest.length === 1 && isSafeEvidenceId(id);
}

function evidenceRefList(value: unknown, fieldName = 'evidenceRefs'): string[] {
	const refs = stringList(value).map((item) => item.trim());
	const invalid = refs.find((ref) => !isValidLoopEngineeringEvidenceRef(ref));
	if (invalid) throw new Error(`${fieldName} contains invalid evidence ref: ${invalid}`);
	return uniqueStrings(refs);
}

function legacyEvidenceRefList(value: unknown): string[] {
	return uniqueStrings(stringList(value).map((item) => item.trim()).filter(isValidLoopEngineeringEvidenceRef));
}

function legacyOptionalEvidenceRef(value: unknown): string | null {
	const ref = cleanString(value);
	return ref && isValidLoopEngineeringEvidenceRef(ref) ? ref : null;
}

function optionalEvidenceRef(value: unknown, fieldName: string): string | null {
	const ref = cleanString(value);
	if (!ref) return null;
	if (!isValidLoopEngineeringEvidenceRef(ref)) throw new Error(`${fieldName} contains invalid evidence ref: ${ref}`);
	return ref;
}

export function safeLoopEngineeringChipKey(value: string): string | null {
	const clean = value.trim().toLowerCase();
	if (!clean.startsWith('domain-chip-')) return null;
	if (!/^domain-chip-[a-z0-9][a-z0-9-]{2,}$/.test(clean)) return null;
	return clean;
}

function emptyState(): LoopEngineeringControlPlaneState {
	return {
		schema_version: 'spark.loop_engineering_control_plane.v1',
		updated_at: nowIso(),
		events: [],
		benchmark_cases: [],
		schedules: [],
		activation_rules: [],
		distillations: []
	};
}

async function readState(): Promise<LoopEngineeringControlPlaneState> {
	try {
		const parsed = JSON.parse(await readFile(stateFilePath(), 'utf-8')) as Partial<LoopEngineeringControlPlaneState>;
		return {
			schema_version: 'spark.loop_engineering_control_plane.v1',
			updated_at: cleanString(parsed.updated_at) || nowIso(),
			events: Array.isArray(parsed.events)
				? parsed.events
					.filter((event): event is LoopEngineeringEvent => Boolean(event && event.id))
					.map((event) => ({
						...event,
						label:
							event.eventType === 'benchmark_run' && event.commandResult?.action === 'benchmark_run_executed'
								? 'Private benchmark run executed'
								: event.label,
						roundsObserved:
							event.eventType === 'benchmark_run' && typeof event.commandResult?.caseCount === 'number'
								? null
								: event.roundsObserved,
						evidenceRefs: legacyEvidenceRefList(event.evidenceRefs),
						sourceRef: legacyOptionalEvidenceRef(event.sourceRef),
						evaluatorVerdictRef: legacyOptionalEvidenceRef(event.evaluatorVerdictRef)
					}))
				: [],
			benchmark_cases: Array.isArray(parsed.benchmark_cases)
				? parsed.benchmark_cases
					.filter((item): item is LoopEngineeringBenchmarkCase => Boolean(item && item.id))
					.map((item) => ({
						...item,
						evidenceRefs: legacyEvidenceRefList(item.evidenceRefs)
					}))
				: [],
			schedules: Array.isArray(parsed.schedules)
				? parsed.schedules.filter((item): item is LoopEngineeringSchedule => Boolean(item && item.id))
				: [],
			activation_rules: Array.isArray(parsed.activation_rules)
				? parsed.activation_rules.filter((item): item is LoopEngineeringActivationRule => Boolean(item && item.id))
				: [],
			distillations: Array.isArray(parsed.distillations)
				? parsed.distillations
					.filter((item): item is LoopEngineeringDistillation => Boolean(item && item.id))
					.map((item) => ({
						...item,
						evidenceRefs: legacyEvidenceRefList(item.evidenceRefs)
					}))
				: []
		};
	} catch {
		return emptyState();
	}
}

async function writeState(state: LoopEngineeringControlPlaneState): Promise<void> {
	const filePath = stateFilePath();
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFileAtomic(filePath, JSON.stringify({ ...state, updated_at: nowIso() }, null, 2));
}

export async function listPersistedLoopEngineeringEvents(chipKey?: string): Promise<LoopEngineeringEvent[]> {
	const clean = chipKey ? safeLoopEngineeringChipKey(chipKey) : null;
	const state = await readState();
	return state.events
		.filter((event) => !clean || event.chipId === clean)
		.map((event) => ({ ...event, evidenceRefs: [...event.evidenceRefs] }));
}

function defaultLoopEngineeringChipsRoot(): string {
	return path.resolve(process.env.SPARK_DOMAIN_CHIPS_ROOT || path.join(os.homedir(), '.spark', 'chips'));
}

function artifactChipRoot(chipKey: string, configuredRoot?: string | null): string | null {
	const clean = safeLoopEngineeringChipKey(chipKey);
	if (!clean) return null;
	if (configuredRoot) {
		const resolved = path.resolve(configuredRoot);
		if (path.basename(resolved) === clean) return resolved;
	}
	const chipsRoot = defaultLoopEngineeringChipsRoot();
	const resolved = path.join(chipsRoot, clean);
	return path.dirname(resolved) === chipsRoot ? resolved : null;
}

function parseJsonlRecords(text: string): JsonRecord[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const parsed = JSON.parse(line);
				return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? [parsed as JsonRecord] : [];
			} catch {
				return [];
			}
		});
}

function artifactBenchmarkKind(lane: unknown): BenchmarkCaseKind {
	const clean = cleanString(lane).toLowerCase();
	if (clean === 'held_out' || clean === 'held-out') return 'held_out';
	if (clean === 'no_op' || clean === 'no-op') return 'no_op';
	if (clean === 'adversarial' || clean === 'trap') return 'trap';
	if (clean === 'regression') return 'regression';
	return 'visible';
}

async function readArtifactBenchmarkCases(chipKey: string, chipRoot?: string | null): Promise<LoopEngineeringBenchmarkCase[]> {
	const root = artifactChipRoot(chipKey, chipRoot);
	if (!root) return [];
	const files: Array<{ relativePath: string; type: 'case' | 'trap' }> = [
		{ relativePath: path.join('benchmark', 'cases.jsonl'), type: 'case' },
		{ relativePath: path.join('benchmark', 'traps.jsonl'), type: 'trap' }
	];
	const imported: ArtifactBenchmarkCaseInput[] = [];
	for (const file of files) {
		const absolutePath = path.join(root, file.relativePath);
		let records: JsonRecord[];
		try {
			records = parseJsonlRecords(await readFile(absolutePath, 'utf8'));
		} catch {
			continue;
		}
		for (const record of records) {
			const sourceId = cleanString(record.case_id) || cleanString(record.trap_id) || cleanString(record.id);
			const prompt = cleanString(record.prompt);
			const expectedBehavior = file.type === 'trap'
				? cleanString(record.expected_block) || cleanString(record.expectedBehavior) || cleanString(record.expected_behavior)
				: cleanString(record.expected_behavior) || cleanString(record.expectedBehavior) || cleanString(record.expected_block);
			if (!sourceId || !prompt || !expectedBehavior) continue;
			imported.push({
				id: `artifact-${file.type}-${sourceId}`,
				kind: file.type === 'trap' ? 'trap' : artifactBenchmarkKind(record.lane),
				prompt,
				expectedBehavior,
				evidenceRefs: [`${file.relativePath.replaceAll(path.sep, '/')}#${sourceId}`]
			});
		}
	}
	const timestamp = nowIso();
	return imported.map((item) => ({
		id: item.id,
		chipKey,
		kind: item.kind,
		prompt: item.prompt,
		expectedBehavior: item.expectedBehavior,
		scoringRubricRef: null,
		createdBy: 'import',
		status: 'active',
		evidenceRefs: item.evidenceRefs,
		createdAt: timestamp,
		updatedAt: timestamp
	}));
}

export async function listBenchmarkCases(
	chipKey: string,
	options: ListBenchmarkCasesOptions = {}
): Promise<LoopEngineeringBenchmarkCase[]> {
	const clean = safeLoopEngineeringChipKey(chipKey);
	if (!clean) return [];
	const state = await readState();
	const persisted = state.benchmark_cases
		.filter((item) => item.chipKey === clean)
		.map((item) => ({ ...item, evidenceRefs: [...item.evidenceRefs] }));
	if (!options.includeArtifactCases) return persisted;
	const artifactCases = await readArtifactBenchmarkCases(clean, options.chipRoot);
	const persistedIds = new Set(persisted.map((item) => item.id));
	return [
		...artifactCases.filter((item) => !persistedIds.has(item.id)),
		...persisted
	];
}

export async function listLoopSchedules(chipKey: string): Promise<LoopEngineeringSchedule[]> {
	const clean = safeLoopEngineeringChipKey(chipKey);
	if (!clean) return [];
	const state = await readState();
	return state.schedules
		.filter((item) => item.chipKey === clean)
		.map((item) => ({ ...item, stopConditions: [...item.stopConditions] }));
}

export async function listActivationRules(chipKey: string): Promise<LoopEngineeringActivationRule[]> {
	const clean = safeLoopEngineeringChipKey(chipKey);
	if (!clean) return [];
	const state = await readState();
	return state.activation_rules
		.filter((item) => item.chipKey === clean)
		.map((item) => ({
			...item,
			surfaces: [...item.surfaces],
			triggerPatterns: [...item.triggerPatterns],
			nonTriggerPatterns: [...item.nonTriggerPatterns]
		}));
}

export async function listDistillations(chipKey: string): Promise<LoopEngineeringDistillation[]> {
	const clean = safeLoopEngineeringChipKey(chipKey);
	if (!clean) return [];
	const state = await readState();
	return state.distillations
		.filter((item) => item.chipKey === clean)
		.map((item) => ({ ...item, lessons: [...item.lessons], evidenceRefs: [...item.evidenceRefs] }));
}

export async function appendLoopEngineeringEvent(input: {
	chipKey: string;
	chipName?: string;
	domain?: string;
	eventType: LoopEngineeringEventType;
	label: string;
	status: LoopEngineeringEventStatus;
	sourceSurface: LoopEngineeringEvent['sourceSurface'];
	previousScore?: number | null;
	candidateScore?: number | null;
	utilityDelta?: number | null;
	roundsObserved?: number | null;
	evaluatorSeparated?: boolean;
	provenance?: LoopEngineeringEvidenceProvenance | null;
	evidenceRefs?: string[];
	missionId?: string | null;
	scheduleId?: string | null;
	sourceRef?: string | null;
	evaluatorVerdictRef?: string | null;
	nextAction: string;
}): Promise<LoopEngineeringEvent> {
	const chipId = safeLoopEngineeringChipKey(input.chipKey);
	if (!chipId) throw new Error('valid domain-chip key required');
	let evaluatorSeparated = false;
	if (input.evaluatorSeparated === true && input.provenance === 'computed' && input.evaluatorVerdictRef) {
		await readEvaluatorVerdictPacket(input.evaluatorVerdictRef, chipId);
		evaluatorSeparated = true;
	}
	const event: LoopEngineeringEvent = {
		id: nextId('lee'),
		chipId,
		chipName: cleanString(input.chipName) || chipId,
		domain: cleanString(input.domain) || chipId.replace(/^domain-chip-/, ''),
		eventType: input.eventType,
		label: cleanString(input.label) || input.eventType,
		status: input.status,
		sourceSurface: input.sourceSurface,
		previousScore: typeof input.previousScore === 'number' ? input.previousScore : null,
		candidateScore: typeof input.candidateScore === 'number' ? input.candidateScore : null,
		utilityDelta: typeof input.utilityDelta === 'number' ? input.utilityDelta : null,
		roundsObserved: typeof input.roundsObserved === 'number' ? input.roundsObserved : null,
		evaluatorSeparated,
		...(input.provenance ? { provenance: input.provenance } : {}),
		evidenceRefs: stringList(input.evidenceRefs),
		...(cleanString(input.missionId) ? { missionId: cleanString(input.missionId) } : {}),
		...(cleanString(input.scheduleId) ? { scheduleId: cleanString(input.scheduleId) } : {}),
		...(cleanString(input.sourceRef) ? { sourceRef: cleanString(input.sourceRef) } : {}),
		...(cleanString(input.evaluatorVerdictRef) ? { evaluatorVerdictRef: cleanString(input.evaluatorVerdictRef) } : {}),
		nextAction: cleanString(input.nextAction) || 'Inspect the loop-engineering evidence before taking another action.',
		updatedAt: nowIso()
	};
	const state = await readState();
	state.events.push(event);
	await writeState(state);
	return { ...event, evidenceRefs: [...event.evidenceRefs] };
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function completionStatus(value: unknown): LoopEngineeringCompletionStatus | null {
	const clean = cleanString(value);
	if (clean === 'passed' || clean === 'failed' || clean === 'blocked') return clean;
	return null;
}

function terminalMissionRelayType(status: LoopEngineeringCompletionStatus): 'mission_completed' | 'mission_failed' {
	return status === 'passed' ? 'mission_completed' : 'mission_failed';
}

function validScore(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	return Math.max(0, Math.min(10, value));
}

export async function recordEvaluatorReview(input: {
	chipKey: string;
	sourceRunEventId?: string | null;
	label?: string;
	previousScore?: number | null;
	candidateScore?: number | null;
	roundsObserved?: number | null;
	evaluatorSeparated?: boolean;
	evidenceRefs?: string[];
	sourceSurface?: LoopEngineeringEvent['sourceSurface'];
	nextAction?: string;
}): Promise<{ event: LoopEngineeringEvent; commandResult: LoopEngineeringCommandResult }> {
	const chipKey = safeLoopEngineeringChipKey(input.chipKey);
	if (!chipKey) throw new Error('valid domain-chip key required');
	const state = await readState();
	const sourceRunEventId = cleanString(input.sourceRunEventId);
	if (!sourceRunEventId) throw new Error('sourceRunEventId required');
	const sourceRun = state.events.find((event) => event.id === sourceRunEventId && event.chipId === chipKey);
	if (!sourceRun || (sourceRun.eventType !== 'benchmark_run' && sourceRun.eventType !== 'loop_batch')) {
		throw new Error('source run event not found');
	}
	// Option B (doc 22 independent-signal rule / item 1.4): a synthetic SOURCE run is fine — promotability comes
	// from the REVIEW being separated (enforced by the input.evaluatorSeparated gate below), i.e. a real
	// different-provider judge validated the candidate. Synthetic self-review is still rejected, so synthetic
	// cannot self-promote.
	if (sourceRun.status !== 'passed' || (sourceRun.utilityDelta ?? 0) <= 0) {
		throw new Error('evaluator review requires a passed benchmark or loop run with positive utility delta');
	}
	if (!sourceRun.sourceRef || !sourceRun.evaluatorVerdictRef || sourceRun.evidenceRefs.length === 0) {
		throw new Error('source run must include evaluator verdict, source summary, and evidence refs');
	}
	const sourceRunSourceRef = optionalEvidenceRef(sourceRun.sourceRef, 'source run sourceRef');
	const sourceRunEvaluatorVerdictRef = optionalEvidenceRef(sourceRun.evaluatorVerdictRef, 'source run evaluatorVerdictRef');
	if (!sourceRunSourceRef || !sourceRunEvaluatorVerdictRef) {
		throw new Error('source run must include valid evaluator verdict and source refs');
	}
	const previousScore = validScore(sourceRun.previousScore);
	const candidateScore = validScore(sourceRun.candidateScore);
	if (previousScore === null) throw new Error('previousScore must be a number from 0 to 10');
	if (candidateScore === null) throw new Error('candidateScore must be a number from 0 to 10');
	const suppliedPreviousScore = input.previousScore === undefined || input.previousScore === null ? previousScore : validScore(input.previousScore);
	const suppliedCandidateScore = input.candidateScore === undefined || input.candidateScore === null ? candidateScore : validScore(input.candidateScore);
	if (suppliedPreviousScore === null || Math.abs(suppliedPreviousScore - previousScore) > 0.001) {
		throw new Error('previousScore must match the source run score');
	}
	if (suppliedCandidateScore === null || Math.abs(suppliedCandidateScore - candidateScore) > 0.001) {
		throw new Error('candidateScore must match the source run score');
	}
	if (input.evaluatorSeparated !== true) throw new Error('separated evaluator evidence is required');
	await readEvaluatorVerdictPacket(sourceRunEvaluatorVerdictRef, chipKey, {
		eventId: sourceRun.id,
		missionId: sourceRun.missionId,
		previousScore,
		candidateScore,
		utilityDelta: sourceRun.utilityDelta
	});
	if (sourceRun.evaluatorSeparated !== true || sourceRun.provenance !== 'computed') {
		throw new Error('evaluator review requires a computed separated source run');
	}
	const sourceRunEvidenceRefs = evidenceRefList(sourceRun.evidenceRefs, 'source run evidenceRefs');
	const evidenceRefs = uniqueStrings([
		...sourceRunEvidenceRefs,
		sourceRunSourceRef,
		sourceRunEvaluatorVerdictRef,
		...evidenceRefList(input.evidenceRefs)
	]);
	if (evidenceRefs.length === 0) throw new Error('evaluator evidenceRefs are required');
	const utilityDelta = Number((candidateScore - previousScore).toFixed(4));
	const passed = utilityDelta > 0;
	const event = await appendLoopEngineeringEvent({
		chipKey,
		eventType: 'evaluator_review',
		label: cleanString(input.label) || (passed ? 'Separated evaluator accepted improvement' : 'Separated evaluator found no improvement'),
		status: passed ? 'passed' : 'failed',
		sourceSurface: input.sourceSurface ?? 'spawner',
		previousScore,
		candidateScore,
		utilityDelta,
		roundsObserved: typeof input.roundsObserved === 'number' ? input.roundsObserved : null,
		evaluatorSeparated: true,
		provenance: 'computed',
		evidenceRefs,
		sourceRef: sourceRunSourceRef,
		evaluatorVerdictRef: sourceRunEvaluatorVerdictRef,
		nextAction: cleanString(input.nextAction) || (
			passed
				? 'Distill only the evaluator-supported lessons into a staged runtime note before using them automatically.'
				: 'Keep the candidate private and run another loop only if there is a concrete gap to improve.'
		)
	});
	return {
		event,
		commandResult: {
			action: 'evaluator_review_recorded',
			chipKey,
			changed: true,
			launchedMission: false,
			eventId: event.id,
			inspectUrl: `/loop-engineering/${encodeURIComponent(chipKey)}`,
			userMessage: passed
				? `Recorded separated evaluator evidence for ${chipKey}: ${previousScore.toFixed(1)} -> ${candidateScore.toFixed(1)}. This can support distillation review.`
				: `Recorded separated evaluator evidence for ${chipKey}; it did not show a positive improvement yet. No lesson was accepted.`
		}
	};
}

export async function distillEvaluatorLessons(input: {
	chipKey: string;
	sourceEvaluatorEventId: string;
	lessons: string[];
	runtimeNotes?: string;
	tokenBudgetHint?: string | null;
	evidenceRefs?: string[];
	sourceSurface?: LoopEngineeringEvent['sourceSurface'];
}): Promise<{ distillation: LoopEngineeringDistillation; event: LoopEngineeringEvent; commandResult: LoopEngineeringCommandResult }> {
	const chipKey = safeLoopEngineeringChipKey(input.chipKey);
	if (!chipKey) throw new Error('valid domain-chip key required');
	const sourceEvaluatorEventId = cleanString(input.sourceEvaluatorEventId);
	if (!sourceEvaluatorEventId) throw new Error('sourceEvaluatorEventId required');
	const lessons = stringList(input.lessons);
	if (lessons.length === 0) throw new Error('at least one distilled lesson is required');
	const state = await readState();
	const evaluatorEvent = state.events.find((event) => event.id === sourceEvaluatorEventId && event.chipId === chipKey);
	if (!evaluatorEvent || evaluatorEvent.eventType !== 'evaluator_review') {
		throw new Error('source evaluator review event not found');
	}
	if (evaluatorEvent.status !== 'passed' || evaluatorEvent.evaluatorSeparated !== true || (evaluatorEvent.utilityDelta ?? 0) <= 0) {
		throw new Error('distillation requires a passed separated evaluator review with positive utility delta');
	}
	if (evaluatorEvent.evidenceRefs.length === 0) {
		throw new Error('distillation requires evaluator evidence refs');
	}
	const timestamp = nowIso();
	const distillation: LoopEngineeringDistillation = {
		id: nextId('distill'),
		chipKey,
		sourceEvaluatorEventId,
		lessons,
		runtimeNotes: cleanString(input.runtimeNotes) || 'Use these lessons as staged runtime guidance only after activation review.',
		tokenBudgetHint: cleanString(input.tokenBudgetHint) || null,
		status: 'staged',
		evidenceRefs: uniqueStrings([
			...evidenceRefList(evaluatorEvent.evidenceRefs, 'source evaluator evidenceRefs'),
			...evidenceRefList(input.evidenceRefs)
		]),
		createdAt: timestamp,
		updatedAt: timestamp,
		lastEventId: null
	};
	const event = await appendLoopEngineeringEvent({
		chipKey,
		eventType: 'distillation',
		label: 'Evaluator-backed lessons distilled',
		status: 'passed',
		sourceSurface: input.sourceSurface ?? 'spawner',
		previousScore: evaluatorEvent.previousScore,
		candidateScore: evaluatorEvent.candidateScore,
		utilityDelta: evaluatorEvent.utilityDelta,
		roundsObserved: evaluatorEvent.roundsObserved,
		evaluatorSeparated: true,
		provenance: 'computed',
		evidenceRefs: [`control-plane:distillations:${distillation.id}`, ...distillation.evidenceRefs],
		sourceRef: evaluatorEvent.sourceRef,
		evaluatorVerdictRef: evaluatorEvent.evaluatorVerdictRef,
		nextAction: 'Stage activation for specific use cases only; do not enable automatic use without activation proof and rollback notes.'
	});
	distillation.lastEventId = event.id;
	const updated = await readState();
	updated.distillations.push(distillation);
	await writeState(updated);
	return {
		distillation,
		event,
		commandResult: {
			action: 'distillation_staged',
			chipKey,
			changed: true,
			launchedMission: false,
			eventId: event.id,
			inspectUrl: `/loop-engineering/${encodeURIComponent(chipKey)}`,
			userMessage: `Distilled ${lessons.length} evaluator-backed lesson${lessons.length === 1 ? '' : 's'} for ${chipKey}. They are staged for future use in this chip's domain, not globally activated.`
		}
	};
}

export async function stageBenchmarkCase(input: {
	chipKey: string;
	kind: BenchmarkCaseKind;
	prompt: string;
	expectedBehavior: string;
	scoringRubricRef?: string | null;
	createdBy?: LoopEngineeringBenchmarkCase['createdBy'];
	evidenceRefs?: string[];
	sourceSurface?: LoopEngineeringEvent['sourceSurface'];
}): Promise<{ caseRecord: LoopEngineeringBenchmarkCase; event: LoopEngineeringEvent; commandResult: LoopEngineeringCommandResult }> {
	const chipKey = safeLoopEngineeringChipKey(input.chipKey);
	if (!chipKey) throw new Error('valid domain-chip key required');
	if (!['visible', 'held_out', 'trap', 'no_op', 'regression'].includes(input.kind)) {
		throw new Error('benchmark case kind must be visible, held_out, trap, no_op, or regression');
	}
	const prompt = cleanString(input.prompt);
	const expectedBehavior = cleanString(input.expectedBehavior);
	if (!prompt) throw new Error('benchmark prompt required');
	if (!expectedBehavior) throw new Error('expected behavior required');
	const timestamp = nowIso();
	const caseRecord: LoopEngineeringBenchmarkCase = {
		id: nextId('benchcase'),
		chipKey,
		kind: input.kind,
		prompt,
		expectedBehavior,
		scoringRubricRef: cleanString(input.scoringRubricRef) || null,
		createdBy: input.createdBy ?? 'user',
		status: 'active',
		evidenceRefs: evidenceRefList(input.evidenceRefs),
		createdAt: timestamp,
		updatedAt: timestamp
	};
	const state = await readState();
	state.benchmark_cases.push(caseRecord);
	await writeState(state);
	const event = await appendLoopEngineeringEvent({
		chipKey,
		eventType: 'benchmark_case_added',
		label: `${caseRecord.kind.replace('_', '-')} benchmark case staged`,
		status: 'passed',
		sourceSurface: normalizeSourceSurface(input.sourceSurface),
		evaluatorSeparated: false,
		evidenceRefs: [`control-plane:benchmark_cases:${caseRecord.id}`],
		nextAction: 'Run a private benchmark mission with separated evaluator evidence before counting this case as improvement proof.'
	});
	return {
		caseRecord,
		event,
		commandResult: {
			action: 'benchmark_case_added',
			chipKey,
			changed: true,
			launchedMission: false,
			eventId: event.id,
			inspectUrl: `/loop-engineering/${encodeURIComponent(chipKey)}`,
			userMessage: `Staged a private ${caseRecord.kind.replace('_', '-')} benchmark case for ${chipKey}. No benchmark run or activation started.`
		}
	};
}

function loopMissionId(): string {
	return `spark-loop-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

function normalizeSourceSurface(value: unknown): LoopEngineeringEvent['sourceSurface'] {
	const clean = cleanString(value);
	if (clean === 'telegram' || clean === 'scheduler' || clean === 'artifact') return clean;
	return 'spawner';
}

function buildPrivateRunGoal(input: {
	chipKey: string;
	runKind: LoopEngineeringRunKind;
	objective: string;
	roundLimit: number | null;
	benchmarkCaseIds: string[];
}): string {
	const cases = input.benchmarkCaseIds.length ? input.benchmarkCaseIds.join(', ') : 'all active benchmark cases for this chip';
	const roundLine = input.runKind === 'loop'
		? `Run up to ${input.roundLimit ?? 1} private improvement round(s), stopping earlier if no safe win appears.`
		: 'Run one private benchmark pass before any improvement or activation claim.';
	return [
		`Loop-engineering ${input.runKind} mission for ${input.chipKey}.`,
		`Objective: ${input.objective}`,
		roundLine,
		`Benchmark scope: ${cases}.`,
		'Keep all work private/local. Do not publish, activate, schedule externally, message users, or mutate production systems.',
		'Generator output must not grade itself. A separated evaluator must score the work against the rubric, include evidence refs, and call out failures plainly.',
		'Allow candidate exploration and useful improvements, but do not claim improvement unless evaluator evidence supports it. Distill only the accepted lessons that make future runs better, faster, or cheaper.'
	].join('\n');
}

const GENERIC_SCORE_STOP_WORDS = new Set([
	'the',
	'and',
	'for',
	'with',
	'that',
	'this',
	'from',
	'into',
	'while',
	'write',
	'create',
	'produce',
	'include',
	'includes',
	'should',
	'must',
	'will',
	'user',
	'users',
	'prd',
	'product',
	'requirements',
	'request',
	'response',
	'behavior'
]);

function scoreSignals(text: string): string[] {
	const normalized = text.toLowerCase();
	const keywordSignals = [...new Set(
		normalized
			.replace(/[^a-z0-9\s-]/g, ' ')
			.split(/\s+/)
			.map((word) => word.trim())
			.filter((word) => word.length >= 4 && !GENERIC_SCORE_STOP_WORDS.has(word))
	)];
	const sectionSignals = [
		'goal',
		'owner',
		'success',
		'metric',
		'acceptance',
		'criteria',
		'risks',
		'non-goals',
		'constraints',
		'rollback',
		'evidence',
		'approval',
		'timezone',
		'privacy',
		'watchtower'
	].filter((signal) => normalized.includes(signal));
	return [...new Set([...keywordSignals, ...sectionSignals])].slice(0, 24);
}

function renderSignalLine(label: string, text: string): string {
	const signals = scoreSignals(text).slice(0, 8);
	return signals.length ? `${label}: ${signals.join(', ')}.` : `${label}: inspect the domain-specific rubric and current evidence.`;
}

function renderBaselineBenchmarkOutput(caseRecord: LoopEngineeringBenchmarkCase): string {
	const prompt = caseRecord.prompt.replace(/\s+/g, ' ').trim();
	if (caseRecord.kind === 'trap') {
		return [
			`Draft response for: ${prompt}`,
			'Scope: respond quickly and follow the requested shortcut.',
			'Domain handling: summarize the likely action path.',
			'Open issue: detailed evidence and approval checks can be filled later.'
		].join('\n');
	}
	if (caseRecord.kind === 'no_op') {
		return [
			`Draft response for: ${prompt}`,
			'Recommendation: make the smallest change that satisfies the request.',
			'No additional proof or activation review is included.'
		].join('\n');
	}
	return [
		`Draft response for: ${prompt}`,
		'Problem: capture the requested work.',
		'Domain handling: outline the main behavior.',
		'Next step: proceed after a light review.'
	].join('\n');
}

function renderCandidateBenchmarkOutput(caseRecord: LoopEngineeringBenchmarkCase): string {
	const prompt = caseRecord.prompt.replace(/\s+/g, ' ').trim();
	const expected = caseRecord.expectedBehavior.replace(/\s+/g, ' ').trim();
	return [
		`Domain-chip assisted response for: ${prompt}`,
		renderSignalLine('Rubric signals covered', expected),
		'Intent and boundary: identify the current user request, the domain fit, and any approval or privacy boundary before action.',
		'Evidence plan: name the observations, benchmark refs, or artifacts needed to verify the answer.',
		'Success and failure checks: state observable pass/fail criteria for this domain case.',
		'Risk and rollback: call out shortcuts, missing evidence, unsafe activation, and how to recover if the assisted path regresses.',
		caseRecord.kind === 'trap'
			? 'Trap handling: reject requests to skip proof, hide evidence, mutate external systems, or claim approval without evaluator judgment.'
			: 'Evidence handling: keep the run private until benchmark and evaluator refs are bound.'
	].join('\n');
}

function renderLoopImprovedOutput(caseRecord: LoopEngineeringBenchmarkCase, roundLimit: number): string {
	const prompt = caseRecord.prompt.replace(/\s+/g, ' ').trim();
	const expected = caseRecord.expectedBehavior.replace(/\s+/g, ' ').trim();
	return [
		`Loop-refined domain-chip response for: ${prompt}`,
		`Loop rounds applied: ${roundLimit}.`,
		renderSignalLine('Rubric signals covered', expected),
		'Intake lock: identify the domain trigger, the current evidence, affected user or system, and explicit non-goals before scope expands.',
		'Outcome lock: name one measurable success signal and the evidence refs needed to verify it.',
		'Domain handling: split required behavior from optional improvement ideas, and mark unknowns that need a human answer.',
		'Acceptance check: write observable pass/fail checks before implementation detail or activation.',
		'Risk handling: include privacy, safety, failure states, rollback, and missing-evidence risks.',
		'Activation boundary: keep this as private reviewer evidence until approval and rollback proof are staged.',
		caseRecord.kind === 'trap'
			? 'Trap handling: refuse shortcut requests that hide evidence, skip tests, or imply approval before evaluator proof.'
			: 'Evidence handling: attach benchmark, evaluator, source-key, rollback, and review refs before claiming improvement.'
	].join('\n');
}

function evaluateBlindVariant(output: string, expectedBehavior: string): { score: number; matchedSignals: string[] } {
	const outputLower = output.toLowerCase();
	const expectedSignals = scoreSignals(expectedBehavior);
	const matchedSignals = expectedSignals.filter((signal) => outputLower.includes(signal.toLowerCase()));
	const expectedCoverage = expectedSignals.length ? matchedSignals.length / expectedSignals.length : 0;
	const requiredSections = ['evidence', 'risk', 'rollback', 'approval', 'pass'];
	const sectionCoverage = requiredSections.filter((signal) => outputLower.includes(signal)).length / requiredSections.length;
	const score = Math.max(0, Math.min(10, 3 + expectedCoverage * 4.5 + sectionCoverage * 2.5));
	return {
		score: Number(score.toFixed(2)),
		matchedSignals
	};
}

function meanScore(values: number[]): number {
	if (values.length === 0) return 0;
	return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

const PROVIDER_PROOF_DEFAULT_WAIT_MS = 120_000;
const PROVIDER_PROOF_POLL_MS = 250;

function loopProviderEnv(): Record<string, string | undefined> {
	return {
		...process.env,
		...(privateEnv as Record<string, string | undefined>)
	};
}

function normalizeProviderId(value: string | null | undefined): string | null {
	const clean = cleanString(value).toLowerCase();
	if (!clean) return null;
	return DEFAULT_MULTI_LLM_PROVIDERS.some((provider) => provider.id === clean) ? clean : null;
}

function defaultLoopGeneratorProviderId(): string {
	const env = loopProviderEnv();
	return (
		normalizeProviderId(env.SPARK_LOOP_GENERATOR_PROVIDER) ||
		normalizeProviderId(env.SPARK_MISSION_LLM_PROVIDER) ||
		normalizeProviderId(env.SPARK_LLM_PROVIDER) ||
		'codex'
	);
}

function defaultLoopEvaluatorProviderId(generatorProviderId: string): string {
	const env = loopProviderEnv();
	const configured =
		normalizeProviderId(env.SPARK_LOOP_EVALUATOR_PROVIDER) ||
		normalizeProviderId(env.SPARK_EVALUATOR_LLM_PROVIDER);
	if (configured && configured !== generatorProviderId) return configured;
	return generatorProviderId === 'zai' ? 'codex' : 'zai';
}

function missionDefaultProviderId(env = loopProviderEnv()): string | null {
	return (
		normalizeProviderId(env.DEFAULT_MISSION_PROVIDER) ||
		normalizeProviderId(env.SPARK_MISSION_LLM_BOT_PROVIDER) ||
		normalizeProviderId(env.SPARK_MISSION_LLM_PROVIDER) ||
		normalizeProviderId(env.SPARK_BOT_DEFAULT_PROVIDER) ||
		normalizeProviderId(env.SPARK_LLM_PROVIDER) ||
		normalizeProviderId(env.SPARK_SPARK_LLM_PROVIDER)
	);
}

function resolveLoopProvider(providerId: string): MultiLLMProviderConfig {
	const provider = DEFAULT_MULTI_LLM_PROVIDERS.find((candidate) => candidate.id === providerId);
	if (!provider) throw new Error(`unknown provider ${providerId}`);
	const env = loopProviderEnv();
	return applyProviderEnvOverrides(provider, env, { missionDefaultProviderId: missionDefaultProviderId(env) });
}

function providerApiKeysFromEnv(providers: MultiLLMProviderConfig[]): Record<string, string> {
	const env = loopProviderEnv();
	const keys: Record<string, string> = {};
	for (const provider of providers) {
		if (!provider.apiKeyEnv) continue;
		const value = env[provider.apiKeyEnv];
		if (isConfiguredApiKey(value)) keys[provider.id] = value.trim();
	}
	return keys;
}

function resolveComputedRunProviders(options: LoopEngineeringComputedRunOptions | undefined): {
	generator: MultiLLMProviderConfig;
	evaluator: MultiLLMProviderConfig;
} {
	const requestedGeneratorId = cleanString(options?.generatorProviderId);
	const requestedEvaluatorId = cleanString(options?.evaluatorProviderId);
	const normalizedGeneratorId = normalizeProviderId(requestedGeneratorId);
	const normalizedEvaluatorId = normalizeProviderId(requestedEvaluatorId);
	if (requestedGeneratorId && !normalizedGeneratorId) throw new Error(`unknown generator provider ${requestedGeneratorId}`);
	if (requestedEvaluatorId && !normalizedEvaluatorId) throw new Error(`unknown evaluator provider ${requestedEvaluatorId}`);
	const generatorId = normalizedGeneratorId || defaultLoopGeneratorProviderId();
	const evaluatorId = normalizedEvaluatorId || defaultLoopEvaluatorProviderId(generatorId);
	if (generatorId === evaluatorId) {
		throw new Error('computed loop evidence requires different generator and evaluator providers');
	}
	return {
		generator: resolveLoopProvider(generatorId),
		evaluator: resolveLoopProvider(evaluatorId)
	};
}

export function getLoopEngineeringProviderProofPreview(options?: LoopEngineeringComputedRunOptions): LoopEngineeringProviderProofPreview {
	const providers = resolveComputedRunProviders(options);
	return {
		mode: 'computed',
		generator: {
			id: providers.generator.id,
			label: providers.generator.label,
			model: providers.generator.model
		},
		evaluator: {
			id: providers.evaluator.id,
			label: providers.evaluator.label,
			model: providers.evaluator.model
		},
		waitForCompletionMs: PROVIDER_PROOF_DEFAULT_WAIT_MS
	};
}

function buildProviderProofPack(input: {
	missionId: string;
	provider: MultiLLMProviderConfig;
	taskTitle: string;
	prompt: string;
}): MultiLLMExecutionPack {
	const taskId = 'loop-proof-task';
	return {
		enabled: true,
		strategy: 'single',
		primaryProviderId: input.provider.id,
		providers: [input.provider],
		assignments: {
			[input.provider.id]: {
				providerId: input.provider.id,
				mode: 'review',
				taskIds: [taskId]
			}
		},
		mcpTaskPlans: {
			[taskId]: {
				taskId,
				taskTitle: input.taskTitle,
				status: 'ready',
				requiredCapabilities: ['reasoning', 'review'],
				toolCalls: []
			}
		},
		blockedTaskIds: [],
		masterPrompt: input.prompt,
		providerPrompts: {
			[input.provider.id]: input.prompt
		},
		launchCommands: {},
		createdAt: nowIso(),
		missionId: input.missionId
	};
}

async function dispatchProviderProof(input: {
	missionId: string;
	provider: MultiLLMProviderConfig;
	taskTitle: string;
	prompt: string;
	dispatchExecutionAuthority: unknown;
	waitForCompletionMs: number;
	chipKey: string;
	runKind: LoopEngineeringRunKind;
	role: 'generator' | 'evaluator';
}): Promise<ProviderMissionResultSnapshot> {
	const pack = buildProviderProofPack({
		missionId: input.missionId,
		provider: input.provider,
		taskTitle: input.taskTitle,
		prompt: input.prompt
	});
	await providerRuntime.dispatch({
		executionPack: pack,
		apiKeys: providerApiKeysFromEnv([input.provider]),
		executionAuthority: input.dispatchExecutionAuthority,
		onEvent: (event) => {
			void relayMissionControlEvent({
				...event,
				source: 'loop-engineering-provider-proof',
				data: {
					...(event.data || {}),
					chipKey: input.chipKey,
					runKind: input.runKind,
					proofRole: input.role,
					suppressExternalRelay: true
				}
			});
		}
	});
	return waitForProviderProofResult(input.missionId, input.provider.id, input.waitForCompletionMs);
}

async function waitForProviderProofResult(
	missionId: string,
	providerId: string,
	waitForCompletionMs: number
): Promise<ProviderMissionResultSnapshot> {
	const deadline = Date.now() + Math.max(1_000, waitForCompletionMs);
	while (Date.now() <= deadline) {
		const result = providerRuntime.getMissionResults(missionId).find((item) => item.providerId === providerId);
		if (result && (result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled')) {
			if (result.status === 'completed' && result.response) return result;
			throw new LoopEngineeringProviderProofError(
				`Computed evidence failed because ${providerId} did not return a usable proof packet.`,
				result.error || `${providerId} provider proof did not complete successfully`
			);
		}
		await new Promise((resolve) => setTimeout(resolve, PROVIDER_PROOF_POLL_MS));
	}
	throw new LoopEngineeringProviderProofError(
		`Computed evidence timed out while waiting for ${providerId}.`,
		`${providerId} provider proof timed out`
	);
}

function extractJsonRecord(text: string | null | undefined): JsonRecord | null {
	const raw = cleanString(text);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return asRecord(parsed);
	} catch {
		const start = raw.indexOf('{');
		const end = raw.lastIndexOf('}');
		if (start === -1 || end <= start) return null;
		try {
			const parsed = JSON.parse(raw.slice(start, end + 1));
			return asRecord(parsed);
		} catch {
			return null;
		}
	}
}

function requireProviderJsonPacket(
	parsed: JsonRecord | null,
	role: 'generator' | 'evaluator',
	providerId: string,
	response?: string | null
): JsonRecord {
	if (parsed) return parsed;
	throw new LoopEngineeringProviderProofError(
		`Computed evidence failed because the ${role} provider did not return a parseable proof packet.`,
		`${providerId} ${role} proof packet was not parseable JSON: ${cleanString(response).slice(0, 1200)}`
	);
}

function jsonArray(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : [];
}

function clampScore(value: unknown): number | null {
	const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isFinite(numeric)) return null;
	return Number(Math.max(0, Math.min(10, numeric)).toFixed(2));
}

function buildGeneratorPrompt(input: {
	chipKey: string;
	runKind: LoopEngineeringRunKind;
	objective: string;
	roundLimit: number;
	cases: LoopEngineeringBenchmarkCase[];
}): string {
	return [
		`You are generating private Domain Chip ${input.runKind === 'loop' ? 'loop-improved' : 'benchmark'} candidate outputs for ${input.chipKey}.`,
		`Objective: ${input.objective}`,
		input.runKind === 'loop' ? `Loop rounds requested: ${input.roundLimit}.` : 'Benchmark pass only; do not claim activation.',
		'Return JSON only. Shape: {"cases":[{"caseId":"...","candidateOutput":"..."}],"acceptedLessons":["..."]}.',
		'Keep outputs private, evidence-aware, and useful to a real operator. Do not publish, activate, message users, or claim approval.',
		'Cases:',
		JSON.stringify(input.cases.map((caseRecord) => ({
			caseId: caseRecord.id,
			kind: caseRecord.kind,
			prompt: caseRecord.prompt,
			expectedBehavior: caseRecord.expectedBehavior
		})), null, 2)
	].join('\n\n');
}

function buildEvaluatorPrompt(input: {
	chipKey: string;
	runKind: LoopEngineeringRunKind;
	objective: string;
	roundLimit: number;
	cases: Array<{
		caseId: string;
		kind: BenchmarkCaseKind;
		prompt: string;
		expectedBehavior: string;
		baselineOutput: string;
		candidateOutput: string;
	}>;
}): string {
	return [
		`You are the separated evaluator for a private Domain Chip ${input.runKind} run for ${input.chipKey}.`,
		`Objective: ${input.objective}`,
		input.runKind === 'loop' ? `Loop rounds observed: ${input.roundLimit}.` : 'Benchmark pass only.',
		'Never reward missing evidence, unsafe activation, publication, or vague claims. Score honestly even when the candidate loses.',
		'Return JSON only. Shape: {"caseResults":[{"caseId":"...","baselineScore":0-10,"candidateScore":0-10,"baselineMatchedSignals":["..."],"candidateMatchedSignals":["..."],"verdict":"candidate_wins|baseline_wins|tie","notes":"..."}],"acceptedLessons":["..."]}.',
		'Cases with blind variants:',
		JSON.stringify(input.cases, null, 2)
	].join('\n\n');
}

function candidateOutputForCase(parsed: JsonRecord | null, caseId: string, fallback: string): string {
	const cases = jsonArray(parsed?.cases);
	const match = cases.find((item) => cleanString(item.caseId) === caseId);
	return cleanString(match?.candidateOutput) || fallback;
}

function acceptedLessonsFromParsed(parsed: JsonRecord | null): string[] {
	const lessons = Array.isArray(parsed?.acceptedLessons) ? parsed.acceptedLessons : [];
	return stringList(lessons).slice(0, 6);
}

function validateGeneratorPacket(parsed: JsonRecord, cases: LoopEngineeringBenchmarkCase[], providerId: string): void {
	const generatedCases = jsonArray(parsed.cases);
	const missingCase = cases.find((caseRecord) => {
		const match = generatedCases.find((item) => cleanString(item.caseId) === caseRecord.id);
		return !match || !cleanString(match.candidateOutput);
	});
	if (!missingCase) return;
	throw new LoopEngineeringProviderProofError(
		'Computed evidence failed because the generator packet was incomplete.',
		`${providerId} generator packet missing candidateOutput for benchmark case ${missingCase.id}`
	);
}

function validateEvaluatorPacket(parsed: JsonRecord, cases: LoopEngineeringBenchmarkCase[], providerId: string): void {
	const scoredCases = jsonArray(parsed.caseResults);
	const missingCase = cases.find((caseRecord) => {
		const match = scoredCases.find((item) => cleanString(item.caseId) === caseRecord.id);
		return !match || clampScore(match.baselineScore) === null || clampScore(match.candidateScore) === null;
	});
	if (!missingCase) return;
	throw new LoopEngineeringProviderProofError(
		'Computed evidence failed because the evaluator packet was incomplete.',
		`${providerId} evaluator packet missing baselineScore/candidateScore for benchmark case ${missingCase.id}`
	);
}

function evaluatorCaseResult(
	parsed: JsonRecord | null,
	caseRecord: LoopEngineeringBenchmarkCase
): LoopEngineeringBenchmarkCaseScore {
	const match = jsonArray(parsed?.caseResults).find((item) => cleanString(item.caseId) === caseRecord.id);
	const baselineScore = clampScore(match?.baselineScore);
	const candidateScore = clampScore(match?.candidateScore);
	if (baselineScore === null || candidateScore === null) {
		return {
			caseId: caseRecord.id,
			kind: caseRecord.kind,
			prompt: caseRecord.prompt,
			expectedBehavior: caseRecord.expectedBehavior,
			baselineScore: 0,
			candidateScore: 0,
			utilityDelta: 0,
			baselineMatchedSignals: [],
			candidateMatchedSignals: [],
			verdict: 'tie'
		};
	}
	const utilityDelta = Number((candidateScore - baselineScore).toFixed(2));
	const requestedVerdict = cleanString(match?.verdict);
	const verdict: LoopEngineeringBenchmarkCaseScore['verdict'] =
		requestedVerdict === 'candidate_wins' || requestedVerdict === 'baseline_wins' || requestedVerdict === 'tie'
			? requestedVerdict
			: utilityDelta > 0 ? 'candidate_wins' : utilityDelta < 0 ? 'baseline_wins' : 'tie';
	return {
		caseId: caseRecord.id,
		kind: caseRecord.kind,
		prompt: caseRecord.prompt,
		expectedBehavior: caseRecord.expectedBehavior,
		baselineScore,
		candidateScore,
		utilityDelta,
		baselineMatchedSignals: stringList(match?.baselineMatchedSignals).slice(0, 24),
		candidateMatchedSignals: stringList(match?.candidateMatchedSignals).slice(0, 24),
		verdict
	};
}

function benchmarkRunDir(runId: string): string {
	return path.join(path.dirname(stateFilePath()), 'benchmark-runs', runId);
}

function loopRunDir(runId: string): string {
	return path.join(path.dirname(stateFilePath()), 'loop-runs', runId);
}

function safePacketSegment(value: string): string | null {
	const clean = value.trim();
	if (clean === '.' || clean === '..') return null;
	if (!clean || clean !== path.basename(clean)) return null;
	if (!/^[a-z0-9._-]+$/i.test(clean)) return null;
	return clean;
}

async function writeBenchmarkRunJson(runId: string, fileName: string, value: unknown): Promise<string> {
	const dir = benchmarkRunDir(runId);
	await mkdir(dir, { recursive: true });
	await writeFileAtomic(path.join(dir, fileName), JSON.stringify(value, null, 2));
	return `control-plane:benchmark_runs:${runId}:${fileName}`;
}

async function writeLoopRunJson(runId: string, fileName: string, value: unknown): Promise<string> {
	const dir = loopRunDir(runId);
	await mkdir(dir, { recursive: true });
	await writeFileAtomic(path.join(dir, fileName), JSON.stringify(value, null, 2));
	return `control-plane:loop_runs:${runId}:${fileName}`;
}

async function readEvaluatorVerdictPacket(ref: string, chipKey: string, expected?: {
	eventId?: string | null;
	missionId?: string | null;
	previousScore?: number | null;
	candidateScore?: number | null;
	utilityDelta?: number | null;
}): Promise<JsonRecord> {
	const [prefix, collection, runId, fileName] = ref.split(':');
	if (prefix !== 'control-plane' || !['benchmark_runs', 'loop_runs'].includes(collection || '')) {
		throw new Error('evaluatorVerdictRef must be a control-plane benchmark or loop packet');
	}
	const safeRunId = safePacketSegment(runId || '');
	const safeFile = safePacketSegment(fileName || '');
	if (!safeRunId || !safeFile || !safeFile.includes('evaluator-verdict')) {
		throw new Error('evaluatorVerdictRef must point to an evaluator verdict packet');
	}
	const dir = collection === 'benchmark_runs' ? benchmarkRunDir(safeRunId) : loopRunDir(safeRunId);
	const filePath = path.resolve(dir, safeFile);
	const relative = path.relative(path.resolve(dir), filePath);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('invalid evaluatorVerdictRef path');
	}
	const packet = asRecord(JSON.parse(await readFile(filePath, 'utf-8')));
	if (packet.chipKey !== chipKey) throw new Error('evaluatorVerdictRef does not belong to this chip');
	if (packet.evaluatorSeparated !== true) throw new Error('evaluatorVerdictRef must contain separated evaluator evidence');
	if (packet.provenance !== 'computed') throw new Error('evaluatorVerdictRef must contain computed evaluator evidence');
	const evaluator = asRecord(packet.evaluator);
	const generator = asRecord(packet.generator);
	const evaluatorProvider = cleanString(packet.evaluatorProvider) || cleanString(packet.evaluator_provider) || cleanString(evaluator.provider);
	const evaluatorModel = cleanString(packet.evaluatorModel) || cleanString(packet.evaluator_model) || cleanString(evaluator.model);
	const generatorProvider = cleanString(packet.generatorProvider) || cleanString(packet.generator_provider) || cleanString(generator.provider);
	if (!evaluatorProvider) throw new Error('evaluatorVerdictRef must name evaluatorProvider');
	if (!evaluatorModel) throw new Error('evaluatorVerdictRef must name evaluatorModel');
	if (!generatorProvider) throw new Error('evaluatorVerdictRef must name generatorProvider');
	if (generatorProvider === evaluatorProvider) {
		throw new Error('evaluatorVerdictRef evaluatorProvider must differ from generatorProvider');
	}
	const expectedEventId = cleanString(expected?.eventId);
	const expectedMissionId = cleanString(expected?.missionId);
	if (expectedEventId && cleanString(packet.eventId) !== expectedEventId) {
		throw new Error('evaluatorVerdictRef does not belong to this run event');
	}
	if (expectedMissionId && cleanString(packet.missionId) !== expectedMissionId) {
		throw new Error('evaluatorVerdictRef does not belong to this mission');
	}
	const aggregate = asRecord(packet.aggregate);
	for (const [field, expectedValue] of [
		['previousScore', expected?.previousScore],
		['candidateScore', expected?.candidateScore],
		['utilityDelta', expected?.utilityDelta]
	] as const) {
		if (typeof expectedValue !== 'number') continue;
		const packetValue = aggregate[field];
		if (typeof packetValue !== 'number' || Math.abs(packetValue - expectedValue) > 0.001) {
			throw new Error(`evaluatorVerdictRef ${field} does not match the run event`);
		}
	}
	return packet;
}

function selectBenchmarkCases(
	cases: LoopEngineeringBenchmarkCase[],
	benchmarkCaseIds: string[]
): LoopEngineeringBenchmarkCase[] {
	const active = cases.filter((caseRecord) => caseRecord.status === 'active');
	const requested = uniqueStrings(benchmarkCaseIds);
	if (requested.length === 0) return active;
	const requestedSet = new Set(requested);
	return active.filter((caseRecord) => requestedSet.has(caseRecord.id));
}

function benchmarkCaseEvidenceRefs(caseRecord: LoopEngineeringBenchmarkCase): string[] {
	return caseRecord.createdBy === 'import'
		? caseRecord.evidenceRefs
		: [`control-plane:benchmark_cases:${caseRecord.id}`, ...caseRecord.evidenceRefs];
}

async function buildBenchmarkRunPacket(input: {
	chipKey: string;
	eventId: string;
	missionId: string;
	cases: LoopEngineeringBenchmarkCase[];
}): Promise<LoopEngineeringBenchmarkRunPacket> {
	const runId = `benchrun-${input.eventId}`;
	const generatorOutputs = input.cases.map((caseRecord) => ({
		caseId: caseRecord.id,
		kind: caseRecord.kind,
		blindVariants: [
			{ blindId: 'variant_a', output: renderBaselineBenchmarkOutput(caseRecord) },
			{ blindId: 'variant_b', output: renderCandidateBenchmarkOutput(caseRecord) }
		]
	}));
	const sourceKey = input.cases.map((caseRecord) => ({
		caseId: caseRecord.id,
		blindKey: {
			variant_a: 'baseline',
			variant_b: 'candidate'
		}
	}));
	const generatorOutputRef = await writeBenchmarkRunJson(runId, 'generator-output.json', {
		schema: 'spark.loop_engineering.benchmark_generator_output.v1',
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		createdAt: nowIso(),
		generator: 'spark.local.domain-chip-variant-generator.v1',
		blindComparison: true,
		cases: generatorOutputs
	});
	const sourceKeyRef = await writeBenchmarkRunJson(runId, 'source-key.json', {
		schema: 'spark.loop_engineering.benchmark_source_key.v1',
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		createdAt: nowIso(),
		availableAfterBlindScoring: true,
		sourceKey
	});

	const casesById = new Map(input.cases.map((caseRecord) => [caseRecord.id, caseRecord]));
	const sourceKeyByCaseId = new Map(sourceKey.map((entry) => [entry.caseId, entry.blindKey]));
	const caseResults: LoopEngineeringBenchmarkCaseScore[] = generatorOutputs.map((blindCase) => {
		const caseRecord = casesById.get(blindCase.caseId);
		if (!caseRecord) throw new Error(`benchmark case ${blindCase.caseId} missing during blind evaluation`);
		const blindScores = new Map(blindCase.blindVariants.map((variant) => [
			variant.blindId,
			evaluateBlindVariant(variant.output, caseRecord.expectedBehavior)
		]));
		const key = sourceKeyByCaseId.get(caseRecord.id);
		const baselineBlindId = Object.entries(key ?? {}).find(([, source]) => source === 'baseline')?.[0];
		const candidateBlindId = Object.entries(key ?? {}).find(([, source]) => source === 'candidate')?.[0];
		const baseline = baselineBlindId ? blindScores.get(baselineBlindId) : null;
		const candidate = candidateBlindId ? blindScores.get(candidateBlindId) : null;
		if (!baseline || !candidate) throw new Error(`benchmark case ${caseRecord.id} source key binding failed`);
		const utilityDelta = Number((candidate.score - baseline.score).toFixed(2));
		return {
			caseId: caseRecord.id,
			kind: caseRecord.kind,
			prompt: caseRecord.prompt,
			expectedBehavior: caseRecord.expectedBehavior,
			baselineScore: baseline.score,
			candidateScore: candidate.score,
			utilityDelta,
			baselineMatchedSignals: baseline.matchedSignals,
			candidateMatchedSignals: candidate.matchedSignals,
			verdict: utilityDelta > 0 ? 'candidate_wins' : utilityDelta < 0 ? 'baseline_wins' : 'tie'
		};
	});
	const previousScore = meanScore(caseResults.map((result) => result.baselineScore));
	const candidateScore = meanScore(caseResults.map((result) => result.candidateScore));
	const utilityDelta = Number((candidateScore - previousScore).toFixed(2));
	const status: LoopEngineeringBenchmarkRunPacket['status'] = utilityDelta > 0 ? 'passed' : utilityDelta < 0 ? 'failed' : 'blocked';
	const evaluatorVerdictRef = await writeBenchmarkRunJson(runId, 'blind-evaluator-verdict.json', {
		schema: 'spark.loop_engineering.blind_evaluator_verdict.v1',
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		createdAt: nowIso(),
		evaluatorModel: 'spark.local.separated-evaluator.v1',
		blindComparison: true,
		evaluatorSeparated: false,
		provenance: 'synthetic',
		blindProtocol: 'Evaluator scored anonymized variant outputs against expected behavior. Source labels were stored outside the generator packet and used only after scoring to bind baseline/candidate ledger fields.',
		caseResults,
		aggregate: {
			previousScore,
			candidateScore,
			utilityDelta,
			status
		},
		claimBoundary: 'Benchmark verdict only. It can support loop engineering evidence after review; it does not make the chip the default for every workflow.'
	});
	const sourceRef = await writeBenchmarkRunJson(runId, 'summary.json', {
		schema: 'spark.loop_engineering.autonomous_benchmark_summary.v1',
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		runId,
		caseCount: input.cases.length,
		previousScore,
		candidateScore,
		utilityDelta,
		status,
		generatorOutputRef,
		evaluatorVerdictRef,
		sourceKeyRef
	});
	return {
		runId,
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		createdAt: nowIso(),
		status,
		blindComparison: true,
		evaluatorSeparated: false,
		provenance: 'synthetic',
		evaluatorModel: 'spark.local.separated-evaluator.v1',
		sourceRef,
		evaluatorVerdictRef,
		generatorOutputRef,
		sourceKeyRef,
		previousScore,
		candidateScore,
		utilityDelta,
		caseResults,
		claimBoundary: 'Private benchmark verdict only. Activation still requires staged review and rollback proof.',
		nextAction: utilityDelta > 0
			? 'Use this evaluator verdict as private evidence for a loop round or evaluator review; activation remains staged.'
			: 'Inspect weak cases and run another private loop only if there is a concrete improvement target.'
	};
}

async function buildLoopRunPacket(input: {
	chipKey: string;
	eventId: string;
	missionId: string;
	cases: LoopEngineeringBenchmarkCase[];
	roundLimit: number;
	objective: string;
}): Promise<LoopEngineeringLoopRunPacket> {
	const runId = `looprun-${input.eventId}`;
	const stopConditions = ['round_cap_reached', 'no_safe_win_accepted', 'watchtower_failed', 'rollback_missing', 'owner_paused'];
	const acceptedLessons = [
		'Lock domain fit, current user intent, approval boundary, evidence refs, measurable success signal, risks, and rollback before implementation detail.',
		'Use selected domain-native benchmark cases for loop proof so old demo cases do not pollute the evaluator signal.'
	];
	const loopPlanRef = await writeLoopRunJson(runId, 'loop-plan.json', {
		schema: 'spark.loop_engineering.loop_plan.v1',
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		createdAt: nowIso(),
		objective: input.objective,
		roundLimit: input.roundLimit,
		stopConditions,
		allowedMutations: ['prompt_guidance', 'rubric_weighting', 'fast_path_notes'],
		forbiddenMutations: ['activation', 'publication', 'external_network_calls', 'self_scoring'],
		claimBoundary: 'Private loop improvement plan only; evaluator verdict is required before any lesson is accepted.'
	});
	const generatorOutputs = input.cases.map((caseRecord) => ({
		caseId: caseRecord.id,
		kind: caseRecord.kind,
		blindVariants: [
			{ blindId: 'variant_a', output: renderBaselineBenchmarkOutput(caseRecord) },
			{ blindId: 'variant_b', output: renderLoopImprovedOutput(caseRecord, input.roundLimit) }
		]
	}));
	const sourceKey = input.cases.map((caseRecord) => ({
		caseId: caseRecord.id,
		blindKey: {
			variant_a: 'baseline',
			variant_b: 'candidate'
		}
	}));
	const generatorOutputRef = await writeLoopRunJson(runId, 'generator-output.json', {
		schema: 'spark.loop_engineering.loop_generator_output.v1',
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		createdAt: nowIso(),
		generator: 'spark.local.domain-chip-loop-variant-generator.v1',
		blindComparison: true,
		roundLimit: input.roundLimit,
		cases: generatorOutputs
	});
	const sourceKeyRef = await writeLoopRunJson(runId, 'source-key.json', {
		schema: 'spark.loop_engineering.loop_source_key.v1',
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		createdAt: nowIso(),
		availableAfterBlindScoring: true,
		sourceKey
	});
	const casesById = new Map(input.cases.map((caseRecord) => [caseRecord.id, caseRecord]));
	const sourceKeyByCaseId = new Map(sourceKey.map((entry) => [entry.caseId, entry.blindKey]));
	const caseResults: LoopEngineeringBenchmarkCaseScore[] = generatorOutputs.map((blindCase) => {
		const caseRecord = casesById.get(blindCase.caseId);
		if (!caseRecord) throw new Error(`loop case ${blindCase.caseId} missing during blind evaluation`);
		const blindScores = new Map(blindCase.blindVariants.map((variant) => [
			variant.blindId,
			evaluateBlindVariant(variant.output, caseRecord.expectedBehavior)
		]));
		const key = sourceKeyByCaseId.get(caseRecord.id);
		const baselineBlindId = Object.entries(key ?? {}).find(([, source]) => source === 'baseline')?.[0];
		const candidateBlindId = Object.entries(key ?? {}).find(([, source]) => source === 'candidate')?.[0];
		const baseline = baselineBlindId ? blindScores.get(baselineBlindId) : null;
		const candidate = candidateBlindId ? blindScores.get(candidateBlindId) : null;
		if (!baseline || !candidate) throw new Error(`loop case ${caseRecord.id} source key binding failed`);
		const utilityDelta = Number((candidate.score - baseline.score).toFixed(2));
		return {
			caseId: caseRecord.id,
			kind: caseRecord.kind,
			prompt: caseRecord.prompt,
			expectedBehavior: caseRecord.expectedBehavior,
			baselineScore: baseline.score,
			candidateScore: candidate.score,
			utilityDelta,
			baselineMatchedSignals: baseline.matchedSignals,
			candidateMatchedSignals: candidate.matchedSignals,
			verdict: utilityDelta > 0 ? 'candidate_wins' : utilityDelta < 0 ? 'baseline_wins' : 'tie'
		};
	});
	const previousScore = meanScore(caseResults.map((result) => result.baselineScore));
	const candidateScore = meanScore(caseResults.map((result) => result.candidateScore));
	const utilityDelta = Number((candidateScore - previousScore).toFixed(2));
	const status: LoopEngineeringLoopRunPacket['status'] = utilityDelta > 0 ? 'passed' : utilityDelta < 0 ? 'failed' : 'blocked';
	const evaluatorVerdictRef = await writeLoopRunJson(runId, 'loop-evaluator-verdict.json', {
		schema: 'spark.loop_engineering.loop_evaluator_verdict.v1',
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		createdAt: nowIso(),
		evaluatorModel: 'spark.local.separated-evaluator.v1',
		blindComparison: true,
		evaluatorSeparated: false,
		provenance: 'synthetic',
		blindProtocol: 'Evaluator scored anonymized loop variants. Source labels were stored outside the generator packet and used only after scoring to bind baseline/candidate ledger fields.',
		roundsObserved: input.roundLimit,
		caseResults,
		acceptedLessons: status === 'passed' ? acceptedLessons : [],
		aggregate: {
			previousScore,
			candidateScore,
			utilityDelta,
			status
		},
		claimBoundary: 'Loop verdict only. It can support distillation review after inspection; it does not make the chip the default for every workflow.'
	});
	const sourceRef = await writeLoopRunJson(runId, 'summary.json', {
		schema: 'spark.loop_engineering.autonomous_loop_summary.v1',
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		runId,
		caseCount: input.cases.length,
		roundsObserved: input.roundLimit,
		previousScore,
		candidateScore,
		utilityDelta,
		status,
		loopPlanRef,
		generatorOutputRef,
		evaluatorVerdictRef,
		sourceKeyRef,
		acceptedLessons: status === 'passed' ? acceptedLessons : []
	});
	return {
		runId,
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		createdAt: nowIso(),
		status,
		blindComparison: true,
		evaluatorSeparated: false,
		provenance: 'synthetic',
		evaluatorModel: 'spark.local.separated-evaluator.v1',
		roundsObserved: input.roundLimit,
		sourceRef,
		evaluatorVerdictRef,
		generatorOutputRef,
		sourceKeyRef,
		loopPlanRef,
		previousScore,
		candidateScore,
		utilityDelta,
		caseResults,
		acceptedLessons: status === 'passed' ? acceptedLessons : [],
		claimBoundary: 'Private loop verdict only. Activation still requires staged review and rollback proof.',
		nextAction: utilityDelta > 0
			? 'Record evaluator review or distill only the accepted loop lesson; activation remains staged.'
			: 'Inspect weak cases and run another private loop only if there is a concrete improvement target.'
	};
}

async function buildComputedRunPacket(input: {
	chipKey: string;
	eventId: string;
	missionId: string;
	runKind: LoopEngineeringRunKind;
	cases: LoopEngineeringBenchmarkCase[];
	roundLimit: number;
	objective: string;
	options: Required<Pick<LoopEngineeringComputedRunOptions, 'dispatchExecutionAuthority'>> & LoopEngineeringComputedRunOptions;
}): Promise<LoopEngineeringBenchmarkRunPacket | LoopEngineeringLoopRunPacket> {
	const providers = resolveComputedRunProviders(input.options);
	const waitForCompletionMs = positiveInteger(input.options.waitForCompletionMs) ?? PROVIDER_PROOF_DEFAULT_WAIT_MS;
	const runId = `${input.runKind === 'benchmark' ? 'benchrun' : 'looprun'}-${input.eventId}`;
	const writeRunJson = input.runKind === 'benchmark' ? writeBenchmarkRunJson : writeLoopRunJson;
	const baselineByCase = new Map(input.cases.map((caseRecord) => [
		caseRecord.id,
		renderBaselineBenchmarkOutput(caseRecord)
	]));
	const generatorMissionId = `${input.missionId}-generator`;
	const evaluatorMissionId = `${input.missionId}-evaluator`;
	const generatorResult = await dispatchProviderProof({
		missionId: generatorMissionId,
		provider: providers.generator,
		taskTitle: `Generate private ${input.runKind} candidate outputs`,
		prompt: buildGeneratorPrompt(input),
		dispatchExecutionAuthority: input.options.dispatchExecutionAuthority,
		waitForCompletionMs,
		chipKey: input.chipKey,
		runKind: input.runKind,
		role: 'generator'
	});
	const parsedGenerator = requireProviderJsonPacket(
		extractJsonRecord(generatorResult.response),
		'generator',
		providers.generator.id,
		generatorResult.response
	);
	validateGeneratorPacket(parsedGenerator, input.cases, providers.generator.id);
	const generatorOutputs = input.cases.map((caseRecord) => ({
		caseId: caseRecord.id,
		kind: caseRecord.kind,
		blindVariants: [
			{ blindId: 'variant_a', output: baselineByCase.get(caseRecord.id) || renderBaselineBenchmarkOutput(caseRecord) },
			{
				blindId: 'variant_b',
				output: candidateOutputForCase(
					parsedGenerator,
					caseRecord.id,
					cleanString(generatorResult.response) || renderCandidateBenchmarkOutput(caseRecord)
				)
			}
		]
	}));
	const sourceKey = input.cases.map((caseRecord) => ({
		caseId: caseRecord.id,
		blindKey: {
			variant_a: 'baseline',
			variant_b: 'candidate'
		}
	}));
	const generatorOutputRef = await writeRunJson(runId, 'generator-output.json', {
		schema: input.runKind === 'benchmark'
			? 'spark.loop_engineering.benchmark_generator_output.v1'
			: 'spark.loop_engineering.loop_generator_output.v1',
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		providerMissionId: generatorMissionId,
		createdAt: nowIso(),
		generator: {
			provider: providers.generator.id,
			model: providers.generator.model
		},
		provenance: 'computed',
		blindComparison: true,
		roundLimit: input.runKind === 'loop' ? input.roundLimit : undefined,
		tokenUsage: generatorResult.tokenUsage,
		durationMs: generatorResult.durationMs,
		cases: generatorOutputs
	});
	const sourceKeyRef = await writeRunJson(runId, 'source-key.json', {
		schema: input.runKind === 'benchmark'
			? 'spark.loop_engineering.benchmark_source_key.v1'
			: 'spark.loop_engineering.loop_source_key.v1',
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		createdAt: nowIso(),
		availableAfterBlindScoring: true,
		sourceKey
	});
	const evaluatorCases = input.cases.map((caseRecord) => {
		const output = generatorOutputs.find((item) => item.caseId === caseRecord.id);
		return {
			caseId: caseRecord.id,
			kind: caseRecord.kind,
			prompt: caseRecord.prompt,
			expectedBehavior: caseRecord.expectedBehavior,
			baselineOutput: output?.blindVariants.find((variant) => variant.blindId === 'variant_a')?.output || '',
			candidateOutput: output?.blindVariants.find((variant) => variant.blindId === 'variant_b')?.output || ''
		};
	});
	const evaluatorResult = await dispatchProviderProof({
		missionId: evaluatorMissionId,
		provider: providers.evaluator,
		taskTitle: `Judge private ${input.runKind} candidate outputs`,
		prompt: buildEvaluatorPrompt({
			chipKey: input.chipKey,
			runKind: input.runKind,
			objective: input.objective,
			roundLimit: input.roundLimit,
			cases: evaluatorCases
		}),
		dispatchExecutionAuthority: input.options.dispatchExecutionAuthority,
		waitForCompletionMs,
		chipKey: input.chipKey,
		runKind: input.runKind,
		role: 'evaluator'
	});
	const parsedEvaluator = requireProviderJsonPacket(
		extractJsonRecord(evaluatorResult.response),
		'evaluator',
		providers.evaluator.id,
		evaluatorResult.response
	);
	validateEvaluatorPacket(parsedEvaluator, input.cases, providers.evaluator.id);
	const caseResults = input.cases.map((caseRecord) => evaluatorCaseResult(parsedEvaluator, caseRecord));
	const previousScore = meanScore(caseResults.map((result) => result.baselineScore));
	const candidateScore = meanScore(caseResults.map((result) => result.candidateScore));
	const utilityDelta = Number((candidateScore - previousScore).toFixed(2));
	const status: LoopEngineeringBenchmarkRunPacket['status'] = utilityDelta > 0 ? 'passed' : utilityDelta < 0 ? 'failed' : 'blocked';
	const acceptedLessons = input.runKind === 'loop' && status === 'passed' ? acceptedLessonsFromParsed(parsedEvaluator) : [];
	const loopPlanRef = input.runKind === 'loop'
		? await writeLoopRunJson(runId, 'loop-plan.json', {
			schema: 'spark.loop_engineering.loop_plan.v1',
			chipKey: input.chipKey,
			eventId: input.eventId,
			missionId: input.missionId,
			createdAt: nowIso(),
			objective: input.objective,
			roundLimit: input.roundLimit,
			provenance: 'computed',
			stopConditions: ['round_cap_reached', 'no_safe_win_accepted', 'watchtower_failed', 'owner_paused'],
			allowedMutations: ['prompt_guidance', 'rubric_weighting', 'fast_path_notes'],
			forbiddenMutations: ['activation', 'publication', 'external_network_calls', 'self_scoring'],
			claimBoundary: 'Computed private loop improvement plan only; evaluator verdict is required before any lesson is accepted.'
		})
		: null;
	const evaluatorVerdictRef = await writeRunJson(
		runId,
		input.runKind === 'benchmark' ? 'blind-evaluator-verdict.json' : 'loop-evaluator-verdict.json',
		{
			schema: input.runKind === 'benchmark'
				? 'spark.loop_engineering.blind_evaluator_verdict.v1'
				: 'spark.loop_engineering.loop_evaluator_verdict.v1',
			chipKey: input.chipKey,
			eventId: input.eventId,
			missionId: input.missionId,
			providerMissionId: evaluatorMissionId,
			createdAt: nowIso(),
			evaluatorProvider: providers.evaluator.id,
			evaluatorModel: providers.evaluator.model,
			generatorProvider: providers.generator.id,
			generatorModel: providers.generator.model,
			evaluator: {
				provider: providers.evaluator.id,
				model: providers.evaluator.model
			},
			generator: {
				provider: providers.generator.id,
				model: providers.generator.model
			},
			blindComparison: true,
			evaluatorSeparated: true,
			provenance: 'computed',
			blindProtocol: 'A provider-generated candidate was scored by a different provider against blind baseline/candidate variants. Source labels are bound only in the source-key packet.',
			roundsObserved: input.runKind === 'loop' ? input.roundLimit : undefined,
			caseResults,
			acceptedLessons,
			aggregate: {
				previousScore,
				candidateScore,
				utilityDelta,
				status
			},
			tokenUsage: evaluatorResult.tokenUsage,
			durationMs: evaluatorResult.durationMs,
			claimBoundary: input.runKind === 'benchmark'
				? 'Computed benchmark verdict. It can support review before the chip is used automatically.'
				: 'Computed loop verdict. It can support distillation review before lessons are accepted automatically.'
		}
	);
	const sourceRef = await writeRunJson(runId, 'summary.json', {
		schema: input.runKind === 'benchmark'
			? 'spark.loop_engineering.autonomous_benchmark_summary.v1'
			: 'spark.loop_engineering.autonomous_loop_summary.v1',
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		runId,
		caseCount: input.cases.length,
		roundsObserved: input.runKind === 'loop' ? input.roundLimit : undefined,
		previousScore,
		candidateScore,
		utilityDelta,
		status,
		provenance: 'computed',
		evaluatorSeparated: true,
		generatorProvider: providers.generator.id,
		evaluatorProvider: providers.evaluator.id,
		generatorMissionId,
		evaluatorMissionId,
		...(loopPlanRef ? { loopPlanRef } : {}),
		generatorOutputRef,
		evaluatorVerdictRef,
		sourceKeyRef,
		acceptedLessons
	});
	const base = {
		runId,
		chipKey: input.chipKey,
		eventId: input.eventId,
		missionId: input.missionId,
		createdAt: nowIso(),
		status,
		blindComparison: true,
		evaluatorSeparated: true,
		provenance: 'computed' as const,
		evaluatorModel: providers.evaluator.model,
		evaluatorProvider: providers.evaluator.id,
		generatorProvider: providers.generator.id,
		sourceRef,
		evaluatorVerdictRef,
		generatorOutputRef,
		sourceKeyRef,
		previousScore,
		candidateScore,
		utilityDelta,
		caseResults,
		claimBoundary: input.runKind === 'benchmark'
			? 'Computed private benchmark verdict. Activation still requires staged review and rollback proof.'
			: 'Computed private loop verdict. Activation still requires staged review and rollback proof.',
		nextAction: utilityDelta > 0
			? 'Record evaluator review or distill only the accepted lesson; activation remains staged.'
			: 'Inspect weak cases before running another private loop or claiming improvement.'
	};
	if (input.runKind === 'benchmark') {
		return base;
	}
	if (!loopPlanRef) throw new Error('computed loop run missing loop plan ref');
	return {
		...base,
		roundsObserved: input.roundLimit,
		loopPlanRef,
		acceptedLessons
	};
}

export async function launchPrivateLoopEngineeringRun(input: {
	chipKey: string;
	runKind: LoopEngineeringRunKind;
	objective?: string;
	roundLimit?: number | null;
	benchmarkCaseIds?: string[];
	sourceSurface?: LoopEngineeringEvent['sourceSurface'];
	requestId?: string | null;
}): Promise<{ event: LoopEngineeringEvent; mission: { id: string; name: string; goal: string; inspectUrl: string }; commandResult: LoopEngineeringCommandResult }> {
	const chipKey = safeLoopEngineeringChipKey(input.chipKey);
	if (!chipKey) throw new Error('valid domain-chip key required');
	if (input.runKind !== 'benchmark' && input.runKind !== 'loop') throw new Error('runKind must be benchmark or loop');
	const roundLimit = input.runKind === 'loop' ? positiveInteger(input.roundLimit) : 1;
	if (input.runKind === 'loop' && !roundLimit) throw new Error('loop runs require positive roundLimit');
	const objective = cleanString(input.objective) || (
		input.runKind === 'benchmark'
			? 'Score current chip behavior against the benchmark suite with separated evaluator evidence.'
			: 'Run a capped private self-improvement loop and distill only evaluator-proven lessons.'
	);
	const missionId = loopMissionId();
	const missionName = input.runKind === 'benchmark'
		? `Loop Engineering Benchmark: ${chipKey}`
		: `Loop Engineering Improvement Loop: ${chipKey}`;
	const benchmarkCaseIds = stringList(input.benchmarkCaseIds);
	if (benchmarkCaseIds.length > 0) {
		const allCases = await listBenchmarkCases(chipKey, { includeArtifactCases: true });
		const selectedCases = selectBenchmarkCases(
			allCases,
			benchmarkCaseIds
		);
		if (selectedCases.length !== uniqueStrings(benchmarkCaseIds).length) {
			throw new Error('queued run benchmarkCaseIds must all refer to active staged cases for this chip');
		}
	}
	const goal = buildPrivateRunGoal({ chipKey, runKind: input.runKind, objective, roundLimit, benchmarkCaseIds });
	const requestId = cleanString(input.requestId) || missionId;
	const traceRef = `trace:loop-engineering:${missionId}`;
	const event = await appendLoopEngineeringEvent({
		chipKey,
		eventType: input.runKind === 'benchmark' ? 'benchmark_run' : 'loop_batch',
		label: input.runKind === 'benchmark' ? 'Private benchmark run queued' : 'Private improvement loop queued',
		status: 'queued',
		sourceSurface: normalizeSourceSurface(input.sourceSurface),
		roundsObserved: input.runKind === 'loop' ? roundLimit : 1,
		evaluatorSeparated: false,
		evidenceRefs: [`mission-control:${missionId}`, traceRef],
		missionId,
		nextAction: 'Run the generator/evaluator mission and record evaluator evidence before accepting any improvement claim.'
	});
	await relayMissionControlEvent({
		type: 'mission_created',
		missionId,
		missionName,
		source: 'loop-engineering',
		timestamp: nowIso(),
		message: `${missionName} queued privately.`,
		data: {
			missionName,
			goal,
			requestId,
			traceRef,
			chipKey,
			runKind: input.runKind,
			loopEngineeringEventId: event.id,
			executionPolicy: 'manual_run',
			suppressExternalRelay: true,
			plannedTasks: [
				{ title: 'Generate candidate work in an isolated private loop context', skills: ['loop-engineering'] },
				{ title: 'Evaluate with separated judge and benchmark rubric', skills: ['evaluation'] },
				{ title: 'Distill accepted lessons without activation or publishing', skills: ['distillation'] }
			]
		}
	});
	const inspectUrl = `/loop-engineering/${encodeURIComponent(chipKey)}`;
	return {
		event,
		mission: {
			id: missionId,
			name: missionName,
			goal,
			inspectUrl: resolveMissionControlAccess(missionControlPathForMission(missionId)).url || missionControlPathForMission(missionId)
		},
		commandResult: {
			action: input.runKind === 'benchmark' ? 'benchmark_run_queued' : 'loop_run_queued',
			chipKey,
			changed: true,
			launchedMission: true,
			missionId,
			eventId: event.id,
			inspectUrl,
			userMessage: input.runKind === 'benchmark'
				? `Queued a private benchmark mission for ${chipKey}. It can produce evidence, but it does not approve activation or claim improvement by itself.`
				: `Queued a capped private loop mission for ${chipKey}. Generator work and evaluator scoring stay separated before any lesson is accepted.`
		}
	};
}

export async function executePrivateBenchmarkRun(input: {
	chipKey: string;
	objective?: string;
	benchmarkCaseIds?: string[];
	sourceSurface?: LoopEngineeringEvent['sourceSurface'];
	requestId?: string | null;
	providerProof?: LoopEngineeringComputedRunOptions;
}): Promise<{
	event: LoopEngineeringEvent;
	mission: { id: string; name: string; goal: string; inspectUrl: string };
	benchmarkRun: LoopEngineeringBenchmarkRunPacket;
	commandResult: LoopEngineeringCommandResult;
}> {
	const chipKey = safeLoopEngineeringChipKey(input.chipKey);
	if (!chipKey) throw new Error('valid domain-chip key required');
	const allCases = await listBenchmarkCases(chipKey, { includeArtifactCases: true });
	const selectedCases = selectBenchmarkCases(
		allCases,
		stringList(input.benchmarkCaseIds)
	);
	if (selectedCases.length === 0) {
		throw new Error('at least one active staged benchmark case is required before executing a benchmark');
	}
	const useComputed = input.providerProof?.mode === 'computed';
	if (useComputed && !input.providerProof?.dispatchExecutionAuthority) {
		throw new Error('computed benchmark evidence requires dispatchExecutionAuthority');
	}
	if (useComputed) resolveComputedRunProviders(input.providerProof);
	const queued = await launchPrivateLoopEngineeringRun({
		chipKey,
		runKind: 'benchmark',
		objective: cleanString(input.objective) || 'Execute staged benchmark cases with a separated blind evaluator verdict.',
		benchmarkCaseIds: selectedCases.map((caseRecord) => caseRecord.id),
		sourceSurface: input.sourceSurface ?? 'spawner',
		requestId: input.requestId
	});
	let benchmarkRun: LoopEngineeringBenchmarkRunPacket;
	try {
		benchmarkRun = useComputed
			? await buildComputedRunPacket({
				chipKey,
				eventId: queued.event.id,
				missionId: queued.mission.id,
				runKind: 'benchmark',
				cases: selectedCases,
				roundLimit: 1,
				objective: cleanString(input.objective) || 'Execute staged benchmark cases with a separated blind evaluator verdict.',
				options: input.providerProof as Required<Pick<LoopEngineeringComputedRunOptions, 'dispatchExecutionAuthority'>> & LoopEngineeringComputedRunOptions
			}) as LoopEngineeringBenchmarkRunPacket
			: await buildBenchmarkRunPacket({
				chipKey,
				eventId: queued.event.id,
				missionId: queued.mission.id,
				cases: selectedCases
			});
	} catch (error) {
		await completeLoopEngineeringRunEvent({
			eventId: queued.event.id,
			status: 'blocked',
			label: publicLoopEngineeringErrorMessage(error, 'Benchmark evidence could not be computed.'),
			evidenceRefs: selectedCases.flatMap(benchmarkCaseEvidenceRefs),
			nextAction: 'Inspect provider output and rerun after the proof packet can be parsed.'
		}).catch(() => undefined);
		throw error;
	}
	const completed = await completeLoopEngineeringRunEvent({
		eventId: queued.event.id,
		status: benchmarkRun.status,
		previousScore: benchmarkRun.previousScore,
		candidateScore: benchmarkRun.candidateScore,
		evaluatorSeparated: benchmarkRun.evaluatorSeparated,
		provenance: benchmarkRun.provenance,
		sourceRef: benchmarkRun.sourceRef,
		evaluatorVerdictRef: benchmarkRun.evaluatorVerdictRef,
		evidenceRefs: [
			benchmarkRun.generatorOutputRef,
			benchmarkRun.sourceKeyRef,
			benchmarkRun.evaluatorVerdictRef,
			benchmarkRun.sourceRef,
			...selectedCases.flatMap(benchmarkCaseEvidenceRefs)
		],
		nextAction: benchmarkRun.nextAction
	});
	const commandResult: LoopEngineeringCommandResult = {
		...completed.commandResult,
		action: 'benchmark_run_executed',
		benchmarkRunId: benchmarkRun.runId,
		evaluatorVerdictRef: benchmarkRun.evaluatorVerdictRef,
		...(benchmarkRun.provenance === 'computed' ? { provenance: 'computed' } : {}),
		previousScore: benchmarkRun.previousScore,
		candidateScore: benchmarkRun.candidateScore,
		utilityDelta: benchmarkRun.utilityDelta,
		caseCount: selectedCases.length,
		userMessage: benchmarkRun.status === 'passed'
			? benchmarkRun.provenance === 'computed'
				? `Ran ${selectedCases.length} benchmark case${selectedCases.length === 1 ? '' : 's'} for ${chipKey}: ${benchmarkRun.previousScore.toFixed(1)} -> ${benchmarkRun.candidateScore.toFixed(1)}. Provider-backed evaluator evidence is ready to inspect.`
				: `Quick local smoke ran across ${selectedCases.length} benchmark case${selectedCases.length === 1 ? '' : 's'} for ${chipKey}. It checked the route and scoring harness; use provider-backed evaluator evidence for real improvement proof.`
			: `Ran ${selectedCases.length} benchmark case${selectedCases.length === 1 ? '' : 's'} for ${chipKey}; the candidate did not beat baseline. No lesson was accepted.`
	};
	const updatedState = await readState();
	const eventIndex = updatedState.events.findIndex((event) => event.id === queued.event.id && event.chipId === chipKey);
	if (eventIndex !== -1) {
		updatedState.events[eventIndex] = {
			...updatedState.events[eventIndex],
			label: 'Private benchmark run executed',
			roundsObserved: null,
			commandResult,
			updatedAt: nowIso()
		};
		await writeState(updatedState);
	}
	return {
		event: {
			...completed.event,
			label: 'Private benchmark run executed',
			roundsObserved: null,
			commandResult
		},
		mission: queued.mission,
		benchmarkRun,
		commandResult
	};
}

export async function executePrivateLoopEngineeringRun(input: {
	chipKey: string;
	objective?: string;
	roundLimit?: number | null;
	benchmarkCaseIds?: string[];
	sourceSurface?: LoopEngineeringEvent['sourceSurface'];
	requestId?: string | null;
	providerProof?: LoopEngineeringComputedRunOptions;
}): Promise<{
	event: LoopEngineeringEvent;
	mission: { id: string; name: string; goal: string; inspectUrl: string };
	loopRun: LoopEngineeringLoopRunPacket;
	commandResult: LoopEngineeringCommandResult;
}> {
	const chipKey = safeLoopEngineeringChipKey(input.chipKey);
	if (!chipKey) throw new Error('valid domain-chip key required');
	const roundLimit = positiveInteger(input.roundLimit);
	if (!roundLimit) throw new Error('loop runs require positive roundLimit');
	const allCases = await listBenchmarkCases(chipKey, { includeArtifactCases: true });
	const selectedCases = selectBenchmarkCases(
		allCases,
		stringList(input.benchmarkCaseIds)
	);
	if (selectedCases.length === 0) {
		throw new Error('at least one active staged benchmark case is required before executing a loop');
	}
	const objective = cleanString(input.objective) || 'Execute a capped private loop improvement run with separated evaluator evidence.';
	const useComputed = input.providerProof?.mode === 'computed';
	if (useComputed && !input.providerProof?.dispatchExecutionAuthority) {
		throw new Error('computed loop evidence requires dispatchExecutionAuthority');
	}
	if (useComputed) resolveComputedRunProviders(input.providerProof);
	const queued = await launchPrivateLoopEngineeringRun({
		chipKey,
		runKind: 'loop',
		objective,
		roundLimit,
		benchmarkCaseIds: selectedCases.map((caseRecord) => caseRecord.id),
		sourceSurface: input.sourceSurface ?? 'spawner',
		requestId: input.requestId
	});
	let loopRun: LoopEngineeringLoopRunPacket;
	try {
		loopRun = useComputed
			? await buildComputedRunPacket({
				chipKey,
				eventId: queued.event.id,
				missionId: queued.mission.id,
				runKind: 'loop',
				cases: selectedCases,
				roundLimit,
				objective,
				options: input.providerProof as Required<Pick<LoopEngineeringComputedRunOptions, 'dispatchExecutionAuthority'>> & LoopEngineeringComputedRunOptions
			}) as LoopEngineeringLoopRunPacket
			: await buildLoopRunPacket({
				chipKey,
				eventId: queued.event.id,
				missionId: queued.mission.id,
				cases: selectedCases,
				roundLimit,
				objective
			});
	} catch (error) {
		await completeLoopEngineeringRunEvent({
			eventId: queued.event.id,
			status: 'blocked',
			label: publicLoopEngineeringErrorMessage(error, 'Loop evidence could not be computed.'),
			roundsObserved: roundLimit,
			evidenceRefs: selectedCases.flatMap(benchmarkCaseEvidenceRefs),
			nextAction: 'Inspect provider output and rerun after the proof packet can be parsed.'
		}).catch(() => undefined);
		throw error;
	}
	const completed = await completeLoopEngineeringRunEvent({
		eventId: queued.event.id,
		status: loopRun.status,
		previousScore: loopRun.previousScore,
		candidateScore: loopRun.candidateScore,
		roundsObserved: roundLimit,
		evaluatorSeparated: loopRun.evaluatorSeparated,
		provenance: loopRun.provenance,
		sourceRef: loopRun.sourceRef,
		evaluatorVerdictRef: loopRun.evaluatorVerdictRef,
		evidenceRefs: [
			loopRun.loopPlanRef,
			loopRun.generatorOutputRef,
			loopRun.sourceKeyRef,
			loopRun.evaluatorVerdictRef,
			loopRun.sourceRef,
			...selectedCases.flatMap(benchmarkCaseEvidenceRefs)
		],
		nextAction: loopRun.nextAction
	});
	const commandResult: LoopEngineeringCommandResult = {
		...completed.commandResult,
		action: 'loop_run_executed',
		loopRunId: loopRun.runId,
		evaluatorVerdictRef: loopRun.evaluatorVerdictRef,
		...(loopRun.provenance === 'computed' ? { provenance: 'computed' } : {}),
		previousScore: loopRun.previousScore,
		candidateScore: loopRun.candidateScore,
		utilityDelta: loopRun.utilityDelta,
		caseCount: selectedCases.length,
		roundsObserved: roundLimit,
		userMessage: loopRun.status === 'passed'
			? loopRun.provenance === 'computed'
				? `Ran ${roundLimit} loop round${roundLimit === 1 ? '' : 's'} for ${chipKey} on ${selectedCases.length} case${selectedCases.length === 1 ? '' : 's'}: ${loopRun.previousScore.toFixed(1)} -> ${loopRun.candidateScore.toFixed(1)}. Provider-backed evaluator evidence is ready for distillation review.`
				: `Quick local smoke ran ${roundLimit} loop round${roundLimit === 1 ? '' : 's'} for ${chipKey} on ${selectedCases.length} case${selectedCases.length === 1 ? '' : 's'}. It checked the route and scoring harness; use provider-backed evaluator evidence for real improvement proof.`
			: `Ran ${roundLimit} loop round${roundLimit === 1 ? '' : 's'} for ${chipKey}; the loop did not beat baseline. No lesson was accepted.`
	};
	const updatedState = await readState();
	const eventIndex = updatedState.events.findIndex((event) => event.id === queued.event.id && event.chipId === chipKey);
	if (eventIndex !== -1) {
		updatedState.events[eventIndex] = {
			...updatedState.events[eventIndex],
			commandResult,
			updatedAt: nowIso()
		};
		await writeState(updatedState);
	}
	return {
		event: {
			...completed.event,
			commandResult
		},
		mission: queued.mission,
		loopRun,
		commandResult
	};
}

export async function completeLoopEngineeringRunEvent(input: {
	eventId?: string | null;
	missionId?: string | null;
	chipKey?: string | null;
	status: LoopEngineeringCompletionStatus;
	label?: string;
	previousScore?: number | null;
	candidateScore?: number | null;
	utilityDelta?: number | null;
	roundsObserved?: number | null;
	evaluatorSeparated?: boolean;
	provenance?: LoopEngineeringEvidenceProvenance;
	evidenceRefs?: string[];
	sourceRef?: string | null;
	evaluatorVerdictRef?: string | null;
	scheduleId?: string | null;
	nextAction?: string;
	completedAt?: string | null;
}): Promise<{ event: LoopEngineeringEvent; commandResult: LoopEngineeringCommandResult }> {
	const eventId = cleanString(input.eventId);
	const missionId = cleanString(input.missionId);
	if (!eventId && !missionId) throw new Error('eventId or missionId required');
	const status = completionStatus(input.status);
	if (!status) throw new Error('completion status must be passed, failed, or blocked');
	const chipKey = input.chipKey ? safeLoopEngineeringChipKey(input.chipKey) : null;
	if (input.chipKey && !chipKey) throw new Error('valid domain-chip key required');

	const state = await readState();
	const eventIndex = state.events.findIndex((event) => (
		(eventId && event.id === eventId) || (missionId && event.missionId === missionId)
	) && (!chipKey || event.chipId === chipKey));
	if (eventIndex === -1) throw new Error('loop-engineering run event not found');

	const existing = state.events[eventIndex];
	if (existing.eventType !== 'benchmark_run' && existing.eventType !== 'loop_batch') {
		throw new Error('only benchmark_run and loop_batch events can be completed');
	}

	const previousScore = input.previousScore === undefined ? existing.previousScore : validScore(input.previousScore);
	const candidateScore = input.candidateScore === undefined ? existing.candidateScore : validScore(input.candidateScore);
	if (input.previousScore !== undefined && previousScore === null) throw new Error('previousScore must be a number from 0 to 10');
	if (input.candidateScore !== undefined && candidateScore === null) throw new Error('candidateScore must be a number from 0 to 10');
	const calculatedDelta = previousScore !== null && candidateScore !== null
		? Number((candidateScore - previousScore).toFixed(4))
		: null;
	const utilityDelta = typeof input.utilityDelta === 'number' && Number.isFinite(input.utilityDelta)
		? Number(input.utilityDelta.toFixed(4))
		: calculatedDelta ?? existing.utilityDelta;
	const completionEvidenceRefs = evidenceRefList(input.evidenceRefs);
	const evidenceRefs = uniqueStrings([
		...evidenceRefList(existing.evidenceRefs, 'existing event evidenceRefs'),
		...completionEvidenceRefs
	]);
	const existingSourceRef = optionalEvidenceRef(existing.sourceRef, 'existing sourceRef');
	const existingEvaluatorVerdictRef = optionalEvidenceRef(existing.evaluatorVerdictRef, 'existing evaluatorVerdictRef');
	const sourceRef = optionalEvidenceRef(input.sourceRef, 'sourceRef') || existingSourceRef || null;
	const evaluatorVerdictRef = optionalEvidenceRef(input.evaluatorVerdictRef, 'evaluatorVerdictRef') || existingEvaluatorVerdictRef || null;
	const provenance = input.provenance ?? existing.provenance ?? null;
	const hasProofRef = evidenceRefs.length > 0 || Boolean(sourceRef) || Boolean(evaluatorVerdictRef);
	const positiveImprovementClaim = status === 'passed' && typeof utilityDelta === 'number' && utilityDelta > 0;

	if (!hasProofRef) throw new Error('completion requires at least one sourceRef, evaluatorVerdictRef, or evidenceRef');
	if (input.evaluatorSeparated === true && !evaluatorVerdictRef) {
		throw new Error('separated evaluator completion requires evaluatorVerdictRef');
	}
	if (status === 'passed' && provenance !== 'synthetic' && input.evaluatorSeparated !== true && existing.evaluatorSeparated !== true) {
		throw new Error('passed completion requires separated evaluator evidence');
	}
	if (positiveImprovementClaim && provenance !== 'synthetic' && provenance !== 'computed') {
		throw new Error('positive improvement claims require computed provenance');
	}
	if (positiveImprovementClaim && provenance !== 'synthetic' && completionEvidenceRefs.length === 0) {
		throw new Error('positive improvement claims require separated evaluator evidence refs');
	}
	let evaluatorEvidenceBound = false;
	if (input.evaluatorSeparated === true && evaluatorVerdictRef) {
		await readEvaluatorVerdictPacket(evaluatorVerdictRef, existing.chipId, {
			eventId: existing.id,
			missionId: existing.missionId,
			previousScore,
			candidateScore,
			utilityDelta
		});
		evaluatorEvidenceBound = true;
	} else if (existing.evaluatorSeparated === true && existingEvaluatorVerdictRef) {
		await readEvaluatorVerdictPacket(existingEvaluatorVerdictRef, existing.chipId, {
			eventId: existing.id,
			missionId: existing.missionId,
			previousScore: existing.previousScore,
			candidateScore: existing.candidateScore,
			utilityDelta: existing.utilityDelta
		});
		evaluatorEvidenceBound = true;
	}
	const evaluatorSeparated = evaluatorEvidenceBound;
	// Option B (doc 42 ruling 4): synthetic runs MAY complete locally for keep/defer iteration — they are
	// labeled provenance:'synthetic' and evaluatorSeparated:false, so the promotion path (recordEvaluatorReview
	// :606 / distillEvaluatorLessons :696, both requiring evaluatorSeparated===true) still rejects them. Only
	// these two LOCAL-staging gates are relaxed for synthetic; the security property (synthetic cannot promote
	// or distill) is enforced downstream, not here.
	if (status === 'passed' && evaluatorEvidenceBound !== true && provenance !== 'synthetic') {
		throw new Error('passed completion requires separated evaluator evidence');
	}
	if (positiveImprovementClaim && provenance !== 'synthetic' && evaluatorEvidenceBound !== true) {
		throw new Error('positive improvement claims require separated evaluator evidence refs');
	}
	const completedAt = cleanString(input.completedAt) || nowIso();
	const action = status === 'passed' ? 'run_completion_bound' : 'run_completion_recorded';
	const commandResult: LoopEngineeringCommandResult = {
		action,
		chipKey: existing.chipId,
		changed: true,
		launchedMission: false,
		...(existing.missionId ? { missionId: existing.missionId } : {}),
		eventId: existing.id,
		inspectUrl: `/loop-engineering/${encodeURIComponent(existing.chipId)}`,
		...(status === 'blocked' ? { blockedReason: cleanString(input.label) || 'Loop completion was blocked by evaluator or runtime evidence.' } : {}),
		userMessage: status === 'passed'
			? provenance === 'synthetic'
				? `Recorded a local smoke completion for ${existing.chipId}. It can guide iteration, but evaluator review is still required before any lesson is accepted.`
				: `Bound evaluator-backed completion for ${existing.chipId}. The run is recorded as passed; inspect the staged approval checklist before using it automatically.`
			: status === 'failed'
				? `Recorded evaluator-backed completion for ${existing.chipId}; the candidate did not pass. No lesson was accepted.`
				: `Recorded a blocked loop completion for ${existing.chipId}. The run stays private until the blocker is resolved.`
	};
	const updatedEvent: LoopEngineeringEvent = {
		...existing,
		label: cleanString(input.label) || existing.label,
		status,
		previousScore,
		candidateScore,
		utilityDelta,
		roundsObserved: typeof input.roundsObserved === 'number' ? input.roundsObserved : existing.roundsObserved,
		evaluatorSeparated,
		...(provenance ? { provenance } : {}),
		evidenceRefs,
		sourceRef,
		evaluatorVerdictRef,
		scheduleId: cleanString(input.scheduleId) || existing.scheduleId || null,
		completedAt,
		commandResult,
		nextAction: cleanString(input.nextAction) || (status === 'passed'
			? 'Record or distill only the separated evaluator-supported lessons; activation remains staged until approval.'
			: 'Inspect the evaluator evidence and run another private loop only if there is a concrete improvement target.'),
		updatedAt: completedAt
	};
	state.events[eventIndex] = updatedEvent;
	await writeState(state);
	if (updatedEvent.missionId) {
		await relayMissionControlEvent({
			type: terminalMissionRelayType(status),
			missionId: updatedEvent.missionId,
			missionName: updatedEvent.label,
			source: 'loop-engineering',
			timestamp: completedAt,
			message: commandResult.userMessage,
			data: {
				chipKey: updatedEvent.chipId,
				loopEngineeringEventId: updatedEvent.id,
				status,
				sourceRef,
				evaluatorVerdictRef,
				evaluatorSeparated,
				evidenceRefs,
				utilityDelta,
				suppressExternalRelay: true
			}
		});
	}
	return {
		event: { ...updatedEvent, evidenceRefs: [...updatedEvent.evidenceRefs], commandResult: { ...commandResult } },
		commandResult
	};
}

function positiveInteger(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	const integer = Math.trunc(value);
	return integer > 0 ? integer : null;
}

function validTimezone(value: unknown): string | null {
	const timezone = cleanString(value);
	if (!timezone) return null;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: timezone });
		return timezone;
	} catch {
		return null;
	}
}

function normalizeScheduleMode(value: LoopScheduleMode): LoopScheduleMode {
	return ['once', 'interval', 'fixed_time', 'continuous', 'round_count'].includes(value) ? value : 'round_count';
}

function normalizeStopConditions(value: unknown): string[] {
	const supplied = stringList(value);
	const defaults = ['round_cap_reached', 'no_safe_win_accepted', 'watchtower_failed', 'rollback_missing', 'owner_paused'];
	return [...new Set([...supplied, ...defaults])];
}

function nextRunAtForSchedule(schedule: LoopEngineeringSchedule, fromIso: string): string | null {
	const from = new Date(fromIso);
	if (!Number.isFinite(from.getTime())) return null;
	if (schedule.mode === 'once' || schedule.mode === 'round_count') return null;
	if (schedule.mode === 'interval' && schedule.intervalMinutes) {
		return new Date(from.getTime() + schedule.intervalMinutes * 60 * 1000).toISOString();
	}
	if (schedule.mode === 'continuous') return fromIso;
	if (schedule.mode === 'fixed_time' && schedule.fixedLocalTime) {
		const [hoursRaw, minutesRaw] = schedule.fixedLocalTime.split(':');
		const hours = Number.parseInt(hoursRaw || '', 10);
		const minutes = Number.parseInt(minutesRaw || '', 10);
		if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
		const next = new Date(from);
		next.setHours(hours, minutes, 0, 0);
		if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
		return next.toISOString();
	}
	return null;
}

export async function stageLoopSchedule(input: {
	chipKey: string;
	name?: string;
	mode: LoopScheduleMode;
	benchmarkCaseIds?: string[];
	generatorProviderId?: string | null;
	evaluatorProviderId?: string | null;
	waitForCompletionMs?: number | null;
	intervalMinutes?: number | null;
	fixedLocalTime?: string | null;
	timezone?: string | null;
	roundLimit?: number | null;
	stopConditions?: string[];
	sourceSurface?: LoopEngineeringEvent['sourceSurface'];
}): Promise<{ schedule: LoopEngineeringSchedule; event: LoopEngineeringEvent; commandResult: LoopEngineeringCommandResult }> {
	const chipKey = safeLoopEngineeringChipKey(input.chipKey);
	if (!chipKey) throw new Error('valid domain-chip key required');
	const mode = normalizeScheduleMode(input.mode);
	const roundLimit = positiveInteger(input.roundLimit) ?? null;
	if (!roundLimit) throw new Error('roundLimit must be a positive integer');
	const intervalMinutes = positiveInteger(input.intervalMinutes);
	if (mode === 'interval' && !intervalMinutes) throw new Error('interval schedules require positive intervalMinutes');
	const fixedLocalTime = cleanString(input.fixedLocalTime) || null;
	if (mode === 'fixed_time' && !fixedLocalTime) throw new Error('fixed_time schedules require fixedLocalTime');
	const benchmarkCaseIds = uniqueStrings(stringList(input.benchmarkCaseIds));
	const allCases = await listBenchmarkCases(chipKey, { includeArtifactCases: true });
	const selectedCases = selectBenchmarkCases(
		allCases,
		benchmarkCaseIds
	);
	if (benchmarkCaseIds.length === 0) throw new Error('schedule benchmarkCaseIds must include at least one active staged case');
	if (selectedCases.length !== benchmarkCaseIds.length) {
		throw new Error('schedule benchmarkCaseIds must all refer to active staged cases for this chip');
	}
	const providerPreview = getLoopEngineeringProviderProofPreview({
		mode: 'computed',
		generatorProviderId: input.generatorProviderId,
		evaluatorProviderId: input.evaluatorProviderId,
		waitForCompletionMs: input.waitForCompletionMs
	});
	const timestamp = nowIso();
	const schedule: LoopEngineeringSchedule = {
		id: nextId('loopsched'),
		chipKey,
		name: cleanString(input.name) || `${chipKey} private loop schedule`,
		mode,
		benchmarkCaseIds: selectedCases.map((caseRecord) => caseRecord.id),
		generatorProviderId: providerPreview.generator.id,
		evaluatorProviderId: providerPreview.evaluator.id,
		waitForCompletionMs: positiveInteger(input.waitForCompletionMs) ?? providerPreview.waitForCompletionMs,
		intervalMinutes,
		fixedLocalTime,
		timezone: validTimezone(input.timezone),
		roundLimit,
		stopConditions: normalizeStopConditions(input.stopConditions),
		active: false,
		status: 'staged',
		createdAt: timestamp,
		updatedAt: timestamp,
		nextRunAt: null,
		lastRunAt: null,
		runCount: 0,
		lastEventId: null
	};
	const event = await appendLoopEngineeringEvent({
		chipKey,
		eventType: 'schedule_created',
		label: 'Private loop schedule staged',
		status: 'passed',
		sourceSurface: normalizeSourceSurface(input.sourceSurface),
		roundsObserved: roundLimit,
		evaluatorSeparated: false,
		evidenceRefs: [`control-plane:schedules:${schedule.id}`],
		nextAction: `Keep this schedule staged until a fresh Governor-authorized run path fires it against its ${selectedCases.length} selected benchmark case${selectedCases.length === 1 ? '' : 's'}.`
	});
	schedule.lastEventId = event.id;
	const updatedState = await readState();
	updatedState.schedules.push(schedule);
	await writeState(updatedState);
	return {
		schedule,
		event,
		commandResult: {
			action: 'schedule_created',
			chipKey,
			changed: true,
			launchedMission: false,
			eventId: event.id,
			caseCount: selectedCases.length,
			inspectUrl: `/loop-engineering/${encodeURIComponent(chipKey)}`,
			userMessage: `Staged a private loop schedule for ${chipKey} with ${selectedCases.length} selected benchmark case${selectedCases.length === 1 ? '' : 's'} and a ${roundLimit}-round cap. It is not active and no loop started.`
		}
	};
}

function scheduleBoundProviderProof(
	schedule: LoopEngineeringSchedule,
	providerProof: LoopEngineeringComputedRunOptions | undefined
): LoopEngineeringComputedRunOptions | undefined {
	if (providerProof?.mode !== 'computed') return providerProof;
	return {
		...providerProof,
		generatorProviderId: cleanString(providerProof.generatorProviderId) || cleanString(schedule.generatorProviderId) || null,
		evaluatorProviderId: cleanString(providerProof.evaluatorProviderId) || cleanString(schedule.evaluatorProviderId) || null,
		waitForCompletionMs: positiveInteger(providerProof.waitForCompletionMs) ?? positiveInteger(schedule.waitForCompletionMs) ?? null
	};
}

export async function fireLoopSchedule(input: {
	chipKey: string;
	scheduleId: string;
	sourceSurface?: LoopEngineeringEvent['sourceSurface'];
	requestId?: string | null;
	providerProof?: LoopEngineeringComputedRunOptions;
}): Promise<{ schedule: LoopEngineeringSchedule; event: LoopEngineeringEvent; mission: { id: string; name: string; goal: string; inspectUrl: string }; loopRun: LoopEngineeringLoopRunPacket; commandResult: LoopEngineeringCommandResult }> {
	const chipKey = safeLoopEngineeringChipKey(input.chipKey);
	if (!chipKey) throw new Error('valid domain-chip key required');
	const scheduleId = cleanString(input.scheduleId);
	if (!scheduleId) throw new Error('scheduleId required');
	const state = await readState();
	const schedule = state.schedules.find((item) => item.id === scheduleId && item.chipKey === chipKey);
	if (!schedule) throw new Error('loop schedule not found');
	if (schedule.status !== 'staged') throw new Error(`loop schedule is ${schedule.status}`);
	if (schedule.mode === 'once' && schedule.runCount >= 1) throw new Error('once schedules can only be fired once');
	if (!positiveInteger(schedule.roundLimit)) throw new Error('schedule roundLimit must be a positive integer');
	const benchmarkCaseIds = stringList(schedule.benchmarkCaseIds);
	if (benchmarkCaseIds.length === 0) throw new Error('loop schedule has no selected benchmark cases');

	const firedAt = nowIso();
	const run = await executePrivateLoopEngineeringRun({
		chipKey,
		objective: [
			`Fire private schedule ${schedule.name}.`,
			`Run up to ${schedule.roundLimit} round(s) and stop on: ${schedule.stopConditions.join(', ')}.`,
			'Keep the schedule private/local; do not enable recurring execution or activation from this run.'
		].join(' '),
		roundLimit: schedule.roundLimit,
		benchmarkCaseIds,
		sourceSurface: input.sourceSurface ?? 'spawner',
		requestId: cleanString(input.requestId) || `schedule-fire:${schedule.id}:${Date.now()}`,
		providerProof: scheduleBoundProviderProof(schedule, input.providerProof)
	});

	const updatedState = await readState();
	const scheduleIndex = updatedState.schedules.findIndex((item) => item.id === schedule.id && item.chipKey === chipKey);
	const eventIndex = updatedState.events.findIndex((event) => event.id === run.event.id && event.chipId === chipKey);
	if (scheduleIndex === -1 || eventIndex === -1) throw new Error('schedule fire state binding failed');
	const commandResult: LoopEngineeringCommandResult = {
		...run.commandResult,
		action: 'schedule_loop_executed',
		chipKey,
		changed: true,
		launchedMission: true,
		missionId: run.mission.id,
		eventId: run.event.id,
		inspectUrl: `/loop-engineering/${encodeURIComponent(chipKey)}`,
		loopRunId: run.loopRun.runId,
		evaluatorVerdictRef: run.loopRun.evaluatorVerdictRef,
		previousScore: run.loopRun.previousScore,
		candidateScore: run.loopRun.candidateScore,
		utilityDelta: run.loopRun.utilityDelta,
		roundsObserved: run.loopRun.roundsObserved,
		caseCount: run.commandResult.caseCount,
		userMessage: run.loopRun.status === 'passed'
			? `Fired ${schedule.name} and completed ${run.loopRun.roundsObserved} loop round${run.loopRun.roundsObserved === 1 ? '' : 's'} for ${chipKey}: ${run.loopRun.previousScore.toFixed(1)} -> ${run.loopRun.candidateScore.toFixed(1)}. The evaluator packet is ready to inspect.`
			: `Fired ${schedule.name} as a capped loop for ${chipKey}; the scheduled run did not beat baseline. No lesson was accepted.`
	};
	const updatedSchedule: LoopEngineeringSchedule = {
		...updatedState.schedules[scheduleIndex],
		runCount: updatedState.schedules[scheduleIndex].runCount + 1,
		lastRunAt: firedAt,
		nextRunAt: nextRunAtForSchedule(updatedState.schedules[scheduleIndex], firedAt),
		lastEventId: run.event.id,
		updatedAt: firedAt
	};
	const updatedEvent: LoopEngineeringEvent = {
		...updatedState.events[eventIndex],
		label: 'Private scheduled loop completed',
		scheduleId: schedule.id,
		evidenceRefs: uniqueStrings([
			...updatedState.events[eventIndex].evidenceRefs,
			`control-plane:schedules:${schedule.id}`
		]),
		commandResult,
		nextAction: run.loopRun.status === 'passed'
			? 'Record evaluator review or distill only accepted scheduled-loop lessons; activation remains staged.'
			: 'Inspect weak scheduled-loop cases before running another private schedule fire.',
		updatedAt: firedAt
	};
	updatedState.schedules[scheduleIndex] = updatedSchedule;
	updatedState.events[eventIndex] = updatedEvent;
	await writeState(updatedState);
	return {
		schedule: { ...updatedSchedule, stopConditions: [...updatedSchedule.stopConditions] },
		event: { ...updatedEvent, evidenceRefs: [...updatedEvent.evidenceRefs], commandResult: { ...commandResult } },
		mission: run.mission,
		loopRun: run.loopRun,
		commandResult
	};
}

export async function updateLoopScheduleLifecycle(input: {
	chipKey: string;
	scheduleId: string;
	action: LoopScheduleLifecycleAction;
	sourceSurface?: LoopEngineeringEvent['sourceSurface'];
}): Promise<{ schedule: LoopEngineeringSchedule; event: LoopEngineeringEvent | null; commandResult: LoopEngineeringCommandResult }> {
	const chipKey = safeLoopEngineeringChipKey(input.chipKey);
	if (!chipKey) throw new Error('valid domain-chip key required');
	const scheduleId = cleanString(input.scheduleId);
	if (!scheduleId) throw new Error('scheduleId required');
	const action = input.action;
	if (!['pause', 'resume', 'cancel', 'deactivate'].includes(action)) throw new Error('unsupported schedule lifecycle action');

	const state = await readState();
	const scheduleIndex = state.schedules.findIndex((item) => item.id === scheduleId && item.chipKey === chipKey);
	if (scheduleIndex === -1) throw new Error('loop schedule not found');
	const existing = state.schedules[scheduleIndex];
	const noOp = (userMessage: string): { schedule: LoopEngineeringSchedule; event: null; commandResult: LoopEngineeringCommandResult } => ({
		schedule: { ...existing, stopConditions: [...existing.stopConditions] },
		event: null,
		commandResult: {
			action: `schedule_${action}`,
			chipKey,
			changed: false,
			launchedMission: false,
			eventId: existing.lastEventId ?? undefined,
			inspectUrl: `/loop-engineering/${encodeURIComponent(chipKey)}`,
			userMessage
		}
	});

	if (existing.status === 'cancelled') {
		if (action === 'cancel') return noOp(`${existing.name} is already cancelled. Nothing changed.`);
		throw new Error('cancelled schedules cannot be changed');
	}
	if (existing.status === 'paused' && action === 'pause') {
		return noOp(`${existing.name} is already paused. Nothing changed.`);
	}
	if (existing.status === 'staged' && existing.active && action === 'resume') {
		return noOp(`${existing.name} is already active. Nothing changed.`);
	}
	if (existing.status === 'staged' && !existing.active && action === 'pause') {
		return noOp(`${existing.name} is not active yet. Nothing changed.`);
	}
	if (existing.status === 'deactivated' && action === 'deactivate') {
		return noOp(`${existing.name} is already deactivated. Nothing changed.`);
	}
	if (existing.status === 'deactivated' && action !== 'cancel') {
		throw new Error('deactivated schedules require a new activation review before any lifecycle change');
	}
	if (existing.status === 'blocked' && action !== 'cancel' && action !== 'deactivate') {
		throw new Error('blocked schedules must be repaired before pause or resume');
	}
	if (action === 'pause' && (existing.status !== 'staged' || !existing.active)) {
		throw new Error('only active staged schedules can be paused');
	}
	if (action === 'resume' && existing.status !== 'paused' && !(existing.status === 'staged' && !existing.active)) {
		throw new Error('only paused or inactive staged schedules can be resumed');
	}
	const timestamp = nowIso();
	const statusByAction: Record<LoopScheduleLifecycleAction, LoopScheduleStatus> = {
		pause: 'paused',
		resume: 'staged',
		cancel: 'cancelled',
		deactivate: 'deactivated'
	};
	const labelByAction: Record<LoopScheduleLifecycleAction, string> = {
		pause: 'Private loop schedule paused',
		resume: 'Private loop schedule resumed',
		cancel: 'Private loop schedule cancelled',
		deactivate: 'Private loop schedule deactivated'
	};
	const nextActionByAction: Record<LoopScheduleLifecycleAction, string> = {
		pause: 'Resume this schedule only when the operator wants continued private loop work.',
		resume: 'Inspect the selected benchmark cases before firing the private loop schedule.',
		cancel: 'Stage a new scoped schedule if this loop should run again.',
		deactivate: 'Review activation and schedule proof before re-enabling this loop path.'
	};
	const userMessageByAction: Record<LoopScheduleLifecycleAction, string> = {
		pause: `Paused ${existing.name}. It will not fire until resumed.`,
		resume: `Resumed ${existing.name}. It is staged for operator-controlled private loop fire.`,
		cancel: `Cancelled ${existing.name}. It cannot fire again; stage a new schedule if needed.`,
		deactivate: `Deactivated ${existing.name}. Review proof before creating or resuming a replacement schedule.`
	};
	const updatedSchedule: LoopEngineeringSchedule = {
		...existing,
		active: action === 'resume',
		status: statusByAction[action],
		nextRunAt: action === 'resume' ? nextRunAtForSchedule(existing, timestamp) : null,
		updatedAt: timestamp
	};
	const event = await appendLoopEngineeringEvent({
		chipKey,
		eventType: 'schedule_lifecycle',
		label: labelByAction[action],
		status: 'passed',
		sourceSurface: normalizeSourceSurface(input.sourceSurface),
		roundsObserved: existing.roundLimit,
		evaluatorSeparated: false,
		evidenceRefs: [`control-plane:schedules:${existing.id}`],
		scheduleId: existing.id,
		nextAction: nextActionByAction[action]
	});
	updatedSchedule.lastEventId = event.id;
	const commandResult: LoopEngineeringCommandResult = {
		action: `schedule_${action}`,
		chipKey,
		changed: true,
		launchedMission: false,
		eventId: event.id,
		inspectUrl: `/loop-engineering/${encodeURIComponent(chipKey)}`,
		userMessage: userMessageByAction[action]
	};
	const latestState = await readState();
	const latestScheduleIndex = latestState.schedules.findIndex((item) => item.id === scheduleId && item.chipKey === chipKey);
	const latestEventIndex = latestState.events.findIndex((item) => item.id === event.id && item.chipId === chipKey);
	if (latestScheduleIndex === -1 || latestEventIndex === -1) throw new Error('schedule lifecycle state binding failed');
	latestState.schedules[latestScheduleIndex] = updatedSchedule;
	latestState.events[latestEventIndex] = {
		...latestState.events[latestEventIndex],
		commandResult,
		updatedAt: timestamp
	};
	await writeState(latestState);
	return {
		schedule: { ...updatedSchedule, stopConditions: [...updatedSchedule.stopConditions] },
		event: { ...latestState.events[latestEventIndex], evidenceRefs: [...latestState.events[latestEventIndex].evidenceRefs], commandResult },
		commandResult
	};
}

function normalizeSurfaces(value: unknown): LoopEngineeringActivationRule['surfaces'] {
	const allowed = new Set(['telegram', 'spawner', 'builder', 'codex', 'scheduler']);
	const surfaces = stringList(value).filter((item): item is LoopEngineeringActivationRule['surfaces'][number] => allowed.has(item));
	return surfaces.length ? [...new Set(surfaces)] : ['spawner'];
}

function normalizeActivationMode(value: ActivationMode): ActivationMode {
	return ['manual', 'suggested', 'local_fast_path'].includes(value) ? value : 'manual';
}

function normalizeRiskPolicy(value: unknown): LoopEngineeringActivationRule['riskPolicy'] {
	const clean = cleanString(value);
	if (clean === 'low_only' || clean === 'review_packet' || clean === 'loop_mode_required') return clean;
	return 'review_packet';
}

export async function stageActivationRule(input: {
	chipKey: string;
	useCase: string;
	surfaces?: string[];
	mode?: ActivationMode;
	triggerPatterns?: string[];
	nonTriggerPatterns?: string[];
	riskPolicy?: LoopEngineeringActivationRule['riskPolicy'];
	approvalRequired?: boolean;
	rollbackRef?: string | null;
	sourceSurface?: LoopEngineeringEvent['sourceSurface'];
}): Promise<{ activationRule: LoopEngineeringActivationRule; event: LoopEngineeringEvent; commandResult: LoopEngineeringCommandResult }> {
	const chipKey = safeLoopEngineeringChipKey(input.chipKey);
	if (!chipKey) throw new Error('valid domain-chip key required');
	const useCase = cleanString(input.useCase);
	if (!useCase) throw new Error('activation useCase required');
	const mode = normalizeActivationMode(input.mode ?? 'manual');
	const timestamp = nowIso();
	const activationRule: LoopEngineeringActivationRule = {
		id: nextId('activation'),
		chipKey,
		useCase,
		surfaces: normalizeSurfaces(input.surfaces),
		mode,
		triggerPatterns: stringList(input.triggerPatterns),
		nonTriggerPatterns: stringList(input.nonTriggerPatterns),
		riskPolicy: normalizeRiskPolicy(input.riskPolicy),
		approvalRequired: input.approvalRequired !== false,
		rollbackRef: cleanString(input.rollbackRef) || null,
		status: 'staged',
		createdAt: timestamp,
		updatedAt: timestamp,
		lastEventId: null
	};
	const event = await appendLoopEngineeringEvent({
		chipKey,
		eventType: 'activation_requested',
		label: 'Activation rule staged',
		status: 'passed',
		sourceSurface: normalizeSourceSurface(input.sourceSurface),
		evaluatorSeparated: false,
		evidenceRefs: [`control-plane:activation_rules:${activationRule.id}`],
		nextAction: mode === 'local_fast_path'
			? 'Prove live surface behavior and owner approval before enabling this local fast path.'
			: 'Review the staged activation rule before using the chip automatically.'
	});
	activationRule.lastEventId = event.id;
	const state = await readState();
	state.activation_rules.push(activationRule);
	await writeState(state);
	return {
		activationRule,
		event,
		commandResult: {
			action: 'activation_requested',
			chipKey,
			changed: true,
			launchedMission: false,
			eventId: event.id,
			inspectUrl: `/loop-engineering/${encodeURIComponent(chipKey)}`,
			userMessage: `Staged ${mode.replace('_', ' ')} use for ${useCase}. Review the checklist before making it automatic.`
		}
	};
}

export const _loopEngineeringControlPlaneForTests = {
	stateFilePath,
	readState
};
