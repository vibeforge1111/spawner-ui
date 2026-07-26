import type { LoopEngineeringSchedule } from '$lib/server/loop-engineering-control-plane';

const TOKEN_LABELS: Record<string, string> = {
	adversary_clearance_not_passed: 'Adversarial challenge review has not passed',
	autoloop_round_not_passed: 'Autoloop round has not passed',
	baseline_candidate_randomization_missing: 'Baseline and candidate randomization is missing',
	blind_ab_scorecard_missing: 'Blind A/B scorecard is missing',
	blind_judge_score_not_passed: 'Blind judge score has not passed',
	blind_labels_hidden_missing: 'Blind labels were not hidden',
	candidate_not_kept: 'Candidate was not kept after review',
	chip_assisted_result_missing: 'Chip-assisted result is missing',
	chip_benefit_ab_not_passed: 'Chip benefit A/B review has not passed',
	chip_benefit_not_proven: 'Chip benefit is not proven yet',
	consumer_transfer_not_passed: 'Consumer transfer trial has not passed',
	evaluator_id_missing: 'Evaluator identity is missing',
	five_round_trend_missing: 'Five-round improvement trend is missing',
	generator_self_scored_not_false: 'Generator self-scoring has not been ruled out',
	hidden_case_content_in_chip: 'Hidden case content appears in the chip',
	judge_approved_no_safe_win_missing: 'No judge-approved safe win is recorded',
	local_telegram_fast_path_proof_missing: 'Local Telegram fast-path proof is missing',
	local_telegram_handler_missing: 'Local Telegram handler proof is missing',
	local_telegram_handler_passed: 'Local Telegram handler proof passed',
	live_telegram_proof_missing: 'Live Telegram proof is missing',
	long_loop_trend_not_passed: 'Long-loop trend has not passed',
	meaningful_utility_delta_not_observed: 'Meaningful utility delta was not observed',
	next_hypothesis_missing: 'Next improvement hypothesis is missing',
	no_chip_baseline_missing: 'No-chip baseline is missing',
	no_positive_score_delta: 'Positive score delta is missing',
	no_safe_win_accepted: 'No safe win accepted',
	operator_publication_approval_missing: 'Operator publication approval is missing',
	output_only_judge_missing: 'Output-only judge is missing',
	positive_utility_trend_missing: 'Positive utility trend is missing',
	proof_auditor_clearance_missing: 'Proof auditor clearance is missing',
	rollback_missing: 'Rollback is missing',
	rollback_not_executed: 'Rollback check has not run',
	rollback_readiness_not_passed: 'Rollback readiness has not passed',
	role_separation_missing: 'Generator and evaluator role separation is missing',
	round_cap_reached: 'Round cap reached',
	safety_clearance_not_passed: 'Safety clearance has not passed',
	same_budget_verification_missing: 'Same-budget verification is missing',
	sealed_case_pack_hash_missing: 'Sealed case-pack hash is missing',
	sealed_evaluation_not_supported: 'Sealed evaluation is not supported yet',
	sealed_evaluation_report_missing: 'Sealed evaluation report is missing',
	sealed_evaluation_report_schema_invalid: 'Sealed evaluation report schema is invalid',
	sealed_evaluation_result_missing: 'Sealed evaluator result is missing',
	sealed_report_signature_or_hash_missing: 'Sealed report signature or hash is missing',
	sealed_score_delta_missing: 'Sealed score delta is missing',
	starter_smoke_only: 'Only starter smoke evidence exists',
	watchtower_failed: 'Watchtower failed',
	watchtower_not_executed: 'Watchtower check has not run',
	watchtower_regression_not_passed: 'Watchtower regression has not passed',
	owner_paused: 'Owner paused the loop'
};

function humanDateTime(value: string | null | undefined): string | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return null;
	return new Date(parsed).toLocaleString([], {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

export function formatLoopEngineeringToken(value: string | null | undefined): string {
	const clean = String(value || '').trim();
	if (!clean) return 'Unknown';
	if (TOKEN_LABELS[clean]) return TOKEN_LABELS[clean];
	return clean
		.replace(/^domain-chip-/, '')
		.replace(/[_-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatLoopEngineeringList(values: string[], limit = 3): string {
	const visible = values.slice(0, limit).map(formatLoopEngineeringToken);
	const remaining = values.length - visible.length;
	return remaining > 0 ? `${visible.join(', ')} and ${remaining} more` : visible.join(', ');
}

export function formatLoopEngineeringSentence(value: string | null | undefined): string {
	const text = String(value || '').trim();
	if (!text) return '';
	const replaced = text.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/g, (token) => formatLoopEngineeringToken(token));
	return replaced.replace(/^Resolve blocker:\s*/i, 'Resolve: ');
}

export function formatLoopScheduleMode(schedule: Pick<LoopEngineeringSchedule, 'mode' | 'intervalMinutes' | 'fixedLocalTime'>): string {
	if (schedule.mode === 'interval') return schedule.intervalMinutes ? `Every ${schedule.intervalMinutes} min` : 'Interval';
	if (schedule.mode === 'fixed_time') return schedule.fixedLocalTime ? `At ${schedule.fixedLocalTime}` : 'Fixed time';
	if (schedule.mode === 'continuous') return 'Continuous private loop';
	if (schedule.mode === 'once') return 'Once';
	return 'Round count';
}

export function formatLoopScheduleTiming(schedule: Pick<
	LoopEngineeringSchedule,
	'mode' | 'intervalMinutes' | 'fixedLocalTime' | 'timezone' | 'roundLimit' | 'nextRunAt' | 'lastRunAt'
>): string {
	const parts = [formatLoopScheduleMode(schedule), `round cap ${schedule.roundLimit}`];
	if (schedule.timezone) parts.push(schedule.timezone);
	const nextRun = humanDateTime(schedule.nextRunAt);
	const lastRun = humanDateTime(schedule.lastRunAt);
	if (nextRun) parts.push(`next ${nextRun}`);
	if (lastRun) parts.push(`last ${lastRun}`);
	return parts.join(' · ');
}

export function scheduleOperatorSummary(schedule: Pick<
	LoopEngineeringSchedule,
	'active' | 'status' | 'runCount' | 'benchmarkCaseIds'
>): string {
	const selectedCases = schedule.benchmarkCaseIds?.length ?? 0;
	const runLabel = schedule.runCount === 1 ? '1 run' : `${schedule.runCount} runs`;
	if (schedule.status === 'cancelled') return `Cancelled after ${runLabel}. Stage a new schedule before running this loop again.`;
	if (schedule.status === 'deactivated') return `Deactivated after ${runLabel}. Review activation and schedule scope before reusing it.`;
	if (schedule.status === 'paused') return `Paused with ${selectedCases} selected case${selectedCases === 1 ? '' : 's'} and ${runLabel}.`;
	if (schedule.active) return `Active private schedule with ${selectedCases} selected case${selectedCases === 1 ? '' : 's'} and ${runLabel}.`;
	return `Staged but inactive with ${selectedCases} selected case${selectedCases === 1 ? '' : 's'} and ${runLabel}.`;
}
