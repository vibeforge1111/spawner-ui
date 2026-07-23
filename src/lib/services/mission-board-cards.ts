import type {
	MissionControlCompletionEvidence,
	MissionControlProjectLineage,
	MissionControlTaskStatus,
	MissionControlTaskStatusCounts
} from '$lib/types/mission-control';
import { summarizeCompletionEvidenceForDisplay } from './completion-evidence-display';
import { isPreparationTaskTitle } from './execution-task-rows';

export type MissionBoardCardStatus = 'draft' | 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type MissionBoardCardSource = 'mcp' | 'spark';

export interface MissionBoardTaskSummary {
	title: string;
	skills: string[];
	status?: MissionControlTaskStatus;
}

export interface MissionBoardProviderResult {
	providerId: string;
	status: string;
	summary: string;
}

export interface MissionBoardCard {
	id: string;
	name: string;
	status: MissionBoardCardStatus;
	mode: string;
	source: MissionBoardCardSource;
	updatedAt: string | null;
	createdAt: string | null;
	lastEventType?: string | null;
	executionStarted?: boolean;
	executionPolicy?: string | null;
	queuedAt?: string | null;
	startedAt?: string | null;
	taskCount: number;
	taskStatusCounts?: MissionControlTaskStatusCounts;
	strategy?: string;
	taskNames?: string[];
	tasks?: MissionBoardTaskSummary[];
	summary?: string | null;
	providerSummary?: string | null;
	providerResults?: MissionBoardProviderResult[];
	completionEvidence?: MissionControlCompletionEvidence;
	projectLineage?: MissionControlProjectLineage | null;
	canvasHref?: string | null;
	detailHref?: string | null;
	repeatCount?: number;
}

export interface MissionBoardCardActionLinks {
	detailHref: string;
	canvasHref: string | null;
	traceHref: string;
	resultHref: string | null;
}

export interface MissionBoardWorkBreakdown {
	build: MissionControlTaskStatusCounts;
	preparation: MissionControlTaskStatusCounts;
	hasPreparation: boolean;
}

export function terminalMissionBoardColumnLabel(): string {
	return 'History';
}

export function activeMissionBoardColumnLabel(): string {
	return 'Active';
}

export interface MissionCanvasPipelineCandidate {
	id: string;
	name?: string | null;
}

function missionDetailHref(missionId: string): string {
	return `/kanban?mission=${encodeURIComponent(missionId)}`;
}

function withoutHash(href: string): string {
	return href.split('#')[0] || href;
}

function missionNumericSuffix(id: string): string {
	return id.replace(/^(spark|mission)-/, '');
}

export function canvasHrefForMissionControlEntry(
	missionId: string,
	pipelines: MissionCanvasPipelineCandidate[] = []
): string {
	const suffix = missionNumericSuffix(missionId);
	const pipeline = pipelines.find((candidate) => suffix && candidate.id.includes(suffix));
	return pipeline
		? `/canvas?pipeline=${encodeURIComponent(pipeline.id)}&mission=${encodeURIComponent(missionId)}`
		: `/canvas?mission=${encodeURIComponent(missionId)}`;
}

export function getMissionBoardCardActionLinks(
	card: Pick<MissionBoardCard, 'id' | 'canvasHref' | 'detailHref' | 'providerResults' | 'status'>
): MissionBoardCardActionLinks {
	const encodedMissionId = encodeURIComponent(card.id);
	const detailHref = card.detailHref ?? missionDetailHref(card.id);
	const hasTerminalResult = ['completed', 'failed', 'cancelled'].includes(card.status);
	const hasProviderResult = (card.providerResults?.length ?? 0) > 0;

	return {
		detailHref,
		canvasHref: card.canvasHref ?? null,
		traceHref: `/trace?missionId=${encodedMissionId}`,
		resultHref: hasTerminalResult || hasProviderResult ? `${withoutHash(detailHref)}#result` : null
	};
}

function latestTimestamp(a: string | null, b: string | null): string | null {
	if (!a) return b;
	if (!b) return a;
	const aMs = Date.parse(a);
	const bMs = Date.parse(b);
	const aValid = Number.isFinite(aMs);
	const bValid = Number.isFinite(bMs);
	if (aValid && bValid) return aMs >= bMs ? a : b;
	if (aValid) return a;
	if (bValid) return b;
	return a;
}

function mergeLiveWithStaticCard(live: MissionBoardCard, staticCard: MissionBoardCard): MissionBoardCard {
	return {
		...staticCard,
		...live,
		name: live.name || staticCard.name,
		status: live.status,
		source: live.source,
		mode: live.mode || staticCard.mode,
		updatedAt: latestTimestamp(live.updatedAt, staticCard.updatedAt),
		createdAt: live.createdAt || staticCard.createdAt,
		queuedAt: live.queuedAt ?? staticCard.queuedAt,
		startedAt: live.startedAt ?? staticCard.startedAt,
		lastEventType: live.lastEventType ?? staticCard.lastEventType,
		executionStarted: live.executionStarted ?? staticCard.executionStarted,
		taskCount: Math.max(live.taskCount || 0, staticCard.taskCount || 0),
		taskStatusCounts: live.taskStatusCounts ?? staticCard.taskStatusCounts,
		taskNames: live.taskNames?.length ? live.taskNames : staticCard.taskNames,
		tasks: live.tasks?.length ? live.tasks : staticCard.tasks,
		summary: live.summary ?? staticCard.summary,
		providerSummary: live.providerSummary ?? staticCard.providerSummary,
		providerResults: live.providerResults?.length ? live.providerResults : staticCard.providerResults,
		completionEvidence: live.completionEvidence ?? staticCard.completionEvidence,
		projectLineage: live.projectLineage ?? staticCard.projectLineage,
		canvasHref: live.canvasHref ?? staticCard.canvasHref,
		detailHref: live.detailHref ?? staticCard.detailHref
	};
}

export function mergeMissionBoardCards(
	liveCards: MissionBoardCard[],
	staticCards: MissionBoardCard[]
): MissionBoardCard[] {
	const byId = new Map<string, MissionBoardCard>();
	for (const card of liveCards) {
		byId.set(card.id, card);
	}

	for (const card of staticCards) {
		const live = byId.get(card.id);
		byId.set(card.id, live ? mergeLiveWithStaticCard(live, card) : card);
	}

	return [...byId.values()];
}

function repeatedTerminalCardKey(card: MissionBoardCard): string | null {
	if (!['completed', 'failed', 'cancelled'].includes(card.status)) return null;
	if (card.projectLineage?.projectPath || card.projectLineage?.previewUrl) return null;
	if ((card.taskCount || 0) <= 1) {
		return [card.status, card.name.trim().toLowerCase(), card.taskCount || 0].join('|');
	}
	const evidence = (card.providerSummary || card.summary || '').trim().toLowerCase();
	if (!evidence) return null;
	return [card.status, card.name.trim().toLowerCase(), card.taskCount || 0, evidence].join('|');
}

export function collapseRepeatedTerminalMissionCards(cards: MissionBoardCard[]): MissionBoardCard[] {
	const byKey = new Map<string, MissionBoardCard>();
	const collapsed: MissionBoardCard[] = [];

	for (const card of cards) {
		const key = repeatedTerminalCardKey(card);
		if (!key) {
			collapsed.push(card);
			continue;
		}

		const existing = byKey.get(key);
		if (!existing) {
			const firstEntry = { ...card, repeatCount: 0 };
			byKey.set(key, firstEntry);
			collapsed.push(firstEntry);
			continue;
		}

		existing.repeatCount = (existing.repeatCount || 0) + 1;
	}

	return collapsed;
}

export const summarizeCompletionEvidenceForBoard = summarizeCompletionEvidenceForDisplay;

function emptyCounts(): MissionControlTaskStatusCounts {
	return { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, total: 0 };
}

function addTaskToCounts(
	counts: MissionControlTaskStatusCounts,
	status: MissionControlTaskStatus | undefined
): void {
	const normalized = status || 'queued';
	counts[normalized] += 1;
	counts.total += 1;
}

export function getMissionBoardWorkBreakdown(card: MissionBoardCard): MissionBoardWorkBreakdown {
	const build = emptyCounts();
	const preparation = emptyCounts();
	const tasks = card.tasks || [];
	const hasTaskStatuses = tasks.some((task) => Boolean(task.status));

	if (tasks.length === 0 || (!hasTaskStatuses && card.taskStatusCounts)) {
		return {
			build: card.taskStatusCounts ?? {
				...emptyCounts(),
				queued: Math.max(0, card.taskCount || 0),
				total: Math.max(0, card.taskCount || 0)
			},
			preparation,
			hasPreparation: false
		};
	}

	for (const task of tasks) {
		addTaskToCounts(isPreparationTaskTitle(task.title) ? preparation : build, task.status);
	}

	return {
		build,
		preparation,
		hasPreparation: preparation.total > 0
	};
}

export function isCreatorMissionBoardCard(
	card: Pick<MissionBoardCard, 'id' | 'mode' | 'name'>
): boolean {
	return (
		card.id.startsWith('mission-creator-') ||
		card.mode === 'creator-mission' ||
		card.name.toLowerCase().startsWith('creator mission:')
	);
}

export function canRunCreatorMissionBoardCard(
	card: Pick<MissionBoardCard, 'id' | 'mode' | 'name' | 'status' | 'executionStarted' | 'executionPolicy'>
): boolean {
	if (!isCreatorMissionBoardCard(card)) return false;
	if (card.executionStarted) return false;
	if (card.executionPolicy === 'read_only') return false;
	return card.status !== 'completed' && card.status !== 'failed' && card.status !== 'cancelled' && card.status !== 'paused';
}

export function canValidateCreatorMissionBoardCard(
	card: Pick<MissionBoardCard, 'id' | 'mode' | 'name' | 'status'>
): boolean {
	if (!isCreatorMissionBoardCard(card)) return false;
	return card.status !== 'cancelled';
}

export function canShowMissionBoardProjectActions(
	card: Pick<MissionBoardCard, 'projectLineage'> & { status?: string | null }
): boolean {
	if (!card.projectLineage?.projectPath) return false;
	return card.status === 'completed' || card.status === 'failed' || card.status === 'cancelled';
}
