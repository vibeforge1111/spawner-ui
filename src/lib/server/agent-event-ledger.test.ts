import { appendFile, mkdtemp, writeFile } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	appendAgentEvent,
	buildAgentBlackBoxReport,
	buildMissionControlAgentEvent,
	getFinalAnswerGateAuditPath,
	readRecentAgentEvents
} from './agent-event-ledger';

const originalAuditPath = process.env.SPARK_FINAL_ANSWER_GATE_AUDIT_PATH;
const originalStateDir = process.env.SPAWNER_STATE_DIR;

afterEach(() => {
	if (originalAuditPath === undefined) delete process.env.SPARK_FINAL_ANSWER_GATE_AUDIT_PATH;
	else process.env.SPARK_FINAL_ANSWER_GATE_AUDIT_PATH = originalAuditPath;
	if (originalStateDir === undefined) delete process.env.SPAWNER_STATE_DIR;
	else process.env.SPAWNER_STATE_DIR = originalStateDir;
});

describe('agent event ledger', () => {
	it('keeps invalid timestamps deterministic without dropping the newest valid event', async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), 'spawner-agent-events-'));
		process.env.SPAWNER_STATE_DIR = stateDir;
		process.env.SPARK_FINAL_ANSWER_GATE_AUDIT_PATH = path.join(stateDir, 'missing-audit.jsonl');
		const invalidEntries = Array.from({ length: 6 }, (_, index) =>
			appendAgentEvent(
				buildMissionControlAgentEvent({
					eventType: 'progress',
					missionId: 'mission-invalid-time',
					missionName: 'Invalid time',
					taskId: null,
					taskName: null,
					progress: index,
					summary: `Invalid ${index}`,
					timestamp: 'not-a-date',
					source: 'test'
				})
			)
		);
		const valid = appendAgentEvent(
			buildMissionControlAgentEvent({
				eventType: 'mission_completed',
				missionId: 'mission-invalid-time',
				missionName: 'Invalid time',
				taskId: null,
				taskName: null,
				progress: 100,
				summary: 'Newest valid',
				timestamp: '2026-07-23T12:00:00.000Z',
				source: 'test'
			})
		);
		for (const entry of invalidEntries) entry.created_at = 'not-a-date';
		valid.created_at = '2026-07-23T12:00:00.000Z';
		await writeFile(
			path.join(stateDir, 'agent-events.jsonl'),
			[...invalidEntries, valid].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
			'utf-8'
		);

		const recent = readRecentAgentEvents({ limit: 2 });
		expect(recent[0].event_id).toBe(valid.event_id);
		expect(recent[1].event_id).toBe(
			invalidEntries.map((entry) => entry.event_id).sort().at(-1)
		);
	});

	it('ingests Telegram final-answer gate audits into black-box events', async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), 'spawner-agent-events-'));
		const auditPath = path.join(stateDir, 'final-answer-gate-audit.jsonl');
		process.env.SPAWNER_STATE_DIR = stateDir;
		process.env.SPARK_FINAL_ANSWER_GATE_AUDIT_PATH = auditPath;
		await writeFile(
			auditPath,
			`${JSON.stringify({
				ts: '2026-05-10T08:00:00.000Z',
				event: 'final_answer_checked',
				outcome: 'suppressed_builder_reply',
				chat_id: '8319079055',
				user_id: '42',
				suppression_reason: 'diagnostic_wall',
				builder_routing_decision: 'plain_chat',
				builder_bridge_mode: 'builder',
				builder_reply_length: 240,
				fallback_route: 'local_chat',
				latest_intent_preserved: true
			})}\n`,
			'utf-8'
		);

		expect(getFinalAnswerGateAuditPath()).toBe(auditPath);
		const events = readRecentAgentEvents({ sessionId: 'telegram:8319079055', limit: 5 });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event_type: 'final_answer_checked',
			selected_route: 'local_chat',
			session_id: 'telegram:8319079055',
			actor_id: 'telegram:42',
			summary: 'Final answer gate suppressed_builder_reply: diagnostic_wall; fallback=local_chat.',
			facts: {
				audit_source: 'telegram_final_answer_gate',
				suppression_reason: 'diagnostic_wall',
				latest_intent_preserved: true
			},
			sources: [{ source: 'telegram_final_answer_gate', role: 'final_answer_evidence' }]
		});

		const report = buildAgentBlackBoxReport({ sessionId: 'telegram:8319079055', limit: 5 });
		expect(report.counts.entries).toBe(1);
		expect(report.entries[0]).toMatchObject({
			event_type: 'final_answer_checked',
			route_chosen: 'local_chat',
			blockers: ['diagnostic_wall']
		});
	});

	it('promotes mission trace refs to top-level ledger metadata', async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), 'spawner-agent-events-'));
		process.env.SPAWNER_STATE_DIR = stateDir;

		const event = buildMissionControlAgentEvent({
			eventType: 'mission_started',
			missionId: 'mission-1',
			missionName: 'Trace proof',
			taskId: null,
			taskName: null,
			progress: 0,
			summary: 'Started.',
			timestamp: '2026-05-12T00:00:00.000Z',
			source: 'test',
			requestId: 'request-1',
			traceRef: 'trace:spawner-prd:mission-1'
		});

		const entry = appendAgentEvent(event, { requestId: 'request-1' });

		expect(entry.request_id).toBe('request-1');
		expect(entry.trace_ref).toBe('trace:spawner-prd:mission-1');
		expect(entry.facts.trace_ref).toBe('trace:spawner-prd:mission-1');
	});

	it('keeps provider execution proof as metadata-only facts', async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), 'spawner-agent-events-'));
		process.env.SPAWNER_STATE_DIR = stateDir;

		const event = buildMissionControlAgentEvent({
			eventType: 'task_completed',
			missionId: 'mission-provider-proof',
			missionName: 'Provider proof',
			taskId: null,
			taskName: null,
			progress: 100,
			summary: 'Codex worker completed.',
			timestamp: '2026-05-12T00:00:00.000Z',
			source: 'codex',
			requestId: 'request-provider-proof',
			traceRef: 'trace:spawner-prd:mission-provider-proof',
			providerId: 'codex',
			model: 'gpt-5.5'
		});

		const entry = appendAgentEvent(event, { requestId: 'request-provider-proof' });

		expect(entry.facts).toMatchObject({
			provider: 'codex',
			providerId: 'codex',
			model: 'gpt-5.5',
			trace_ref: 'trace:spawner-prd:mission-provider-proof'
		});
		expect(JSON.stringify(entry.facts)).not.toContain('response');
		expect(JSON.stringify(entry.facts)).not.toContain('provider output');
	});

	it('reports malformed ledger JSONL lines without exposing raw content', async () => {
		const stateDir = await mkdtemp(path.join(tmpdir(), 'spawner-agent-events-'));
		process.env.SPAWNER_STATE_DIR = stateDir;
		process.env.SPARK_FINAL_ANSWER_GATE_AUDIT_PATH = path.join(stateDir, 'missing-final-answer-audit.jsonl');
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

		try {
			appendAgentEvent(buildMissionControlAgentEvent({
				eventType: 'mission_started',
				missionId: 'mission-jsonl-warning',
				missionName: 'JSONL warning',
				taskId: null,
				taskName: null,
				progress: 0,
				summary: 'Started.',
				timestamp: '2026-05-12T00:00:00.000Z',
				source: 'test'
			}));
			await appendFile(path.join(stateDir, 'agent-events.jsonl'), '{not valid json with private-ish raw text}\n', 'utf-8');

			const events = readRecentAgentEvents({ limit: 5 });

			expect(events).toHaveLength(1);
			expect(warning).toHaveBeenCalledWith(expect.stringContaining('skipped malformed agent-events JSONL line'));
			expect(warning.mock.calls.flat().join('\n')).not.toContain('private-ish raw text');
		} finally {
			warning.mockRestore();
		}
	});
});
