import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, realpathSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { POST, _runAutoAnalysisWatchdog } from './+server';
import {
	buildClientGovernorDecisionAuthority,
	buildClientTurnIntentVNextAuthority
} from '$lib/services/harness-authority-client';

const { PRIVATE_ENV, executeProviderTaskMock } = vi.hoisted(() => ({
	PRIVATE_ENV: {
		SPARK_BRIDGE_API_KEY: 'bridge-test-key',
		MCP_API_KEY: ''
	} as Record<string, string>,
	executeProviderTaskMock: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: PRIVATE_ENV }));
vi.mock('$lib/server/cli-resolver', () => ({ resolveCliBinary: () => 'codex' }));
vi.mock('$lib/services/spark-agent-bridge', () => ({
	sparkAgentBridge: {
		executeProviderTask: executeProviderTaskMock
	}
}));

let testSpawnerDir: string;
const originalProvider = process.env.SPARK_MISSION_LLM_PROVIDER;
const originalAutoProvider = process.env.SPAWNER_PRD_AUTO_PROVIDER;
const originalStateDir = process.env.SPAWNER_STATE_DIR;
const originalWorkspaceRoot = process.env.SPARK_WORKSPACE_ROOT;
const originalAllowExternalProjectPaths = process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
const BRIDGE_TEST_KEY = 'bridge-test-key';
const originalBridgeKey = process.env.SPARK_BRIDGE_API_KEY;

function writeAuthority(requestId: string) {
	return buildClientGovernorDecisionAuthority({
		source: 'prd-write-authority-test',
		reason: 'Focused PRD bridge write authority regression.',
		toolName: 'spawner.prd.write',
		mutationClass: 'writes_files',
		requestId,
		target: requestId
	});
}

function writeVNextAuthority(requestId: string) {
	return buildClientTurnIntentVNextAuthority({
		source: 'prd-write-authority-test',
		reason: 'Focused PRD bridge write authority regression.',
		toolName: 'spawner.prd.write',
		mutationClass: 'writes_files',
		requestId,
		target: requestId
	});
}

async function resetTestSpawnerDir() {
	if (testSpawnerDir && existsSync(testSpawnerDir)) {
		await rm(testSpawnerDir, { recursive: true, force: true });
	}
	if (originalStateDir === undefined) delete process.env.SPAWNER_STATE_DIR;
	else process.env.SPAWNER_STATE_DIR = originalStateDir;
	if (originalProvider === undefined) delete process.env.SPARK_MISSION_LLM_PROVIDER;
	else process.env.SPARK_MISSION_LLM_PROVIDER = originalProvider;
	if (originalAutoProvider === undefined) delete process.env.SPAWNER_PRD_AUTO_PROVIDER;
	else process.env.SPAWNER_PRD_AUTO_PROVIDER = originalAutoProvider;
	if (originalBridgeKey === undefined) delete process.env.SPARK_BRIDGE_API_KEY;
	else process.env.SPARK_BRIDGE_API_KEY = originalBridgeKey;
	if (originalWorkspaceRoot === undefined) delete process.env.SPARK_WORKSPACE_ROOT;
	else process.env.SPARK_WORKSPACE_ROOT = originalWorkspaceRoot;
	if (originalAllowExternalProjectPaths === undefined) delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
	else process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS = originalAllowExternalProjectPaths;
}

async function waitForPendingAutoAnalysisStatus(status: string) {
	const pendingPath = path.join(testSpawnerDir, 'pending-request.json');
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (existsSync(pendingPath)) {
			const pending = JSON.parse(await readFile(pendingPath, 'utf-8'));
			if (pending.autoAnalysis?.status === status) return pending;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return JSON.parse(await readFile(pendingPath, 'utf-8'));
}

async function waitForMissionEventTypes(missionId: string, expected: string[]) {
	const missionControlPath = path.join(testSpawnerDir, 'mission-control.json');
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (existsSync(missionControlPath)) {
			const missionControl = JSON.parse(await readFile(missionControlPath, 'utf-8'));
			const eventTypes = missionControl.recent
				.filter((entry: { missionId?: string }) => entry.missionId === missionId)
				.map((entry: { eventType: string }) => entry.eventType);
			if (expected.every((eventType) => eventTypes.includes(eventType))) return eventTypes;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	const missionControl = JSON.parse(await readFile(missionControlPath, 'utf-8'));
	return missionControl.recent
		.filter((entry: { missionId?: string }) => entry.missionId === missionId)
		.map((entry: { eventType: string }) => entry.eventType);
}

describe('/api/prd-bridge/write integration', () => {
	beforeEach(async () => {
		await resetTestSpawnerDir();
		testSpawnerDir = await mkdtemp(path.join(tmpdir(), 'spawner-prd-write-'));
		process.env.SPAWNER_STATE_DIR = testSpawnerDir;
		process.env.SPARK_BRIDGE_API_KEY = BRIDGE_TEST_KEY;
		executeProviderTaskMock.mockReset();
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		await resetTestSpawnerDir();
	});

	it('blocks control-auth-only PRD writes before durable state or provider work', async () => {
		process.env.SPARK_MISSION_LLM_PROVIDER = 'zai';
		const requestId = 'tg-build-no-prd-authority';

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_TEST_KEY },
				body: JSON.stringify({
					content: '# No Authority\n\nBuild a tiny static page.',
					requestId,
					projectName: 'No Authority',
					buildMode: 'direct'
				})
			}),
			getClientAddress: () => '127.0.0.1'
		} as never);

		const body = await response.json();
		expect(response.status).toBe(409);
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
		expect(existsSync(path.join(testSpawnerDir, 'pending-prd.md'))).toBe(false);
		expect(existsSync(path.join(testSpawnerDir, 'pending-request.json'))).toBe(false);
		expect(existsSync(path.join(testSpawnerDir, 'results', `${requestId}.json`))).toBe(false);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('accepts Spark bridge key for hosted Telegram PRD writes before Harness authority evaluation', async () => {
		process.env.SPARK_MISSION_LLM_PROVIDER = 'zai';
		const requestId = 'tg-build-hosted-bridge-key-no-authority';

		const response = await POST({
			request: new Request('https://spawner.example.com/api/prd-bridge/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_TEST_KEY },
				body: JSON.stringify({
					content: '# Hosted Bridge Key\n\nBuild a tiny static page.',
					requestId,
					projectName: 'Hosted Bridge Key',
					buildMode: 'direct'
				})
			}),
			getClientAddress: () => '203.0.113.10'
		} as never);

		const body = await response.json();
		expect(response.status).toBe(409);
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
		expect(existsSync(path.join(testSpawnerDir, 'pending-prd.md'))).toBe(false);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('blocks bare VNext authority for PRD writes', async () => {
		const requestId = 'tg-build-vnext-prd-authority';

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_TEST_KEY },
				body: JSON.stringify({
					content: '# VNext Authority\n\nBuild a tiny static page.',
					requestId,
					projectName: 'VNext Authority',
					buildMode: 'direct',
					executionAuthority: writeVNextAuthority(requestId)
				})
			}),
			getClientAddress: () => '127.0.0.1'
		} as never);

		const body = await response.json();
		expect(response.status).toBe(409);
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
		expect(existsSync(path.join(testSpawnerDir, 'pending-prd.md'))).toBe(false);
	});

	it('writes deterministic fallback analysis when hosted provider cannot start an auto worker', async () => {
		process.env.SPARK_MISSION_LLM_PROVIDER = 'zai';
		const requestId = 'tg-build-smoke-fallback-test';
		const traceRef = 'trace:spawner-prd:mission-tg-build-smoke-fallback-test';
		const capabilityProposalPacket = {
			schema_version: 'spark.capability_proposal.v1',
			status: 'proposal_plan_only',
			implementation_route: 'domain_chip',
			owner_system: 'Spark domain chip runtime',
			capability_ledger_key: 'domain_chip:cafe-memory-reporter'
		};
		const runnerCapability = {
			runnerWritable: 'no',
			runnerLabel: 'telegram-chat-runner',
			failureReason: 'read-only preflight failed',
			checkedAt: '2026-05-10T00:00:00.000Z'
		};

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_TEST_KEY },
				body: JSON.stringify({
					content: '# Cafe Landing Page\n\nBuild mode: direct\n\nBuild a tiny static landing page for a cafe with a menu section.',
					requestId,
					projectName: 'Cafe Landing Page',
					buildMode: 'direct',
					tier: 'pro',
					chatId: 'telegram-chat-1',
					userId: 'telegram-user-1',
					traceRef,
					runnerCapability,
					capabilityProposalPacket,
					executionAuthority: writeAuthority(requestId)
				})
			}),
			getClientAddress: () => '127.0.0.1'
		} as never);

		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.autoAnalysis).toMatchObject({ provider: 'zai', started: false });
		expect(body.authority).toMatchObject({ source: 'governor_decision', governorOutcome: 'execute' });
		expect(existsSync(path.join(testSpawnerDir, 'results', `${requestId}.json`))).toBe(true);
		const storedResult = JSON.parse(await readFile(path.join(testSpawnerDir, 'results', `${requestId}.json`), 'utf-8'));
		expect(storedResult.traceRef).toBe(traceRef);
		expect(storedResult.metadata.traceRef).toBe(traceRef);
		expect(storedResult.instructionTextRedacted).toBe(true);
		expect(storedResult.executionPrompt).toBeUndefined();
		const pendingMeta = JSON.parse(await readFile(path.join(testSpawnerDir, 'pending-request.json'), 'utf-8'));
		expect(pendingMeta.traceRef).toBe(traceRef);
		expect(pendingMeta.relay.traceRef).toBe(traceRef);
		expect(pendingMeta.runnerCapability).toMatchObject(runnerCapability);
		expect(pendingMeta.relay.runnerCapability).toMatchObject(runnerCapability);
		expect(pendingMeta.capabilityProposalPacket).toMatchObject(capabilityProposalPacket);
		expect(pendingMeta.capabilityProposalSummary).toMatchObject({
			schemaVersion: 'spark.capability_proposal.v1',
			status: 'proposal_plan_only',
			implementationRoute: 'domain_chip',
			ledgerKey: 'domain_chip:cafe-memory-reporter',
			ownerSystem: 'Spark domain chip runtime'
		});
	});

	it('persists rejected target path intent as evidence without project lineage authority', async () => {
		process.env.SPARK_MISSION_LLM_PROVIDER = 'zai';
		const requestId = 'tg-build-rejected-path-evidence';
		const requestedProjectPath = 'C:\\tmp\\spark-generated\\outside-root';

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_TEST_KEY },
				body: JSON.stringify({
					content: '# Outside Root App\n\nBuild a compact dashboard. The executable path was rejected before dispatch and must not be used as project lineage.',
					requestId,
					projectName: 'Outside Root App',
					buildMode: 'direct',
					tier: 'pro',
					chatId: 'telegram-chat-1',
					userId: 'telegram-user-1',
					forceDispatch: true,
					projectPathEvidence: {
						requestedProjectPath,
						usedProjectPath: null,
						evidenceOnly: true,
						rejectedReason: 'outside_configured_workspace_root'
					},
					executionAuthority: writeAuthority(requestId)
				})
			}),
			getClientAddress: () => '127.0.0.1'
		} as never);

		expect(response.status).toBe(200);
		const pendingMeta = JSON.parse(await readFile(path.join(testSpawnerDir, 'pending-request.json'), 'utf-8'));
		expect(pendingMeta.projectLineage).toBeNull();
		expect(pendingMeta.projectPathEvidence).toEqual({
			requestedProjectPath,
			usedProjectPath: null,
			evidenceOnly: true,
			rejectedReason: 'outside_configured_workspace_root'
		});
		expect(pendingMeta.relay.projectPathEvidence).toEqual(pendingMeta.projectPathEvidence);
		const traceRows = (await readFile(path.join(testSpawnerDir, 'prd-auto-trace.jsonl'), 'utf-8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(traceRows.find((row) => row.event === 'request_written')).toMatchObject({
			projectPathEvidence: {
				hasRequestedProjectPath: true,
				usedProjectPath: false,
				evidenceOnly: true,
				rejectedReason: 'outside_configured_workspace_root'
			}
		});
	});

	it('persists Codex auto-analysis watchdog state and relays timeout as mission failure', async () => {
		process.env.SPAWNER_PRD_AUTO_PROVIDER = 'codex';
		process.env.SPARK_WORKSPACE_ROOT = path.join(testSpawnerDir, 'workspaces');
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
		executeProviderTaskMock.mockReturnValue(new Promise(() => undefined));
		const requestId = 'tg-build-codex-timeout-1780929999999';
		const traceRef = 'trace:spawner-prd:mission-1780929999999';
		const expectedWorkingDirectory = path.join(
			realpathSync(testSpawnerDir),
			'workspaces',
			'prd-auto-analysis',
			requestId
		);

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_TEST_KEY },
				body: JSON.stringify({
					content: '# Codex Timeout Board\n\nBuild a local board with README and tests.',
					requestId,
					projectName: 'Codex Timeout Board',
					buildMode: 'direct',
					buildLane: 'direct',
					tier: 'pro',
					chatId: 'telegram-chat-1',
					userId: 'telegram-user-1',
					traceRef,
					executionAuthority: writeAuthority(requestId)
				})
			}),
			getClientAddress: () => '127.0.0.1'
		} as never);

		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.autoAnalysis).toMatchObject({ provider: 'codex', started: true });
		expect(executeProviderTaskMock).toHaveBeenCalledOnce();
		const providerCall = executeProviderTaskMock.mock.calls[0]?.[0] as { prompt?: string; workingDirectory?: string };
		expect(providerCall.prompt).toContain('$SparkEventsApiKey = $env:EVENTS_API_KEY');
		expect(providerCall.prompt).toContain('$env:MCP_API_KEY');
		expect(providerCall.prompt).toContain('$SparkEventsHeaders["x-api-key"] = $SparkEventsApiKey');
		expect(providerCall.prompt).toContain('Use -Headers $SparkEventsHeaders');
		expect(providerCall.prompt).toContain('Do not print, log, write, or include $SparkEventsApiKey');
		expect(providerCall.workingDirectory).toBe(expectedWorkingDirectory);
		expect(providerCall.workingDirectory).not.toContain(`${path.sep}modules${path.sep}spawner-ui${path.sep}source`);

		const pendingStarted = JSON.parse(await readFile(path.join(testSpawnerDir, 'pending-request.json'), 'utf-8'));
		expect(pendingStarted.status).toBe('pending');
		expect(pendingStarted.autoAnalysis).toMatchObject({
			provider: 'codex',
			status: 'running',
			timeoutMs: 420_000
		});
		expect(typeof pendingStarted.autoAnalysis.deadlineAt).toBe('string');
		expect(existsSync(path.join(testSpawnerDir, 'results', `${requestId}.json`))).toBe(false);

		await _runAutoAnalysisWatchdog({
			requestId,
			projectName: 'Codex Timeout Board',
			buildMode: 'direct',
			buildLane: 'direct',
			tier: 'pro',
			traceRef,
			timeoutMs: 420_000
		});

		const pendingTimedOut = JSON.parse(await readFile(path.join(testSpawnerDir, 'pending-request.json'), 'utf-8'));
		expect(pendingTimedOut.status).toBe('timeout');
		expect(pendingTimedOut.autoAnalysis).toMatchObject({
			status: 'timeout',
			timeoutMs: 420_000,
			canonicalResultAvailable: false
		});
		expect(existsSync(path.join(testSpawnerDir, 'results', `${requestId}.json`))).toBe(false);

		const traceRows = (await readFile(path.join(testSpawnerDir, 'prd-auto-trace.jsonl'), 'utf-8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(traceRows.find((row) => row.event === 'auto_worker_dispatch')).toMatchObject({
			requestId,
			traceRef,
			workingDirectory: expectedWorkingDirectory
		});
		expect(traceRows.find((row) => row.event === 'watchdog_timeout')).toMatchObject({
			requestId,
			traceRef,
			timeoutMs: 420_000
		});

		const missionControl = JSON.parse(await readFile(path.join(testSpawnerDir, 'mission-control.json'), 'utf-8'));
		const missionEvents = missionControl.recent.filter(
			(entry: { missionId?: string }) => entry.missionId === 'mission-1780929999999'
		);
		expect(missionEvents.map((entry: { eventType: string }) => entry.eventType)).toContain('task_failed');
		expect(missionEvents.map((entry: { eventType: string }) => entry.eventType)).toContain('mission_failed');
	});

	it('marks Codex auto-analysis complete when watchdog finds a canonical result', async () => {
		process.env.SPAWNER_PRD_AUTO_PROVIDER = 'codex';
		process.env.SPARK_WORKSPACE_ROOT = path.join(testSpawnerDir, 'workspaces');
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;
		executeProviderTaskMock.mockReturnValue(new Promise(() => undefined));
		const requestId = 'tg-build-codex-watchdog-result-1780930000000';
		const traceRef = 'trace:spawner-prd:mission-1780930000000';

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_TEST_KEY },
				body: JSON.stringify({
					content: '# Codex Watchdog Result Board\n\nBuild a local board with README and tests.',
					requestId,
					projectName: 'Codex Watchdog Result Board',
					buildMode: 'direct',
					buildLane: 'direct',
					tier: 'pro',
					traceRef,
					executionAuthority: writeAuthority(requestId)
				})
			}),
			getClientAddress: () => '127.0.0.1'
		} as never);

		expect(response.status).toBe(200);
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({ requestId, success: true, tasks: [{ id: 'task-1', title: 'Done' }] }),
			'utf-8'
		);

		await _runAutoAnalysisWatchdog({
			requestId,
			projectName: 'Codex Watchdog Result Board',
			buildMode: 'direct',
			buildLane: 'direct',
			tier: 'pro',
			traceRef,
			timeoutMs: 420_000
		});

		const pendingComplete = JSON.parse(await readFile(path.join(testSpawnerDir, 'pending-request.json'), 'utf-8'));
		expect(pendingComplete.status).toBe('processed');
		expect(pendingComplete.autoAnalysis).toMatchObject({
			status: 'complete',
			success: true,
			canonicalResultAvailable: true,
			resultFileName: `${requestId}.json`
		});

		const traceRows = (await readFile(path.join(testSpawnerDir, 'prd-auto-trace.jsonl'), 'utf-8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(traceRows.find((row) => row.event === 'watchdog_result_found')).toMatchObject({
			requestId,
			traceRef
		});
		expect(traceRows.some((row) => row.event === 'watchdog_timeout')).toBe(false);

		const missionEvents = await waitForMissionEventTypes('mission-1780930000000', ['task_completed']);
		expect(missionEvents).toContain('task_completed');
		expect(missionEvents).not.toContain('mission_completed');
	});

	it('relays Codex auto-analysis completion when a canonical result artifact is written', async () => {
		process.env.SPAWNER_PRD_AUTO_PROVIDER = 'codex';
		const requestId = 'tg-build-codex-result-1780940000000';
		const traceRef = 'trace:spawner-prd:mission-1780940000000';
		executeProviderTaskMock.mockImplementation(async () => {
			await writeFile(
				path.join(testSpawnerDir, 'results', `${requestId}.json`),
				JSON.stringify({ requestId, success: true, tasks: [{ id: 'task-1', title: 'Done' }] }),
				'utf-8'
			);
			return {
				success: true,
				error: null,
				durationMs: 42,
				sparkAgentSessionId: 'session-success-artifact'
			};
		});

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_TEST_KEY },
				body: JSON.stringify({
					content: '# Codex Result Board\n\nBuild a local board with README and tests.',
					requestId,
					projectName: 'Codex Result Board',
					buildMode: 'direct',
					buildLane: 'direct',
					tier: 'pro',
					traceRef,
					executionAuthority: writeAuthority(requestId)
				})
			}),
			getClientAddress: () => '127.0.0.1'
		} as never);

		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.autoAnalysis).toMatchObject({ provider: 'codex', started: true });

		const pending = await waitForPendingAutoAnalysisStatus('complete');
		expect(pending.status).toBe('processed');
		expect(pending.autoAnalysis).toMatchObject({
			status: 'complete',
			success: true,
			providerProcessSuccess: true,
			canonicalResultAvailable: true,
			resultFileName: `${requestId}.json`
		});

		const missionEvents = await waitForMissionEventTypes('mission-1780940000000', ['task_completed']);
		expect(missionEvents).toContain('task_completed');
		expect(missionEvents).not.toContain('mission_completed');
	});

	it('marks Codex auto-analysis as failed when no canonical result artifact is written', async () => {
		process.env.SPAWNER_PRD_AUTO_PROVIDER = 'codex';
		executeProviderTaskMock.mockResolvedValue({
			success: true,
			error: null,
			durationMs: 42,
			sparkAgentSessionId: 'session-no-artifact'
		});
		const requestId = 'tg-build-codex-no-artifact-1780941111111';
		const traceRef = 'trace:spawner-prd:mission-1780941111111';

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_TEST_KEY },
				body: JSON.stringify({
					content: '# Codex No Artifact Board\n\nBuild a local board with README and tests.',
					requestId,
					projectName: 'Codex No Artifact Board',
					buildMode: 'direct',
					buildLane: 'direct',
					tier: 'pro',
					chatId: 'telegram-chat-1',
					userId: 'telegram-user-1',
					traceRef,
					executionAuthority: writeAuthority(requestId)
				})
			}),
			getClientAddress: () => '127.0.0.1'
		} as never);

		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.autoAnalysis).toMatchObject({ provider: 'codex', started: true });

		const pending = await waitForPendingAutoAnalysisStatus('error');
		expect(pending.status).toBe('error');
		expect(pending.reason).toBe('Auto-analysis worker finished without a canonical result artifact.');
		expect(pending.autoAnalysis).toMatchObject({
			status: 'error',
			success: false,
			providerProcessSuccess: true,
			canonicalResultAvailable: false,
			resultFileName: `${requestId}.json`
		});

		const traceRows = (await readFile(path.join(testSpawnerDir, 'prd-auto-trace.jsonl'), 'utf-8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(traceRows.find((row) => row.event === 'auto_worker_finished')).toMatchObject({
			requestId,
			traceRef,
			success: false,
			providerProcessSuccess: true,
			error: 'Auto-analysis worker finished without a canonical result artifact.',
			resultArtifact: {
				present: false,
				fileName: `${requestId}.json`
			}
		});

		const missionControl = JSON.parse(await readFile(path.join(testSpawnerDir, 'mission-control.json'), 'utf-8'));
		const missionEvents = missionControl.recent.filter(
			(entry: { missionId?: string }) => entry.missionId === 'mission-1780941111111'
		);
		expect(missionEvents.map((entry: { eventType: string }) => entry.eventType)).toContain('task_failed');
		expect(missionEvents.map((entry: { eventType: string }) => entry.eventType)).toContain('mission_failed');
	});

	it('relays terminal completion for fast_direct deterministic success', async () => {
		const requestId = 'tg-build-fastdirect-completion-1780950000000';
		const missionId = 'mission-1780950000000';
		const traceRef = 'trace:spawner-prd:mission-1780950000000';

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_TEST_KEY },
				body: JSON.stringify({
					content:
						'Create one-file only index.html. Keep it as static HTML only. Build a countdown timer page. No package.json. Do not make a full app.',
					requestId,
					projectName: 'Fast Direct Completion Board',
					buildMode: 'direct',
					buildLane: 'fast_direct',
					options: { fastLane: true },
					tier: 'pro',
					chatId: 'telegram-chat-fastdirect',
					userId: 'telegram-user-fastdirect',
					traceRef,
					executionAuthority: writeAuthority(requestId)
				})
			}),
			getClientAddress: () => '127.0.0.1'
		} as never);

		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.autoAnalysis).toMatchObject({
			provider: 'deterministic-fast-lane',
			started: false
		});
		expect(JSON.parse(await readFile(path.join(testSpawnerDir, 'results', `${requestId}.json`), 'utf-8'))).toMatchObject({
			success: true,
			projectName: 'Fast Direct Completion Board'
		});

		const missionControl = JSON.parse(await readFile(path.join(testSpawnerDir, 'mission-control.json'), 'utf-8'));
		const missionEvents = missionControl.recent.filter(
			(entry: { missionId?: string }) => entry.missionId === missionId
		);
		const completionEvents = missionEvents.filter((entry: { eventType: string }) =>
			['task_completed', 'mission_completed'].includes(entry.eventType)
		);
		expect(completionEvents.map((entry: { eventType: string }) => entry.eventType)).toEqual(
			expect.arrayContaining(['task_completed', 'mission_completed'])
		);
		expect(completionEvents.filter((entry: { eventType: string }) => entry.eventType === 'task_completed')).toHaveLength(1);
		expect(completionEvents.filter((entry: { eventType: string }) => entry.eventType === 'mission_completed')).toHaveLength(1);
		expect(
			completionEvents.find((entry: { eventType: string }) => entry.eventType === 'mission_completed')
		).toMatchObject({
			requestId,
			traceRef,
			providerId: 'deterministic-fast-lane'
		});
	});

	it('keeps exact two-file static proofs deterministic and scoped to the requested folder', async () => {
		const requestId = 'tg-build-static-proof-s';
		const traceRef = 'trace:spawner-prd:mission-static-proof-s';
		const targetFolder = path.join(testSpawnerDir, 'spark-os-proof-s');
		const proofMarker = 'SPARK_OS_TEST_STATIC_PROOF_S';
		const proofSentence = 'Spawner trace parity runtime proof';

		const response = await POST({
			request: new Request('http://localhost/api/prd-bridge/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-api-key': BRIDGE_TEST_KEY },
				body: JSON.stringify({
					content: [
						`Create a local-only static proof in ${targetFolder}.`,
						'You must create exactly 2 local proof files and no others: index.html and README.md.',
						'Do not create app.js, styles.css, package.json, assets, folders, or any extra file.',
						'Put all styling inline inside index.html.',
						`Include the visible marker ${proofMarker} in both files.`,
						`Include the exact sentence "${proofSentence}" in both files.`
					].join(' '),
					requestId,
					projectName: 'Spark OS Proof S',
					buildMode: 'direct',
					tier: 'pro',
					chatId: 'telegram-chat-1',
					userId: 'telegram-user-1',
					traceRef,
					executionAuthority: writeAuthority(requestId)
				})
			}),
			getClientAddress: () => '127.0.0.1'
		} as never);

		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.autoAnalysis).toMatchObject({ provider: 'deterministic-static', started: false });
		const storedText = await readFile(path.join(testSpawnerDir, 'results', `${requestId}.json`), 'utf-8');
		const storedResult = JSON.parse(storedText);
		expect(storedResult.projectType).toBe('static-exact-file-proof');
		expect(storedResult.executionPrompt).toBeUndefined();
		expect(storedResult.tasks[0].workspaceTargets).toEqual([targetFolder]);
		expect(storedResult.tasks[0].acceptanceCriteria[0]).toContain('index.html, README.md');
		expect(storedText).not.toContain(`${targetFolder}. You must`);
		expect(await readFile(path.join(targetFolder, 'index.html'), 'utf-8')).toContain(proofMarker);
		expect(await readFile(path.join(targetFolder, 'index.html'), 'utf-8')).toContain(proofSentence);
		expect(await readFile(path.join(targetFolder, 'README.md'), 'utf-8')).toContain(proofMarker);
		expect(await readFile(path.join(targetFolder, 'README.md'), 'utf-8')).toContain(proofSentence);
		const pendingMeta = JSON.parse(await readFile(path.join(testSpawnerDir, 'pending-request.json'), 'utf-8'));
		expect(pendingMeta.projectLineage.projectPath).toBe(targetFolder);
		const traceRows = (await readFile(path.join(testSpawnerDir, 'prd-auto-trace.jsonl'), 'utf-8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(traceRows.find((row) => row.event === 'authority_verdict_evaluated')).toMatchObject({
			traceRef,
			authorityVerdict: {
				schema_version: 'spark.authority_verdict.v1',
				traceRef,
				actionFamily: 'mission_execution',
				verdict: 'blocked',
				sourceRepo: 'spawner-ui',
				reasonCode: 'auto_provider_deterministic-static_not_started'
			}
		});
		const missionControl = JSON.parse(await readFile(path.join(testSpawnerDir, 'mission-control.json'), 'utf-8'));
		const missionEvents = missionControl.recent.filter(
			(entry: { missionId?: string }) => entry.missionId === 'mission-tg-build-static-proof-s'
		);
		expect(missionEvents.map((entry: { eventType: string }) => entry.eventType)).toEqual(
			expect.arrayContaining(['task_completed', 'mission_completed'])
		);
		expect(
			missionEvents.find((entry: { eventType: string }) => entry.eventType === 'mission_completed')
		).toMatchObject({
			requestId,
			traceRef,
			providerId: 'deterministic-static'
		});
	});
});
