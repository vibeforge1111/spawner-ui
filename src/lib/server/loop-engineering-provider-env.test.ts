import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { PRIVATE_ENV } = vi.hoisted(() => ({
	PRIVATE_ENV: {} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({ env: PRIVATE_ENV }));

import { buildServerGovernorDecisionAuthority } from './harness-authority';
import { providerRuntime } from './provider-runtime';
import {
	executePrivateLoopEngineeringRun,
	stageBenchmarkCase
} from './loop-engineering-control-plane';

const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
const originalKimiKey = process.env.KIMI_API_KEY;
const originalZaiKey = process.env.ZAI_API_KEY;
let cleanupDirs: string[] = [];

function dispatchAuthority(requestId = 'loop-private-env-provider-proof') {
	return buildServerGovernorDecisionAuthority({
		source: 'loop-engineering-provider-env-test',
		reason: 'Provider-backed Loop Engineering proof must use the server private env.',
		toolName: 'spawner.dispatch',
		mutationClass: 'launches_mission',
		requestId,
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

beforeEach(async () => {
	const stateDir = await mkdtemp(path.join(os.tmpdir(), 'spark-loop-provider-env-'));
	process.env.SPAWNER_STATE_DIR = stateDir;
	delete process.env.KIMI_API_KEY;
	delete process.env.ZAI_API_KEY;
	PRIVATE_ENV.KIMI_API_KEY = 'private-env-kimi-key';
	PRIVATE_ENV.ZAI_API_KEY = 'private-env-zai-key';
	PRIVATE_ENV.KIMI_MODEL = 'kimi-private-model';
	PRIVATE_ENV.ZAI_MODEL = 'glm-private-model';
	PRIVATE_ENV.DEFAULT_MISSION_PROVIDER = 'codex';
	PRIVATE_ENV.SPARK_MISSION_LLM_MODEL = 'gpt-private-mission-model';
	cleanupDirs.push(stateDir);
});
afterEach(async () => {
	vi.restoreAllMocks();
	if (originalSpawnerStateDir) process.env.SPAWNER_STATE_DIR = originalSpawnerStateDir;
	else delete process.env.SPAWNER_STATE_DIR;
	if (originalKimiKey) process.env.KIMI_API_KEY = originalKimiKey;
	else delete process.env.KIMI_API_KEY;
	if (originalZaiKey) process.env.ZAI_API_KEY = originalZaiKey;
	else delete process.env.ZAI_API_KEY;
	delete PRIVATE_ENV.KIMI_API_KEY;
	delete PRIVATE_ENV.ZAI_API_KEY;
	delete PRIVATE_ENV.KIMI_MODEL;
	delete PRIVATE_ENV.ZAI_MODEL;
	delete PRIVATE_ENV.DEFAULT_MISSION_PROVIDER;
	delete PRIVATE_ENV.SPARK_MISSION_LLM_MODEL;
	await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	cleanupDirs = [];
});

describe('loop engineering provider env', () => {
	it('uses SvelteKit private env keys for computed generator and evaluator dispatch', async () => {
		const staged = await stageBenchmarkCase({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			kind: 'held_out',
			prompt: 'Write a PRD for failed invoice exports.',
			expectedBehavior: 'Include owner, affected users, success metric, acceptance criteria, rollback, and evidence refs.'
		});
		const providerResults = new Map<string, any[]>();
		const capturedApiKeys: Array<Record<string, string>> = [];
		const capturedProviders: Array<{ id: string; model: string | undefined }> = [];
		vi.spyOn(providerRuntime, 'dispatch').mockImplementation(async ({ executionPack, apiKeys }) => {
			const provider = executionPack.providers[0];
			const providerId = provider?.id || 'unknown';
			const missionId = executionPack.missionId || `mission-${providerId}`;
			capturedApiKeys.push(apiKeys);
			capturedProviders.push({ id: providerId, model: provider?.model });
			const response = providerId === 'kimi'
				? JSON.stringify({
					cases: [
						{
							caseId: staged.caseRecord.id,
							candidateOutput: 'PRD draft with owner, affected users, success metric, acceptance criteria, rollback, and evidence refs.'
						}
					],
					acceptedLessons: ['Start with owner, user, metric, acceptance criteria, rollback, and evidence refs.']
				})
				: JSON.stringify({
					caseResults: [
						{
							caseId: staged.caseRecord.id,
							baselineScore: 4.1,
							candidateScore: 8.6,
							baselineMatchedSignals: ['owner'],
							candidateMatchedSignals: ['owner', 'affected users', 'success metric', 'acceptance criteria', 'rollback', 'evidence refs'],
							verdict: 'candidate_wins',
							notes: 'Candidate is more actionable and evidence-bound.'
						}
					],
					acceptedLessons: ['Start with owner, user, metric, acceptance criteria, rollback, and evidence refs.']
				});
			const now = new Date().toISOString();
			providerResults.set(missionId, [{
				providerId,
				status: 'completed',
				requestId: null,
				traceRef: null,
				response,
				error: null,
				durationMs: 41,
				tokenUsage: { promptTokens: 10, completionTokens: 18, totalTokens: 28 },
				startedAt: now,
				completedAt: now
			}]);
			return {
				success: true,
				missionId,
				sessions: { [providerId]: { status: 'completed' } },
				startedAt: now,
				authority: dispatchAuthority()
			} as never;
		});
		vi.spyOn(providerRuntime, 'getMissionResults').mockImplementation((missionId) => providerResults.get(missionId) ?? []);

		const run = await executePrivateLoopEngineeringRun({
			chipKey: 'domain-chip-prd-writing-proof-loop',
			objective: 'Verify computed loop evidence can use server private env provider keys.',
			roundLimit: 1,
			benchmarkCaseIds: [staged.caseRecord.id],
			providerProof: {
				mode: 'computed',
				generatorProviderId: 'kimi',
				evaluatorProviderId: 'zai',
				dispatchExecutionAuthority: dispatchAuthority(),
				waitForCompletionMs: 1_000
			}
		});

		expect(capturedApiKeys).toEqual([
			{ kimi: 'private-env-kimi-key' },
			{ zai: 'private-env-zai-key' }
		]);
		expect(capturedProviders).toEqual([
			{ id: 'kimi', model: 'kimi-private-model' },
			{ id: 'zai', model: 'glm-private-model' }
		]);
		expect(run.loopRun).toMatchObject({
			provenance: 'computed',
			evaluatorSeparated: true,
			generatorProvider: 'kimi',
			evaluatorProvider: 'zai',
			utilityDelta: 4.5
		});
	});
});
