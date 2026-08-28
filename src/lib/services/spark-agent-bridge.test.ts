import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventBridge, type BridgeEvent } from './event-bridge';
import { buildServerGovernorDecisionAuthority } from '$lib/server/harness-authority';
import {
	prepareProviderWorkingDirectory,
	providerProcessFailureMessage,
	providerProcessTimeoutMessage,
	providerProcessTimeoutMs,
	sparkAgentBridge
} from './spark-agent-bridge';

const createdDirs: string[] = [];
const originalSparkWorkspaceRoot = process.env.SPARK_WORKSPACE_ROOT;
const originalAllowExternalProjectPaths = process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;

function workerRunAuthority(requestId = 'spark-agent-worker-test') {
	return buildServerGovernorDecisionAuthority({
		source: 'spark-agent-bridge-test',
		reason: 'Focused Spark Agent worker authority regression.',
		toolName: 'spawner.spark_agent.worker.run',
		mutationClass: 'launches_mission',
		requestId,
		target: 'mission-worker-proof',
		externalNetwork: true
	});
}

function canvasAddSkillAuthority(requestId = 'spark-agent-command-test') {
	return buildServerGovernorDecisionAuthority({
		source: 'spark-agent-bridge-test',
		reason: 'Focused Spark Agent command authority regression.',
		toolName: 'spawner.spark_agent.canvas.add_skill',
		mutationClass: 'controls_mission',
		requestId,
		target: 'spark-agent-command-session'
	});
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

describe('prepareProviderWorkingDirectory', () => {
	afterEach(() => {
		restoreEnv('SPARK_WORKSPACE_ROOT', originalSparkWorkspaceRoot);
		restoreEnv('SPARK_ALLOW_EXTERNAL_PROJECT_PATHS', originalAllowExternalProjectPaths);
		sparkAgentBridge.resetForTests();
		for (const dir of createdDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('creates a missing new-project workspace before provider spawn', () => {
		const root = mkdtempSync(join(tmpdir(), 'spark-provider-workspace-'));
		const projectName = `new-project-${Date.now()}`;
		const dir = join(root, projectName);
		createdDirs.push(root);
		process.env.SPARK_WORKSPACE_ROOT = root;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;

		expect(existsSync(dir)).toBe(false);
		expect(prepareProviderWorkingDirectory(dir)).toBe(join(realpathSync(root), projectName));
		expect(existsSync(dir)).toBe(true);
	});

	it('creates the session pipeline ID through the production crypto path', () => {
		const session = sparkAgentBridge.startSession();
		expect(session.canvas.pipelineId).toMatch(/^pipe-[0-9a-z]+-[0-9a-f]{8}$/);
	});

	it('rejects explicit provider workspaces outside Spark workspace by default', () => {
		const root = mkdtempSync(join(tmpdir(), 'spark-provider-root-'));
		const external = mkdtempSync(join(tmpdir(), 'spark-provider-external-'));
		createdDirs.push(root, external);
		process.env.SPARK_WORKSPACE_ROOT = root;
		delete process.env.SPARK_ALLOW_EXTERNAL_PROJECT_PATHS;

		expect(() => prepareProviderWorkingDirectory(join(external, 'project'))).toThrow(
			'Project path must stay inside Spark workspace root'
		);
	});

	it('uses the process cwd when no workspace is provided', () => {
		expect(prepareProviderWorkingDirectory()).toBe(process.cwd());
	});

	it('carries request, trace, provider, and model metadata on worker events', async () => {
		sparkAgentBridge.setWorkerExecutorForTests(async () => ({ success: true, response: 'done' }));
		const emitted: BridgeEvent[] = [];
		const unsubscribe = eventBridge.subscribe((event) => emitted.push(event));

		await sparkAgentBridge.executeProviderTask({
			providerId: 'codex',
			missionId: 'mission-worker-proof',
			prompt: 'metadata proof only',
			executionAuthority: workerRunAuthority('request-worker-proof'),
			model: 'gpt-5.5',
			requestId: 'request-worker-proof',
			traceRef: 'trace:spawner-prd:mission-worker-proof',
			commandTemplate: 'codex exec --model gpt-5.5'
		});
		unsubscribe?.();

		const completed = emitted.find((event) => event.type === 'task_completed');
		expect(completed?.data).toMatchObject({
			provider: 'codex',
			providerId: 'codex',
			model: 'gpt-5.5',
			requestId: 'request-worker-proof',
			traceRef: 'trace:spawner-prd:mission-worker-proof'
		});
	});

	it('blocks direct provider task execution without native Governor authority', async () => {
		let executorCalled = false;
		sparkAgentBridge.setWorkerExecutorForTests(async () => {
			executorCalled = true;
			return { success: true, response: 'should-not-run' };
		});

		await expect(
			sparkAgentBridge.executeProviderTask({
				providerId: 'codex',
				missionId: 'mission-worker-no-authority',
				prompt: 'metadata proof only'
			} as never)
		).rejects.toThrow('Execution requires Harness Core authority.');

		expect(executorCalled).toBe(false);
	});

	it('blocks direct provider task execution when the Governor tool ledger is missing', async () => {
		let executorCalled = false;
		sparkAgentBridge.setWorkerExecutorForTests(async () => {
			executorCalled = true;
			return { success: true, response: 'should-not-run' };
		});
		const authority = workerRunAuthority('request-worker-missing-ledger');
		const missingLedgerAuthority = JSON.parse(JSON.stringify(authority));
		missingLedgerAuthority.tool_ledgers = [];

		await expect(
			sparkAgentBridge.executeProviderTask({
				providerId: 'codex',
				missionId: 'mission-worker-missing-ledger',
				prompt: 'metadata proof only',
				executionAuthority: missingLedgerAuthority,
				requestId: 'request-worker-missing-ledger'
			})
		).rejects.toThrow('Execution authority blocked this request.');

		expect(executorCalled).toBe(false);
	});
});

describe('sparkAgentBridge command authority residue', () => {
	afterEach(() => {
		sparkAgentBridge.resetForTests();
	});

	it('uses nested command authority for dispatch without storing it in command telemetry', async () => {
		const session = sparkAgentBridge.startSession({
			sessionId: 'spark-agent-command-session',
			actor: 'authority-residue-test'
		});
		const authority = canvasAddSkillAuthority('request-command-authority-residue');

		const result = await sparkAgentBridge.executeCommand({
			sessionId: session.id,
			command: 'canvas.add_skill',
			requestId: 'request-command-authority-residue',
			params: {
				nodeId: 'node-authority-proof',
				skillId: 'planner',
				skillName: 'Planner',
				description: 'Plan implementation',
				executionAuthority: authority,
				nested: {
					governorDecision: authority,
					keep: 'visible'
				}
			}
		});

		expect(result.ok).toBe(true);
		expect(result.data?.node).toMatchObject({
			id: 'node-authority-proof',
			skillId: 'planner'
		});

		const received = sparkAgentBridge
			.getSessionEvents(session.id)
			.find((event) => event.type === 'spark_agent.command.received');
		expect(received?.data.params).toMatchObject({
			nodeId: 'node-authority-proof',
			skillId: 'planner',
			nested: {
				keep: 'visible'
			}
		});
		expect(JSON.stringify(received?.data.params)).not.toContain('executionAuthority');
		expect(JSON.stringify(received?.data.params)).not.toContain('governorDecision');
	});

	it('strips authority residue from session metadata and session-start events', () => {
		const authority = canvasAddSkillAuthority('request-session-metadata-residue');
		const session = sparkAgentBridge.startSession({
			sessionId: 'spark-agent-metadata-session',
			actor: 'authority-residue-test',
			metadata: {
				owner: 'test',
				executionAuthority: authority,
				nested: {
					governorDecision: authority,
					keep: 'visible'
				}
			}
		});

		expect(session.metadata).toMatchObject({
			owner: 'test',
			nested: {
				keep: 'visible'
			}
		});
		expect(JSON.stringify(session.metadata)).not.toContain('executionAuthority');
		expect(JSON.stringify(session.metadata)).not.toContain('governorDecision');

		const started = sparkAgentBridge
			.getSessionEvents(session.id)
			.find((event) => event.type === 'spark_agent.session.started');
		expect(started?.data.metadata).toMatchObject({
			owner: 'test',
			nested: {
				keep: 'visible'
			}
		});
		expect(JSON.stringify(started?.data.metadata)).not.toContain('executionAuthority');
		expect(JSON.stringify(started?.data.metadata)).not.toContain('governorDecision');
	});
});

describe('providerProcessFailureMessage', () => {
	it('uses stderr first for actionable provider failures', () => {
		expect(providerProcessFailureMessage(1, 'stdout fallback', 'Provider rejected the request')).toBe(
			'Provider rejected the request'
		);
	});

	it('falls back to bounded stdout when stderr is empty', () => {
		expect(providerProcessFailureMessage(1, 'Model unavailable for this provider', '')).toBe(
			'Model unavailable for this provider'
		);
	});

	it('redacts secrets and local paths before surfacing provider output', () => {
		const message = providerProcessFailureMessage(
			1,
			'',
			'Error in C:\\Users\\USER\\private\\app with OPENAI_API_KEY=sk-secretvalue123456, Bearer ghp_secretvalue1234567890, Authorization: Token placeholder-token-value-123456, Authorization: ApiKey placeholder-apikey-value-123456, and Authorization: OAuth placeholder-oauth-value-123456'
		);

		expect(message).toContain('local file');
		expect(message).toContain('[secret]');
		expect(message).not.toContain('C:\\Users\\USER');
		expect(message).not.toContain('sk-secretvalue123456');
		expect(message).not.toContain('ghp_secretvalue1234567890');
		expect(message).not.toContain('placeholder-token-value-123456');
		expect(message).not.toContain('placeholder-apikey-value-123456');
		expect(message).not.toContain('placeholder-oauth-value-123456');
	});

	it('falls back to the exit code when no provider output is usable', () => {
		expect(providerProcessFailureMessage(2, '', '')).toBe('Exited with code 2');
	});
});

describe('latest canvas snapshot selection', () => {
	afterEach(() => {
		sparkAgentBridge.resetForTests();
	});

	it('uses canvas activity instead of unrelated later session activity', () => {
		const olderCanvas = sparkAgentBridge.startSession({ sessionId: 'older-canvas' });
		const newerCanvas = sparkAgentBridge.startSession({ sessionId: 'newer-canvas' });
		olderCanvas.events.push({
			id: 'event-older-canvas',
			type: 'spark_agent.canvas.updated',
			sessionId: olderCanvas.id,
			timestamp: '2026-07-24T10:00:00.000Z',
			data: {}
		});
		olderCanvas.updatedAt = '2026-07-24T12:00:00.000Z';
		newerCanvas.events.push({
			id: 'event-newer-canvas',
			type: 'spark_agent.canvas.updated',
			sessionId: newerCanvas.id,
			timestamp: '2026-07-24T11:00:00.000Z',
			data: {}
		});
		newerCanvas.updatedAt = '2026-07-24T11:00:00.000Z';

		expect(sparkAgentBridge.getLatestCanvasSnapshot()).toMatchObject({
			sessionId: newerCanvas.id,
			updatedAt: '2026-07-24T11:00:00.000Z'
		});
		expect(
			sparkAgentBridge.getLatestCanvasSnapshot('2026-07-24T10:30:00.000Z', olderCanvas.id)
		).toBeNull();
	});
});

describe('subscriber failure isolation', () => {
	afterEach(() => {
		sparkAgentBridge.resetForTests();
		vi.restoreAllMocks();
	});

	it('continues delivering an event after one subscriber throws', () => {
		const session = sparkAgentBridge.startSession();
		const delivered = vi.fn();
		sparkAgentBridge.subscribe(session.id, () => {
			throw new Error('/Users/alice/private/subscriber.sock');
		});
		sparkAgentBridge.subscribe(session.id, delivered);
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		sparkAgentBridge.endSession(session.id);

		expect(delivered).toHaveBeenCalledOnce();
		expect(error).toHaveBeenCalledWith(
			'[spark-agent-bridge] Subscriber callback failed:',
			'Error'
		);
		expect(JSON.stringify(error.mock.calls)).not.toContain('/Users/alice');
	});
});

describe('provider process timeout helpers', () => {
	it('uses the shared agent timeout configuration', () => {
		expect(providerProcessTimeoutMs({ SPAWNER_AGENT_WORK_TIMEOUT_MS: '120000' })).toBe(120000);
	});

	it('renders a bounded timeout message without provider output', () => {
		expect(providerProcessTimeoutMessage('codex', 120000)).toBe('Provider codex timed out after 2 minutes');
	});
});

describe('endSession double-end guard', () => {
	afterEach(() => {
		sparkAgentBridge.resetForTests();
	});

	it('throws when ending an already-ended session (route returns 409)', () => {
		const session = sparkAgentBridge.startSession();
		sparkAgentBridge.endSession(session.id);

		expect(() => sparkAgentBridge.endSession(session.id)).toThrow('already ended');
	});

	it('returns the session successfully on first end', () => {
		const session = sparkAgentBridge.startSession();
		const ended = sparkAgentBridge.endSession(session.id);

		expect(ended.status).toBe('ended');
		expect(ended.endedAt).toBeTruthy();
	});

	it('allows ending different sessions independently', () => {
		const a = sparkAgentBridge.startSession();
		const b = sparkAgentBridge.startSession();

		sparkAgentBridge.endSession(a.id);
		const endedB = sparkAgentBridge.endSession(b.id);
		expect(endedB.status).toBe('ended');

		expect(() => sparkAgentBridge.endSession(a.id)).toThrow('already ended');
	});

	it('reports a bounded error when worker termination throws', () => {
		const session = sparkAgentBridge.startSession();
		const workerSessions = (
			sparkAgentBridge as unknown as {
				workerSessions: Map<string, { status: 'running'; process: { kill: () => boolean } }>;
			}
		).workerSessions;
		workerSessions.set(session.id, {
			status: 'running',
			process: {
				kill: () => {
					throw new Error('/Users/alice/private/worker.sock');
				}
			}
		});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(() => sparkAgentBridge.endSession(session.id)).not.toThrow();
		expect(error).toHaveBeenCalledWith(
			'[spark-agent-bridge] Worker termination failed:',
			'Error'
		);
		expect(JSON.stringify(error.mock.calls)).not.toContain('/Users/alice');
	});
});
