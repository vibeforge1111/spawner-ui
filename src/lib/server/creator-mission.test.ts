import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createCreatorMission,
	creatorMissionPath,
	defaultBuilderRepo,
	executeCreatorMission,
	readCreatorMissionTrace,
	runCreatorArtifactBundle,
	runCreatorPlan,
	setCreatorManifestRunnerForTests,
	setCreatorValidationCommandRunnerForTests,
	validateCreatorMission,
	type CreatorArtifactBundle,
	type CreatorArtifactManifest,
	type CreatorArtifactType,
	type CreatorIntentPacket
} from './creator-mission';
import { buildServerGovernorDecisionAuthority } from './harness-authority';

let tempDirs: string[] = [];

function packet(overrides: Partial<CreatorIntentPacket> = {}): CreatorIntentPacket {
	return {
		schema_version: 'spark-creator-intent.v1',
		user_goal: 'Create a Startup YC specialization path with benchmarked autoloop from Telegram and Spark Swarm',
		target_domain: 'startup-yc',
		target_operator_surface: 'telegram+builder+swarm',
		expected_agent_capability: 'Improve Spark startup-yc capability.',
		success_examples: ['Benchmark improves on held-out Startup YC cases.'],
		failure_examples: ['Score improves only through formatting.'],
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
		intent_id: 'creator-intent-startup-yc-test',
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
		network_contribution_policy: 'github_pr_required',
		...overrides
	};
}

function manifest(artifactType: CreatorArtifactType, repo: string): CreatorArtifactManifest {
	return {
		schema_version: 'spark-artifact-manifest.v1' as const,
		artifact_id: `startup-yc-${artifactType.replace(/_/g, '-')}-v1`,
		artifact_type: artifactType,
		repo,
		inputs: ['creator-intent-startup-yc-test'],
		outputs: [`${artifactType}.json`],
		validation_commands: ['python -m pytest tests'],
		promotion_gates: ['schema_gate', 'rollback_gate'],
		rollback_plan: `Revert ${artifactType}.`
	};
}

function bundle(overrides: Partial<CreatorIntentPacket> = {}): CreatorArtifactBundle {
	return {
		intent_packet: packet(overrides),
		artifact_manifests: [
			manifest('domain_chip', 'domain-chip-startup-yc'),
			manifest('benchmark_pack', 'startup-bench')
		],
		validation_issues: []
	};
}

function fullPathBundle(repo: string): CreatorArtifactBundle {
	return {
		intent_packet: packet(),
		artifact_manifests: [
			manifest('domain_chip', repo),
			manifest('benchmark_pack', repo),
			manifest('specialization_path', repo),
			manifest('autoloop_policy', repo),
			manifest('tool_integration', repo),
			manifest('swarm_publish_packet', repo)
		],
		validation_issues: []
	};
}

function validationGovernorAuthority(target: string) {
	return buildServerGovernorDecisionAuthority({
		source: 'creator-mission-validation-test',
		reason: 'Creator mission validation test authorizes manifest validation commands.',
		toolName: 'spawner.creator.validate',
		mutationClass: 'writes_files',
		requestId: `validate:${target}`,
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test',
		target
	});
}

function dispatchGovernorAuthority(target: string, requestId = target) {
	return buildServerGovernorDecisionAuthority({
		source: 'creator-mission-dispatch-test',
		reason: 'Creator mission execution test authorizes Spawner dispatch.',
		toolName: 'spawner.dispatch',
		mutationClass: 'launches_mission',
		requestId,
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test',
		target
	});
}

async function tempStateDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'spawner-creator-mission-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	const { setCreatorDispatchRunnerForTests } = await import('./creator-mission');
	setCreatorManifestRunnerForTests(null);
	setCreatorValidationCommandRunnerForTests(null);
	setCreatorDispatchRunnerForTests(null);
	for (const dir of tempDirs) {
		await rm(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

describe('creator mission trace', () => {
	it('creates a persisted full-path trace from a creator intent packet', async () => {
		const stateDir = await tempStateDir();
		const trace = await createCreatorMission(
			{
				brief: 'Create a Startup YC specialization path with benchmarked autoloop from Telegram and Spark Swarm',
				missionId: 'mission-creator-test',
				requestId: 'creator-request-test',
				baseUrl: 'http://127.0.0.1:4174'
			},
			{
				stateDir,
				now: () => new Date('2026-04-30T10:00:00.000Z'),
				runManifestPlanner: async () => bundle()
			}
		);

		expect(trace).toMatchObject({
			schema_version: 'spark-creator-trace.v1',
			trace_id: 'creator-trace-mission-creator-test',
			intent_id: 'creator-intent-startup-yc-test',
			mission_id: 'mission-creator-test',
			request_id: 'creator-request-test',
			creator_mode: 'full_path',
			current_stage: 'task_graph_created',
			stage_status: 'queued',
			artifacts: ['domain_chip', 'benchmark_pack', 'specialization_path', 'autoloop_policy', 'tool_integration', 'swarm_publish_packet'],
			artifact_manifests: [
				expect.objectContaining({
					artifact_id: 'startup-yc-domain-chip-v1',
					artifact_type: 'domain_chip',
					repo: 'domain-chip-startup-yc'
				}),
				expect.objectContaining({
					artifact_id: 'startup-yc-benchmark-pack-v1',
					artifact_type: 'benchmark_pack',
					repo: 'startup-bench'
				})
			],
			artifact_manifest_validation_issues: [],
			repo_changes: [],
			benchmarks: [],
			publish_readiness: 'private_draft',
			swarm: { payload_ready: false, api_ready: false, publish_mode: 'swarm_shared' }
		});
		expect(trace.tasks.map((task) => task.id)).toEqual([
			'creator-intent-plan',
			'domain-chip-contract',
			'benchmark-pack',
			'specialization-path',
			'autoloop-policy',
			'telegram-spawner-flow',
			'creator-validation',
			'swarm-publish-packet'
		]);
		expect(trace.validation_gates.map((gate) => gate.id)).toContain('publish_review_gate');
		expect(trace.specialization_entry.required_artifacts).toEqual([
			'domain_chip',
			'benchmark_pack',
			'specialization_path',
			'autoloop_policy',
			'tool_integration',
			'swarm_publish_packet'
		]);
		expect(trace.specialization_entry.agent_entrypoint).toContain('benchmark to prove better tool use, reasoning, and decisions');
		expect(trace.specialization_entry.evaluation_loop.held_out).toContain('not used as mutation prompts');
		expect(trace.improvement_evidence).toMatchObject({
			status: 'missing',
			held_out_required: true,
			held_out_pass: false
		});
		expect(trace.links.canvas).toBe('http://127.0.0.1:4174/canvas?pipeline=creator-creator-request-test&mission=mission-creator-test');
		expect(trace.links.kanban).toBe('http://127.0.0.1:4174/kanban?mission=mission-creator-test');

		const saved = JSON.parse(await readFile(creatorMissionPath('mission-creator-test', stateDir), 'utf-8'));
		expect(saved.intent_packet.target_domain).toBe('startup-yc');
		expect(saved.artifact_manifests.map((manifest: { artifact_id: string }) => manifest.artifact_id)).toContain('startup-yc-domain-chip-v1');
		expect(saved.tasks).toHaveLength(8);
		expect(saved.specialization_entry.telegram_command).toContain('--surface telegram');
		expect(saved.improvement_evidence.status).toBe('missing');

		const queuedCanvas = JSON.parse(await readFile(path.join(stateDir, 'pending-load.json'), 'utf-8'));
		expect(queuedCanvas).toMatchObject({
			requestId: 'creator-request-test',
			missionId: 'mission-creator-test',
			pipelineId: 'creator-creator-request-test',
			source: 'creator-mission',
			autoRun: false,
			buildMode: 'advanced_prd'
		});
		expect(queuedCanvas.nodes).toHaveLength(8);
		expect(queuedCanvas.connections.length).toBeGreaterThan(0);
		expect((await readdir(stateDir)).filter((file) => file.includes('.tmp'))).toEqual([]);
	});

	it('records full-path specialization improvement evidence without publishing to Swarm', async () => {
		const stateDir = await tempStateDir();
		await createCreatorMission(
			{
				brief: 'Create a Startup YC specialization path with benchmarked autoloop from Telegram and Spark Swarm',
				missionId: 'mission-creator-golden-path',
				requestId: 'req-golden-path',
				privacyMode: 'swarm_shared'
			},
			{
				stateDir,
				runManifestPlanner: async () => fullPathBundle(stateDir)
			}
		);

		setCreatorValidationCommandRunnerForTests(async (_executable, _args, options) => {
			await mkdir(path.join(options.cwd, 'reports'), { recursive: true });
			await writeFile(
				path.join(options.cwd, 'validation-ledger.json'),
				JSON.stringify({
					benchmark_evidence: {
						baseline_score: 0.42,
						candidate_score: 0.73,
						delta: 0.31,
						held_out_verdict: 'pass',
						benchmark_refs: ['benchmarks/startup-yc.visible.json', 'benchmarks/startup-yc.held-out.json'],
						reasoning_delta: 'Candidate correctly rejects formatting-only gains.',
						tool_usage_delta: 'Candidate uses the benchmark runner before autoloop keep decisions.',
						ability_delta: 'Agent chooses stronger Startup YC triage actions on held-out cases.'
					}
				}),
				'utf-8'
			);
			await writeFile(
				path.join(options.cwd, 'reports', 'creator-mission-status.json'),
				JSON.stringify({
					schema_version: 'adaptive_creator_loop.creator_mission_status.v1',
					mission_id: 'mission-creator-golden-path',
					read_only: true,
					claim_boundary: 'read-only product adapter over canonical creator-system outputs',
					canonical: {
						verdict: 'ready_for_swarm_packet',
						stage_status: 'review_required',
						evidence_tier: 'transfer_supported',
						evidence_mode: 'recomputed',
						automation_blocked: false,
						blocking_checks: [],
						warning_checks: [],
						missing_paths: [],
						recommended_next_command: 'review the local contribution packet'
					},
					publication: {
						publish_mode: 'swarm_shared',
						local_display_allowed: true,
						github_pr_allowed: false,
						swarm_shared_allowed: false,
						network_absorbable: false,
						requested_network_absorption: true,
						blocked_reason: 'Network absorption still needs review.',
						required_gates: ['human_operator_review', 'publication_approval'],
						missing_gates: ['publication_approval'],
						gate_status: { human_operator_review: true, publication_approval: false },
						unsafe_claim_blocked: true
					},
					source_packets: [],
					blockers: [{ source: 'publication_gate', message: 'Network absorption is not approved.' }],
					warnings: [],
					next_actions: ['Keep this local until the publication gate is approved.'],
					surface_adapters: {
						telegram: { text: 'Startup YC creator path is review-ready locally.', may_request_secret_paste: false },
						builder: {},
						spawner: {},
						canvas: {},
						kanban: {}
					}
				}),
				'utf-8'
			);
			return { exitCode: 0, stdout: 'ok', stderr: '' };
		});

		const result = await validateCreatorMission(
			{ missionId: 'mission-creator-golden-path' },
			{
				stateDir,
				now: () => new Date('2026-04-30T13:00:00.000Z'),
				executionAuthority: validationGovernorAuthority('mission-creator-golden-path')
			}
		);

		expect(result.run.status).toBe('passed');
		expect(result.trace.stage_status).toBe('validated');
		expect(result.trace.validation_runs).toHaveLength(1);
		expect(result.trace.tasks.map((task) => task.id)).toEqual([
			'creator-intent-plan',
			'domain-chip-contract',
			'benchmark-pack',
			'specialization-path',
			'autoloop-policy',
			'telegram-spawner-flow',
			'creator-validation',
			'swarm-publish-packet'
		]);
		expect(result.trace.validation_gates.map((gate) => gate.id)).toEqual([
			'schema_gate',
			'lineage_gate',
			'benchmark_gate',
			'benchmark_proof_gate',
			'complexity_gate',
			'memory_hygiene_gate',
			'transfer_gate',
			'publish_review_gate'
		]);
		expect(result.trace.specialization_entry).toMatchObject({
			telegram_command: '/creator plan --domain startup-yc --surface telegram --benchmark held-out',
			required_artifacts: ['domain_chip', 'benchmark_pack', 'specialization_path', 'autoloop_policy', 'tool_integration', 'swarm_publish_packet']
		});
		expect(result.trace.specialization_entry.evaluation_loop.keep_rule).toContain('held-out passes');
		expect(result.trace.benchmark_summary).toEqual({
			baseline_score: 0.42,
			candidate_score: 0.73,
			delta: 0.31,
			held_out_pass: true
		});
		expect(result.trace.improvement_evidence).toMatchObject({
			status: 'recorded',
			baseline_score: 0.42,
			candidate_score: 0.73,
			delta: 0.31,
			held_out_required: true,
			held_out_pass: true,
			validation_run_id: result.run.run_id,
			benchmark_refs: ['benchmarks/startup-yc.visible.json', 'benchmarks/startup-yc.held-out.json']
		});
		expect(result.trace.improvement_evidence.notes.join('\n')).toContain('benchmark runner before autoloop keep decisions');
		expect(result.trace.benchmarks).toEqual(['benchmarks/startup-yc.visible.json', 'benchmarks/startup-yc.held-out.json']);
		expect(result.trace.canonical).toMatchObject({
			verdict: 'ready_for_swarm_packet',
			stage_status: 'review_required',
			evidence_tier: 'transfer_supported',
			evidence_mode: 'recomputed'
		});
		expect(result.trace.publication).toMatchObject({
			publish_mode: 'swarm_shared',
			swarm_shared_allowed: false,
			network_absorbable: false,
			missing_gates: ['publication_approval']
		});
		expect(result.trace.creator_mission_status?.schema_version).toBe('adaptive_creator_loop.creator_mission_status.v1');
		expect(result.trace.blockers.join('\n')).toContain('publication_gate: Network absorption is not approved.');
		expect(result.trace.publish_readiness).toBe('workspace_validated');
		expect(result.trace.stage_status).not.toBe('published');
		expect(result.trace.swarm).toMatchObject({
			payload_ready: false,
			api_ready: false,
			publish_mode: 'swarm_shared'
		});
		const saved = JSON.parse(await readFile(creatorMissionPath('mission-creator-golden-path', stateDir), 'utf-8'));
		expect(saved.improvement_evidence.status).toBe('recorded');
		expect(saved.swarm.payload_ready).toBe(false);
	});

	it('can look up a trace by request id', async () => {
		const stateDir = await tempStateDir();
		await createCreatorMission(
			{ brief: 'Make Spark good at investor diligence', missionId: 'mission-creator-lookup', requestId: 'req-lookup' },
			{ stateDir, runManifestPlanner: async () => bundle({ target_domain: 'investor-diligence' }) }
		);

		const trace = await readCreatorMissionTrace({ requestId: 'req-lookup' }, stateDir);
		expect(trace?.mission_id).toBe('mission-creator-lookup');
		expect(trace?.intent_packet.target_domain).toBe('investor-diligence');
	});

	it('returns null when the requested mission trace file is malformed JSON', async () => {
		const stateDir = await tempStateDir();
		const traceDir = path.join(stateDir, 'creator-missions');
		await mkdir(traceDir, { recursive: true });
		await writeFile(
			path.join(traceDir, 'mission-creator-malformed.json'),
			'{"schema_version":"spark-creator-trace.v1",',
			'utf-8'
		);

		const trace = await readCreatorMissionTrace({ missionId: 'mission-creator-malformed' }, stateDir);
		expect(trace).toBeNull();
	});

	it('skips malformed trace files when scanning the directory for a request id', async () => {
		const stateDir = await tempStateDir();
		await createCreatorMission(
			{ brief: 'Mixed dir', missionId: 'mission-creator-good', requestId: 'req-good' },
			{ stateDir, runManifestPlanner: async () => bundle({ target_domain: 'good' }) }
		);
		const traceDir = path.join(stateDir, 'creator-missions');
		await writeFile(path.join(traceDir, 'mission-corrupt.json'), '{"request_id":"req-good"', 'utf-8');

		const trace = await readCreatorMissionTrace({ requestId: 'req-good' }, stateDir);
		expect(trace?.mission_id).toBe('mission-creator-good');
	});

	it('executes a persisted creator mission with an auto-run canvas load', async () => {
		const stateDir = await tempStateDir();
		await createCreatorMission(
			{
				brief: 'Create Startup YC path',
				missionId: 'mission-creator-execute',
				requestId: 'req-execute'
			},
			{
				stateDir,
				runManifestPlanner: async () => bundle({ target_domain: 'startup-yc' })
			}
		);

		let capturedLoad: any = null;
		const result = await executeCreatorMission(
			{ missionId: 'mission-creator-execute' },
			{
				stateDir,
				now: () => new Date('2026-04-30T11:00:00.000Z'),
				executionAuthority: dispatchGovernorAuthority('mission-creator-execute', 'req-execute'),
				dispatchRunner: async (load) => {
					capturedLoad = load;
					return {
						started: true,
						missionId: load.missionId,
						projectPath: 'C:\\Users\\USER\\Desktop',
						providerId: 'codex'
					};
				}
			}
		);

		expect(result.dispatch.started).toBe(true);
		expect(capturedLoad.autoRun).toBe(true);
		expect(capturedLoad.relay.autoRun).toBe(true);
		expect(capturedLoad.executionPrompt).toContain('Target operating-system folder:');
		expect(capturedLoad.executionPrompt).toContain('Artifact manifests: domain_chip:domain-chip-startup-yc');
		expect(result.trace.current_stage).toBe('execution_started');
		expect(result.trace.stage_status).toBe('running');

		const saved = JSON.parse(await readFile(creatorMissionPath('mission-creator-execute', stateDir), 'utf-8'));
		expect(saved.current_stage).toBe('execution_started');
		expect(saved.updated_at).toBe('2026-04-30T11:00:00.000Z');

		const queuedCanvas = JSON.parse(await readFile(path.join(stateDir, 'last-canvas-load.json'), 'utf-8'));
		expect(queuedCanvas.autoRun).toBe(true);
		expect(queuedCanvas.relay.autoRun).toBe(true);
		expect(queuedCanvas.executionAuthority).toBeUndefined();
		expect(queuedCanvas.relay.executionAuthority).toBeUndefined();
	});

	it('requires native Governor dispatch authority before direct creator execution writes an executable load', async () => {
		const stateDir = await tempStateDir();
		await createCreatorMission(
			{
				brief: 'Create Startup YC path',
				missionId: 'mission-creator-execute-no-authority',
				requestId: 'req-execute-no-authority'
			},
			{
				stateDir,
				runManifestPlanner: async () => bundle({ target_domain: 'startup-yc' })
			}
		);

		await expect(executeCreatorMission(
			{ missionId: 'mission-creator-execute-no-authority' },
			{ stateDir, dispatchRunner: async () => ({ started: true, missionId: 'mission-creator-execute-no-authority' }) }
		)).rejects.toThrow('Execution requires Harness Core authority.');
	});

	it('does not infer read-only creator execution from no-run prose', async () => {
		const stateDir = await tempStateDir();
		await createCreatorMission(
			{
				brief: 'Create Startup YC specialization path, but stage only. Do not run.',
				missionId: 'mission-creator-prose-only',
				requestId: 'req-prose-only'
			},
			{
				stateDir,
				runManifestPlanner: async () => bundle({ target_domain: 'startup-yc' })
			}
		);

		const trace = await readCreatorMissionTrace({ missionId: 'mission-creator-prose-only' }, stateDir);
		expect(trace?.execution_policy).toBe('manual_run');
	});

	it('blocks execution for explicitly read-only creator missions', async () => {
		const stateDir = await tempStateDir();
		await createCreatorMission(
			{
				brief: 'Create Startup YC specialization path, but stage only. Do not run.',
				missionId: 'mission-creator-stage-only',
				requestId: 'req-stage-only',
				executionPolicy: 'read_only'
			},
			{
				stateDir,
				runManifestPlanner: async () => bundle({ target_domain: 'startup-yc' })
			}
		);

		const trace = await readCreatorMissionTrace({ missionId: 'mission-creator-stage-only' }, stateDir);
		expect(trace?.execution_policy).toBe('read_only');
		await expect(executeCreatorMission({ missionId: 'mission-creator-stage-only' }, { stateDir })).rejects.toThrow(
			/read-only\/stage-only/
		);
	});

	it('can use Builder creator manifests as the planning source', async () => {
		const stateDir = await tempStateDir();
		setCreatorManifestRunnerForTests(async () => ({
			intent_packet: packet({ target_domain: 'startup-yc' }),
			artifact_manifests: [
				{
					schema_version: 'spark-artifact-manifest.v1',
					artifact_id: 'startup-yc-specialization-path-v1',
					artifact_type: 'specialization_path',
					repo: 'specialization-path-startup-yc',
					inputs: ['creator-intent-startup-yc-test'],
					outputs: ['specialization-path.json'],
					validation_commands: ['python -m pytest tests'],
					promotion_gates: ['schema_gate', 'rollback_gate'],
					rollback_plan: 'Revert the specialization path commit.'
				}
			],
			validation_issues: []
		}));

		const trace = await createCreatorMission(
			{
				brief: 'Create Startup YC path',
				missionId: 'mission-creator-manifests',
				requestId: 'req-manifests'
			},
			{ stateDir }
		);

		expect(trace.artifact_manifests).toHaveLength(1);
		expect(trace.artifact_manifests[0].repo).toBe('specialization-path-startup-yc');
	});

	it('runs allowlisted manifest validation commands and updates the trace', async () => {
		const stateDir = await tempStateDir();
		setCreatorValidationCommandRunnerForTests(async (executable, args, options) => ({
			exitCode: executable === 'python' && args[0] === '--version' && options.cwd === stateDir ? 0 : 1,
			stdout: 'Python 3.13.5',
			stderr: ''
		}));
		await createCreatorMission(
			{
				brief: 'Create Startup YC path',
				missionId: 'mission-creator-validate',
				requestId: 'req-validate'
			},
			{
				stateDir,
				runManifestPlanner: async () => ({
					intent_packet: packet({ target_domain: 'startup-yc' }),
					artifact_manifests: [
						{
							schema_version: 'spark-artifact-manifest.v1',
							artifact_id: 'startup-yc-validation-v1',
							artifact_type: 'creator_report',
							repo: stateDir,
							inputs: ['creator-intent-startup-yc-test'],
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

		const result = await validateCreatorMission(
			{ missionId: 'mission-creator-validate' },
			{
				stateDir,
				now: () => new Date('2026-04-30T12:00:00.000Z'),
				executionAuthority: validationGovernorAuthority('mission-creator-validate')
			}
		);

		expect(result.run.status).toBe('passed');
		expect(result.run.results[0]).toMatchObject({
			status: 'passed',
			command: 'python --version',
			stdout_tail: 'Python 3.13.5'
		});
		expect(result.trace.stage_status).toBe('blocked');
		expect(result.trace.publish_readiness).toBe('private_draft');
		expect(result.trace.blockers.join('\n')).toContain('Fresh benchmark runner evidence is required');
		const saved = JSON.parse(await readFile(creatorMissionPath('mission-creator-validate', stateDir), 'utf-8'));
		expect(saved.validation_runs).toHaveLength(1);
	});

	it('requires native Governor authority before direct manifest validation commands run', async () => {
		const stateDir = await tempStateDir();
		let commandCalls = 0;
		setCreatorValidationCommandRunnerForTests(async () => {
			commandCalls += 1;
			return { exitCode: 0, stdout: 'ok', stderr: '' };
		});
		await createCreatorMission(
			{
				brief: 'Create Startup YC path',
				missionId: 'mission-creator-validate-no-authority',
				requestId: 'req-validate-no-authority'
			},
			{
				stateDir,
				runManifestPlanner: async () => ({
					intent_packet: packet({ target_domain: 'startup-yc' }),
					artifact_manifests: [
						{
							schema_version: 'spark-artifact-manifest.v1',
							artifact_id: 'startup-yc-validation-v1',
							artifact_type: 'creator_report',
							repo: stateDir,
							inputs: ['creator-intent-startup-yc-test'],
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

		await expect(validateCreatorMission(
			{ missionId: 'mission-creator-validate-no-authority' },
			{ stateDir }
		)).rejects.toThrow('Execution requires Harness Core authority.');
		expect(commandCalls).toBe(0);
		const saved = JSON.parse(await readFile(creatorMissionPath('mission-creator-validate-no-authority', stateDir), 'utf-8'));
		expect(saved.validation_runs).toHaveLength(0);
	});

	it('reports per-command validation progress', async () => {
		const stateDir = await tempStateDir();
		const progressEvents: Array<{ phase: string; index: number; total: number; command: string; status?: string }> = [];
		await createCreatorMission(
			{
				brief: 'Create Startup YC path',
				missionId: 'mission-creator-validate-progress',
				requestId: 'req-validate-progress'
			},
			{
				stateDir,
				runManifestPlanner: async () => ({
					intent_packet: packet({ target_domain: 'startup-yc' }),
					artifact_manifests: [
						{
							schema_version: 'spark-artifact-manifest.v1',
							artifact_id: 'startup-yc-validation-progress-v1',
							artifact_type: 'creator_report',
							repo: stateDir,
							inputs: ['creator-intent-startup-yc-test'],
							outputs: ['reports/creator-run-summary.json'],
							validation_commands: ['python --version', 'python -m pytest tests'],
							promotion_gates: ['schema_gate', 'rollback_gate'],
							rollback_plan: 'Delete generated reports.'
						}
					],
					validation_issues: []
				})
			}
		);

		const result = await validateCreatorMission(
			{ missionId: 'mission-creator-validate-progress' },
			{
				stateDir,
				executionAuthority: validationGovernorAuthority('mission-creator-validate-progress'),
				commandRunner: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
				onCommandProgress: (event) => {
					progressEvents.push({
						phase: event.phase,
						index: event.index,
						total: event.total,
						command: event.command,
						status: event.result?.status
					});
				}
			}
		);

		expect(result.run.status).toBe('passed');
		expect(progressEvents).toEqual([
			{ phase: 'started', index: 1, total: 2, command: 'python --version', status: undefined },
			{ phase: 'completed', index: 1, total: 2, command: 'python --version', status: 'passed' },
			{ phase: 'started', index: 2, total: 2, command: 'python -m pytest tests', status: undefined },
			{ phase: 'completed', index: 2, total: 2, command: 'python -m pytest tests', status: 'passed' }
		]);
	});

	it('runs npm manifest validation commands through the platform executable', async () => {
		const stateDir = await tempStateDir();
		await createCreatorMission(
			{
				brief: 'Create Startup YC path',
				missionId: 'mission-creator-validate-npm',
				requestId: 'req-validate-npm'
			},
			{
				stateDir,
				runManifestPlanner: async () => ({
					intent_packet: packet({ target_domain: 'startup-yc' }),
					artifact_manifests: [
						{
							schema_version: 'spark-artifact-manifest.v1',
							artifact_id: 'startup-yc-node-validation-v1',
							artifact_type: 'tool_integration',
							repo: stateDir,
							inputs: ['creator-intent-startup-yc-test'],
							outputs: ['package.json'],
							validation_commands: ['npm --version'],
							promotion_gates: ['schema_gate', 'rollback_gate'],
							rollback_plan: 'No generated files to remove.'
						}
					],
					validation_issues: []
				})
			}
		);

		const result = await validateCreatorMission(
			{ missionId: 'mission-creator-validate-npm' },
			{
				stateDir,
				timeoutMs: 30_000,
				executionAuthority: validationGovernorAuthority('mission-creator-validate-npm')
			}
		);

		expect(result.run.status).toBe('passed');
		expect(result.run.results[0]).toMatchObject({
			status: 'passed',
			command: 'npm --version'
		});
		expect(result.run.results[0].stdout_tail.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});

	it('prefers attached local creator artifact validation commands over planned repos', async () => {
		const stateDir = await tempStateDir();
		const missionId = 'mission-creator-local-artifact-bundle';
		const artifactRoot = path.join(stateDir, 'creator-artifacts', 'spark-qa-operator-benchmark');
		await mkdir(artifactRoot, { recursive: true });
		await writeFile(
			path.join(artifactRoot, 'artifact_manifest.json'),
			JSON.stringify({
				schema_version: 'spark-artifact-manifest.v1',
				mission_id: missionId,
				artifact_set_id: 'spark-qa-operator-benchmark-factory-v1',
				artifacts: [
					{ artifact_id: 'spark-qa-operator-benchmark-pack-v1', path: 'benchmark_pack.json' }
				],
				validation_commands: [
					'node scripts/validate-spark-qa-benchmark-creator.mjs creator-artifacts/spark-qa-operator-benchmark',
					'npm run check'
				],
				promotion_gates: ['schema_gate', 'privacy_gate'],
				rollback_plan: 'Remove local artifact bundle.'
			}),
			'utf-8'
		);
		await writeFile(
			path.join(artifactRoot, 'validation-ledger.json'),
			JSON.stringify({
				status: 'staged_not_scored',
				benchmark_evidence: { baseline_score: null, candidate_score: null, delta: null },
				held_out_verdict: 'blocked',
				benchmark_refs: ['benchmark_creator_prd.json', 'benchmark_pack.json'],
				gate_results: {
					heldout_gate: 'blocked_until_fresh_run',
					promotion_gate: 'blocked_until_scored_evidence'
				},
				missing_evidence_count: 4,
				notes: ['No benchmark score has been produced or claimed.']
			}),
			'utf-8'
		);
		await writeFile(
			path.join(artifactRoot, 'creator-mission-status.json'),
			JSON.stringify({
				schema_version: 'spark-creator-mission-status.v1',
				mission_id: missionId,
				verdict: 'staged_not_scored',
				stage_status: 'staged',
				evidence_tier: 'tier_1_packet_shape',
				evidence_mode: 'local_only',
				automation_blocked: true,
				blocking_checks: ['fresh_benchmark_runner_artifact_missing'],
				publication: {
					publish_mode: 'local_only',
					local_display_allowed: true,
					github_pr_allowed: false,
					swarm_shared_allowed: false,
					network_absorbable: false,
					unsafe_claim_blocked: true
				}
			}),
			'utf-8'
		);
		await createCreatorMission(
			{
				brief: 'Create level 10 benchmarks for Spark QA Operator',
				missionId,
				requestId: 'req-local-artifact-bundle'
			},
			{
				stateDir,
				runManifestPlanner: async () => ({
					intent_packet: packet({ target_domain: 'spark-qa-operator' }),
					artifact_manifests: [
						{
							schema_version: 'spark-artifact-manifest.v1',
							artifact_id: 'spark-qa-operator-domain-chip-v1',
							artifact_type: 'domain_chip',
							repo: 'missing-spark-qa-operator-domain-chip',
							inputs: ['creator-intent-spark-qa-operator'],
							outputs: ['spark-chip.json'],
							validation_commands: ['python -m pytest tests'],
							promotion_gates: ['schema_gate'],
							rollback_plan: 'No files should be touched.'
						}
					],
					validation_issues: []
				})
			}
		);

		const commands: string[] = [];
		const result = await validateCreatorMission(
			{ missionId },
			{
				stateDir,
				executionAuthority: validationGovernorAuthority(missionId),
				commandRunner: async (executable, args, options) => {
					commands.push([executable, ...args].join(' '));
					expect(options.cwd).toBe(process.cwd());
					return { exitCode: 0, stdout: 'ok', stderr: '' };
				}
			}
		);

		expect(result.run.status).toBe('passed');
		expect(result.run.results).toHaveLength(2);
		expect(commands).toEqual([
			'node scripts/validate-spark-qa-benchmark-creator.mjs creator-artifacts/spark-qa-operator-benchmark',
			'npm run check'
		]);
		expect(result.run.results.map((item) => item.error || '')).not.toContain('Repository path not found');
		expect(result.trace.stage_status).toBe('blocked');
		expect(result.trace.publish_readiness).toBe('private_draft');
		expect(result.trace.improvement_evidence).toMatchObject({
			status: 'missing',
			baseline_score: null,
			candidate_score: null,
			delta: null,
			held_out_pass: false,
			benchmark_refs: ['benchmark_creator_prd.json', 'benchmark_pack.json']
		});
		expect(result.trace.creator_mission_status?.schema_version).toBe('spark-creator-mission-status.v1');
		expect(result.trace.canonical).toMatchObject({
			verdict: 'staged_not_scored',
			automation_blocked: true,
			blocking_checks: ['fresh_benchmark_runner_artifact_missing']
		});
		expect(result.trace.blockers.join('\n')).toContain('promotion_gate: blocked_until_scored_evidence');
		expect(result.trace.blockers.join('\n')).toContain('Fresh benchmark runner evidence is required');
	});
});

describe('defaultBuilderRepo', () => {
	it('honors explicit SPARK_BUILDER_REPO even when other candidates exist', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'spark-spawner-builderrepo-'));
		tempDirs.push(root);
		const explicit = path.join(root, 'explicit-builder');
		await mkdir(explicit, { recursive: true });
		const resolved = defaultBuilderRepo({ SPARK_BUILDER_REPO: explicit });
		expect(resolved).toBe(path.resolve(explicit));
	});

	it('prefers the installed layout path when its marker file exists', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'spark-spawner-builderrepo-'));
		tempDirs.push(root);
		const installed = path.join(root, 'home', '.spark', 'modules', 'spark-intelligence-builder', 'source');
		await mkdir(path.join(installed, 'src', 'spark_intelligence'), { recursive: true });
		await writeFile(path.join(installed, 'src', 'spark_intelligence', 'cli.py'), '# marker\n');
		const resolved = defaultBuilderRepo(
			{},
			{ homedir: () => path.join(root, 'home'), cwd: path.join(root, 'dev', 'spawner-ui') }
		);
		expect(resolved).toBe(path.resolve(installed));
	});

	it('falls back to the dev-checkout path when the installed layout is missing', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'spark-spawner-builderrepo-'));
		tempDirs.push(root);
		const devCheckout = path.join(root, 'dev', 'spark-intelligence-builder');
		await mkdir(path.join(devCheckout, 'src', 'spark_intelligence'), { recursive: true });
		await writeFile(path.join(devCheckout, 'src', 'spark_intelligence', 'cli.py'), '# marker\n');
		const resolved = defaultBuilderRepo(
			{},
			{ homedir: () => path.join(root, 'home', 'no-spark-here'), cwd: path.join(root, 'dev', 'spawner-ui') }
		);
		expect(resolved).toBe(path.resolve(devCheckout));
	});

	it('returns the installed-layout path as a hint when nothing valid is found', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'spark-spawner-builderrepo-'));
		tempDirs.push(root);
		const resolved = defaultBuilderRepo(
			{},
			{ homedir: () => path.join(root, 'home'), cwd: path.join(root, 'dev', 'spawner-ui') }
		);
		const expected = path.join(root, 'home', '.spark', 'modules', 'spark-intelligence-builder', 'source');
		expect(resolved).toBe(path.resolve(expected));
	});
});

describe('runCreatorPlan builder repo resolution', () => {
	it('surfaces an actionable error when no valid builder repo exists', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'spark-spawner-builderrepo-'));
		tempDirs.push(root);
		await expect(
			runCreatorPlan(
				{
					brief: 'Create a Startup YC specialization path',
					missionId: 'mission-creator-no-builder',
					requestId: 'req-no-builder'
				},
				{
					envRecord: {},
					cwd: path.join(root, 'dev', 'spawner-ui'),
					homedir: () => path.join(root, 'home', 'no-spark-here')
				}
			)
		).rejects.toThrow(/Builder repo not found: .*spark-intelligence-builder.*spark setup/);
	});

	it('surfaces an actionable error when the builder dir exists but the marker file is missing', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'spark-spawner-builderrepo-'));
		tempDirs.push(root);
		const devCheckout = path.join(root, 'dev', 'spark-intelligence-builder');
		await mkdir(devCheckout, { recursive: true });
		await expect(
			runCreatorArtifactBundle(
				{
					brief: 'Create a Startup YC specialization path',
					missionId: 'mission-creator-empty-builder',
					requestId: 'req-empty-builder'
				},
				{
					envRecord: {},
					cwd: path.join(root, 'dev', 'spawner-ui'),
					homedir: () => path.join(root, 'home', 'no-spark-here')
				}
			)
		).rejects.toThrow(/spark setup/);
	});
});
