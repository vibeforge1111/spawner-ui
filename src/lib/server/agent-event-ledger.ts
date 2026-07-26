import { env } from '$env/dynamic/private';
import * as fs from 'fs';
import os from 'os';
import * as path from 'path';
import { spawnerStateDir } from './spawner-state';

export const AGENT_EVENT_SCHEMA_VERSION = 'spark.agent_event.v1';
export const AGENT_EVENT_COMPONENT = 'agent_event_model';

export type AgentEventType =
	| 'task_intent_detected'
	| 'route_selected'
	| 'source_used'
	| 'capability_probed'
	| 'blocker_detected'
	| 'memory_candidate_created'
	| 'contradiction_found'
	| 'mission_changed_state'
	| 'agent_drift_detected'
	| 'user_override_received'
	| 'action_gate_evaluated'
	| 'final_answer_checked';

export type SourceFreshness = 'fresh' | 'stale' | 'contradicted' | 'unknown' | 'live_probed';

export interface AgentSourceRef {
	source: string;
	role: string;
	freshness: SourceFreshness;
	source_ref: string | null;
	summary: string;
}

export interface AgentEventRecord {
	schema_version: typeof AGENT_EVENT_SCHEMA_VERSION;
	event_type: AgentEventType;
	summary: string;
	user_intent: string | null;
	selected_route: string | null;
	route_confidence: string | null;
	facts: Record<string, unknown>;
	sources: AgentSourceRef[];
	assumptions: string[];
	blockers: string[];
	changed: string[];
	memory_candidate: Record<string, unknown> | null;
}

export interface AgentEventLedgerEntry extends AgentEventRecord {
	event_id: string;
	component: typeof AGENT_EVENT_COMPONENT;
	created_at: string;
	request_id: string | null;
	trace_ref: string | null;
	session_id: string | null;
	actor_id: string | null;
}

export interface AgentBlackBoxEntry {
	event_id: string;
	event_type: AgentEventType;
	created_at: string;
	trace_ref: string | null;
	perceived_intent: string | null;
	route_chosen: string | null;
	sources_used: AgentSourceRef[];
	assumptions: string[];
	blockers: string[];
	changed: string[];
	memory_candidate: Record<string, unknown> | null;
	summary: string;
}

export interface AgentBlackBoxReport {
	schema_version: typeof AGENT_EVENT_SCHEMA_VERSION;
	checked_at: string;
	request_id: string | null;
	session_id: string | null;
	counts: {
		entries: number;
		blocker_events: number;
		memory_candidates: number;
	};
	entries: AgentBlackBoxEntry[];
}

export interface MissionControlAgentEventInput {
	eventType: string;
	missionId: string;
	missionName: string | null;
	taskId: string | null;
	taskName: string | null;
	progress: number | null;
	summary: string;
	timestamp: string;
	source: string;
	requestId?: string | null;
	traceRef?: string | null;
	toState?: string | null;
	providerId?: string | null;
	model?: string | null;
}

export function getAgentEventLedgerPath(): string {
	return path.resolve(spawnerStateDir(env), 'agent-events.jsonl');
}

export function getFinalAnswerGateAuditPath(): string {
	return (
		process.env.SPARK_FINAL_ANSWER_GATE_AUDIT_PATH ||
		env.SPARK_FINAL_ANSWER_GATE_AUDIT_PATH ||
		path.join(os.homedir(), '.spark', 'state', 'spark-telegram-bot', 'final-answer-gate-audit.jsonl')
	);
}

export function buildMissionControlAgentEvent(input: MissionControlAgentEventInput): AgentEventRecord {
	const missionRef = input.missionId || 'unknown-mission';
	const toState = input.toState || missionStateForEvent(input.eventType);
	const changed = [`${missionRef}:mission_event=${input.eventType}`];
	if (toState) {
		changed.push(`${missionRef}:state=${toState}`);
	}

	return {
		schema_version: AGENT_EVENT_SCHEMA_VERSION,
		event_type: 'mission_changed_state',
		summary: input.summary || `Mission Control recorded ${input.eventType}.`,
		user_intent: null,
		selected_route: 'mission_control',
		route_confidence: 'high',
		facts: {
			mission_id: missionRef,
			mission_event_type: input.eventType,
			mission_name: input.missionName,
			task_id: input.taskId,
			task_name: input.taskName,
			progress: input.progress,
			to_state: toState,
			trace_ref: normalizeNullable(input.traceRef),
			bridge_source: input.source,
			...(normalizeNullable(input.providerId) ? {
				provider: normalizeNullable(input.providerId),
				providerId: normalizeNullable(input.providerId)
			} : {}),
			...(normalizeNullable(input.model) ? { model: normalizeNullable(input.model) } : {})
		},
		sources: [
			{
				source: 'mission_trace',
				role: 'work_state_evidence',
				freshness: 'fresh',
				source_ref: missionRef,
				summary: input.summary || input.eventType
			}
		],
		assumptions: [],
		blockers: [],
		changed,
		memory_candidate: null
	};
}

export function tryAppendAgentEventLine(
	ledgerPath: string,
	line: string,
	io: Pick<typeof fs, 'mkdirSync' | 'appendFileSync'> = fs
): boolean {
	try {
		io.mkdirSync(path.dirname(ledgerPath), { recursive: true });
		io.appendFileSync(ledgerPath, line, 'utf-8');
		return true;
	} catch (error) {
		console.warn(
			'[agent-event-ledger] append failed; the entry remains in memory but was not persisted',
			error instanceof Error ? error.name : typeof error
		);
		return false;
	}
}

export function appendAgentEvent(
	event: AgentEventRecord,
	options: {
		requestId?: string | null;
		traceRef?: string | null;
		sessionId?: string | null;
		actorId?: string | null;
		createdAt?: string | null;
	} = {}
): AgentEventLedgerEntry {
	const requestedCreatedAt = normalizeNullable(options.createdAt);
	const parsedCreatedAt = requestedCreatedAt ? Date.parse(requestedCreatedAt) : Number.NaN;
	const createdAtMs = Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : Date.now();
	const entry: AgentEventLedgerEntry = {
		...event,
		event_id: `agent-${createdAtMs}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
		component: AGENT_EVENT_COMPONENT,
		created_at: new Date(createdAtMs).toISOString(),
		request_id: normalizeNullable(options.requestId),
		trace_ref: normalizeNullable(options.traceRef) || traceRefFromFacts(event.facts),
		session_id: normalizeNullable(options.sessionId),
		actor_id: normalizeNullable(options.actorId)
	};
	const ledgerPath = getAgentEventLedgerPath();
	tryAppendAgentEventLine(ledgerPath, `${JSON.stringify(entry)}\n`);
	return entry;
}

export function readRecentAgentEvents(
	options: { requestId?: string | null; sessionId?: string | null; limit?: number } = {}
): AgentEventLedgerEntry[] {
	const ledgerPath = getAgentEventLedgerPath();
	const limit = Math.max(1, options.limit || 20);
	const requestId = normalizeNullable(options.requestId);
	const sessionId = normalizeNullable(options.sessionId);
	const ledgerEntries = fs.existsSync(ledgerPath)
		? fs
				.readFileSync(ledgerPath, 'utf-8')
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => {
					try {
						const parsed = JSON.parse(line) as unknown;
						return normalizeAgentEventLedgerEntry(parsed);
					} catch {
						warnMalformedJsonlLine('agent-events', line);
						return null;
					}
				})
				.filter((entry): entry is AgentEventLedgerEntry => Boolean(entry))
		: [];
	const finalAnswerEntries = readFinalAnswerGateAuditEvents();
	const createdAtMs = (entry: AgentEventLedgerEntry): number => {
		const parsed = Date.parse(entry.created_at);
		return Number.isFinite(parsed) ? parsed : 0;
	};
	return [...ledgerEntries, ...finalAnswerEntries]
		.filter((entry) => !requestId || entry.request_id === requestId)
		.filter((entry) => !sessionId || entry.session_id === sessionId)
		.sort(
			(a, b) =>
				createdAtMs(a) - createdAtMs(b) ||
				a.event_id.localeCompare(b.event_id)
		)
		.slice(-limit)
		.reverse();
}

function readFinalAnswerGateAuditEvents(): AgentEventLedgerEntry[] {
	const auditPath = getFinalAnswerGateAuditPath();
	if (!fs.existsSync(auditPath)) return [];
	return fs
		.readFileSync(auditPath, 'utf-8')
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line, index) => {
			try {
				const record = JSON.parse(line) as Record<string, unknown>;
				return finalAnswerAuditToAgentEvent(record, index);
			} catch {
				warnMalformedJsonlLine('final-answer-gate-audit', line);
				return null;
			}
		})
		.filter((entry): entry is AgentEventLedgerEntry => Boolean(entry));
}

function warnMalformedJsonlLine(source: string, line: string): void {
	console.warn(`[agent-event-ledger] skipped malformed ${source} JSONL line (${line.length} chars)`);
}

function normalizeAgentEventLedgerEntry(value: unknown): AgentEventLedgerEntry | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		warnMalformedJsonlLine('agent-events', 'non-object payload');
		return null;
	}
	const record = value as Record<string, unknown>;
	const sources = Array.isArray(record.sources) ? (record.sources as AgentSourceRef[]) : [];
	const assumptions = Array.isArray(record.assumptions) ? (record.assumptions as string[]) : [];
	const blockers = Array.isArray(record.blockers) ? (record.blockers as string[]) : [];
	const changed = Array.isArray(record.changed) ? (record.changed as string[]) : [];
	const facts = record.facts && typeof record.facts === 'object' && !Array.isArray(record.facts)
		? (record.facts as Record<string, unknown>)
		: {};
	const memoryCandidate = record.memory_candidate && typeof record.memory_candidate === 'object' && !Array.isArray(record.memory_candidate)
		? (record.memory_candidate as Record<string, unknown>)
		: null;
	return {
		schema_version: AGENT_EVENT_SCHEMA_VERSION,
		event_type: (record.event_type as AgentEventType) ?? 'task_intent_detected',
		summary: typeof record.summary === 'string' ? record.summary : '',
		user_intent: typeof record.user_intent === 'string' ? record.user_intent : null,
		selected_route: typeof record.selected_route === 'string' ? record.selected_route : null,
		route_confidence: typeof record.route_confidence === 'string' ? record.route_confidence : null,
		facts,
		sources,
		assumptions,
		blockers,
		changed,
		memory_candidate: memoryCandidate,
		event_id: typeof record.event_id === 'string' ? record.event_id : '',
		component: AGENT_EVENT_COMPONENT,
		created_at: typeof record.created_at === 'string' ? record.created_at : new Date(0).toISOString(),
		request_id: typeof record.request_id === 'string' ? record.request_id : null,
		trace_ref: typeof record.trace_ref === 'string' ? record.trace_ref : null,
		session_id: typeof record.session_id === 'string' ? record.session_id : null,
		actor_id: typeof record.actor_id === 'string' ? record.actor_id : null
	};
}

function finalAnswerAuditToAgentEvent(record: Record<string, unknown>, index: number): AgentEventLedgerEntry {
	const rawTs =
		typeof record.ts === 'string' && record.ts.trim() && Number.isFinite(Date.parse(record.ts))
			? record.ts
			: null;
	const createdAt = rawTs ?? new Date(0).toISOString();
	const chatId = stringValue(record.chat_id);
	const userId = stringValue(record.user_id);
	const reason = stringValue(record.suppression_reason) || 'unknown';
	const fallbackRoute = stringValue(record.fallback_route) || 'unknown';
	const builderRoute = stringValue(record.builder_routing_decision);
	const builderMode = stringValue(record.builder_bridge_mode);
	const outcome = stringValue(record.outcome) || 'suppressed_builder_reply';
	const requestId = stringValue(record.request_id);
	const traceRef = stringValue(record.trace_ref);
	return {
		schema_version: AGENT_EVENT_SCHEMA_VERSION,
		event_type: 'final_answer_checked',
		summary: `Final answer gate ${outcome}: ${reason}; fallback=${fallbackRoute}.`,
		user_intent: null,
		selected_route: fallbackRoute,
		route_confidence: 'high',
		facts: {
			audit_source: 'telegram_final_answer_gate',
			outcome,
			suppression_reason: reason,
			builder_routing_decision: builderRoute,
			builder_bridge_mode: builderMode,
			builder_reply_length: record.builder_reply_length,
			trace_ref: traceRef,
			latest_intent_preserved: record.latest_intent_preserved === true
		},
		sources: [
			{
				source: 'telegram_final_answer_gate',
				role: 'final_answer_evidence',
				freshness: 'fresh',
				source_ref: chatId ? `telegram:${chatId}` : null,
				summary: reason
			}
		],
		assumptions: [],
		blockers: reason === 'low_information' ? [] : [reason],
		changed: [`telegram:${chatId || 'unknown'}:final_answer_gate=${outcome}`],
		memory_candidate: null,
		event_id: `final-answer-${Date.parse(createdAt) || 0}-${index}`,
		component: AGENT_EVENT_COMPONENT,
		created_at: createdAt,
		request_id: requestId,
		trace_ref: traceRef,
		session_id: chatId ? `telegram:${chatId}` : null,
		actor_id: userId ? `telegram:${userId}` : null
	};
}

export function buildAgentBlackBoxReport(
	options: { requestId?: string | null; sessionId?: string | null; limit?: number } = {}
): AgentBlackBoxReport {
	const entries = readRecentAgentEvents(options).map((entry) => ({
		event_id: entry.event_id,
		event_type: entry.event_type,
		created_at: entry.created_at,
		trace_ref: entry.trace_ref,
		perceived_intent: entry.user_intent,
		route_chosen: entry.selected_route,
		sources_used: entry.sources,
		assumptions: entry.assumptions,
		blockers: entry.blockers,
		changed: entry.changed,
		memory_candidate: entry.memory_candidate,
		summary: entry.summary
	}));
	return {
		schema_version: AGENT_EVENT_SCHEMA_VERSION,
		checked_at: new Date().toISOString(),
		request_id: normalizeNullable(options.requestId),
		session_id: normalizeNullable(options.sessionId),
		// Single reduce pass instead of two .filter().length walks over the
		// same entries array — the audit report routinely returns hundreds
		// of entries and the prior shape traversed them twice.
		counts: entries.reduce(
			(acc, entry) => {
				if (entry.blockers.length > 0) acc.blocker_events += 1;
				if (entry.memory_candidate !== null) acc.memory_candidates += 1;
				return acc;
			},
			{ entries: entries.length, blocker_events: 0, memory_candidates: 0 }
		),
		entries
	};
}

export function missionStateForEvent(eventType: string): string | null {
	switch (eventType) {
		case 'mission_created':
			return 'created';
		case 'mission_started':
		case 'mission_resumed':
		case 'dispatch_started':
			return 'running';
		case 'mission_paused':
			return 'paused';
		case 'mission_completed':
			return 'completed';
		case 'mission_failed':
			return 'failed';
		case 'mission_cancelled':
			return 'cancelled';
		case 'task_started':
		case 'task_progress':
		case 'progress':
			return 'running';
		case 'task_completed':
			return 'task_completed';
		case 'task_failed':
			return 'task_failed';
		case 'task_cancelled':
			return 'task_cancelled';
		default:
			return null;
	}
}

function normalizeNullable(value: string | null | undefined): string | null {
	const text = value?.trim();
	return text || null;
}

function traceRefFromFacts(facts: Record<string, unknown>): string | null {
	return stringValue(facts.trace_ref) || stringValue(facts['traceRef']);
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}
