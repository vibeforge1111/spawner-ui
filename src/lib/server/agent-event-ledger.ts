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

export function appendAgentEvent(
	event: AgentEventRecord,
	options: { requestId?: string | null; traceRef?: string | null; sessionId?: string | null; actorId?: string | null } = {}
): AgentEventLedgerEntry {
	const entry: AgentEventLedgerEntry = {
		...event,
		event_id: `agent-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
		component: AGENT_EVENT_COMPONENT,
		created_at: new Date().toISOString(),
		request_id: normalizeNullable(options.requestId),
		trace_ref: normalizeNullable(options.traceRef) || traceRefFromFacts(event.facts),
		session_id: normalizeNullable(options.sessionId),
		actor_id: normalizeNullable(options.actorId)
	};
	const ledgerPath = getAgentEventLedgerPath();
	fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
	try {
	fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf-8');
	} catch (error) {
		console.warn(
			`[agent-event-ledger] failed to append to ${ledgerPath}; entry is returned but the on-disk ledger is unchanged for this write.`,
			error
		);
	}
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
						return JSON.parse(line) as AgentEventLedgerEntry;
					} catch {
						warnMalformedJsonlLine('agent-events', line);
						return null;
					}
				})
				.filter((entry): entry is AgentEventLedgerEntry => Boolean(entry))
		: [];
	const finalAnswerEntries = readFinalAnswerGateAuditEvents();
	return [...ledgerEntries, ...finalAnswerEntries]
		.filter((entry) => !requestId || entry.request_id === requestId)
		.filter((entry) => !sessionId || entry.session_id === sessionId)
		.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
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

function finalAnswerAuditToAgentEvent(record: Record<string, unknown>, index: number): AgentEventLedgerEntry {
	const createdAt = typeof record.ts === 'string' && record.ts.trim() ? record.ts : new Date(0).toISOString();
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
		counts: {
			entries: entries.length,
			blocker_events: entries.filter((entry) => entry.blockers.length > 0).length,
			memory_candidates: entries.filter((entry) => entry.memory_candidate !== null).length
		},
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
