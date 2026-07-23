import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

const privateEnv = vi.hoisted(() => ({
	EVENTS_API_KEY: 'events-secret',
	MCP_API_KEY: '',
	EVENTS_ALLOWED_ORIGINS: '',
	SPARK_LIVE_CONTAINER: undefined as string | undefined
}));

vi.mock('$env/dynamic/private', () => ({
	env: privateEnv
}));

vi.mock('$lib/server/mission-control-relay', () => ({
	relayMissionControlEvent: vi.fn(),
	isMissionControlMissionId: (value: unknown): value is string =>
		typeof value === 'string' && /^(spark|mission)-[A-Za-z0-9_-]+$/.test(value.trim())
}));

vi.mock('$lib/server/provider-runtime', () => ({
	providerRuntime: {
		getSessionsForMission: vi.fn(() => []),
		markMissionTerminalFromLifecycleEvent: vi.fn()
	}
}));

import { GET, OPTIONS, POST } from './+server';
import { relayMissionControlEvent } from '$lib/server/mission-control-relay';
import { providerRuntime } from '$lib/server/provider-runtime';
import { eventBridge, type BridgeEvent } from '$lib/services/event-bridge';

let testSpawnerDir: string | null = null;

afterEach(async () => {
	delete process.env.SPAWNER_STATE_DIR;
	privateEnv.SPARK_LIVE_CONTAINER = undefined;
	vi.mocked(relayMissionControlEvent).mockClear();
	vi.mocked(providerRuntime.getSessionsForMission).mockReset();
	vi.mocked(providerRuntime.getSessionsForMission).mockReturnValue([]);
	vi.mocked(providerRuntime.markMissionTerminalFromLifecycleEvent).mockClear();
	if (testSpawnerDir && existsSync(testSpawnerDir)) {
		await rm(testSpawnerDir, { recursive: true, force: true });
	}
	testSpawnerDir = null;
	vi.restoreAllMocks();
});

function createEvent(url: string, init?: RequestInit, clientAddress = '203.0.113.1') {
	return {
		request: new Request(url, init),
		getClientAddress: () => clientAddress
	} as never;
}

async function readNextSsePayload(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Record<string, unknown>> {
	const decoder = new TextDecoder();
	const chunk = await reader.read();
	expect(chunk.done).toBe(false);
	const text = decoder.decode(chunk.value);
	const match = text.match(/^data:\s*(.+?)\n\n$/s);
	expect(match?.[1]).toBeTruthy();
	return JSON.parse(match![1]);
}

function emitPrivateBridgeEvent(): BridgeEvent {
	const event = {
		type: 'task_completed',
		missionId: 'mission-sse-private',
		taskId: 'T1',
		taskName: 'Private task',
		progress: 100,
		message: 'Task done',
		data: {
			response: 'private provider output',
			verification: { filesChanged: ['secret.ts'] }
		},
		timestamp: '2026-06-09T00:00:00.000Z',
		source: 'codex'
	};
	eventBridge.emit(event);
	return event;
}

describe('/api/events auth', () => {
	it('unsubscribes the Event Bridge when enqueue fails after the reader disconnects', async () => {
		let subscriber: ((event: BridgeEvent) => void) | undefined;
		const unsubscribe = vi.fn();
		vi.spyOn(eventBridge, 'subscribe').mockImplementation((callback) => {
			subscriber = callback;
			return unsubscribe;
		});
		const response = await GET(
			createEvent('https://example.com/api/events', {
				method: 'GET',
				headers: { 'x-api-key': 'events-secret' }
			})
		);
		const reader = response.body!.getReader();
		await reader.read();
		await reader.cancel();

		subscriber?.({
			type: 'task_completed',
			timestamp: new Date().toISOString(),
			source: 'packet-204'
		});

		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it('rejects API keys in query parameters without persisting them in cookies', async () => {
		const response = await GET(
			createEvent('https://example.com/api/events?apiKey=events-secret', { method: 'GET' })
		);

		expect(response.status).toBe(401);
		expect(response.headers.get('set-cookie')).toBeNull();
	});

	it('rejects query API keys in hosted deployments', async () => {
		privateEnv.SPARK_LIVE_CONTAINER = '1';

		const response = await GET(
			createEvent('https://example.com/api/events?apiKey=events-secret', { method: 'GET' })
		);

		expect(response.status).toBe(401);
		expect(response.headers.get('set-cookie')).toBeNull();
	});

	it('accepts header API keys in hosted deployments', async () => {
		privateEnv.SPARK_LIVE_CONTAINER = '1';

		const response = await GET(
			createEvent('https://example.com/api/events', {
				method: 'GET',
				headers: { 'x-api-key': 'events-secret' }
			})
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('set-cookie')).toContain('spawner_events_api_key=');
	});

	it('does not persist an API key cookie over insecure HTTP', async () => {
		const response = await GET(
			createEvent('http://example.com/api/events', {
				method: 'GET',
				headers: { 'x-api-key': 'events-secret' }
			})
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('set-cookie')).toBeNull();
		await response.body?.cancel();
	});

	it('rejects non-local requests without API key when one is configured', async () => {
		const response = await GET(createEvent('https://example.com/api/events', { method: 'GET' }));

		expect(response.status).toBe(401);
	});

	it('accepts the generic hosted UI events cookie', async () => {
		const response = await GET(
			createEvent('https://example.com/api/events', {
				method: 'GET',
				headers: {
					cookie: 'spawner_events_api_key=events-secret'
				}
			})
		);

		expect(response.status).toBe(200);
	});

	it('rejects malformed encoded auth cookies without crashing', async () => {
		const response = await GET(
			createEvent('https://example.com/api/events', {
				method: 'GET',
				headers: {
					cookie: 'spawner_events_api_key=%E0%A4%A'
				}
			})
		);

		expect(response.status).toBe(401);
	});

	it('accepts a loopback theatre SSE origin with an events key', async () => {
		const response = await GET(
			createEvent(
				'http://localhost:3333/api/events',
				{
					method: 'GET',
					headers: {
						origin: 'http://localhost:5600',
						'x-api-key': 'events-secret'
					}
				},
				'127.0.0.1'
			)
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5600');
	});

	it('redacts event data for loopback no-key SSE subscribers', async () => {
		const abort = new AbortController();
		const response = await GET(
			createEvent(
				'http://127.0.0.1:3333/api/events',
				{ method: 'GET', signal: abort.signal },
				'127.0.0.1'
			)
		);
		expect(response.status).toBe(200);
		const reader = response.body!.getReader();

		await readNextSsePayload(reader);
		emitPrivateBridgeEvent();
		const payload = await readNextSsePayload(reader);
		abort.abort();
		await reader.cancel().catch(() => undefined);

		expect(payload).toMatchObject({
			type: 'task_completed',
			missionId: 'mission-sse-private',
			taskId: 'T1',
			taskName: 'Private task',
			progress: 100,
			message: 'Task done',
			source: 'codex',
			authorityBoundary: {
				payload: 'event_metadata',
				data: 'requires_control_auth'
			}
		});
		expect(payload.data).toBeUndefined();
		expect(JSON.stringify(payload)).not.toContain('private provider output');
		expect(JSON.stringify(payload)).not.toContain('secret.ts');
	});

	it('keeps full event data for authenticated SSE subscribers', async () => {
		const abort = new AbortController();
		const response = await GET(
			createEvent(
				'http://127.0.0.1:3333/api/events',
				{
					method: 'GET',
					headers: { 'x-api-key': 'events-secret' },
					signal: abort.signal
				},
				'127.0.0.1'
			)
		);
		expect(response.status).toBe(200);
		const reader = response.body!.getReader();

		await readNextSsePayload(reader);
		emitPrivateBridgeEvent();
		const payload = await readNextSsePayload(reader);
		abort.abort();
		await reader.cancel().catch(() => undefined);

		expect(payload.authorityBoundary).toBeUndefined();
		expect(payload.data).toMatchObject({
			response: 'private provider output',
			verification: { filesChanged: ['secret.ts'] }
		});
	});

	it('answers loopback theatre preflight for event posts with an events key', async () => {
		const response = await OPTIONS(
			createEvent(
				'http://localhost:3333/api/events',
				{
					method: 'OPTIONS',
					headers: {
						origin: 'http://localhost:5600',
						'x-api-key': 'events-secret',
						'access-control-request-method': 'POST',
						'access-control-request-headers': 'content-type,x-api-key'
					}
				},
				'127.0.0.1'
			)
		);

		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5600');
		expect(response.headers.get('access-control-allow-methods')).toContain('POST');
	});

	it('accepts POST events with x-api-key and persists auth cookie', async () => {
		const response = await POST(
			createEvent('https://example.com/api/events', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': 'events-secret'
				},
				body: JSON.stringify({
					type: 'progress',
					data: { ok: true }
				})
			})
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('set-cookie')).toContain('spawner_events_api_key=');
	});

	it('generates unpredictable event IDs on the real POST path', async () => {
		const random = vi.spyOn(Math, 'random');
		const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue('deadbeef-1234-4123-8123-123456789abc');
		const response = await POST(
			createEvent('https://example.com/api/events', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': 'events-secret'
				},
				body: JSON.stringify({ type: 'task_progress', source: 'crypto-test' })
			})
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.eventId).toMatch(/^evt-\d+-deadbeef$/);
		expect(uuid).toHaveBeenCalledOnce();
		expect(random).not.toHaveBeenCalled();
	});

	it('rejects unauthenticated local event posts before relaying mission state', async () => {
		const response = await POST(
			createEvent(
				'http://127.0.0.1:3333/api/events',
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						type: 'mission_completed',
						missionId: 'mission-local-unauth-events',
						source: 'codex'
					})
				},
				'127.0.0.1'
			)
		);

		expect(response.status).toBe(401);
		expect(relayMissionControlEvent).not.toHaveBeenCalled();
	});

	it('downgrades replayed terminal lifecycle events without an active provider session', async () => {
		const response = await POST(
			createEvent('https://example.com/api/events', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': 'events-secret'
				},
				body: JSON.stringify({
					type: 'mission_completed',
					missionId: 'mission-replayed-terminal',
					source: 'codex',
					data: { providerId: 'codex', response: 'replayed completion' }
				})
			})
		);

		expect(response.status).toBe(200);
		expect(providerRuntime.markMissionTerminalFromLifecycleEvent).not.toHaveBeenCalled();
		expect(relayMissionControlEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'mission_lifecycle_untrusted',
				originalType: 'mission_completed',
				missionId: 'mission-replayed-terminal',
				data: expect.objectContaining({
					lifecycleTrust: expect.objectContaining({
						trusted: false,
						reason: 'no_matching_active_provider_session',
						providerId: 'codex'
					})
				})
			})
		);
	});

	it('allows terminal lifecycle events that match an active provider session', async () => {
		vi.mocked(providerRuntime.getSessionsForMission).mockReturnValue([
			{
				providerId: 'codex',
				missionId: 'mission-live-terminal',
				status: 'running',
				abortController: new AbortController(),
				startedAt: new Date('2026-06-09T00:00:00.000Z'),
				completedAt: null,
				result: null,
				error: null
			}
		]);

		const response = await POST(
			createEvent('https://example.com/api/events', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': 'events-secret'
				},
				body: JSON.stringify({
					type: 'mission_completed',
					missionId: 'mission-live-terminal',
					source: 'codex',
					data: { providerId: 'codex', response: 'live completion' }
				})
			})
		);

		expect(response.status).toBe(200);
		expect(providerRuntime.markMissionTerminalFromLifecycleEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				missionId: 'mission-live-terminal',
				status: 'completed',
				providerId: 'codex',
				response: 'live completion'
			})
		);
		expect(relayMissionControlEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'mission_completed',
				missionId: 'mission-live-terminal'
			})
		);
	});

	it('downgrades terminal lifecycle events that omit the requestId/traceRef recorded on the session', async () => {
		vi.mocked(providerRuntime.getSessionsForMission).mockReturnValue([
			{
				providerId: 'codex',
				missionId: 'mission-ref-bound-terminal',
				requestId: 'tg-build-ref-bound-1788000000000',
				traceRef: 'trace:spawner-prd:mission-ref-bound-terminal',
				status: 'running',
				abortController: new AbortController(),
				startedAt: new Date('2026-06-09T00:00:00.000Z'),
				completedAt: null,
				result: null,
				error: null
			}
		]);

		const response = await POST(
			createEvent('https://example.com/api/events', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': 'events-secret'
				},
				body: JSON.stringify({
					type: 'mission_completed',
					missionId: 'mission-ref-bound-terminal',
					source: 'codex',
					data: { providerId: 'codex', response: 'completion without refs' }
				})
			})
		);

		expect(response.status).toBe(200);
		expect(providerRuntime.markMissionTerminalFromLifecycleEvent).not.toHaveBeenCalled();
		expect(relayMissionControlEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'mission_lifecycle_untrusted',
				originalType: 'mission_completed',
				missionId: 'mission-ref-bound-terminal',
				data: expect.objectContaining({
					lifecycleTrust: expect.objectContaining({
						trusted: false,
						reason: 'session_requires_request_or_trace_ref_match'
					})
				})
			})
		);
	});

	it('allows terminal lifecycle events that present the requestId recorded on the session', async () => {
		vi.mocked(providerRuntime.getSessionsForMission).mockReturnValue([
			{
				providerId: 'codex',
				missionId: 'mission-ref-match-terminal',
				requestId: 'tg-build-ref-match-1788000000001',
				traceRef: 'trace:spawner-prd:mission-ref-match-terminal',
				status: 'running',
				abortController: new AbortController(),
				startedAt: new Date('2026-06-09T00:00:00.000Z'),
				completedAt: null,
				result: null,
				error: null
			}
		]);

		const response = await POST(
			createEvent('https://example.com/api/events', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': 'events-secret'
				},
				body: JSON.stringify({
					type: 'mission_completed',
					missionId: 'mission-ref-match-terminal',
					source: 'codex',
					data: {
						providerId: 'codex',
						requestId: 'tg-build-ref-match-1788000000001',
						response: 'completion bound by requestId'
					}
				})
			})
		);

		expect(response.status).toBe(200);
		expect(providerRuntime.markMissionTerminalFromLifecycleEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				missionId: 'mission-ref-match-terminal',
				status: 'completed',
				providerId: 'codex',
				response: 'completion bound by requestId'
			})
		);
	});

	it('rejects PRD analysis results that do not bind to a governed pending request', async () => {
		testSpawnerDir = await mkdtemp(path.join(tmpdir(), 'spawner-events-unbound-'));
		process.env.SPAWNER_STATE_DIR = testSpawnerDir;
		const requestId = 'events-unbound-result-test';

		const response = await POST(
			createEvent('https://example.com/api/events', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': 'events-secret'
				},
				body: JSON.stringify({
					type: 'prd_analysis_complete',
					source: 'codex-auto',
					data: {
						requestId,
						result: {
							success: true,
							projectName: 'Unbound Events Result',
							projectType: 'direct-build',
							complexity: 'simple',
							infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
							techStack: { framework: 'Existing Spawner UI', language: 'TypeScript' },
							tasks: [{ id: 'TAS-1', title: 'Should never store', skills: [], dependencies: [] }],
							skills: []
						}
					}
				})
			})
		);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body.code).toBe('prd_result_unbound');
		expect(existsSync(path.join(testSpawnerDir, 'results', `${requestId}.json`))).toBe(false);
		expect(existsSync(path.join(testSpawnerDir, 'pending-request.json'))).toBe(false);

		const traceRows = (await readFile(path.join(testSpawnerDir, 'prd-auto-trace.jsonl'), 'utf-8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(traceRows.map((row) => row.event)).toEqual(
			expect.arrayContaining(['events_received_complete', 'events_rejected_unbound'])
		);
		expect(traceRows.map((row) => row.event)).not.toContain('canonical_result_stored');
	});

	it('stores PRD analysis results under configured Spawner state directory', async () => {
		testSpawnerDir = await mkdtemp(path.join(tmpdir(), 'spawner-events-state-'));
		process.env.SPAWNER_STATE_DIR = testSpawnerDir;
		const requestId = 'events-state-dir-test';
		const traceRef = 'trace:spawner-prd:events-state-dir-test';
		await writeFile(
			path.join(testSpawnerDir, 'pending-request.json'),
			JSON.stringify({
				requestId,
				traceRef,
				status: 'pending',
				autoAnalysis: {
					status: 'running',
					startedAt: '2026-06-08T18:00:00.000Z'
				}
			}),
			'utf-8'
		);

		const response = await POST(
			createEvent('https://example.com/api/events', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': 'events-secret'
				},
				body: JSON.stringify({
					type: 'prd_analysis_complete',
					source: 'codex-auto',
					data: {
						requestId,
						result: {
							success: true,
							projectName: 'Events State Dir Test',
							projectType: 'clarification-understanding',
							complexity: 'simple',
							infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
							techStack: { framework: 'Existing Spawner UI', language: 'TypeScript' },
							tasks: [{ id: 'TAS-1', title: 'Store result consistently', skills: [], dependencies: [] }],
							skills: [],
							executionPrompt: 'Store result consistently.'
						}
					}
				})
			})
		);

		expect(response.status).toBe(200);
		expect(existsSync(path.join(testSpawnerDir, 'results', `${requestId}.json`))).toBe(true);
		const stored = await readFile(path.join(testSpawnerDir, 'results', `${requestId}.json`), 'utf-8');
		const storedJson = JSON.parse(stored);
		expect(storedJson.traceRef).toBe(traceRef);
		expect(storedJson.metadata.traceRef).toBe(traceRef);
		expect(stored).not.toContain('executionPrompt');
		expect(stored).not.toContain('Store result consistently.');

		const pending = JSON.parse(await readFile(path.join(testSpawnerDir, 'pending-request.json'), 'utf-8'));
		expect(pending).toMatchObject({
			requestId,
			status: 'processed',
			reason: 'Canonical provider result stored from events bridge.',
			autoAnalysis: {
				status: 'complete',
				success: true,
				canonicalResultAvailable: true,
				resultFileName: `${requestId}.json`
			}
		});

		const traceRows = (await readFile(path.join(testSpawnerDir, 'prd-auto-trace.jsonl'), 'utf-8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(traceRows.map((row) => row.event)).toEqual(
			expect.arrayContaining(['events_received_complete', 'canonical_result_stored'])
		);
	});

	it('applies base tier skill gating when PRD results arrive through events', async () => {
		testSpawnerDir = await mkdtemp(path.join(tmpdir(), 'spawner-events-skill-gate-'));
		process.env.SPAWNER_STATE_DIR = testSpawnerDir;
		const requestId = 'events-base-skill-gate-test';
		await writeFile(path.join(testSpawnerDir, 'pending-request.json'), JSON.stringify({ requestId, tier: 'base' }), 'utf-8');

		const response = await POST(
			createEvent('https://example.com/api/events', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': 'events-secret'
				},
				body: JSON.stringify({
					type: 'prd_analysis_complete',
					source: 'codex-auto',
					data: {
						requestId,
						result: {
							success: true,
							projectName: 'Events Skill Gate',
							projectType: 'direct-build',
							complexity: 'simple',
							infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
							techStack: { framework: 'Existing Spawner UI', language: 'TypeScript' },
							tasks: [
								{
									id: 'TAS-1',
									title: 'Build base task',
									skills: ['frontend-engineer', 'threejs-3d-graphics'],
									dependencies: []
								}
							],
							skills: ['frontend-engineer', 'threejs-3d-graphics']
						}
					}
				})
			})
		);

		expect(response.status).toBe(200);
		const stored = JSON.parse(await readFile(path.join(testSpawnerDir, 'results', `${requestId}.json`), 'utf-8'));
		expect(stored.tasks[0].skills).toEqual(['frontend-engineer']);
		expect(stored.skills).toEqual(['frontend-engineer']);
		expect(stored.metadata.skillGate).toMatchObject({
			applied: true,
			tier: 'base'
		});
	});

	it('adds Telegram relay metadata to provider lifecycle events from the current canvas load', async () => {
		testSpawnerDir = await mkdtemp(path.join(tmpdir(), 'spawner-events-relay-'));
		process.env.SPAWNER_STATE_DIR = testSpawnerDir;
		await import('fs/promises').then(({ writeFile }) =>
			writeFile(
				path.join(testSpawnerDir!, 'last-canvas-load.json'),
				JSON.stringify({
					relay: {
						missionId: 'mission-relay-test',
						chatId: '8319079055',
						userId: '8319079055',
						requestId: 'tg-build-test',
						goal: 'Build a tiny app',
						telegramRelay: { port: 8789, profile: 'spark-agi' }
					}
				}),
				'utf-8'
			)
		);

		const response = await POST(
			createEvent('https://example.com/api/events', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': 'events-secret'
				},
				body: JSON.stringify({
					type: 'task_started',
					missionId: 'mission-relay-test',
					source: 'codex',
					taskId: 'T1',
					taskName: 'Scaffold'
				})
			})
		);

		expect(response.status).toBe(200);
		expect(relayMissionControlEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				missionId: 'mission-relay-test',
				data: expect.objectContaining({
					chatId: '8319079055',
					userId: '8319079055',
					requestId: 'tg-build-test',
					telegramRelay: { port: 8789, profile: 'spark-agi' }
				})
			})
		);
	});
});
