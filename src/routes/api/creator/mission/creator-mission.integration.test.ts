import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './+server';
import {
	buildServerGovernorDecisionAuthority,
	buildServerTurnIntentVNextAuthority
} from '$lib/server/harness-authority';
import type { CreatorIntentPacket } from '$lib/server/creator-mission';

const { PRIVATE_ENV, TEST_API_KEY } = vi.hoisted(() => ({
	TEST_API_KEY: 'creator-mission-route-test-secret',
	PRIVATE_ENV: {
		SPARK_BRIDGE_API_KEY: '',
		MCP_API_KEY: 'creator-mission-route-test-secret'
	} as Record<string, string>
}));

vi.mock('$env/dynamic/private', () => ({ env: PRIVATE_ENV }));

vi.mock('$lib/server/mission-control-relay', () => ({
	relayMissionControlEvent: vi.fn(async () => undefined)
}));

const originalMcpApiKey = process.env.MCP_API_KEY;

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function event(url: string, body?: unknown) {
	return {
		request: new Request(
			url,
			body === undefined
				? { headers: { 'x-api-key': TEST_API_KEY } }
				: {
						method: 'POST',
						headers: { 'content-type': 'application/json', 'x-api-key': TEST_API_KEY },
						body: JSON.stringify(body)
					}
		),
		url: new URL(url),
		getClientAddress: () => '127.0.0.1'
	};
}

function machineAuthority() {
	return {
		schema: 'spark.machine_origin_policy.v1',
		origin: 'creator-mission-test',
		source: 'creator_mission_route_test',
		reason: 'Focused creator mission creation authority regression.',
		allowedTools: ['creator.mission.create'],
		mutationClassesAllowed: ['creates_chip'],
		networkPolicy: 'local_only'
	};
}

function creatorVNextAuthority() {
	return buildServerTurnIntentVNextAuthority({
		source: 'creator-mission-route-test',
		reason: 'User started creator mission creation from Spark.',
		toolName: 'creator.mission.create',
		mutationClass: 'creates_chip',
		target: 'startup-yc'
	});
}

function creatorGovernorAuthority() {
	return buildServerGovernorDecisionAuthority({
		source: 'creator-mission-route-test',
		reason: 'User started creator mission creation from Spark.',
		toolName: 'creator.mission.create',
		mutationClass: 'creates_chip',
		target: 'startup-yc'
	});
}

function creatorPacket(): CreatorIntentPacket {
	return {
		schema_version: 'spark-creator-intent.v1',
		user_goal: 'Create Startup YC path',
		target_domain: 'startup-yc',
		target_operator_surface: 'telegram+builder+swarm',
		expected_agent_capability: 'Improve Spark startup-yc capability.',
		success_examples: ['Held-out score improves.'],
		failure_examples: ['Formatting-only score movement.'],
		tools_in_scope: ['spark_telegram_bot', 'spark_swarm'],
		data_sources_allowed: ['local_repo', 'spark_swarm'],
		risk_level: 'medium',
		privacy_mode: 'swarm_shared',
		desired_outputs: {
			domain_chip: true,
			specialization_path: true,
			benchmark_pack: true,
			autoloop_policy: true,
			telegram_flow: true,
			spawner_mission: false,
			swarm_publish_packet: true
		}
	};
}

let tempDir = '';

beforeEach(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'spawner-creator-route-'));
	process.env.SPAWNER_STATE_DIR = tempDir;
	PRIVATE_ENV.MCP_API_KEY = TEST_API_KEY;
	process.env.MCP_API_KEY = TEST_API_KEY;
});

afterEach(async () => {
	delete process.env.SPAWNER_STATE_DIR;
	restoreEnv('MCP_API_KEY', originalMcpApiKey);
	const { setCreatorPlanRunnerForTests } = await import('$lib/server/creator-mission');
	setCreatorPlanRunnerForTests(null);
	await rm(tempDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('/api/creator/mission', () => {
	it('creates and reads a creator mission trace', async () => {
		const { setCreatorPlanRunnerForTests } = await import('$lib/server/creator-mission');
		setCreatorPlanRunnerForTests(async () => ({
			schema_version: 'spark-creator-intent.v1',
			user_goal: 'Create Startup YC path',
			target_domain: 'startup-yc',
			target_operator_surface: 'telegram+builder+swarm',
			expected_agent_capability: 'Improve Spark startup-yc capability.',
			success_examples: ['Held-out score improves.'],
			failure_examples: ['Formatting-only score movement.'],
			tools_in_scope: ['spark_telegram_bot', 'spark_swarm'],
			data_sources_allowed: ['local_repo', 'spark_swarm'],
			risk_level: 'medium',
			privacy_mode: 'swarm_shared',
			desired_outputs: {
				domain_chip: true,
				specialization_path: true,
				benchmark_pack: true,
				autoloop_policy: true,
				telegram_flow: true,
				spawner_mission: false,
				swarm_publish_packet: true
			},
			intent_id: 'creator-intent-startup-yc-route',
			artifact_targets: ['domain_chip', 'benchmark_pack', 'specialization_path', 'autoloop_policy', 'tool_integration', 'swarm_publish_packet'],
			usage_surfaces: ['telegram', 'builder', 'swarm'],
			success_claim: 'Improve Spark startup-yc capability.',
			capabilities_to_prove: ['detect default-dead risk'],
			benchmark_requirements: {
				visible_cases: 20,
				fixed_suite: true,
				held_out_cases: true,
				trap_cases: true,
				simulator_transfer: true,
				fresh_agent_absorption: true,
				human_calibration: false
			},
			network_contribution_policy: 'github_pr_required'
		}));

		const postResponse = await POST(event('http://127.0.0.1/api/creator/mission', {
			brief: 'Create Startup YC path',
			missionId: 'mission-creator-api',
			requestId: 'creator-api-req',
			executionAuthority: creatorGovernorAuthority()
		}) as never);
		expect(postResponse.status).toBe(200);
		const postBody = await postResponse.json();
		expect(postBody.trace.creator_mode).toBe('full_path');
		expect(postBody.trace.trace_id).toBe('creator-trace-mission-creator-api');
		expect(postBody.trace.intent_id).toBe('creator-intent-startup-yc-route');
		expect(postBody.tracePath).toContain('mission-creator-api.json');
		expect(postBody.trace.artifact_manifests[0].artifact_type).toBe('domain_chip');
		expect(postBody.trace.intent_packet.target_domain).toBe('startup-yc');
		expect(postBody.trace.execution_policy).toBe('manual_run');
		expect(postBody.taskCount).toBeGreaterThan(1);
		expect(postBody.canvasUrl).toBe('http://127.0.0.1/canvas?pipeline=creator-creator-api-req&mission=mission-creator-api');
		expect(postBody.trace.tasks.map((task: { id: string }) => task.id)).toContain('benchmark-pack');

		const { relayMissionControlEvent } = await import('$lib/server/mission-control-relay');
		expect(vi.mocked(relayMissionControlEvent)).toHaveBeenCalledTimes(3);
		const missionCreatedCall = vi.mocked(relayMissionControlEvent).mock.calls[0]?.[0] as {
			type?: string;
			data?: { plannedTasks?: Array<{ title: string }> };
		};
		const taskCompletedCall = vi.mocked(relayMissionControlEvent).mock.calls[2]?.[0] as {
			type?: string;
			data?: { taskGraph?: Array<{ id: string }> };
		};
		expect(missionCreatedCall.type).toBe('mission_created');
		expect((missionCreatedCall.data as { executionPolicy?: string })?.executionPolicy).toBe('manual_run');
		expect(missionCreatedCall.data?.plannedTasks?.length).toBe(postBody.taskCount);
		expect(taskCompletedCall.type).toBe('task_completed');
		expect(taskCompletedCall.data?.taskGraph?.map((task) => task.id)).toContain('creator-validation');

		const getResponse = await GET(event('http://127.0.0.1/api/creator/mission?requestId=creator-api-req') as never);
		expect(getResponse.status).toBe(200);
		const getBody = await getResponse.json();
		expect(getBody.trace.mission_id).toBe('mission-creator-api');
		// The GET response intentionally no longer leaks the absolute server tracePath (#877
		// path-redaction series); the trace is returned without exposing the filesystem path.
		expect(getBody.tracePath).toBeUndefined();
	});

	it('marks explicitly read-only creator mission requests as read-only', async () => {
		const { setCreatorPlanRunnerForTests } = await import('$lib/server/creator-mission');
		setCreatorPlanRunnerForTests(async () => ({
			schema_version: 'spark-creator-intent.v1',
			user_goal: 'Create Startup YC specialization path',
			target_domain: 'startup-yc',
			target_operator_surface: 'telegram+builder+swarm',
			expected_agent_capability: 'Improve Spark startup-yc capability.',
			success_examples: ['Held-out score improves.'],
			failure_examples: ['Formatting-only score movement.'],
			tools_in_scope: ['spark_telegram_bot', 'spark_swarm'],
			data_sources_allowed: ['local_repo', 'spark_swarm'],
			risk_level: 'medium',
			privacy_mode: 'swarm_shared',
			desired_outputs: {
				domain_chip: true,
				specialization_path: true,
				benchmark_pack: true,
				autoloop_policy: true,
				telegram_flow: true,
				spawner_mission: false,
				swarm_publish_packet: true
			}
		}));

		const response = await POST(event('http://127.0.0.1/api/creator/mission', {
			brief: 'Create Startup YC specialization path, but stage only. Do not run.',
			missionId: 'mission-creator-stage-only-route',
			requestId: 'creator-stage-only-route',
			executionPolicy: 'read_only'
		}) as never);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.trace.execution_policy).toBe('read_only');
		const { relayMissionControlEvent } = await import('$lib/server/mission-control-relay');
		expect(vi.mocked(relayMissionControlEvent)).toHaveBeenCalledTimes(1);
		const missionCreatedCall = vi.mocked(relayMissionControlEvent).mock.calls[0]?.[0] as {
			type?: string;
			message?: string;
			data?: { executionPolicy?: string };
		};
		expect(missionCreatedCall.type).toBe('mission_created');
		expect(missionCreatedCall.message).toMatch(/staged/i);
		expect(missionCreatedCall.data?.executionPolicy).toBe('read_only');
	});

	it('does not turn no-run prose into read-only authority', async () => {
		const response = await POST(event('http://127.0.0.1/api/creator/mission', {
			brief: 'Create Startup YC specialization path, but stage only. Do not run.',
			missionId: 'mission-creator-prose-no-authority',
			requestId: 'creator-prose-no-authority'
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
	});

	it('rejects missing briefs', async () => {
		const response = await POST(event('http://127.0.0.1/api/creator/mission', {}) as never);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toBe('brief is required');
	});

	it('rejects executable creator mission creation without execution authority', async () => {
		const response = await POST(event('http://127.0.0.1/api/creator/mission', {
			brief: 'Create Startup YC path',
			missionId: 'mission-creator-missing-authority',
			requestId: 'creator-missing-authority'
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
	});

	it('rejects legacy machine-origin policy for executable creator mission creation', async () => {
		const response = await POST(event('http://127.0.0.1/api/creator/mission', {
			brief: 'Create Startup YC path',
			missionId: 'mission-creator-legacy-authority',
			requestId: 'creator-legacy-authority',
			executionAuthority: machineAuthority()
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('legacy_machine_origin_demoted');
	});

	it('rejects bare VNext authority for executable creator mission creation', async () => {
		const response = await POST(event('http://127.0.0.1/api/creator/mission', {
			brief: 'Create Startup YC path',
			missionId: 'mission-creator-vnext-authority',
			requestId: 'creator-vnext-authority',
			executionAuthority: creatorVNextAuthority()
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
	});

	it('accepts native GovernorDecisionV1 authority for executable creator mission creation', async () => {
		const { setCreatorPlanRunnerForTests } = await import('$lib/server/creator-mission');
		setCreatorPlanRunnerForTests(async () => creatorPacket());

		const response = await POST(event('http://127.0.0.1/api/creator/mission', {
			brief: 'Create Startup YC path',
			missionId: 'mission-creator-governor-authority',
			requestId: 'creator-governor-authority',
			executionAuthority: creatorGovernorAuthority()
		}) as never);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(body.authority).toMatchObject({
			allowed: true,
			source: 'governor_decision'
		});
		expect(body.trace.execution_policy).toBe('manual_run');
	});
});
