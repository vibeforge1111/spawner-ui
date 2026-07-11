import { describe, expect, it } from 'vitest';
import {
	formatLoopEngineeringList,
	formatLoopEngineeringSentence,
	formatLoopEngineeringToken,
	formatLoopScheduleMode,
	formatLoopScheduleTiming,
	scheduleOperatorSummary
} from './display';

describe('loop engineering display helpers', () => {
	it('formats schedule timing for operators without raw ISO timestamps', () => {
		const line = formatLoopScheduleTiming({
			mode: 'interval',
			intervalMinutes: 45,
			fixedLocalTime: null,
			timezone: 'Asia/Dubai',
			roundLimit: 3,
			nextRunAt: '2026-07-02T09:30:00.000Z',
			lastRunAt: '2026-07-01T13:43:44.737Z'
		});

		expect(line).toContain('Every 45 min');
		expect(line).toContain('round cap 3');
		expect(line).toContain('Asia/Dubai');
		expect(line).toContain('next');
		expect(line).toContain('last');
		expect(line).not.toContain('2026-07-02T09:30:00.000Z');
		expect(line).not.toContain('2026-07-01T13:43:44.737Z');
	});

	it('summarizes schedule state as a control-plane sentence', () => {
		expect(scheduleOperatorSummary({
			active: false,
			status: 'paused',
			runCount: 1,
			benchmarkCaseIds: ['case-a', 'case-b']
		})).toBe('Paused with 2 selected cases and 1 run.');

		expect(scheduleOperatorSummary({
			active: false,
			status: 'cancelled',
			runCount: 3,
			benchmarkCaseIds: ['case-a']
		})).toContain('Stage a new schedule');
	});

	it('turns internal schedule modes into readable labels', () => {
		expect(formatLoopScheduleMode({
			mode: 'round_count',
			intervalMinutes: null,
			fixedLocalTime: null
		})).toBe('Round count');
		expect(formatLoopScheduleMode({
			mode: 'continuous',
			intervalMinutes: null,
			fixedLocalTime: null
		})).toBe('Continuous private loop');
	});

	it('turns loop-engineering blocker tokens into operator-readable copy', () => {
		expect(formatLoopEngineeringToken('operator_publication_approval_missing')).toBe('Operator publication approval is missing');
		expect(formatLoopEngineeringToken('watchtower_regression_not_passed')).toBe('Watchtower regression has not passed');
		expect(formatLoopEngineeringSentence('Resolve blocker: operator_publication_approval_missing')).toBe('Resolve: Operator publication approval is missing');
		expect(formatLoopEngineeringList([
			'five_round_trend_missing',
			'positive_utility_trend_missing',
			'sealed_evaluation_result_missing',
			'watchtower_regression_not_passed'
		], 3)).toBe('Five-round improvement trend is missing, Positive utility trend is missing, Sealed evaluator result is missing and 1 more');
	});
});
