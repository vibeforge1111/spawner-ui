import { describe, expect, it } from 'vitest';
import {
	activeMissionBoardColumnLabel,
	canRunCreatorMissionBoardCard,
	canValidateCreatorMissionBoardCard,
	canvasHrefForMissionControlEntry,
	collapseRepeatedTerminalMissionCards,
	getMissionBoardCardActionLinks,
	getMissionBoardWorkBreakdown,
	isCreatorMissionBoardCard,
	mergeMissionBoardCards,
	terminalMissionBoardColumnLabel,
	canShowMissionBoardProjectActions,
	type MissionBoardCard
} from './mission-board-cards';

function card(partial: Partial<MissionBoardCard>): MissionBoardCard {
	return {
		id: 'mission-1',
		name: 'Mission',
		status: 'ready',
		mode: 'spark',
		source: 'spark',
		updatedAt: '2026-04-28T10:00:00.000Z',
		createdAt: '2026-04-28T09:55:00.000Z',
		taskCount: 0,
		...partial
	};
}

describe('mergeMissionBoardCards', () => {
	it('keeps the finite updated timestamp when the matching card timestamp is malformed', () => {
		const live = card({ id: 'mission-malformed-time', updatedAt: 'not-a-date' });
		const stored = card({
			id: 'mission-malformed-time',
			source: 'mcp',
			updatedAt: '2026-04-28T10:00:00.000Z'
		});

		const [merged] = mergeMissionBoardCards([live], [stored]);

		expect(merged.updatedAt).toBe('2026-04-28T10:00:00.000Z');
	});

	it('keeps live relay status when an older static mission has the same id', () => {
		const live = card({
			id: 'mission-1777211869020',
			status: 'running',
			source: 'spark',
			updatedAt: '2026-04-28T10:05:00.000Z',
			taskCount: 1,
			taskStatusCounts: { queued: 0, running: 1, completed: 0, failed: 0, cancelled: 0, total: 1 },
			tasks: [{ title: 'Build UI', skills: ['canvas'] }]
		});
		const staleStatic = card({
			id: 'mission-1777211869020',
			status: 'ready',
			source: 'mcp',
			mode: 'multi-llm-orchestrator',
			updatedAt: '2026-04-28T10:01:00.000Z',
			taskCount: 3,
			tasks: [
				{ title: 'Create files', skills: [] },
				{ title: 'Build UI', skills: [] },
				{ title: 'Wire controls', skills: [] }
			]
		});

		const [merged] = mergeMissionBoardCards([live], [staleStatic]);

		expect(merged.status).toBe('running');
		expect(merged.source).toBe('spark');
		expect(merged.mode).toBe('spark');
		expect(merged.updatedAt).toBe('2026-04-28T10:05:00.000Z');
		expect(merged.taskCount).toBe(3);
		expect(merged.taskStatusCounts).toEqual({ queued: 0, running: 1, completed: 0, failed: 0, cancelled: 0, total: 1 });
		expect(merged.tasks).toEqual([{ title: 'Build UI', skills: ['canvas'] }]);
	});

	it('uses static task details when the live relay has not received task events yet', () => {
		const live = card({
			id: 'mission-2',
			status: 'running',
			source: 'spark',
			taskCount: 0,
			tasks: []
		});
		const staticCard = card({
			id: 'mission-2',
			status: 'ready',
			source: 'mcp',
			taskCount: 2,
			tasks: [
				{ title: 'Create files', skills: [] },
				{ title: 'Render UI', skills: [] }
			]
		});

		const [merged] = mergeMissionBoardCards([live], [staticCard]);

		expect(merged.status).toBe('running');
		expect(merged.taskCount).toBe(2);
		expect(merged.tasks).toEqual(staticCard.tasks);
	});

	it('keeps completed live progress visible when static mission storage is stale', () => {
		const live = card({
			id: 'mission-3',
			status: 'completed',
			source: 'spark',
			updatedAt: '2026-04-28T10:10:00.000Z',
			taskCount: 3,
			taskStatusCounts: { queued: 0, running: 0, completed: 3, failed: 0, cancelled: 0, total: 3 },
			taskNames: ['Create shell', 'Wire controls', 'Write README'],
			tasks: [
				{ title: 'Create shell', skills: [], status: 'completed' },
				{ title: 'Wire controls', skills: [], status: 'completed' },
				{ title: 'Write README', skills: [], status: 'completed' }
			],
			providerSummary: 'Codex: shipped and verified',
			completionEvidence: {
				state: 'complete',
				summary: 'Completion evidence present.',
				missing: [],
				providerResultCount: 1,
				providerTerminal: true,
				hasTerminalEvent: true,
				hasProviderCompletionTime: true,
				hasProviderSummary: true,
				hasArtifactReference: false,
				tasksTerminal: true
			}
		});
		const staleStatic = card({
			id: 'mission-3',
			status: 'running',
			source: 'mcp',
			mode: 'multi-llm-orchestrator',
			updatedAt: '2026-04-28T10:05:00.000Z',
			taskCount: 3,
			tasks: [
				{ title: 'Create shell', skills: [], status: 'running' },
				{ title: 'Wire controls', skills: [], status: 'queued' },
				{ title: 'Write README', skills: [], status: 'queued' }
			]
		});

		const [merged] = mergeMissionBoardCards([live], [staleStatic]);

		expect(merged.status).toBe('completed');
		expect(merged.updatedAt).toBe('2026-04-28T10:10:00.000Z');
		expect(merged.taskStatusCounts).toEqual({
			queued: 0,
			running: 0,
			completed: 3,
			failed: 0,
			cancelled: 0,
			total: 3
		});
		expect(merged.tasks?.map((task) => task.status)).toEqual(['completed', 'completed', 'completed']);
		expect(merged.providerSummary).toBe('Codex: shipped and verified');
		expect(merged.completionEvidence).toMatchObject({ state: 'complete', missing: [] });
	});

	it('preserves execution state from live relay cards', () => {
		const live = card({
			id: 'mission-creator-1',
			status: 'running',
			source: 'spark',
			mode: 'creator-mission',
			lastEventType: 'mission_started',
			executionStarted: true
		});
		const staticCard = card({
			id: 'mission-creator-1',
			status: 'ready',
			source: 'mcp',
			executionStarted: false
		});

		const [merged] = mergeMissionBoardCards([live], [staticCard]);

		expect(merged.lastEventType).toBe('mission_started');
		expect(merged.executionStarted).toBe(true);
	});

	it('preserves failed provider details over older static task text', () => {
		const live = card({
			id: 'mission-4',
			status: 'failed',
			source: 'spark',
			updatedAt: '2026-04-28T10:20:00.000Z',
			taskCount: 2,
			taskStatusCounts: { queued: 0, running: 0, completed: 0, failed: 2, cancelled: 0, total: 2 },
			tasks: [
				{ title: 'Create shell', skills: [], status: 'failed' },
				{ title: 'Run final smoke verification', skills: [], status: 'failed' }
			],
			providerSummary: 'Codex: command exited 1',
			providerResults: [{ providerId: 'codex', status: 'failed', summary: 'command exited 1' }]
		});
		const staleStatic = card({
			id: 'mission-4',
			status: 'ready',
			source: 'mcp',
			updatedAt: '2026-04-28T10:00:00.000Z',
			taskCount: 2,
			summary: 'Static plan only'
		});

		const [merged] = mergeMissionBoardCards([live], [staleStatic]);

		expect(merged.status).toBe('failed');
		expect(merged.taskStatusCounts).toMatchObject({ failed: 2, total: 2 });
		expect(merged.providerSummary).toBe('Codex: command exited 1');
		expect(merged.providerResults).toEqual([
			{ providerId: 'codex', status: 'failed', summary: 'command exited 1' }
		]);
	});

	it('preserves mission detail links from live relay cards', () => {
		const live = card({
			id: 'mission-5',
			source: 'spark',
			status: 'running',
			detailHref: '/missions/mission-5',
			canvasHref: '/canvas?pipeline=prd-5&mission=mission-5'
		});
		const staticCard = card({
			id: 'mission-5',
			source: 'mcp',
			status: 'ready',
			detailHref: '/missions/static-mission-5'
		});

		const [merged] = mergeMissionBoardCards([live], [staticCard]);

		expect(merged.detailHref).toBe('/missions/mission-5');
		expect(merged.canvasHref).toBe('/canvas?pipeline=prd-5&mission=mission-5');
	});

	it('preserves project lineage from live relay cards', () => {
		const live = card({
			id: 'mission-6',
			source: 'spark',
			status: 'completed',
			projectLineage: {
				projectId: 'project-founder-signal-room',
				projectPath: 'C:\\Users\\USER\\Desktop\\founder-signal-room',
				previewUrl: 'http://127.0.0.1:5555/preview/token/index.html',
				parentMissionId: 'mission-parent',
				iterationNumber: 2,
				improvementFeedback: 'Make the strategy document feel alive.'
			}
		});
		const staticCard = card({
			id: 'mission-6',
			source: 'mcp',
			status: 'ready'
		});

		const [merged] = mergeMissionBoardCards([live], [staticCard]);

		expect(merged.projectLineage).toEqual(live.projectLineage);
	});
});

describe('terminalMissionBoardColumnLabel', () => {
	it('labels the mixed completed, failed, and cancelled board bucket as history', () => {
		expect(terminalMissionBoardColumnLabel()).toBe('History');
	});
});

describe('activeMissionBoardColumnLabel', () => {
	it('labels the mixed running and paused board bucket as active', () => {
		expect(activeMissionBoardColumnLabel()).toBe('Active');
	});
});

describe('canShowMissionBoardProjectActions', () => {
	it('hides shipped-project actions while a mission is still active', () => {
		const active = card({
			id: 'spark-running',
			status: 'running',
			projectLineage: {
				projectId: 'project-running',
				projectPath: '/Users/example/.spark/workspaces/default',
				previewUrl: 'http://127.0.0.1:3333/preview/default/index.html',
				parentMissionId: null,
				iterationNumber: null,
				improvementFeedback: null
			}
		});
		const shipped = card({
			id: 'spark-complete',
			status: 'completed',
			projectLineage: active.projectLineage
		});

		expect(canShowMissionBoardProjectActions(active)).toBe(false);
		expect(canShowMissionBoardProjectActions(shipped)).toBe(true);
	});
});

describe('collapseRepeatedTerminalMissionCards', () => {
	it('collapses repeated completed diagnostics while keeping the latest card', () => {
		const cards = [
			card({
				id: 'spark-latest',
				name: 'Telegram Golden Path Probe',
				status: 'completed',
				taskCount: 1,
				summary: 'Mission completed.',
				providerSummary: 'Codex: SPARK_E2E_NO_EDIT_OK'
			}),
			card({
				id: 'spark-older',
				name: 'Telegram Golden Path Probe',
				status: 'completed',
				taskCount: 1,
				summary: 'Mission completed.',
				providerSummary: 'Codex: SPARK_E2E_NO_EDIT_OK'
			}),
			card({
				id: 'spark-other',
				name: 'Tiny Maze Game',
				status: 'completed',
				taskCount: 4,
				summary: 'Mission completed.',
				providerSummary: 'Codex: built prototype'
			})
		];

		const collapsed = collapseRepeatedTerminalMissionCards(cards);

		expect(collapsed.map((item) => item.id)).toEqual(['spark-latest', 'spark-other']);
		expect(collapsed[0].repeatCount).toBe(1);
	});

	it('does not collapse shipped project lineage cards with the same title', () => {
		const cards = [
			card({
				id: 'ship-latest',
				name: 'Tiny Maze Game',
				status: 'completed',
				taskCount: 4,
				summary: 'Mission completed.',
				providerSummary: 'Codex: built prototype',
				projectLineage: { projectId: null, projectPath: '/tmp/maze-a', previewUrl: null, parentMissionId: null, iterationNumber: null, improvementFeedback: null }
			}),
			card({
				id: 'ship-older',
				name: 'Tiny Maze Game',
				status: 'completed',
				taskCount: 4,
				summary: 'Mission completed.',
				providerSummary: 'Codex: built prototype',
				projectLineage: { projectId: null, projectPath: '/tmp/maze-b', previewUrl: null, parentMissionId: null, iterationNumber: null, improvementFeedback: null }
			})
		];

		expect(collapseRepeatedTerminalMissionCards(cards)).toHaveLength(2);
	});
});

describe('mission board work breakdown', () => {
	it('keeps PRD preparation separate from build task progress', () => {
		const breakdown = getMissionBoardWorkBreakdown(card({
			taskCount: 5,
			taskStatusCounts: { queued: 0, running: 0, completed: 5, failed: 0, cancelled: 0, total: 5 },
			tasks: [
				{ title: 'PRD analysis', skills: [], status: 'completed' },
				{ title: 'Create playable shell', skills: [], status: 'completed' },
				{ title: 'Design core loop', skills: [], status: 'completed' },
				{ title: 'Add scoring and restart', skills: [], status: 'completed' },
				{ title: 'Verify playable loop', skills: [], status: 'completed' }
			]
		}));

		expect(breakdown.hasPreparation).toBe(true);
		expect(breakdown.preparation).toMatchObject({ completed: 1, total: 1 });
		expect(breakdown.build).toMatchObject({ completed: 4, total: 4 });
	});

	it('falls back to relay task counts when detailed tasks are not present yet', () => {
		const breakdown = getMissionBoardWorkBreakdown(card({
			taskCount: 3,
			taskStatusCounts: { queued: 2, running: 1, completed: 0, failed: 0, cancelled: 0, total: 3 }
		}));

		expect(breakdown.hasPreparation).toBe(false);
		expect(breakdown.build).toMatchObject({ queued: 2, running: 1, total: 3 });
		expect(breakdown.preparation.total).toBe(0);
	});

	it('uses live counts when task rows are static labels without statuses', () => {
		const breakdown = getMissionBoardWorkBreakdown(card({
			taskCount: 3,
			taskStatusCounts: { queued: 0, running: 0, completed: 3, failed: 0, cancelled: 0, total: 3 },
			tasks: [
				{ title: 'Create shell', skills: [] },
				{ title: 'Wire controls', skills: [] },
				{ title: 'Run smoke test', skills: [] }
			]
		}));

		expect(breakdown.hasPreparation).toBe(false);
		expect(breakdown.build).toMatchObject({ completed: 3, total: 3 });
	});
});

describe('creator mission run eligibility', () => {
	it('allows creator missions that only completed planning task events', () => {
		const plannedCreator = card({
			id: 'mission-creator-1777402152963',
			name: 'Creator Mission: Startup YC',
			mode: 'spark',
			source: 'spark',
			status: 'running',
			lastEventType: 'task_completed',
			executionStarted: false
		});

		expect(isCreatorMissionBoardCard(plannedCreator)).toBe(true);
		expect(canRunCreatorMissionBoardCard(plannedCreator)).toBe(true);
	});

	it('blocks creator run actions after execution has started', () => {
		const executingCreator = card({
			id: 'mission-creator-1777402152963',
			name: 'Creator Mission: Startup YC',
			mode: 'creator-mission',
			source: 'spark',
			status: 'running',
			lastEventType: 'mission_started',
			executionStarted: true
		});

		expect(canRunCreatorMissionBoardCard(executingCreator)).toBe(false);
	});

	it('blocks creator run actions for read-only evidence missions', () => {
		const readOnlyCreator = card({
			id: 'mission-creator-startup-yc-evidence',
			name: 'Creator Mission: Startup YC',
			mode: 'creator-mission',
			source: 'spark',
			status: 'running',
			executionStarted: false,
			executionPolicy: 'read_only'
		});

		expect(canRunCreatorMissionBoardCard(readOnlyCreator)).toBe(false);
	});

	it('does not show run actions for normal Spark missions', () => {
		expect(canRunCreatorMissionBoardCard(card({ id: 'mission-plain', name: 'Regular mission', status: 'ready' }))).toBe(false);
	});
});

describe('creator mission validation eligibility', () => {
	it('allows validation for planned or already-executed creator missions', () => {
		expect(canValidateCreatorMissionBoardCard(card({
			id: 'mission-creator-1777402152963',
			name: 'Creator Mission: Startup YC',
			mode: 'creator-mission',
			status: 'ready'
		}))).toBe(true);
		expect(canValidateCreatorMissionBoardCard(card({
			id: 'mission-creator-1777402152963',
			name: 'Creator Mission: Startup YC',
			mode: 'creator-mission',
			status: 'completed'
		}))).toBe(true);
	});

	it('hides validation for cancelled creator missions and normal Spark missions', () => {
		expect(canValidateCreatorMissionBoardCard(card({
			id: 'mission-creator-1777402152963',
			name: 'Creator Mission: Startup YC',
			mode: 'creator-mission',
			status: 'cancelled'
		}))).toBe(false);
		expect(canValidateCreatorMissionBoardCard(card({ id: 'mission-plain', name: 'Regular mission', status: 'ready' }))).toBe(false);
	});
});

describe('canvasHrefForMissionControlEntry', () => {
	it('uses mission-only canvas links when only a same-title stale history pipeline exists', () => {
		const href = canvasHrefForMissionControlEntry('spark-1778997905515', [
			{ id: 'mission-history-spark-1778851415178', name: 'Telegram Golden Path Probe' }
		]);

		expect(href).toBe('/canvas?mission=spark-1778997905515');
	});

	it('keeps explicit pipeline links when the pipeline id matches the mission suffix', () => {
		const href = canvasHrefForMissionControlEntry('mission-1778917838772', [
			{ id: 'prd-tg-build-maze-1778917838772', name: 'Tiny Maze Game' }
		]);

		expect(href).toBe('/canvas?pipeline=prd-tg-build-maze-1778917838772&mission=mission-1778917838772');
	});
});

describe('getMissionBoardCardActionLinks', () => {
	it('creates inspectable mission links for completed Spark cards without a canvas', () => {
		const actions = getMissionBoardCardActionLinks(
			card({
				id: 'mission-1777402152963',
				status: 'completed',
				source: 'spark'
			})
		);

		expect(actions).toEqual({
			detailHref: '/kanban?mission=mission-1777402152963',
			canvasHref: null,
			traceHref: '/trace?missionId=mission-1777402152963',
			resultHref: '/kanban?mission=mission-1777402152963#result'
		});
	});

	it('preserves known canvas/detail links and strips stale hashes before result anchoring', () => {
		const actions = getMissionBoardCardActionLinks(
			card({
				id: 'mission 5/with spaces',
				status: 'running',
				detailHref: '/missions/custom-mission#old',
				canvasHref: '/canvas?pipeline=prd-5&mission=mission-5',
				providerResults: [{ providerId: 'codex', status: 'running', summary: 'Working' }]
			})
		);

		expect(actions.detailHref).toBe('/missions/custom-mission#old');
		expect(actions.canvasHref).toBe('/canvas?pipeline=prd-5&mission=mission-5');
		expect(actions.traceHref).toBe('/trace?missionId=mission%205%2Fwith%20spaces');
		expect(actions.resultHref).toBe('/missions/custom-mission#result');
	});

	it('hides the result action until a mission is terminal or has provider output', () => {
		const actions = getMissionBoardCardActionLinks(
			card({
				id: 'mission-running',
				status: 'running',
				source: 'spark'
			})
		);

		expect(actions.detailHref).toBe('/kanban?mission=mission-running');
		expect(actions.traceHref).toBe('/trace?missionId=mission-running');
		expect(actions.resultHref).toBeNull();
	});
});
