import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	listActivationRules,
	listBenchmarkCases,
	listDistillations,
	listLoopSchedules,
	listPersistedLoopEngineeringEvents,
	type LoopEngineeringActivationRule,
	type LoopEngineeringBenchmarkCase,
	type LoopEngineeringDistillation,
	type LoopEngineeringSchedule
} from './loop-engineering-control-plane';

type JsonRecord = Record<string, unknown>;

export type LoopChipStatus =
	| 'private_candidate'
	| 'local_fast_path'
	| 'loop_proven_private'
	| 'scaffolded'
	| 'blocked'
	| 'unknown';

export interface LoopEngineeringChipSummary {
	id: string;
	name: string;
	domain: string;
	rootPath: string;
	manifestIdentity: {
		declaredChipKey: string | null;
		effectiveChipKey: string;
		inferredFromFolder: boolean;
	};
	status: LoopChipStatus;
	statusLabel: string;
	visibility: 'private' | 'local' | 'unknown';
	benchmark: {
		status: string;
		primaryMetric: string | null;
		noChipScore: number | null;
		chipScore: number | null;
		utilityDelta: number | null;
		blindVerified: boolean;
		meaningfulDelta: boolean;
	};
	loop: {
		status: string;
		roundsObserved: number;
		requiredRounds: number;
		scoreDeltas: number[];
		longLoopSupported: boolean;
	};
	gates: {
		sealedEvaluator: boolean;
		watchtower: boolean;
		rollback: boolean;
		consumerTransfer: boolean;
		proofAuditor: boolean;
		uxScore: number | null;
	};
	activation: {
		telegramFirst: boolean;
		runtimeState: string | null;
		quickAnswerAllowed: boolean;
		reviewPacketAllowed: boolean;
		loopModeAllowed: boolean;
		liveTelegramProven: boolean;
	};
	scheduling: {
		hasScheduleContracts: boolean;
		supportedModes: string[];
	};
	blockers: string[];
	allowedClaimCount: number;
	disallowedClaimCount: number;
	nextAction: string;
	updatedAt: string | null;
	evidenceRefs: string[];
}
export type LoopEngineeringEventType =
	| 'benchmark_case_added'
	| 'benchmark_run'
	| 'loop_batch'
	| 'distillation'
	| 'evaluator_review'
	| 'watchtower_check'
	| 'rollback_check'
	| 'activation_gate'
	| 'activation_requested'
	| 'schedule_created'
	| 'schedule_lifecycle'
	| 'schedule_contract';

export type LoopEngineeringEventStatus = 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'missing';

export interface LoopEngineeringEvent {
	id: string;
	chipId: string;
	chipName: string;
	domain: string;
	eventType: LoopEngineeringEventType;
	label: string;
	status: LoopEngineeringEventStatus;
	sourceSurface: 'spawner' | 'telegram' | 'scheduler' | 'artifact';
	previousScore: number | null;
	candidateScore: number | null;
	utilityDelta: number | null;
	roundsObserved: number | null;
	evaluatorSeparated: boolean;
	provenance?: 'synthetic' | 'computed' | 'seeded' | null;
	evidenceRefs: string[];
	missionId?: string | null;
	completedAt?: string | null;
	sourceRef?: string | null;
	scheduleId?: string | null;
	evaluatorVerdictRef?: string | null;
	commandResult?: {
		action: string;
		chipKey?: string;
		changed: boolean;
		launchedMission: boolean;
		missionId?: string;
		eventId?: string;
		inspectUrl?: string;
		blockedReason?: string;
		caseCount?: number;
		userMessage: string;
	} | null;
	nextAction: string;
	updatedAt: string | null;
}

export type LoopReadinessStatus = 'passed' | 'attention' | 'blocked' | 'missing';

export interface LoopReadinessCheck {
	id: string;
	label: string;
	status: LoopReadinessStatus;
	detail: string;
	evidenceRefs: string[];
}

export interface LoopClaimEntry {
	claim: string;
	status?: string;
	reason?: string;
	evidenceRefs: string[];
}

export interface LoopEvidenceArtifact {
	ref: string;
	label: string;
	present: boolean;
	status: string | null;
}

export interface LoopEngineeringChipDetail {
	summary: LoopEngineeringChipSummary;
	events: LoopEngineeringEvent[];
	benchmarkCases: LoopEngineeringBenchmarkCase[];
	schedules: LoopEngineeringSchedule[];
	activationRules: LoopEngineeringActivationRule[];
	distillations: LoopEngineeringDistillation[];
	readiness: {
		status: 'local_fast_path_supported' | 'private_candidate_supported' | 'needs_loop_evidence' | 'telegram_activation_blocked';
		label: string;
		checks: LoopReadinessCheck[];
		passCount: number;
		totalCount: number;
		blockedCount: number;
		nextAction: string;
	};
	claims: {
		allowed: LoopClaimEntry[];
		disallowed: LoopClaimEntry[];
	};
	runtime: {
		state: string | null;
		distilledLessons: string[];
		reloopTriggers: string[];
		blockedActions: string[];
		requiredProofBeforeRuntime: string[];
	};
	evidenceArtifacts: LoopEvidenceArtifact[];
}

export interface LoopEngineeringRegistry {
	chipsRoot: string;
	generatedAt: string;
	chips: LoopEngineeringChipSummary[];
	events: LoopEngineeringEvent[];
	summary: {
		total: number;
		resultEvents: number;
		privateCandidates: number;
		localFastPaths: number;
		benchmarkPasses: number;
		longLoopPasses: number;
		liveTelegramProven: number;
		blocked: number;
	};
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boolValue(value: unknown): boolean {
	return value === true;
}

function stringList(value: unknown): string[] {
	return asArray(value).filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

async function readJson(filePath: string): Promise<JsonRecord | null> {
	try {
		return asRecord(JSON.parse(await fs.readFile(filePath, 'utf-8')));
	} catch {
		return null;
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile();
	} catch {
		return false;
	}
}

async function fileMtime(filePath: string): Promise<string | null> {
	try {
		const stat = await fs.stat(filePath);
		return stat.mtime.toISOString();
	} catch {
		return null;
	}
}

async function latestJsonInDir(dirPath: string): Promise<JsonRecord | null> {
	try {
		const files = await fs.readdir(dirPath, { withFileTypes: true });
		const jsonFiles = files
			.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
			.map((entry) => path.join(dirPath, entry.name));
		const stats = await Promise.all(
			jsonFiles.map(async (filePath) => ({ filePath, updatedAt: await fileMtime(filePath) }))
		);
		stats.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
		return stats[0] ? readJson(stats[0].filePath) : null;
	} catch {
		return null;
	}
}

function statusFromEvidence(input: {
	benefit: JsonRecord;
	trend: JsonRecord;
	gate: JsonRecord;
	runtime: JsonRecord;
	blockers: string[];
}): LoopChipStatus {
	const runtimeState = stringValue(input.runtime.runtime_state);
	if (runtimeState?.includes('local_telegram_handler_passed')) return 'local_fast_path';
	if (boolValue(input.gate.private_candidate_supported)) return 'private_candidate';
	if (boolValue(input.trend.long_loop_supported) && boolValue(input.benefit.chip_benefit_supported)) {
		return 'loop_proven_private';
	}
	if (input.blockers.length > 0) return 'blocked';
	return Object.keys(input.benefit).length || Object.keys(input.trend).length || Object.keys(input.gate).length
		? 'scaffolded'
		: 'unknown';
}

function statusLabel(status: LoopChipStatus): string {
	switch (status) {
		case 'local_fast_path':
			return 'Usable locally';
		case 'private_candidate':
			return 'Private candidate';
		case 'loop_proven_private':
			return 'Private proof ready';
		case 'scaffolded':
			return 'Scaffolded';
		case 'blocked':
			return 'Blocked';
		default:
			return 'Unknown';
	}
}

function nextActionForChip(chip: Pick<LoopEngineeringChipSummary, 'activation' | 'blockers' | 'benchmark' | 'loop' | 'gates'>): string {
	if (chip.blockers.length > 0) return `Resolve blocker: ${chip.blockers[0]}`;
	if (!chip.benchmark.blindVerified) return 'Run a blind benchmark with the same budget';
	if (!chip.loop.longLoopSupported) return 'Run saved self-improvement rounds';
	if (!chip.gates.watchtower) return 'Run a regression check';
	if (!chip.gates.rollback) return 'Add rollback proof';
	if (!chip.activation.liveTelegramProven) return 'Capture live Telegram proof before broader activation';
	return 'Ready for operator activation review';
}

function eventStatus(value: boolean, fallbackBlocked = false): LoopEngineeringEventStatus {
	if (value) return 'passed';
	return fallbackBlocked ? 'blocked' : 'missing';
}

function meaningfulBenchmarkDelta(benefit: JsonRecord): boolean {
	if (boolValue(benefit.meaningful_utility_delta)) return true;
	if (!boolValue(benefit.chip_benefit_supported)) return false;
	const delta = numberValue(benefit.effective_utility_delta) ?? numberValue(benefit.utility_delta) ?? numberValue(benefit.judged_utility_delta);
	return typeof delta === 'number' && delta > 0;
}

function eventsForChip(summary: LoopEngineeringChipSummary): LoopEngineeringEvent[] {
	const benchmarkPassed = summary.benchmark.status === 'pass' && summary.benchmark.blindVerified && summary.benchmark.meaningfulDelta;
	const longLoopPassed = summary.loop.longLoopSupported && summary.loop.roundsObserved >= Math.max(5, summary.loop.requiredRounds || 5);
	const activationBlocked = !summary.activation.liveTelegramProven || summary.blockers.length > 0;
	const base = {
		chipId: summary.id,
		chipName: summary.name,
		domain: summary.domain,
		sourceSurface: 'artifact' as const,
		updatedAt: summary.updatedAt
	};
	return [
		{
			...base,
			id: `${summary.id}:benchmark`,
			eventType: 'benchmark_run',
			label: 'Benchmark A/B',
			status: eventStatus(benchmarkPassed),
			previousScore: summary.benchmark.noChipScore,
			candidateScore: summary.benchmark.chipScore,
			utilityDelta: summary.benchmark.utilityDelta,
			roundsObserved: null,
			evaluatorSeparated: summary.benchmark.blindVerified,
			evidenceRefs: ['reports/chip-benefit-ab.json'],
			nextAction: benchmarkPassed ? 'Use this benchmark as activation evidence.' : 'Run a blind same-budget benchmark with separated evaluation.'
		},
		{
			...base,
			id: `${summary.id}:loop`,
			eventType: 'loop_batch',
			label: 'Self-improvement loop',
			status: eventStatus(longLoopPassed),
			previousScore: null,
			candidateScore: summary.benchmark.chipScore,
			utilityDelta: summary.benchmark.utilityDelta,
			roundsObserved: summary.loop.roundsObserved,
			evaluatorSeparated: summary.gates.sealedEvaluator,
			evidenceRefs: ['reports/long-loop-trend.json'],
			nextAction: longLoopPassed ? 'Distill durable lessons into the runtime fast path.' : 'Run five bounded improvement rounds or record a judged no-safe-win.'
		},
		{
			...base,
			id: `${summary.id}:evaluator`,
			eventType: 'evaluator_review',
			label: 'Separated evaluator',
			status: eventStatus(summary.gates.sealedEvaluator),
			previousScore: null,
			candidateScore: null,
			utilityDelta: null,
			roundsObserved: null,
			evaluatorSeparated: summary.gates.sealedEvaluator,
			evidenceRefs: ['reports/r30-controlled-loop/sealed-evaluator-report-v2.json', 'reports/sealed-evaluation-binding.json'],
			nextAction: summary.gates.sealedEvaluator ? 'Keep evaluator separation on future loop runs.' : 'Bind a separated evaluator before counting improvement.'
		},
		{
			...base,
			id: `${summary.id}:watchtower`,
			eventType: 'watchtower_check',
			label: 'Watchtower',
			status: eventStatus(summary.gates.watchtower),
			previousScore: null,
			candidateScore: null,
			utilityDelta: null,
			roundsObserved: null,
			evaluatorSeparated: true,
			evidenceRefs: ['reports/watchtower-check.json'],
			nextAction: summary.gates.watchtower ? 'Watchtower supports keeping the current candidate.' : 'Run watchtower before activation or scheduling.'
		},
		{
			...base,
			id: `${summary.id}:rollback`,
			eventType: 'rollback_check',
			label: 'Rollback',
			status: eventStatus(summary.gates.rollback),
			previousScore: null,
			candidateScore: null,
			utilityDelta: null,
			roundsObserved: null,
			evaluatorSeparated: true,
			evidenceRefs: ['reports/rollback-check.json'],
			nextAction: summary.gates.rollback ? 'Rollback is available for the current candidate.' : 'Bind rollback before activation or recurring schedules.'
		},
		{
			...base,
			id: `${summary.id}:activation`,
			eventType: 'activation_gate',
			label: 'Activation gate',
			status: eventStatus(summary.activation.liveTelegramProven && summary.blockers.length === 0, activationBlocked),
			previousScore: null,
			candidateScore: null,
			utilityDelta: null,
			roundsObserved: null,
			evaluatorSeparated: summary.gates.sealedEvaluator,
			evidenceRefs: ['distilled-runtime/*.json', 'reports/r30-controlled-loop/final-allowed-disallowed-claims-matrix.json'],
			nextAction: summary.nextAction
		},
		{
			...base,
			id: `${summary.id}:schedule`,
			eventType: 'schedule_contract',
			label: 'Schedule contract',
			status: eventStatus(summary.scheduling.hasScheduleContracts),
			previousScore: null,
			candidateScore: null,
			utilityDelta: null,
			roundsObserved: summary.loop.roundsObserved,
			evaluatorSeparated: summary.gates.sealedEvaluator,
			evidenceRefs: ['spark-chip.json'],
			nextAction: summary.scheduling.hasScheduleContracts ? 'Schedule controls can be staged after authority gates land.' : 'Add loop command contracts before scheduling.'
		}
	];
}

function sortLoopEngineeringEvents(events: LoopEngineeringEvent[]): LoopEngineeringEvent[] {
	const statusRank: Record<LoopEngineeringEventStatus, number> = { blocked: 0, failed: 1, missing: 2, queued: 3, running: 4, passed: 5 };
	const eventRank: Record<LoopEngineeringEventType, number> = {
		benchmark_case_added: 0,
		benchmark_run: 1,
		loop_batch: 2,
		distillation: 3,
		evaluator_review: 4,
		watchtower_check: 5,
		rollback_check: 6,
		activation_gate: 7,
		activation_requested: 8,
		schedule_created: 9,
		schedule_lifecycle: 10,
		schedule_contract: 11
	};
	const eventTime = (event: LoopEngineeringEvent): number => {
		const value = event.completedAt ?? event.updatedAt;
		const time = value ? Date.parse(value) : NaN;
		return Number.isFinite(time) ? time : 0;
	};
	return [...events].sort((a, b) => {
		return (
			eventTime(b) - eventTime(a) ||
			statusRank[a.status] - statusRank[b.status] ||
			a.domain.localeCompare(b.domain) ||
			eventRank[a.eventType] - eventRank[b.eventType] ||
			a.label.localeCompare(b.label)
		);
	});
}

function trustedComputedEvent(events: LoopEngineeringEvent[], eventType: LoopEngineeringEventType): LoopEngineeringEvent | null {
	return sortLoopEngineeringEvents(events)
		.find((event) =>
			event.eventType === eventType &&
			event.status === 'passed' &&
			event.evaluatorSeparated === true &&
			event.provenance === 'computed'
		) ?? null;
}

function withoutResolvedBlockers(blockers: string[], resolved: string[]): string[] {
	const resolvedSet = new Set(resolved);
	return blockers.filter((blocker) => !resolvedSet.has(blocker));
}

function applyPersistedEvidenceOverlay(summary: LoopEngineeringChipSummary, events: LoopEngineeringEvent[]): LoopEngineeringChipSummary {
	if (events.length === 0) return summary;
	const benchmark = trustedComputedEvent(events, 'benchmark_run');
	const loop = trustedComputedEvent(events, 'loop_batch');
	const evaluator = trustedComputedEvent(events, 'evaluator_review');
	const evidenceRefs = new Set(summary.evidenceRefs);
	let blockers = [...summary.blockers];

	if (benchmark) {
		for (const ref of benchmark.evidenceRefs) evidenceRefs.add(ref);
		summary.benchmark = {
			...summary.benchmark,
			status: 'pass',
			noChipScore: benchmark.previousScore ?? summary.benchmark.noChipScore,
			chipScore: benchmark.candidateScore ?? summary.benchmark.chipScore,
			utilityDelta: benchmark.utilityDelta ?? summary.benchmark.utilityDelta,
			blindVerified: true,
			meaningfulDelta: (benchmark.utilityDelta ?? 0) > 0 || summary.benchmark.meaningfulDelta
		};
		summary.gates = { ...summary.gates, sealedEvaluator: true };
		blockers = withoutResolvedBlockers(blockers, [
			'no_chip_baseline_missing',
			'chip_assisted_result_missing',
			'blind_ab_scorecard_missing',
			'same_budget_verification_missing',
			'chip_benefit_not_proven',
			'sealed_evaluation_result_missing'
		]);
	}

	if (loop) {
		for (const ref of loop.evidenceRefs) evidenceRefs.add(ref);
		const roundsObserved = Math.max(summary.loop.roundsObserved, loop.roundsObserved ?? 0);
		const requiredRounds = summary.loop.requiredRounds || 5;
		const positiveDelta = (loop.utilityDelta ?? 0) > 0 || (summary.benchmark.utilityDelta ?? 0) > 0;
		const longLoopSupported = roundsObserved >= Math.max(5, requiredRounds) && positiveDelta;
		summary.loop = {
			...summary.loop,
			status: loop.status,
			roundsObserved,
			requiredRounds,
			scoreDeltas: loop.utilityDelta === null || loop.utilityDelta === undefined
				? summary.loop.scoreDeltas
				: [...summary.loop.scoreDeltas, loop.utilityDelta],
			longLoopSupported: summary.loop.longLoopSupported || longLoopSupported
		};
		summary.gates = { ...summary.gates, sealedEvaluator: true };
		if (summary.loop.longLoopSupported) {
			blockers = withoutResolvedBlockers(blockers, [
				'five_round_trend_missing',
				'positive_utility_trend_missing',
				'sealed_evaluation_result_missing'
			]);
		}
	}

	if (evaluator) {
		for (const ref of evaluator.evidenceRefs) evidenceRefs.add(ref);
		summary.gates = { ...summary.gates, sealedEvaluator: true };
		blockers = withoutResolvedBlockers(blockers, ['sealed_evaluation_result_missing']);
	}

	summary.blockers = blockers;
	if (summary.benchmark.meaningfulDelta && summary.loop.longLoopSupported) {
		summary.status = 'loop_proven_private';
	} else if (benchmark || loop || evaluator) {
		summary.status = 'private_candidate';
	}
	summary.statusLabel = statusLabel(summary.status);
	summary.visibility = summary.visibility === 'unknown' && (benchmark || loop || evaluator) ? 'private' : summary.visibility;
	summary.evidenceRefs = [...evidenceRefs];
	summary.nextAction = nextActionForChip(summary);
	return summary;
}

function readinessStatus(value: boolean, blocked = false): LoopReadinessStatus {
	if (value) return 'passed';
	return blocked ? 'blocked' : 'missing';
}

function supportedScheduleModes(manifest: JsonRecord, runtime: JsonRecord): string[] {
	const modes = new Set<string>();
	const commands = asRecord(manifest.commands);
	if (commands['loop-round']) modes.add('round_count');
	if (commands['long-loop-trend']) modes.add('score_plateau');
	if (boolValue(runtime.telegram_first)) modes.add('telegram_triggered');
	if (asArray(runtime.reloop_triggers).length > 0) modes.add('triggered_reloop');
	return [...modes];
}

async function summarizeChip(rootPath: string, persistedEvents: LoopEngineeringEvent[] = []): Promise<LoopEngineeringChipSummary | null> {
	const id = path.basename(rootPath);
	const manifest = (await readJson(path.join(rootPath, 'spark-chip.json'))) ?? {};
	if (Object.keys(manifest).length === 0) return null;
	const declaredChipKey = stringValue(manifest.chip_key);
	const effectiveChipKey = safeChipId(declaredChipKey || '') === id ? declaredChipKey as string : id;
	const inferredFromFolder = declaredChipKey !== effectiveChipKey;

	const benefit = (await readJson(path.join(rootPath, 'reports', 'chip-benefit-ab.json'))) ?? {};
	const trend = (await readJson(path.join(rootPath, 'reports', 'long-loop-trend.json'))) ?? {};
	const watchtower = (await readJson(path.join(rootPath, 'reports', 'watchtower-check.json'))) ?? {};
	const rollback = (await readJson(path.join(rootPath, 'reports', 'rollback-check.json'))) ?? {};
	const transfer = (await readJson(path.join(rootPath, 'reports', 'consumer-transfer-trial-binding.json'))) ?? {};
	const proof = (await readJson(path.join(rootPath, 'reports', 'proof-auditor-check.json'))) ?? {};
	const gate = (await readJson(path.join(rootPath, 'reports', 'loop-gate-check.json'))) ?? {};
	const claims =
		(await readJson(path.join(rootPath, 'reports', 'r30-controlled-loop', 'final-allowed-disallowed-claims-matrix.json'))) ??
		{};
	const runtime = (await latestJsonInDir(path.join(rootPath, 'distilled-runtime'))) ?? {};
	const hardBlockers = [...stringList(gate.hard_blockers), ...stringList(benefit.hard_blockers), ...stringList(trend.hard_blockers)];
	const status = statusFromEvidence({ benefit, trend, gate, runtime, blockers: hardBlockers });
	const runtimeModes = asRecord(runtime.runtime_modes);
	const quickAnswer = asRecord(runtimeModes.quick_answer);
	const reviewPacket = asRecord(runtimeModes.review_packet);
	const loopMode = asRecord(runtimeModes.loop_mode);
	const commands = asRecord(manifest.commands);
	const evidenceRefs = [
		boolValue(benefit.chip_benefit_supported) ? 'reports/chip-benefit-ab.json' : null,
		boolValue(trend.long_loop_supported) ? 'reports/long-loop-trend.json' : null,
		boolValue(gate.private_candidate_supported) ? 'reports/loop-gate-check.json' : null,
		boolValue(watchtower.watchtower_executed) ? 'reports/watchtower-check.json' : null,
		boolValue(rollback.rollback_executed) ? 'reports/rollback-check.json' : null,
		Object.keys(runtime).length ? stringValue(runtime.runtime_path) ?? 'distilled-runtime/*.json' : null
	].filter((item): item is string => Boolean(item));

	const partial: LoopEngineeringChipSummary = {
		id,
		name: stringValue(manifest.chip_name) ?? id,
		domain: stringValue(benefit.domain) ?? stringValue(trend.domain) ?? stringValue(gate.domain) ?? id.replace(/^domain-chip-/, ''),
		rootPath,
		manifestIdentity: {
			declaredChipKey,
			effectiveChipKey,
			inferredFromFolder
		},
		status,
		statusLabel: statusLabel(status),
		visibility: boolValue(gate.promotion_blocked) || boolValue(benefit.promotion_blocked) ? 'private' : 'unknown',
		benchmark: {
			status: stringValue(benefit.ab_status) ?? 'missing',
			primaryMetric: stringValue(benefit.primary_metric),
			noChipScore: numberValue(benefit.no_chip_score),
			chipScore: numberValue(benefit.chip_assisted_score),
			utilityDelta: numberValue(benefit.effective_utility_delta) ?? numberValue(benefit.utility_delta),
			blindVerified: boolValue(benefit.blind_evaluation_verified),
			meaningfulDelta: meaningfulBenchmarkDelta(benefit)
		},
		loop: {
			status: stringValue(trend.trend_status) ?? 'missing',
			roundsObserved: numberValue(trend.rounds_observed) ?? 0,
			requiredRounds: numberValue(trend.required_rounds) ?? numberValue(asRecord(commands['long-loop-trend']).required_rounds) ?? 0,
			scoreDeltas: asArray(trend.score_deltas).filter((value): value is number => typeof value === 'number' && Number.isFinite(value)),
			longLoopSupported: boolValue(trend.long_loop_supported)
		},
		gates: {
			sealedEvaluator: boolValue(gate.sealed_evaluation_supported) || boolValue(gate.sealed_evaluation_bound),
			watchtower: stringValue(watchtower.watchtower_status) === 'passed' || boolValue(gate.watchtower_executed),
			rollback: stringValue(rollback.rollback_status) === 'passed' || boolValue(gate.rollback_executed),
			consumerTransfer: boolValue(gate.consumer_transfer_passed) || boolValue(transfer.transfer_supported) || boolValue(transfer.consumer_transfer_passed),
			proofAuditor: boolValue(gate.proof_auditor_passed) || boolValue(proof.proof_auditor_passed),
			uxScore: numberValue(gate.ux_readability_score)
		},
		activation: {
			telegramFirst: boolValue(runtime.telegram_first),
			runtimeState: stringValue(runtime.runtime_state),
			quickAnswerAllowed: boolValue(quickAnswer.allowed_now),
			reviewPacketAllowed: boolValue(reviewPacket.allowed_now),
			loopModeAllowed: boolValue(loopMode.allowed_now),
			liveTelegramProven: !String(stringValue(runtime.runtime_state) ?? '').includes('live_telegram_unproven')
				&& (boolValue(quickAnswer.allowed_now) || boolValue(reviewPacket.allowed_now))
		},
		scheduling: {
			hasScheduleContracts: Boolean(commands['loop-round'] || commands['long-loop-trend']),
			supportedModes: supportedScheduleModes(manifest, runtime)
		},
		blockers: hardBlockers,
		allowedClaimCount: asArray(claims.allowed_claims).length,
		disallowedClaimCount: asArray(claims.disallowed_claims).length,
		nextAction: '',
		updatedAt: await fileMtime(path.join(rootPath, 'spark-chip.json')),
		evidenceRefs
	};
	partial.nextAction = nextActionForChip(partial);
	return applyPersistedEvidenceOverlay(partial, persistedEvents);
}

export function defaultLoopEngineeringChipsRoot(env: Record<string, string | undefined> = process.env): string {
	return path.resolve(env.SPARK_DOMAIN_CHIPS_ROOT || path.join(os.homedir(), '.spark', 'chips'));
}

export async function listLoopEngineeringChips(options: { chipsRoot?: string } = {}): Promise<LoopEngineeringRegistry> {
	const chipsRoot = path.resolve(options.chipsRoot || defaultLoopEngineeringChipsRoot());
	let entries: string[] = [];
	try {
		entries = (await fs.readdir(chipsRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && entry.name.startsWith('domain-chip-'))
			.map((entry) => path.join(chipsRoot, entry.name));
	} catch {
		entries = [];
	}
	const persistedEvents = await listPersistedLoopEngineeringEvents();
	const persistedByChip = new Map<string, LoopEngineeringEvent[]>();
	for (const event of persistedEvents) {
		const existing = persistedByChip.get(event.chipId) ?? [];
		existing.push(event);
		persistedByChip.set(event.chipId, existing);
	}
	const chips = (await Promise.all(entries.map((entry) => summarizeChip(entry, persistedByChip.get(path.basename(entry)) ?? []))))
		.filter((chip): chip is LoopEngineeringChipSummary => Boolean(chip))
		.sort((a, b) => {
			const statusRank: Record<LoopChipStatus, number> = {
				local_fast_path: 0,
				private_candidate: 1,
				loop_proven_private: 2,
				blocked: 3,
				scaffolded: 4,
				unknown: 5
			};
			return statusRank[a.status] - statusRank[b.status] || a.name.localeCompare(b.name);
		});
	const events = sortLoopEngineeringEvents([...persistedEvents, ...chips.flatMap(eventsForChip)]);
	return {
		chipsRoot,
		generatedAt: new Date().toISOString(),
		chips,
		events,
		summary: {
			total: chips.length,
			resultEvents: events.length,
			privateCandidates: chips.filter((chip) => chip.status === 'private_candidate').length,
			localFastPaths: chips.filter((chip) => chip.status === 'local_fast_path').length,
			benchmarkPasses: chips.filter((chip) => chip.benchmark.status === 'pass').length,
			longLoopPasses: chips.filter((chip) => chip.loop.longLoopSupported).length,
			liveTelegramProven: chips.filter((chip) => chip.activation.liveTelegramProven).length,
			blocked: chips.filter((chip) => chip.blockers.length > 0).length
		}
	};
}

function safeChipId(chipId: string): string | null {
	const clean = chipId.trim();
	if (!clean || clean.includes('/') || clean.includes('\\') || clean === '.' || clean === '..') return null;
	if (!clean.startsWith('domain-chip-')) return null;
	return clean;
}

function claimEntries(value: unknown): LoopClaimEntry[] {
	return asArray(value).map((item) => {
		const record = asRecord(item);
		return {
			claim: stringValue(record.claim) ?? 'Unnamed claim',
			status: stringValue(record.status) ?? undefined,
			reason: stringValue(record.reason) ?? undefined,
			evidenceRefs: stringList(record.evidence_refs ?? record.blocking_refs)
		};
	});
}

function artifactStatus(record: JsonRecord, statusKeys: string[]): string | null {
	for (const key of statusKeys) {
		const value = stringValue(record[key]);
		if (value) return value;
	}
	if (boolValue(record.private_candidate_supported)) return 'private_candidate_supported';
	if (boolValue(record.chip_benefit_supported)) return 'chip_benefit_supported';
	if (boolValue(record.long_loop_supported)) return 'long_loop_supported';
	return null;
}

async function buildEvidenceArtifacts(rootPath: string, evidence: Record<string, JsonRecord>): Promise<LoopEvidenceArtifact[]> {
	const artifacts: Array<{ ref: string; label: string; record: JsonRecord; statusKeys: string[] }> = [
		{ ref: 'reports/chip-benefit-ab.json', label: 'Benchmark A/B', record: evidence.benefit, statusKeys: ['ab_status'] },
		{ ref: 'reports/long-loop-trend.json', label: 'Long-loop trend', record: evidence.trend, statusKeys: ['trend_status'] },
		{
			ref: 'reports/r30-controlled-loop/sealed-evaluator-report-v2.json',
			label: 'Sealed evaluator',
			record: evidence.sealed,
			statusKeys: ['status', 'evaluation_status']
		},
		{ ref: 'reports/watchtower-check.json', label: 'Watchtower', record: evidence.watchtower, statusKeys: ['watchtower_status'] },
		{ ref: 'reports/rollback-check.json', label: 'Rollback', record: evidence.rollback, statusKeys: ['rollback_status'] },
		{
			ref: 'reports/consumer-transfer-trial-binding.json',
			label: 'Cold consumer transfer',
			record: evidence.transfer,
			statusKeys: ['transfer_status', 'binding_status']
		},
		{ ref: 'reports/proof-auditor-check.json', label: 'Proof auditor', record: evidence.proof, statusKeys: ['proof_auditor_status', 'status'] },
		{ ref: 'reports/loop-gate-check.json', label: 'Loop gate', record: evidence.gate, statusKeys: ['gate_status'] },
		{
			ref: 'reports/r30-controlled-loop/final-allowed-disallowed-claims-matrix.json',
			label: 'Claims matrix',
			record: evidence.claims,
			statusKeys: ['objective_status']
		}
	];
	return Promise.all(
		artifacts.map(async (artifact) => ({
			ref: artifact.ref,
			label: artifact.label,
			present: await fileExists(path.join(rootPath, artifact.ref)),
			status: artifactStatus(artifact.record, artifact.statusKeys)
		}))
	);
}

function readinessForChip(summary: LoopEngineeringChipSummary): LoopEngineeringChipDetail['readiness'] {
	const benchmarkPassed = summary.benchmark.status === 'pass' && summary.benchmark.blindVerified && summary.benchmark.meaningfulDelta;
	const fiveRoundLoopPassed =
		summary.loop.longLoopSupported &&
		summary.loop.roundsObserved >= Math.max(5, summary.loop.requiredRounds || 5);
	const uxPassed = typeof summary.gates.uxScore === 'number' && summary.gates.uxScore >= 9;
	const localTelegramHandler = Boolean(summary.activation.runtimeState?.includes('local_telegram_handler_passed'));
	const hasHardBlockers = summary.blockers.length > 0;
	const liveTelegramProof = summary.activation.liveTelegramProven;
	const checks: LoopReadinessCheck[] = [
		{
			id: 'manifest_identity',
			label: 'Manifest identity',
			status: summary.manifestIdentity.inferredFromFolder ? 'attention' : 'passed',
			detail: summary.manifestIdentity.inferredFromFolder
				? `Spawner is using the folder key ${summary.manifestIdentity.effectiveChipKey}; spark-chip.json should declare the same chip_key before stronger activation claims.`
				: 'spark-chip.json declares the same chip_key Spawner uses.',
			evidenceRefs: ['spark-chip.json']
		},
		{
			id: 'private_candidate',
			label: 'Private candidate',
			status: readinessStatus(summary.status === 'private_candidate' || summary.status === 'local_fast_path' || summary.status === 'loop_proven_private'),
			detail: 'The chip has a private candidate or stronger local evidence state.',
			evidenceRefs: ['reports/loop-gate-check.json']
		},
		{
			id: 'benchmark_ab',
			label: 'No-chip vs chip A/B',
			status: readinessStatus(benchmarkPassed),
			detail: benchmarkPassed
				? `Blind same-budget A/B passed with delta ${summary.benchmark.utilityDelta ?? 'n/a'}.`
				: 'Needs a blind same-budget benchmark pass with meaningful delta or a judged no-safe-win.',
			evidenceRefs: ['reports/chip-benefit-ab.json']
		},
		{
			id: 'five_round_loop',
			label: 'Five-round autoloop',
			status: readinessStatus(fiveRoundLoopPassed),
			detail: fiveRoundLoopPassed
				? `${summary.loop.roundsObserved} persisted rounds support the long-loop trend.`
				: 'Needs five persisted rounds or a judge-approved no-safe-win decision.',
			evidenceRefs: ['reports/long-loop-trend.json']
		},
		{
			id: 'sealed_evaluator',
			label: 'Separated sealed evaluator',
			status: readinessStatus(summary.gates.sealedEvaluator),
			detail: 'Generator output must be judged by separated sealed evaluation evidence.',
			evidenceRefs: ['reports/r30-controlled-loop/sealed-evaluator-report-v2.json', 'reports/sealed-evaluation-binding.json']
		},
		{
			id: 'watchtower',
			label: 'Watchtower',
			status: readinessStatus(summary.gates.watchtower),
			detail: 'Regression watchtower evidence must be present and passing.',
			evidenceRefs: ['reports/watchtower-check.json']
		},
		{
			id: 'rollback',
			label: 'Rollback',
			status: readinessStatus(summary.gates.rollback),
			detail: 'Rollback readiness or survival decision must be bound.',
			evidenceRefs: ['reports/rollback-check.json']
		},
		{
			id: 'consumer_transfer',
			label: 'Cold consumer transfer',
			status: readinessStatus(summary.gates.consumerTransfer),
			detail: 'A cold consumer transfer trial must pass before broader claims.',
			evidenceRefs: ['reports/consumer-transfer-trial-binding.json']
		},
		{
			id: 'proof_auditor',
			label: 'Proof auditor',
			status: readinessStatus(summary.gates.proofAuditor),
			detail: 'A proof auditor packet must bind the evidence chain.',
			evidenceRefs: ['reports/proof-auditor-check.json']
		},
		{
			id: 'telegram_readability',
			label: 'Telegram readability',
			status: readinessStatus(uxPassed),
			detail: uxPassed ? `UX readability score is ${summary.gates.uxScore}/10.` : 'Needs a 9/10+ Telegram/onboarding readability score.',
			evidenceRefs: ['reports/ux-readability-check.json', 'reports/loop-gate-check.json']
		},
		{
			id: 'local_telegram_handler',
			label: 'Local Telegram fast path',
			status: readinessStatus(localTelegramHandler),
			detail: localTelegramHandler
				? 'Local Telegram handler evidence exists; this does not prove live Telegram Desktop activation.'
				: 'Needs local handler proof that fresh prompts route to the distilled fast path without rerunning the full loop.',
			evidenceRefs: ['distilled-runtime/*.json']
		},
		{
			id: 'live_telegram_proof',
			label: 'Live Telegram proof',
			status: readinessStatus(liveTelegramProof, true),
			detail: liveTelegramProof
				? 'Live Telegram route proof is present.'
				: 'Live Telegram Desktop route proof is still missing; stronger activation claims stay blocked.',
			evidenceRefs: ['distilled-runtime/*.json']
		},
		{
			id: 'hard_blockers',
			label: 'Hard blockers',
			status: hasHardBlockers ? 'blocked' : 'passed',
			detail: hasHardBlockers ? summary.blockers.slice(0, 3).join(', ') : 'No hard blockers are reported in the bound gates.',
			evidenceRefs: ['reports/loop-gate-check.json']
		}
	];
	const blockedCount = checks.filter((check) => check.status === 'blocked').length;
	const passCount = checks.filter((check) => check.status === 'passed').length;
	const coreLoopSupported =
		benchmarkPassed &&
		fiveRoundLoopPassed &&
		summary.gates.sealedEvaluator &&
		summary.gates.watchtower &&
		summary.gates.rollback &&
		summary.gates.consumerTransfer &&
		summary.gates.proofAuditor &&
		uxPassed;
	let status: LoopEngineeringChipDetail['readiness']['status'] = 'needs_loop_evidence';
	let label = 'Needs loop evidence';
	if (coreLoopSupported && localTelegramHandler && (blockedCount > 0 || !liveTelegramProof)) {
		status = 'telegram_activation_blocked';
		label = 'Telegram activation blocked';
	} else if (coreLoopSupported && localTelegramHandler) {
		status = 'local_fast_path_supported';
		label = 'Local fast path supported';
	} else if (coreLoopSupported) {
		status = 'private_candidate_supported';
		label = 'Private candidate supported';
	}
	return {
		status,
		label,
		checks,
		passCount,
		totalCount: checks.length,
		blockedCount,
		nextAction: summary.nextAction
	};
}

export async function getLoopEngineeringChipDetail(
	chipId: string,
	options: { chipsRoot?: string } = {}
): Promise<LoopEngineeringChipDetail | null> {
	const clean = safeChipId(chipId);
	if (!clean) return null;
	const chipsRoot = path.resolve(options.chipsRoot || defaultLoopEngineeringChipsRoot());
	const rootPath = path.join(chipsRoot, clean);
	if (path.dirname(rootPath) !== chipsRoot) return null;
	const persistedEvents = await listPersistedLoopEngineeringEvents(clean);
	const summary = await summarizeChip(rootPath, persistedEvents);
	if (!summary) return null;

	const evidence = {
		benefit: (await readJson(path.join(rootPath, 'reports', 'chip-benefit-ab.json'))) ?? {},
		trend: (await readJson(path.join(rootPath, 'reports', 'long-loop-trend.json'))) ?? {},
		watchtower: (await readJson(path.join(rootPath, 'reports', 'watchtower-check.json'))) ?? {},
		rollback: (await readJson(path.join(rootPath, 'reports', 'rollback-check.json'))) ?? {},
		transfer: (await readJson(path.join(rootPath, 'reports', 'consumer-transfer-trial-binding.json'))) ?? {},
		proof: (await readJson(path.join(rootPath, 'reports', 'proof-auditor-check.json'))) ?? {},
		gate: (await readJson(path.join(rootPath, 'reports', 'loop-gate-check.json'))) ?? {},
		sealed: (await readJson(path.join(rootPath, 'reports', 'r30-controlled-loop', 'sealed-evaluator-report-v2.json'))) ?? {},
		claims:
			(await readJson(path.join(rootPath, 'reports', 'r30-controlled-loop', 'final-allowed-disallowed-claims-matrix.json'))) ??
			{},
		runtime: (await latestJsonInDir(path.join(rootPath, 'distilled-runtime'))) ?? {}
	};
	return {
		summary,
		events: sortLoopEngineeringEvents([...persistedEvents, ...eventsForChip(summary)]),
		benchmarkCases: await listBenchmarkCases(summary.id, { includeArtifactCases: true, chipRoot: rootPath }),
		schedules: await listLoopSchedules(summary.id),
		activationRules: await listActivationRules(summary.id),
		distillations: await listDistillations(summary.id),
		readiness: readinessForChip(summary),
		claims: {
			allowed: claimEntries(evidence.claims.allowed_claims),
			disallowed: claimEntries(evidence.claims.disallowed_claims)
		},
		runtime: {
			state: stringValue(evidence.runtime.runtime_state),
			distilledLessons: stringList(evidence.runtime.distilled_lessons),
			reloopTriggers: stringList(evidence.runtime.reloop_triggers),
			blockedActions: stringList(evidence.runtime.blocked_actions),
			requiredProofBeforeRuntime: stringList(evidence.runtime.required_proof_before_runtime)
		},
		evidenceArtifacts: await buildEvidenceArtifacts(rootPath, evidence)
	};
}
