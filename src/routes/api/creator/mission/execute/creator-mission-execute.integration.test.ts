import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './+server';
import {
	createCreatorMission,
	setCreatorDispatchRunnerForTests,
	type CreatorIntentPacket
} from '$lib/server/creator-mission';
import {
	buildServerGovernorDecisionAuthority,
	buildServerTurnIntentVNextAuthority
} from '$lib/server/harness-authority';

const { PRIVATE_ENV, TEST_API_KEY } = vi.hoisted(() => ({
	TEST_API_KEY: 'creator-mission-execute-route-test-secret',
	PRIVATE_ENV: {
		SPARK_BRIDGE_API_KEY: '',
		MCP_API_KEY: 'creator-mission-execute-route-test-secret'
	} as Record<string, string>
}));

vi.mock('$env/dynamic/private', () => ({ env: PRIVATE_ENV }));

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
		source: 'creator_execute_route_test',
		reason: 'Focused creator mission execution authority regression.',
		allowedTools: ['spawner.dispatch'],
		mutationClassesAllowed: ['launches_mission'],
		networkPolicy: 'local_only'
	};
}

function dispatchVNextAuthority(target: string) {
	return buildServerTurnIntentVNextAuthority({
		source: 'creator-execute-route-test',
		reason: 'User started creator mission execution from Spark.',
		toolName: 'spawner.dispatch',
		mutationClass: 'launches_mission',
		target
	});
}

function dispatchGovernorAuthority(target: string, requestId = target) {
	return buildServerGovernorDecisionAuthority({
		source: 'creator-execute-route-test',
		reason: 'User started creator mission execution from Spark.',
		toolName: 'spawner.dispatch',
		mutationClass: 'launches_mission',
		requestId,
		target
	});
}

function packet(): CreatorIntentPacket {
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
		privacy_mode: 'github_pr',
		desired_outputs: {
			domain_chip: true,
			specialization_path: true,
			benchmark_pack: true,
			autoloop_policy: true,
			telegram_flow: true,
			spawner_mission: true,
			swarm_publish_packet: true
		},
		intent_id: 'creator-intent-startup-yc-api',
		artifact_targets: ['domain_chip', 'benchmark_pack', 'specialization_path', 'autoloop_policy', 'tool_integration', 'swarm_publish_packet'],
		usage_surfaces: ['telegram', 'builder', 'spawner', 'swarm'],
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
	};
}

let tempDir = '';

beforeEach(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'spawner-creator-execute-route-'));
	process.env.SPAWNER_STATE_DIR = tempDir;
	PRIVATE_ENV.MCP_API_KEY = TEST_API_KEY;
});

afterEach(async () => {
	delete process.env.SPAWNER_STATE_DIR;
	setCreatorDispatchRunnerForTests(null);
	await rm(tempDir, { recursive: true, force: true });
});

describe('/api/creator/mission/execute', () => {
	it('starts execution for an existing creator mission trace', async () => {
		await createCreatorMission(
			{ brief: 'Create Startup YC path', missionId: 'mission-creator-execute-api', requestId: 'req-execute-api' },
			{ stateDir: tempDir, runPlanner: async () => packet() }
		);

		let capturedAutoRun = false;
		setCreatorDispatchRunnerForTests(async (load) => {
			capturedAutoRun = load.autoRun === true && load.relay.autoRun === true;
			return {
				started: true,
				missionId: load.missionId,
				projectPath: 'C:\\Users\\USER\\Desktop',
				providerId: 'codex'
			};
		});

		const response = await POST(event('http://127.0.0.1/api/creator/mission/execute', {
			missionId: 'mission-creator-execute-api',
			executionAuthority: dispatchGovernorAuthority('mission-creator-execute-api', 'req-execute-api')
		}) as never);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(body.started).toBe(true);
		expect(body.providerId).toBe('codex');
		expect(body.tracePath).toContain('mission-creator-execute-api.json');
		expect(body.trace.current_stage).toBe('execution_started');
		expect(body.trace.trace_id).toBe('creator-trace-mission-creator-execute-api');
		expect(capturedAutoRun).toBe(true);
	});

	it('rejects stage-only creator mission execution', async () => {
		await createCreatorMission(
			{
				brief: 'Create Startup YC specialization path, but stage only. Do not run.',
				missionId: 'mission-creator-stage-only-api',
				requestId: 'req-stage-only-api',
				executionPolicy: 'read_only'
			},
			{ stateDir: tempDir, runPlanner: async () => packet() }
		);

		const response = await POST(event('http://127.0.0.1/api/creator/mission/execute', {
			missionId: 'mission-creator-stage-only-api',
			executionAuthority: dispatchGovernorAuthority('mission-creator-stage-only-api', 'req-stage-only-api')
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/read-only\/stage-only/);
	});

	it('rejects execution requests without a mission or request id', async () => {
		const response = await POST(event('http://127.0.0.1/api/creator/mission/execute', {}) as never);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toBe('missionId or requestId is required');
	});

	it('rejects source-only creator mission execution without Harness authority', async () => {
		await createCreatorMission(
			{ brief: 'Create Startup YC path', missionId: 'mission-creator-no-authority', requestId: 'req-no-authority' },
			{ stateDir: tempDir, runPlanner: async () => packet() }
		);

		const response = await POST(event('http://127.0.0.1/api/creator/mission/execute', {
			missionId: 'mission-creator-no-authority',
			source: 'mission-board.creator.execute'
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
	});

	it('rejects legacy machine-origin policy for creator mission execution', async () => {
		await createCreatorMission(
			{ brief: 'Create Startup YC path', missionId: 'mission-creator-legacy-authority', requestId: 'req-legacy-authority' },
			{ stateDir: tempDir, runPlanner: async () => packet() }
		);

		const response = await POST(event('http://127.0.0.1/api/creator/mission/execute', {
			missionId: 'mission-creator-legacy-authority',
			executionAuthority: machineAuthority()
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('legacy_machine_origin_demoted');
	});

	it('rejects bare VNext authority for creator mission execution', async () => {
		await createCreatorMission(
			{ brief: 'Create Startup YC path', missionId: 'mission-creator-execute-vnext', requestId: 'req-execute-vnext' },
			{ stateDir: tempDir, runPlanner: async () => packet() }
		);

		setCreatorDispatchRunnerForTests(async (load) => ({
			started: true,
			missionId: load.missionId,
			projectPath: 'C:\\Users\\USER\\Desktop',
			providerId: 'codex'
		}));

		const response = await POST(event('http://127.0.0.1/api/creator/mission/execute', {
			missionId: 'mission-creator-execute-vnext',
			executionAuthority: dispatchVNextAuthority('mission-creator-execute-vnext')
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
	});

	it('accepts native GovernorDecisionV1 authority for creator mission execution', async () => {
		await createCreatorMission(
			{ brief: 'Create Startup YC path', missionId: 'mission-creator-execute-governor', requestId: 'req-execute-governor' },
			{ stateDir: tempDir, runPlanner: async () => packet() }
		);

		setCreatorDispatchRunnerForTests(async (load) => ({
			started: true,
			missionId: load.missionId,
			projectPath: 'C:\\Users\\USER\\Desktop',
			providerId: 'codex'
		}));

		const response = await POST(event('http://127.0.0.1/api/creator/mission/execute', {
			missionId: 'mission-creator-execute-governor',
			executionAuthority: dispatchGovernorAuthority('mission-creator-execute-governor', 'req-execute-governor')
		}) as never);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(body.authority).toMatchObject({
			allowed: true,
			source: 'governor_decision'
		});
		expect(body.started).toBe(true);
	});
});
