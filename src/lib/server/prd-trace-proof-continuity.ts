import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizePrdTraceValue } from './prd-trace-redaction';
import { readPendingRequestRecord } from './prd-pending-requests';

export const HARNESS_PROOF_CAPSULE_SCHEMA = 'spark.harness_proof.v1' as const;

export type HarnessProofAuthorityDecision = 'allowed' | 'blocked' | 'downgraded';
export type HarnessProofGovernorDecision = 'allow' | 'deny' | 'read_only' | 'not_applicable';
export type HarnessProofRiskTier = 'none' | 'read' | 'write' | 'execute' | 'publish' | 'external';
export type HarnessProofExecutionStatus = 'not_started' | 'started' | 'completed' | 'failed' | 'blocked';
export type HarnessProofReplyShape = 'natural' | 'card' | 'queue' | 'raw_detail' | 'none';
export type HarnessProofJoinStatus = 'joined' | 'missing' | 'not_applicable';
export type HarnessProofMutationClass =
	| 'none'
	| 'read_only'
	| 'writes_memory'
	| 'writes_files'
	| 'launches_mission'
	| 'controls_mission'
	| 'creates_schedule'
	| 'deletes_schedule'
	| 'creates_chip'
	| 'publishes'
	| 'external_network'
	| 'unknown';

export interface HarnessProofCapsuleV1 {
	schema: typeof HARNESS_PROOF_CAPSULE_SCHEMA;
	turnRef: string;
	route: string;
	owner: string;
	intent: {
		kind: string;
		confidence: 'explicit' | 'high' | 'medium' | 'low' | 'blocked';
		noExecution: boolean;
	};
	authority: {
		decision: HarnessProofAuthorityDecision;
		contract: 'spark.turn_intent.v1' | 'turn-intent-envelope-vnext' | 'governor-decision-v1' | 'machine_origin_policy' | 'none';
		riskTier: HarnessProofRiskTier;
		reasonSummary: string;
	};
	governor: {
		decision: HarnessProofGovernorDecision;
		verified: boolean;
	};
	execution: {
		status: HarnessProofExecutionStatus;
		tool: string;
		mutationClass: HarnessProofMutationClass;
	};
	reply: {
		delivered: boolean;
		shape: HarnessProofReplyShape;
		rawReasonsHidden: boolean;
	};
	joins: {
		telegram: HarnessProofJoinStatus;
		builder: HarnessProofJoinStatus;
		spawner: HarnessProofJoinStatus;
		provider: HarnessProofJoinStatus;
		memory: HarnessProofJoinStatus;
		voice: HarnessProofJoinStatus;
	};
}

export interface PrdTraceProofContinuityInput {
	requestId: string;
	event: string;
	details?: Record<string, unknown>;
	harnessProofRef?: string | null;
	proofCapsule?: unknown;
	storage?: 'source_gap_capsule' | 'legacy_gap_capsule';
	joinSource?: 'spawner_prd_trace_writer' | 'spawner_prd_trace_legacy_repair';
}

export interface PrdTraceProofRepairOptions {
	tracePath?: string;
	sparkHome?: string;
	dryRun?: boolean;
	backup?: boolean;
}

export interface PrdTraceProofRepairResult {
	ok: boolean;
	tracePath: string;
	backupPath: string | null;
	dryRun: boolean;
	rowsRead: number;
	rowsWritten: number;
	parseErrors: number;
	gapCapsulesAdded: number;
	alreadyHadProof: number;
	changedRows: number;
	error?: 'trace_log_missing';
}

export async function appendPrdTraceWithContinuity(input: {
	stateDir: string;
	requestId: string;
	event: string;
	details?: Record<string, unknown>;
}): Promise<void> {
	const details = input.details ?? {};
	const pending = await readPendingRequestRecord(input.stateDir, input.requestId);
	const proofRef = normalizeProofRef(details.harnessProofRef ?? details.harness_proof_ref) ??
		normalizeProofRef(pending?.harnessProofRef ?? pending?.harness_proof_ref);
	const proofCapsule = proofCapsuleFromRecord(details) ?? proofCapsuleFromRecord(pending ?? {});
	const safeDetails = sanitizePrdTraceValue(details) as Record<string, unknown>;
	for (const key of ['harnessProofRef', 'harness_proof_ref', 'harnessProofCapsule', 'proofCapsule', 'proof_capsule']) {
		delete safeDetails[key];
	}
	const proofContinuity = prdTraceProofContinuityFields({
		requestId: input.requestId,
		event: input.event,
		details: safeDetails,
		harnessProofRef: proofRef,
		proofCapsule
	});
	const row = {
		ts: new Date().toISOString(),
		requestId: input.requestId,
		event: input.event,
		...safeDetails,
		...proofContinuity,
		privacy: 'metadata_only'
	};
	await fs.promises.mkdir(input.stateDir, { recursive: true });
	await fs.promises.appendFile(path.join(input.stateDir, 'prd-auto-trace.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
}

interface ParsedLine {
	line: string;
	record: Record<string, unknown> | null;
}

export function buildPrdTraceGovernorProofCapsule(input: {
	requestId: string;
	traceId?: string | null;
	route: string;
	tool: string;
	mutationClass: HarnessProofMutationClass;
	reasonSummary: string;
}): HarnessProofCapsuleV1 {
	const turnRef = redactedProofRef('turn', input.traceId?.trim() || input.requestId);
	return {
		schema: HARNESS_PROOF_CAPSULE_SCHEMA,
		turnRef,
		route: safeToken(input.route, 'spawner.prd_bridge'),
		owner: 'spawner-ui',
		intent: {
			kind: safeToken(input.route, 'spawner.prd_bridge'),
			confidence: 'high',
			noExecution: false
		},
		authority: {
			decision: 'allowed',
			contract: 'governor-decision-v1',
			riskTier: riskTierForMutation(input.mutationClass),
			reasonSummary: String(sanitizePrdTraceValue(input.reasonSummary || 'Fresh Governor authority was verified by Spawner.'))
		},
		governor: { decision: 'allow', verified: true },
		execution: {
			status: 'started',
			tool: safeToken(input.tool, 'spawner.prd_bridge.write'),
			mutationClass: input.mutationClass
		},
		reply: { delivered: false, shape: 'none', rawReasonsHidden: true },
		joins: {
			telegram: input.requestId.startsWith('tg-') ? 'joined' : 'not_applicable',
			builder: 'not_applicable',
			spawner: 'joined',
			provider: 'not_applicable',
			memory: 'not_applicable',
			voice: 'not_applicable'
		}
	};
}

export function prdTraceProofContinuityFields(input: PrdTraceProofContinuityInput): Record<string, unknown> {
	const proofCapsule = normalizeHarnessProofCapsule(input.proofCapsule);
	const proofRef = validHarnessProofRef(input.harnessProofRef) ? input.harnessProofRef.trim() : null;
	if (proofCapsule && (!proofRef || proofCapsule.turnRef === proofRef)) {
		return {
			harnessProofRef: proofCapsule.turnRef,
			proofCapsule
		};
	}
	if (validHarnessProofRef(input.harnessProofRef)) {
		return { harnessProofRef: input.harnessProofRef.trim() };
	}
	const gapCapsule = buildPrdTraceMissingAuthorityCapsule({
		requestId: input.requestId,
		event: input.event,
		...(input.details || {})
	});
	return {
		harnessProofRef: gapCapsule.turnRef,
		proofCapsule: gapCapsule,
		proofStatus: 'missing_harness_authority',
		proofStorage: input.storage || 'source_gap_capsule',
		proofJoinSource: input.joinSource || 'spawner_prd_trace_writer'
	};
}

export function buildPrdTraceMissingAuthorityCapsule(record: Record<string, unknown>): HarnessProofCapsuleV1 {
	const event = stringField(record, 'event') || 'prd_trace';
	const requestId = stringField(record, 'requestId') || stringField(record, 'request_id');
	const traceRef = stringField(record, 'traceRef') || stringField(record, 'trace_ref');
	const missionId = stringField(record, 'missionId') || stringField(record, 'mission_id');
	const seed = [traceRef, requestId, missionId, stringField(record, 'ts'), event]
		.filter(Boolean)
		.join(':') || stableJson(record);
	const executionStatus = executionStatusForRecord(record, event);
	const provider = stringField(record, 'provider');
	return {
		schema: HARNESS_PROOF_CAPSULE_SCHEMA,
		turnRef: redactedProofRef('turn', seed),
		route: 'spawner.prd_bridge',
		owner: 'spawner-ui',
		intent: {
			kind: 'spawner.prd_bridge',
			confidence: executionStatus === 'blocked' ? 'blocked' : 'medium',
			noExecution: executionStatus === 'blocked'
		},
		authority: {
			decision: 'downgraded',
			contract: 'none',
			riskTier: 'execute',
			reasonSummary:
				'Spawner PRD trace row has request and trace continuity, but no fresh Harness proof metadata. Treat this as an inspectable proof gap, not authorization.'
		},
		governor: {
			decision: 'not_applicable',
			verified: false
		},
		execution: {
			status: executionStatus,
			tool: toolForEvent(event),
			mutationClass: 'writes_files'
		},
		reply: {
			delivered: false,
			shape: 'none',
			rawReasonsHidden: true
		},
		joins: {
			telegram: requestId.startsWith('tg-') ? 'missing' : 'not_applicable',
			builder: 'not_applicable',
			spawner: 'joined',
			provider: provider || event.includes('auto_worker') ? 'missing' : 'not_applicable',
			memory: 'not_applicable',
			voice: 'not_applicable'
		}
	};
}

export function repairPrdTraceRecord(record: Record<string, unknown>): {
	record: Record<string, unknown>;
	gapCapsuleAdded: boolean;
	alreadyHadProof: boolean;
} {
	const repaired = sanitizePrdTraceValue(record) as Record<string, unknown>;
	if (hasProof(repaired)) {
		if (!stringField(repaired, 'privacy')) repaired.privacy = 'metadata_only';
		return { record: repaired, gapCapsuleAdded: false, alreadyHadProof: true };
	}
	const requestId = stringField(repaired, 'requestId') || stringField(repaired, 'request_id');
	const event = stringField(repaired, 'event') || 'prd_trace';
	Object.assign(
		repaired,
		prdTraceProofContinuityFields({
			requestId,
			event,
			details: repaired,
			storage: 'legacy_gap_capsule',
			joinSource: 'spawner_prd_trace_legacy_repair'
		})
	);
	if (!stringField(repaired, 'privacy')) repaired.privacy = 'metadata_only';
	return { record: repaired, gapCapsuleAdded: true, alreadyHadProof: false };
}

export function defaultPrdTraceProofRepairPath(sparkHome = defaultSparkHome()): string {
	return path.join(sparkHome, 'state', 'spawner-ui', 'prd-auto-trace.jsonl');
}

export function repairPrdTraceProofContinuity(
	options: PrdTraceProofRepairOptions = {}
): PrdTraceProofRepairResult {
	const sparkHome = path.resolve(options.sparkHome || defaultSparkHome());
	const tracePath = path.resolve(options.tracePath || defaultPrdTraceProofRepairPath(sparkHome));
	const dryRun = Boolean(options.dryRun);
	const backup = options.backup === true;
	if (!fs.existsSync(tracePath)) {
		return {
			ok: false,
			tracePath,
			backupPath: null,
			dryRun,
			rowsRead: 0,
			rowsWritten: 0,
			parseErrors: 0,
			gapCapsulesAdded: 0,
			alreadyHadProof: 0,
			changedRows: 0,
			error: 'trace_log_missing'
		};
	}

	const original = fs.readFileSync(tracePath, 'utf8');
	const parsedLines = original.split(/\r?\n/).filter((line) => line.trim()).map(parseLine);
	let parseErrors = 0;
	let gapCapsulesAdded = 0;
	let alreadyHadProof = 0;
	let changedRows = 0;
	const repairedLines = parsedLines.map((entry) => {
		if (!entry.record) {
			parseErrors += 1;
			return entry.line;
		}
		const before = stableJson(entry.record);
		const outcome = repairPrdTraceRecord(entry.record);
		if (outcome.gapCapsuleAdded) gapCapsulesAdded += 1;
		if (outcome.alreadyHadProof) alreadyHadProof += 1;
		if (stableJson(outcome.record) !== before) changedRows += 1;
		return JSON.stringify(outcome.record);
	});
	if (parseErrors > 0) {
		return {
			ok: false,
			tracePath,
			backupPath: null,
			dryRun,
			rowsRead: parsedLines.length,
			rowsWritten: 0,
			parseErrors,
			gapCapsulesAdded,
			alreadyHadProof,
			changedRows
		};
	}

	let backupPath: string | null = null;
	if (!dryRun) {
		fs.mkdirSync(path.dirname(tracePath), { recursive: true });
		if (backup) {
			backupPath = nextBackupPath(tracePath);
			fs.copyFileSync(tracePath, backupPath);
			fs.chmodSync(backupPath, 0o600);
		}
		const tempPath = `${tracePath}.repairing-${Date.now()}`;
		fs.writeFileSync(tempPath, repairedLines.length ? `${repairedLines.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 });
		try {
			fs.renameSync(tempPath, tracePath);
		} catch (error) {
			try { fs.unlinkSync(tempPath); } catch {}
			throw error;
		}
	}

	return {
		ok: parseErrors === 0,
		tracePath,
		backupPath,
		dryRun,
		rowsRead: parsedLines.length,
		rowsWritten: repairedLines.length,
		parseErrors,
		gapCapsulesAdded,
		alreadyHadProof,
		changedRows
	};
}

function executionStatusForRecord(record: Record<string, unknown>, event: string): HarnessProofExecutionStatus {
	const success = record.success;
	if (event === 'clarification_requested') return 'blocked';
	if (success === false || stringField(record, 'error')) return 'failed';
	if (event.includes('dispatch') || event.includes('provisional')) return 'started';
	if (event.includes('worker_finished') || event.includes('written') || event.includes('found')) return 'completed';
	return 'completed';
}

function toolForEvent(event: string): string {
	if (event.includes('auto_worker')) return 'spawner.prd_auto_analysis';
	if (event.includes('fallback')) return 'spawner.prd_fallback_analysis';
	if (event.includes('clarification')) return 'spawner.prd_clarification_gate';
	return 'spawner.prd_bridge.write';
}

function riskTierForMutation(mutationClass: HarnessProofMutationClass): HarnessProofRiskTier {
	if (mutationClass === 'none') return 'none';
	if (mutationClass === 'read_only') return 'read';
	if (mutationClass === 'writes_memory' || mutationClass === 'writes_files' || mutationClass === 'creates_chip') return 'write';
	if (mutationClass === 'publishes') return 'publish';
	if (mutationClass === 'external_network') return 'external';
	return 'execute';
}

function parseLine(line: string): ParsedLine {
	try {
		const parsed = JSON.parse(line);
		return {
			line,
			record: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? parsed as Record<string, unknown>
				: null
		};
	} catch {
		return { line, record: null };
	}
}

function hasProof(record: Record<string, unknown>): boolean {
	return Boolean(
		validHarnessProofRef(record.harnessProofRef) ||
		validHarnessProofRef(record.harness_proof_ref) ||
		proofCapsuleLike(record.proofCapsule) ||
		proofCapsuleLike(record.proof_capsule)
	);
}

function proofCapsuleLike(value: unknown): boolean {
	return Boolean(
		value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>).schema === HARNESS_PROOF_CAPSULE_SCHEMA
	);
}

function normalizeHarnessProofCapsule(value: unknown): HarnessProofCapsuleV1 | null {
	if (!proofCapsuleLike(value)) return null;
	const sanitized = sanitizePrdTraceValue(value);
	if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return null;
	const capsule = sanitized as Record<string, unknown>;
	if (!validHarnessProofRef(capsule.turnRef)) return null;
	for (const key of ['route', 'owner', 'intent', 'authority', 'governor', 'execution', 'reply', 'joins']) {
		if (!(key in capsule)) return null;
	}
	return capsule as unknown as HarnessProofCapsuleV1;
}

function validHarnessProofRef(value: unknown): value is string {
	return typeof value === 'string' && /^turn:sha256:[a-f0-9]{16}$/.test(value.trim());
}

function normalizeProofRef(value: unknown): string | null {
	return validHarnessProofRef(value) ? value.trim() : null;
}

function proofCapsuleFromRecord(record: Record<string, unknown>): unknown {
	return record.harnessProofCapsule ?? record.proofCapsule ?? record.proof_capsule;
}

function stringField(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === 'string' ? value.trim() : '';
}

function redactedProofRef(label: string, value: string): string {
	const safeLabel = safeToken(label, 'ref');
	const digest = createHash('sha256').update(String(value || 'unknown')).digest('hex').slice(0, 16);
	return `${safeLabel}:sha256:${digest}`;
}

function safeToken(value: string, fallback: string): string {
	const token = String(value || '').trim();
	if (!token) return fallback;
	return token.replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 120) || fallback;
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!value || typeof value !== 'object') return value;
	return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((record, key) => {
		record[key] = sortKeys((value as Record<string, unknown>)[key]);
		return record;
	}, {});
}

function defaultSparkHome(): string {
	return process.env.SPARK_HOME?.trim() || path.join(os.homedir(), '.spark');
}

function nextBackupPath(filePath: string): string {
	const base = `${filePath}.proof-backup`;
	if (!fs.existsSync(base)) return base;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const digest = createHash('sha256').update(`${filePath}:${stamp}`).digest('hex').slice(0, 8);
	return `${base}-${stamp}-${digest}`;
}
