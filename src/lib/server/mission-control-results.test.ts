import { describe, expect, it } from 'vitest';
import {
	enrichMissionControlBoardWithProviderResults,
	summarizeProviderResults
} from './mission-control-results';
import type { MissionControlBoardEntry } from './mission-control-relay';
import type { ProviderMissionResultSnapshot } from './provider-runtime';

function result(overrides: Partial<ProviderMissionResultSnapshot>): ProviderMissionResultSnapshot {
	return {
		providerId: 'codex',
		status: 'completed',
		response: null,
		error: null,
		durationMs: null,
		tokenUsage: null,
		startedAt: '2026-04-25T00:00:00.000Z',
		completedAt: '2026-04-25T00:00:01.000Z',
		...overrides
	};
}

function entry(
	missionId: string,
	overrides: Partial<MissionControlBoardEntry> = {}
): MissionControlBoardEntry {
	return {
		missionId,
		missionName: null,
		status: 'completed',
		lastEventType: 'mission_completed',
		lastUpdated: '2026-04-25T00:00:01.000Z',
		queuedAt: null,
		startedAt: null,
		lastSummary: '[MissionControl] Mission completed.',
		taskName: null,
		taskCount: 0,
		taskNames: [],
		taskStatusCounts: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, total: 0 },
		tasks: [],
		...overrides
	};
}

describe('mission-control-results', () => {
	it('summarizes completed provider responses for mission cards', () => {
		const summary = summarizeProviderResults([
			result({ providerId: 'codex', response: 'SPARK_SPAWNER_CODEX_OK\n\nextra detail' })
		]);

		expect(summary.providerSummary).toBe('Codex: SPARK_SPAWNER_CODEX_OK extra detail');
		expect(summary.providerResults).toEqual([
			expect.objectContaining({
				providerId: 'codex',
				status: 'completed',
				summary: 'SPARK_SPAWNER_CODEX_OK extra detail'
			})
		]);
	});

	it('uses provider errors when no response exists', () => {
		const summary = summarizeProviderResults([
			result({ providerId: 'codex', status: 'failed', error: 'Codex exited 1' })
		]);

		expect(summary.providerSummary).toBe('Codex: Codex exited 1');
		expect(summary.providerResults[0].summary).toBe('Codex exited 1');
	});

	it('reclassifies blocked completed provider output as failed', () => {
		const summary = summarizeProviderResults([
			result({
				providerId: 'codex',
				status: 'completed',
				response: [
					'Blocked before task start.',
					'I could not load the mandatory H70 skills because http://127.0.0.1:3333 is unreachable.',
					'Per the mission instructions, I did not create files.',
					'The filesystem sandbox is read-only.'
				].join(' ')
			})
		]);

		expect(summary.providerResults[0]).toMatchObject({
			providerId: 'codex',
			status: 'failed'
		});
		expect(summary.providerSummary).toContain('Blocked before task start');
	});

	it('uses an honest completion fallback when no provider response exists', () => {
		const summary = summarizeProviderResults([result({ providerId: 'codex', response: null })]);

		expect(summary.providerSummary).toBe('Codex: completed without a text response');
		expect(summary.providerResults[0].summary).toBe('completed without a text response');
	});

	it('preserves project links from structured provider responses', () => {
		const summary = summarizeProviderResults([
			result({
				providerId: 'zai',
				response: JSON.stringify({
					status: 'completed',
					summary: 'Materialized hosted project files.',
					project_path: '/data/workspaces/mission-1-demo',
					preview_url: 'https://spawner.example/preview/demo/index.html'
				})
			})
		]);

		expect(summary.providerResults[0]).toMatchObject({
			providerId: 'zai',
			projectPath: '/data/workspaces/mission-1-demo',
			project_path: '/data/workspaces/mission-1-demo',
			previewUrl: 'https://spawner.example/preview/demo/index.html',
			preview_url: 'https://spawner.example/preview/demo/index.html'
		});
	});

	it('redacts local file paths from provider summaries before display', () => {
		const summary = summarizeProviderResults([
			result({
				providerId: 'codex',
				response:
					'Wrote [agent.py](C:/Users/USER/.spark/modules/spark-intelligence-builder/source/src/agent.py) and `/Users/leventcem/.spark/logs/spawner-ui.log`.'
			})
		]);

		expect(summary.providerSummary).toBe('Codex: Wrote agent.py and local file.');
		expect(summary.providerSummary).not.toContain('C:/Users/USER');
		expect(summary.providerSummary).not.toContain('/Users/leventcem');
	});

	it('keeps hosted project metadata from structured provider responses', () => {
		process.env.SPARK_PROJECT_PREVIEW_BASE_URL = 'https://preview.sparkswarm.ai/';
		const summary = summarizeProviderResults([
			result({
				providerId: 'codex',
				response: JSON.stringify({
					status: 'completed',
					summary: 'Materialized hosted project files.',
					project_path: 'C:/Users/USER/.spark/workspaces/mission-1'
				})
			})
		]);
		delete process.env.SPARK_PROJECT_PREVIEW_BASE_URL;

		expect(summary.providerResults[0]).toMatchObject({
			summary: 'Materialized hosted project files.',
			projectPath: 'C:/Users/USER/.spark/workspaces/mission-1',
			project_path: 'C:/Users/USER/.spark/workspaces/mission-1'
		});
		expect(summary.providerResults[0].previewUrl).toContain('https://preview.sparkswarm.ai/preview/');
	});

	it('enriches each board entry through the supplied result lookup', () => {
		const enriched = enrichMissionControlBoardWithProviderResults(
			{ completed: [entry('mission-1')], failed: [] },
			(missionId) => (missionId === 'mission-1' ? [result({ response: 'done' })] : [])
		);

		expect(enriched.completed[0].providerSummary).toBe('Codex: done');
		expect(enriched.completed[0].providerResults).toHaveLength(1);
	});

	it('downgrades completed board cards when provider evidence is still running', () => {
		const enriched = enrichMissionControlBoardWithProviderResults(
			{ completed: [entry('mission-stale-provider')], failed: [] },
			() => [result({ status: 'running', response: null, completedAt: null })]
		);

		expect(enriched.completed).toEqual([]);
		expect(enriched.running[0]).toMatchObject({
			missionId: 'mission-stale-provider',
			status: 'running',
			lastEventType: 'provider_running',
			lastSummary: 'Completion evidence missing: provider is still running.',
			taskStatusCounts: { running: 0, total: 0 },
			providerSummary: 'Codex: running'
		});
		expect(enriched.running[0].providerResults[0]).toEqual(
			expect.objectContaining({ status: 'running', summary: 'running', completedAt: null })
		);
	});

	it('moves completed board cards to failed when completed provider text says no files were created', () => {
		const enriched = enrichMissionControlBoardWithProviderResults(
			{
				completed: [
					entry('mission-provider-blocked', {
						tasks: [
							{ title: 'Create the app shell', skills: [], status: 'completed' },
							{ title: 'Implement the game', skills: [], status: 'completed' }
						],
						taskStatusCounts: {
							queued: 0,
							running: 0,
							completed: 2,
							failed: 0,
							cancelled: 0,
							total: 2
						}
					})
				],
				failed: [],
				running: []
			},
			() => [
				result({
					status: 'completed',
					response:
						'Blocked before task start. I could not load the mandatory H70 skills. I did not create files because the workspace is read-only.'
				})
			]
		);

		expect(enriched.completed).toEqual([]);
		expect(enriched.failed[0]).toMatchObject({
			missionId: 'mission-provider-blocked',
			status: 'failed',
			lastEventType: 'provider_failed',
			taskStatusCounts: { failed: 2, total: 2 },
			providerResults: [expect.objectContaining({ status: 'failed' })],
			providerSummary: expect.stringContaining('Blocked before task start'),
			completionEvidence: {
				state: 'complete',
				missing: [],
				providerTerminal: true,
				hasProviderSummary: true,
				tasksTerminal: true
			}
		});
	});

	it('moves non-terminal board cards to completed when provider results are completed', () => {
		const enriched = enrichMissionControlBoardWithProviderResults(
			{
				created: [
					entry('mission-provider-done', {
						status: 'created',
						lastEventType: 'mission_created',
						tasks: [{ title: 'Build the thing', skills: [], status: 'queued' }],
						taskStatusCounts: {
							queued: 1,
							running: 0,
							completed: 0,
							failed: 0,
							cancelled: 0,
							total: 1
						}
					})
				],
				completed: [],
				failed: [],
				running: [],
				paused: []
			},
			() => [result({ status: 'completed', response: 'done' })]
		);

		expect(enriched.created).toEqual([]);
		expect(enriched.completed[0]).toMatchObject({
			missionId: 'mission-provider-done',
			status: 'completed',
			lastEventType: 'provider_completed',
			taskStatusCounts: { completed: 1, total: 1 },
			providerSummary: 'Codex: done',
			completionEvidence: {
				state: 'complete',
				missing: [],
				providerResultCount: 1,
				providerTerminal: true,
				hasTerminalEvent: true,
				hasProviderCompletionTime: true,
				hasProviderSummary: true,
				tasksTerminal: true
			}
		});
	});

	it('counts reconciled project lineage as completion artifact evidence', () => {
		const enriched = enrichMissionControlBoardWithProviderResults(
			{
				completed: [
					entry('mission-lineage-artifact', {
						tasks: [{ title: 'Build the thing', skills: [], status: 'completed' }],
						taskStatusCounts: {
							queued: 0,
							running: 0,
							completed: 1,
							failed: 0,
							cancelled: 0,
							total: 1
						},
						projectLineage: {
							projectId: 'project-lineage-artifact',
							projectPath: 'C:\\Users\\USER\\.spark\\workspaces\\mission-lineage-artifact',
							previewUrl: 'http://127.0.0.1:3333/preview/demo/index.html',
							parentMissionId: null,
							iterationNumber: null,
							improvementFeedback: null
						}
					})
				],
				failed: [],
				running: []
			},
			() => [result({ status: 'completed', response: 'Built the project.' })]
		);

		expect(enriched.completed[0]).toMatchObject({
			missionId: 'mission-lineage-artifact',
			completionEvidence: {
				state: 'complete',
				missing: [],
				hasArtifactReference: true
			}
		});
	});

	it('marks terminal cards with incomplete evidence when provider results are absent', () => {
		const enriched = enrichMissionControlBoardWithProviderResults(
			{ completed: [entry('mission-no-provider-result')], failed: [], running: [] },
			() => []
		);

		expect(enriched.completed[0]).toMatchObject({
			missionId: 'mission-no-provider-result',
			status: 'completed',
			providerSummary: null,
			completionEvidence: {
				state: 'incomplete',
				missing: ['provider_result', 'provider_summary'],
				providerResultCount: 0,
				hasTerminalEvent: true,
				hasProviderSummary: false
			}
		});
	});

	it('marks non-terminal cards stalled when no progress arrives within the timeout', () => {
		const staleTimestamp = new Date(Date.now() - 31 * 60 * 1000).toISOString();
		const enriched = enrichMissionControlBoardWithProviderResults(
			{
				running: [
					entry('mission-stalled-running', {
						status: 'running',
						lastEventType: 'mission_started',
						lastUpdated: staleTimestamp,
						tasks: [{ title: 'Run analysis', skills: [], status: 'running' }],
						taskStatusCounts: {
							queued: 0,
							running: 1,
							completed: 0,
							failed: 0,
							cancelled: 0,
							total: 1
						}
					})
				],
				failed: [],
				completed: []
			},
			() => []
		);

		expect(enriched.running).toEqual([]);
		expect(enriched.failed[0]).toMatchObject({
			missionId: 'mission-stalled-running',
			status: 'failed',
			lastEventType: 'provider_stalled',
			taskStatusCounts: { failed: 1, total: 1 },
			completionEvidence: {
				state: 'incomplete',
				missing: ['terminal_event', 'provider_result', 'provider_summary']
			}
		});
		expect(enriched.failed[0].lastSummary).toContain('Mission stalled: no progress for');
	});

	it('marks orphan missions stalled within the shorter orphan timeout when no tasks or providers exist', () => {
		const orphanTimestamp = new Date(Date.now() - 6 * 60 * 1000).toISOString();
		const enriched = enrichMissionControlBoardWithProviderResults(
			{
				running: [
					entry('mission-orphan', {
						status: 'running',
						lastEventType: 'mission_started',
						lastUpdated: orphanTimestamp,
						tasks: [],
						taskStatusCounts: {
							queued: 0,
							running: 0,
							completed: 0,
							failed: 0,
							cancelled: 0,
							total: 0
						},
						taskName: null
					})
				],
				failed: [],
				completed: []
			},
			() => []
		);

		expect(enriched.running).toEqual([]);
		expect(enriched.failed[0]).toMatchObject({
			missionId: 'mission-orphan',
			status: 'failed',
			lastEventType: 'provider_stalled'
		});
		expect(enriched.failed[0].lastSummary).toContain('no task or provider activity');
	});

	it('uses full stalled timeout for missions that have task evidence (non-orphan)', () => {
		const recentTimestamp = new Date(Date.now() - 6 * 60 * 1000).toISOString();
		const enriched = enrichMissionControlBoardWithProviderResults(
			{
				running: [
					entry('mission-with-tasks', {
						status: 'running',
						lastEventType: 'mission_started',
						lastUpdated: recentTimestamp,
						tasks: [{ title: 'Write tests', skills: [], status: 'running' }],
						taskStatusCounts: {
							queued: 0,
							running: 1,
							completed: 0,
							failed: 0,
							cancelled: 0,
							total: 1
						},
						taskName: 'Write tests'
					})
				],
				failed: [],
				completed: []
			},
			() => []
		);

		// Still running — not stale because task evidence keeps it in the 30min timeout
		expect(enriched.running).toHaveLength(1);
		expect(enriched.failed).toEqual([]);
	});

	it('strips trailing slashes from preview base URL', () => {
		process.env.SPARK_PROJECT_PREVIEW_BASE_URL = 'https://preview.sparkswarm.ai///';
		const summary = summarizeProviderResults([
			result({
				providerId: 'codex',
				response: JSON.stringify({
					status: 'completed',
					summary: 'Hosted preview built.',
					project_path: '/data/workspaces/mission-2'
				})
			})
		]);
		delete process.env.SPARK_PROJECT_PREVIEW_BASE_URL;

		expect(summary.providerResults[0].previewUrl).toContain('https://preview.sparkswarm.ai/preview/');
		expect(summary.providerResults[0].previewUrl).not.toContain('///');
	});

	it('keeps paused board cards paused even when the underlying provider process was cancelled', () => {
		const enriched = enrichMissionControlBoardWithProviderResults(
			{
				paused: [
					entry('mission-paused-provider-cancelled', {
						status: 'paused',
						lastEventType: 'mission_paused',
						tasks: [{ title: 'Build the thing', skills: [], status: 'running', progress: 72 }],
						taskStatusCounts: {
							queued: 0,
							running: 1,
							completed: 0,
							failed: 0,
							cancelled: 0,
							total: 1
						}
					})
				],
				completed: [],
				failed: [],
				running: [],
				created: [],
				cancelled: []
			},
			() => [result({ status: 'cancelled', error: 'Mission paused' })]
		);

		expect(enriched.paused[0]).toMatchObject({
			missionId: 'mission-paused-provider-cancelled',
			status: 'paused',
			lastEventType: 'mission_paused',
			providerSummary: 'Codex: paused; ready to resume'
		});
		expect(enriched.cancelled).toEqual([]);
	});

	it('moves paused board cards back to running when the provider resumes', () => {
		const enriched = enrichMissionControlBoardWithProviderResults(
			{
				paused: [
					entry('mission-paused-provider-running', {
						status: 'paused',
						lastEventType: 'mission_paused',
						tasks: [{ title: 'Build the thing', skills: [], status: 'running', progress: 72 }],
						taskStatusCounts: {
							queued: 0,
							running: 1,
							completed: 0,
							failed: 0,
							cancelled: 0,
							total: 1
						}
					})
				],
				completed: [],
				failed: [],
				running: [],
				created: [],
				cancelled: []
			},
			() => [result({ status: 'running', response: null, error: null, completedAt: null })]
		);

		expect(enriched.paused).toEqual([]);
		expect(enriched.running[0]).toMatchObject({
			missionId: 'mission-paused-provider-running',
			status: 'running',
			lastEventType: 'provider_running',
			providerSummary: 'Codex: running'
		});
	});
});
