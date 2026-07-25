import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('$lib/server/provider-runtime', () => ({
	providerRuntime: {
		dispatch: vi.fn(async ({ executionPack }) => ({
			success: true,
			missionId: executionPack.missionId,
			sessions: { codex: { status: 'running' } },
			startedAt: '2026-05-04T10:00:00.000Z'
		})),
		getMissionResults: vi.fn(() => [])
	}
}));

import { GET, POST } from './+server';
import { providerRuntime } from '$lib/server/provider-runtime';
import { getMissionControlPersistPath } from '$lib/server/mission-control-relay';
import {
	assertNativeGovernorHarnessAuthority,
	buildServerGovernorDecisionAuthority
} from '$lib/server/harness-authority';

const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
const originalMcpApiKey = process.env.MCP_API_KEY;
const originalBridgeApiKey = process.env.SPARK_BRIDGE_API_KEY;
const TEST_API_KEY = 'spark-run-route-test-secret';
let testSpawnerStateDir: string | null = null;

function routeEvent(body: unknown, method = 'POST') {
	return {
		request: new Request('http://127.0.0.1/api/spark/run', {
			method,
			headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
			...(method === 'POST' ? { body: JSON.stringify(body) } : {})
		}),
		url: new URL('http://127.0.0.1/api/spark/run'),
		getClientAddress: () => '127.0.0.1'
	};
}

function machineAuthority() {
	return {
		schema: 'spark.machine_origin_policy.v1',
		origin: 'spark-run-test',
		source: 'spark_run_route_test',
		reason: 'Focused Spark run authority regression.',
		allowedTools: ['spawner.run'],
		mutationClassesAllowed: ['launches_mission'],
		networkPolicy: 'local_only'
	};
}

function vnextAuthority(options: { executable?: boolean; capabilityId?: string; actionType?: string } = {}) {
	const executable = options.executable !== false;
	const freshUserIntent = {
		id: 'evidence:spawner-run-vnext-test:fresh',
		kind: 'fresh_user_intent',
		source: 'spawner-ui',
		summary: 'Test user intent for Spawner run authority.',
		confidence: 0.95,
		trace_refs: []
	};
	return {
		schema_version: 'turn-intent-envelope-vnext',
		turn_id: 'turn:spawner-run-vnext-test',
		raw_turn_ref: {
			id: 'trace:spawner-run-vnext-test',
			redaction_class: 'metadata_only',
			summary: 'Test Telegram run authority.'
		},
		selected_move: executable ? 'execute_action' : 'chat_explain',
		freshness: {
			fresh_user_intent_present: true,
			fresh_user_intent_ref: freshUserIntent,
			stale_state_used_as_authority: false,
			memory_used_as_instruction: false,
			pending_state_used_as_authority: false
		},
		evidence: [freshUserIntent],
		action_authority: {
			state: executable ? 'executable' : 'chat_only',
			risk_tier: executable ? 'medium' : 'none',
			confidence: executable ? 0.95 : 0.2,
			requires_human_confirmation: false,
			reason: executable ? 'Fresh Telegram intent authorized Spawner mission execution.' : 'Chat-only turn.'
		},
		proposed_actions: executable
			? [
					{
						action_id: 'action:spawner-run-vnext-test',
						capability_id: options.capabilityId || 'capability:spawner-ui:spawner.run',
						action_type: options.actionType || 'launch_mission',
						risk_tier: 'medium',
						summary: 'Run Spawner mission.',
						args_ref: {
							id: 'artifact:spawner-run-vnext-test',
							kind: 'tool_args',
							path_or_uri: 'telegram://turns/spawner-run-vnext-test/actions/spawner.run',
							redaction_class: 'metadata_only',
							summary: 'Test args.'
						},
						requires_confirmation: false
					}
				]
			: []
	};
}

function governorAuthority(options: { executable?: boolean; withLedger?: boolean } = {}) {
	const executable = options.executable !== false;
	if (executable) {
		return buildServerGovernorDecisionAuthority({
			source: 'spark-run.integration.test',
			reason: 'Focused Spark run authority regression.',
			toolName: 'spawner.run',
			mutationClass: 'launches_mission'
		});
	}
	const envelope = vnextAuthority({ executable });
	const action = envelope.proposed_actions[0];
	const authorization = executable && action
		? {
				schema_version: 'authorization-decision-v1',
				decision_id: 'decision:spawner-run-governor-test',
				created_at: '2026-06-02T00:00:00.000Z',
				turn_id: envelope.turn_id,
				action_id: action.action_id,
				capability_id: action.capability_id,
				verdict: 'allow',
				risk_tier: action.risk_tier,
				reasons: ['harness_core_authorized'],
				evidence: [],
				approval: { required: false, status: 'not_required' },
				restrictions: {
					network_allowed: false,
					write_allowed: false,
					publish_allowed: false
				},
				trace: {
					id: 'trace:spawner-run-governor-test',
					redaction_class: 'metadata_only',
					summary: 'Governor authorization trace.'
				}
			}
		: null;
	const ledger = authorization && options.withLedger !== false
		? {
				schema_version: 'tool-call-ledger-v1',
				ledger_id: 'ledger:spawner-run-governor-test',
				created_at: '2026-06-02T00:00:01.000Z',
				turn_id: envelope.turn_id,
				action_id: action.action_id,
				capability_id: action.capability_id,
				tool_name: 'spawner.run',
				lifecycle: [
					{ stage: 'propose', at: '2026-06-02T00:00:00.000Z', verdict: 'passed' },
					{ stage: 'authorize', at: '2026-06-02T00:00:00.000Z', verdict: 'passed' },
					{ stage: 'execute', at: '2026-06-02T00:00:01.000Z', verdict: 'skipped' }
				],
				authorization,
				arguments: {
					schema_valid: true,
					raw_ref: action.args_ref,
					sanitized_ref: action.args_ref
				},
				result: {
					status: 'not_started',
					summary: 'Spawner dispatch has not executed yet.',
					sanitized_output_ref: {
						id: 'artifact:spawner-run-governor-output',
						kind: 'tool_output',
						path_or_uri: 'spawner://governor-test/output',
						redaction_class: 'metadata_only',
						summary: 'Pre-dispatch ledger output reference.'
					}
				},
				trace: {
					id: 'trace:spawner-run-governor-ledger',
					redaction_class: 'metadata_only',
					summary: 'Governor ledger trace.'
				}
			}
		: null;
	return {
		schema_version: 'governor-decision-v1',
		decision_id: 'governor-decision:spawner-run-test',
		created_at: '2026-06-02T00:00:02.000Z',
		surface: 'telegram',
		turn_id: envelope.turn_id,
		selected_move: envelope.selected_move,
		authority_state: envelope.action_authority.state,
		risk_tier: envelope.action_authority.risk_tier,
		outcome: executable ? 'execute' : 'chat_only',
		envelope,
		authorizations: authorization ? [authorization] : [],
		tool_ledgers: ledger ? [ledger] : [],
		execution_boundary: {
			action_authorized: executable,
			action_count: envelope.proposed_actions.length,
			authorized_action_count: authorization ? 1 : 0,
			requires_human_confirmation: false,
			legacy_authority_demoted: true,
			reasons: executable
				? ['fresh_user_intent_is_authority', 'governor_authorized_execution']
				: ['fresh_user_intent_is_authority', 'governor_keeps_turn_conversational']
		},
		reply_contract: {
			style: 'human_conversational',
			instruction: executable
				? 'Proceed only with the authorized action and record the result ledger.'
				: 'Answer conversationally; do not launch, write, schedule, publish, or run tools.',
			inspect_link_allowed: executable,
			should_interrupt: false
		},
		evidence: [],
		trace: {
			id: 'trace:spawner-run-governor-decision',
			redaction_class: 'metadata_only',
			summary: 'Governor decision trace.'
		}
	};
}

async function expectOkJson(response: Response) {
	const body = await response.json();
	expect(response.status, JSON.stringify(body)).toBe(200);
	return body;
}

describe('/api/spark/run integration', () => {
	beforeEach(async () => {
		testSpawnerStateDir = await mkdtemp(path.join(tmpdir(), 'spawner-spark-run-test-'));
		process.env.SPAWNER_STATE_DIR = testSpawnerStateDir;
		process.env.MCP_API_KEY = TEST_API_KEY;
		process.env.SPARK_BRIDGE_API_KEY = TEST_API_KEY;
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		if (originalSpawnerStateDir === undefined) {
			delete process.env.SPAWNER_STATE_DIR;
		} else {
			process.env.SPAWNER_STATE_DIR = originalSpawnerStateDir;
		}
		if (originalMcpApiKey === undefined) {
			delete process.env.MCP_API_KEY;
		} else {
			process.env.MCP_API_KEY = originalMcpApiKey;
		}
		if (originalBridgeApiKey === undefined) {
			delete process.env.SPARK_BRIDGE_API_KEY;
		} else {
			process.env.SPARK_BRIDGE_API_KEY = originalBridgeApiKey;
		}
		delete process.env.SPAWNER_MISSION_CONTROL_PUBLIC_URL;
		if (testSpawnerStateDir) {
			await rm(testSpawnerStateDir, { recursive: true, force: true });
			testSpawnerStateDir = null;
		}
	});

	it('returns local-only Mission Control access for Telegram callers by default', async () => {
		expect(getMissionControlPersistPath()).toContain('spawner-spark-run-test-');
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(routeEvent({
			goal: 'Build a tiny Telegram smoke app.',
			providers: ['codex'],
			requestId: 'tg-spark-run-local',
			traceRef: 'trace:telegram-run:tg-spark-run-local',
			executionAuthority: governorAuthority()
		}) as never);

		const body = await expectOkJson(response);
		expect(body).toMatchObject({
			success: true,
			requestId: 'tg-spark-run-local',
			traceRef: 'trace:telegram-run:tg-spark-run-local',
			providers: ['codex'],
			missionControlAccess: {
				mode: 'local-only',
				url: null,
				mobileReachable: false
			}
		});
		expect(dispatch).toHaveBeenCalledTimes(1);
		const dispatchAuthority = dispatch.mock.calls[0]?.[0]?.executionAuthority;
		expect(() => assertNativeGovernorHarnessAuthority({
			authority: dispatchAuthority,
			toolName: 'spawner.dispatch',
			ownerSystem: 'spawner-ui',
			mutationClass: 'launches_mission',
			requestId: 'tg-spark-run-local'
		})).not.toThrow();
	});

	it('exposes a non-dispatching route health probe', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await GET(routeEvent(null, 'GET') as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			route: '/api/spark/run',
			check: 'route-loaded',
			dispatchesMission: false
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('returns hosted Mission Control access when a mobile URL is configured', async () => {
		process.env.SPAWNER_MISSION_CONTROL_PUBLIC_URL = 'https://mission.sparkswarm.ai';

		const response = await POST(routeEvent({
			goal: 'Build a tiny Telegram hosted smoke app.',
			providers: ['codex'],
			requestId: 'tg-spark-run-hosted',
			executionAuthority: governorAuthority()
		}) as never);

		const body = await expectOkJson(response);
		expect(body.missionControlAccess).toMatchObject({
			mode: 'hosted',
			mobileReachable: true
		});
		expect(body.missionControlAccess.url).toBe(`https://mission.sparkswarm.ai/missions/${body.missionId}`);
	});

	it('uses a provided missionName instead of deriving the board title from the goal', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(routeEvent({
			goal: 'Deeply analyze the local Spark stack before creating the chip.',
			missionName: 'Spark Bug Recognition Domain Chip',
			providers: ['codex'],
			requestId: 'tg-context-title',
			executionAuthority: governorAuthority()
		}) as never);

		const body = await expectOkJson(response);
		expect(body.missionName).toBe('Spark Bug Recognition Domain Chip');
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it('blocks Spark run dispatch without Harness authority', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(routeEvent({
			goal: 'Build a tiny Telegram smoke app.',
			providers: ['codex'],
			requestId: 'tg-spark-run-no-authority'
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('blocks legacy machine-origin policy for Spark run dispatch', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(routeEvent({
			goal: 'Build a tiny Telegram smoke app.',
			providers: ['codex'],
			requestId: 'tg-spark-run-legacy-authority',
			executionAuthority: machineAuthority()
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('legacy_machine_origin_demoted');
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('accepts native GovernorDecisionV1 authority for Spark run dispatch', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(routeEvent({
			goal: 'Run a no-edit Spawner proof mission that only replies SPARK_QA_NO_EDIT_OK.',
			providers: ['codex'],
			requestId: 'tg-spark-run-governor',
			traceRef: 'trace:telegram-run:tg-spark-run-governor',
			executionAuthority: governorAuthority()
		}) as never);

		const body = await expectOkJson(response);
		expect(body.success).toBe(true);
		expect(body.authority).toMatchObject({
			allowed: true,
			source: 'governor_decision',
			governorOutcome: 'execute',
			traceId: expect.stringMatching(/^trace:spawner:spark-run\.integration\.test:/)
		});
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it('does not let local wording heuristics veto native Governor authority', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(routeEvent({
			goal: 'The phrase "do not run" is quoted in the mission brief; execute the authorized no-edit proof and reply SPARK_QA_NO_EDIT_OK.',
			providers: ['codex'],
			requestId: 'tg-spark-run-governor-local-veto-proof',
			executionAuthority: governorAuthority()
		}) as never);

		const body = await expectOkJson(response);
		expect(body.success).toBe(true);
		expect(body.authority.source).toBe('governor_decision');
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it('keeps local execution-intent heuristics out of the Spark run authority path', () => {
		const source = readFileSync(path.join(__dirname, '+server.ts'), 'utf8');

		expect(source).not.toMatch(/evaluateExecutionIntentBoundary/);
		expect(source).toMatch(/assertNativeGovernorHarnessAuthority/);
	});

	it('blocks bare TurnIntentEnvelopeVNext authority for Spark run dispatch', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(routeEvent({
			goal: 'Run a no-edit Spawner proof mission that only replies SPARK_QA_NO_EDIT_OK.',
			providers: ['codex'],
			requestId: 'tg-spark-run-vnext',
			traceRef: 'trace:telegram-run:tg-spark-run-vnext',
			executionAuthority: vnextAuthority()
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority).toMatchObject({
			allowed: false,
			source: 'turn_intent_vnext'
		});
		expect(body.authority.reasonCodes).toContain('native_governor_required');
		expect(body.authority).toMatchObject({
			traceId: 'trace:spawner-run-vnext-test'
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('blocks chat-only GovernorDecisionV1 authority for Spark run dispatch', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(routeEvent({
			goal: 'Run a no-edit Spawner proof mission that only replies SPARK_QA_NO_EDIT_OK.',
			providers: ['codex'],
			requestId: 'tg-spark-run-governor-chat-only',
			executionAuthority: governorAuthority({ executable: false })
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority).toMatchObject({
			allowed: false,
			source: 'governor_decision',
			governorOutcome: 'chat_only'
		});
		expect(body.authority.reasonCodes).toContain('governor_outcome_chat_only_not_executable');
		expect(body.authority.reasonCodes).toContain('governor_action_not_authorized');
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('blocks chat-only TurnIntentEnvelopeVNext authority for Spark run dispatch', async () => {
		const dispatch = vi.mocked(providerRuntime.dispatch);
		dispatch.mockClear();

		const response = await POST(routeEvent({
			goal: 'Run a no-edit Spawner proof mission that only replies SPARK_QA_NO_EDIT_OK.',
			providers: ['codex'],
			requestId: 'tg-spark-run-vnext-chat-only',
			executionAuthority: vnextAuthority({ executable: false })
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority).toMatchObject({
			allowed: false,
			source: 'turn_intent_vnext'
		});
		expect(body.authority.reasonCodes).toContain('tool_not_allowed_by_policy');
		expect(body.authority.reasonCodes).toContain('action_not_executable');
		expect(dispatch).not.toHaveBeenCalled();
	});
});
