import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './+server';
import {
	createCreatorMission,
	readCreatorMissionTrace,
	setCreatorValidationCommandRunnerForTests,
	type CreatorIntentPacket
} from '$lib/server/creator-mission';
import { getMissionControlRelaySnapshot } from '$lib/server/mission-control-relay';
import { buildServerGovernorDecisionAuthority, buildServerTurnIntentVNextAuthority } from '$lib/server/harness-authority';

const { PRIVATE_ENV, TEST_API_KEY } = vi.hoisted(() => ({
	TEST_API_KEY: 'creator-mission-validate-route-test-secret',
	PRIVATE_ENV: {
		SPARK_BRIDGE_API_KEY: '',
		MCP_API_KEY: 'creator-mission-validate-route-test-secret'
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

function packet(): CreatorIntentPacket {
	return {
		schema_version: 'spark-creator-intent.v1',
		user_goal: 'Create Startup YC path',
		target_domain: 'startup-yc',
		target_operator_surface: 'builder',
		expected_agent_capability: 'Improve Spark startup-yc capability.',
		success_examples: ['Held-out score improves.'],
		failure_examples: ['Formatting-only score movement.'],
		tools_in_scope: ['spark_intelligence_builder'],
		data_sources_allowed: ['local_repo'],
		risk_level: 'medium',
		privacy_mode: 'local_only',
		desired_outputs: {
			domain_chip: true,
			specialization_path: false,
			benchmark_pack: true,
			autoloop_policy: false,
			telegram_flow: false,
			spawner_mission: false,
			swarm_publish_packet: false
		},
		intent_id: 'creator-intent-startup-yc-validate',
		artifact_targets: ['creator_report'],
		usage_surfaces: ['builder'],
		success_claim: 'Improve Spark startup-yc capability.',
		capabilities_to_prove: ['detect default-dead risk'],
		benchmark_requirements: { visible_cases: 5, fixed_suite: true, trap_cases: true },
		network_contribution_policy: 'workspace_only'
	};
}

function validationGovernorAuthority(target = 'mission-creator-validate-api') {
	return buildServerGovernorDecisionAuthority({
		source: 'creator-validation-route-test',
		reason: 'User requested creator artifact validation from Spark.',
		toolName: 'spawner.creator.validate',
		mutationClass: 'writes_files',
		target
	});
}

function validationVNextAuthority(target = 'mission-creator-validate-api') {
	return buildServerTurnIntentVNextAuthority({
		source: 'creator-validation-route-test',
		reason: 'User requested creator artifact validation from Spark.',
		toolName: 'spawner.creator.validate',
		mutationClass: 'writes_files',
		target
	});
}

async function waitForValidationRun(missionId: string) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const trace = await readCreatorMissionTrace({ missionId }, tempDir);
		if (trace && trace.validation_runs.length > 0) return trace;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for validation run on ${missionId}`);
}

let tempDir = '';
let validationCommandCalls = 0;

beforeEach(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'spawner-creator-validate-route-'));
	process.env.SPAWNER_STATE_DIR = tempDir;
	PRIVATE_ENV.MCP_API_KEY = TEST_API_KEY;
	validationCommandCalls = 0;
	setCreatorValidationCommandRunnerForTests(async () => {
		validationCommandCalls += 1;
		return {
			exitCode: 0,
			stdout: 'ok',
			stderr: ''
		};
	});
});

afterEach(async () => {
	delete process.env.SPAWNER_STATE_DIR;
	setCreatorValidationCommandRunnerForTests(null);
	await rm(tempDir, { recursive: true, force: true });
});

describe('/api/creator/mission/validate', () => {
	it('runs manifest validations for an existing creator mission trace', async () => {
		await createCreatorMission(
			{ brief: 'Create Startup YC path', missionId: 'mission-creator-validate-api', requestId: 'req-validate-api' },
			{
				stateDir: tempDir,
				runManifestPlanner: async () => ({
					intent_packet: packet(),
					artifact_manifests: [
						{
							schema_version: 'spark-artifact-manifest.v1',
							artifact_id: 'startup-yc-creator-report-v1',
							artifact_type: 'creator_report',
							repo: tempDir,
							inputs: ['creator-intent-startup-yc-validate'],
							outputs: ['reports/creator-run-summary.json'],
							validation_commands: ['python --version'],
							promotion_gates: ['schema_gate', 'rollback_gate'],
							rollback_plan: 'Delete generated reports.'
						}
					],
					validation_issues: []
				})
			}
		);

		const response = await POST(event('http://127.0.0.1/api/creator/mission/validate', {
			missionId: 'mission-creator-validate-api',
			executionAuthority: validationGovernorAuthority('mission-creator-validate-api')
		}) as never);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(body.authority.source).toBe('governor_decision');
		expect(body.status).toBe('passed');
		expect(body.trace.stage_status).toBe('blocked');
		expect(body.trace.publish_readiness).toBe('private_draft');
		expect(body.trace.blockers.join('\n')).toContain('Fresh benchmark runner evidence is required');
		expect(body.trace.validation_runs).toHaveLength(1);
		const snapshot = getMissionControlRelaySnapshot('mission-creator-validate-api');
		expect(snapshot.recent.some((entry) =>
			entry.eventType === 'task_progress' &&
			entry.summary.includes('Validation 1/1') &&
			entry.summary.includes('python --version')
		)).toBe(true);
	});

	it('accepts background validation and records the run asynchronously', async () => {
		await createCreatorMission(
			{ brief: 'Create Startup YC path', missionId: 'mission-creator-validate-async', requestId: 'req-validate-async' },
			{
				stateDir: tempDir,
				runManifestPlanner: async () => ({
					intent_packet: packet(),
					artifact_manifests: [
						{
							schema_version: 'spark-artifact-manifest.v1',
							artifact_id: 'startup-yc-creator-report-v1',
							artifact_type: 'creator_report',
							repo: tempDir,
							inputs: ['creator-intent-startup-yc-validate'],
							outputs: ['reports/creator-run-summary.json'],
							validation_commands: ['python --version'],
							promotion_gates: ['schema_gate', 'rollback_gate'],
							rollback_plan: 'Delete generated reports.'
						}
					],
					validation_issues: []
				})
			}
		);

		const response = await POST(event('http://127.0.0.1/api/creator/mission/validate', {
			missionId: 'mission-creator-validate-async',
			async: true,
			executionAuthority: validationGovernorAuthority('mission-creator-validate-async')
		}) as never);

		expect(response.status).toBe(202);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			accepted: true,
			status: 'running',
			missionId: 'mission-creator-validate-async',
			requestId: 'req-validate-async'
		});
		expect(body.authority.source).toBe('governor_decision');
		const trace = await waitForValidationRun('mission-creator-validate-async');
		expect(trace.stage_status).toBe('blocked');
		expect(trace.publish_readiness).toBe('private_draft');
		expect(trace.blockers.join('\n')).toContain('Fresh benchmark runner evidence is required');
		expect(trace.validation_runs[0].status).toBe('passed');
	});

	it('rejects validation requests without a mission or request id', async () => {
		const response = await POST(event('http://127.0.0.1/api/creator/mission/validate', {}) as never);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toBe('missionId or requestId is required');
	});

	it('rejects unknown creator missions before enqueueing validation', async () => {
		const response = await POST(event('http://127.0.0.1/api/creator/mission/validate', {
			missionId: 'mission-creator-missing',
			async: true,
			executionAuthority: validationGovernorAuthority('mission-creator-missing')
		}) as never);
		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error).toBe('creator mission trace not found');
	});

	it('blocks source-only validation commands without Harness authority', async () => {
		await createCreatorMission(
			{ brief: 'Create Startup YC path', missionId: 'mission-creator-validate-no-authority', requestId: 'req-validate-no-authority' },
			{
				stateDir: tempDir,
				runManifestPlanner: async () => ({
					intent_packet: packet(),
					artifact_manifests: [
						{
							schema_version: 'spark-artifact-manifest.v1',
							artifact_id: 'startup-yc-creator-report-v1',
							artifact_type: 'creator_report',
							repo: tempDir,
							inputs: ['creator-intent-startup-yc-validate'],
							outputs: ['reports/creator-run-summary.json'],
							validation_commands: ['python --version'],
							promotion_gates: ['schema_gate', 'rollback_gate'],
							rollback_plan: 'Delete generated reports.'
						}
					],
					validation_issues: []
				})
			}
		);

		const response = await POST(event('http://127.0.0.1/api/creator/mission/validate', {
			missionId: 'mission-creator-validate-no-authority',
			source: 'mission-board.creator-validation'
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
		expect(validationCommandCalls).toBe(0);
		const trace = await readCreatorMissionTrace({ missionId: 'mission-creator-validate-no-authority' }, tempDir);
		expect(trace?.validation_runs).toHaveLength(0);
	});

	it('blocks bare VNext authority for validation commands', async () => {
		await createCreatorMission(
			{ brief: 'Create Startup YC path', missionId: 'mission-creator-validate-vnext', requestId: 'req-validate-vnext' },
			{
				stateDir: tempDir,
				runManifestPlanner: async () => ({
					intent_packet: packet(),
					artifact_manifests: [
						{
							schema_version: 'spark-artifact-manifest.v1',
							artifact_id: 'startup-yc-creator-report-v1',
							artifact_type: 'creator_report',
							repo: tempDir,
							inputs: ['creator-intent-startup-yc-validate'],
							outputs: ['reports/creator-run-summary.json'],
							validation_commands: ['python --version'],
							promotion_gates: ['schema_gate', 'rollback_gate'],
							rollback_plan: 'Delete generated reports.'
						}
					],
					validation_issues: []
				})
			}
		);

		const response = await POST(event('http://127.0.0.1/api/creator/mission/validate', {
			missionId: 'mission-creator-validate-vnext',
			executionAuthority: validationVNextAuthority('mission-creator-validate-vnext')
		}) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
		expect(validationCommandCalls).toBe(0);
		const trace = await readCreatorMissionTrace({ missionId: 'mission-creator-validate-vnext' }, tempDir);
		expect(trace?.validation_runs).toHaveLength(0);
	});
});
