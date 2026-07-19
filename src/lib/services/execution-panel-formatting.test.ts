import { describe, expect, it } from 'vitest';
import {
	formatExecutionDuration,
	getAgentStatusColor,
	getLogColor,
	getLogIcon,
	getStatusColor,
	getTaskBadgeClass,
	getTaskRowClass,
	getTransitionBadge,
	sortAgentRuntimeByFreshness,
	splitExecutionGoals
} from './execution-panel-formatting';

describe('execution panel formatting helpers', () => {
	it('parses real newlines and keeps literal backslash-n text intact', () => {
		expect(splitExecutionGoals('first\nsecond\r\n\n third ')).toEqual(['first', 'second', 'third']);
		expect(splitExecutionGoals('first\\nsecond')).toEqual(['first\\nsecond']);
	});

	it('sorts valid agent updates newest-first without jumbling invalid timestamps', () => {
		const agents = [
			{ agentId: 'invalid-a', status: 'running', updatedAt: 'not-a-date' },
			{ agentId: 'newest', status: 'completed', updatedAt: '2026-06-05T12:00:00Z' },
			{ agentId: 'invalid-b', status: 'idle', updatedAt: '' },
			{ agentId: 'older', status: 'running', updatedAt: '2026-06-05T11:00:00Z' }
		] as AgentRuntimeStatus[];

		expect(sortAgentRuntimeByFreshness(agents).map((agent) => agent.agentId)).toEqual([
			'newest', 'older', 'invalid-a', 'invalid-b'
		]);
		expect(agents.map((agent) => agent.agentId)).toEqual(['invalid-a', 'newest', 'invalid-b', 'older']);
	});

	it('maps log types to colors and glyphs', () => {
		expect(getLogColor('complete')).toBe('text-accent-primary');
		expect(getLogColor('error')).toBe('text-status-error');
		expect(getLogColor('handoff')).toBe('text-status-warning');
		expect(getLogColor('progress')).toBe('text-text-secondary');

		expect(getLogIcon('complete')).toBe('\u25a0');
		expect(getLogIcon('error')).toBe('\u2715');
		expect(getLogIcon('handoff')).toBe('\u25b8');
		expect(getLogIcon('start')).toBe('\u25b6');
		expect(getLogIcon('progress')).toBe('\u25aa');
	});

	it('maps execution and agent statuses to classes', () => {
		expect(getStatusColor('completed')).toBe('text-accent-primary');
		expect(getStatusColor('failed')).toBe('text-status-error');
		expect(getStatusColor('running')).toBe('text-vibe-teal');
		expect(getStatusColor('creating')).toBe('text-vibe-teal');
		expect(getStatusColor('paused')).toBe('text-blue-400');
		expect(getStatusColor('cancelled')).toBe('text-gray-400');
		expect(getStatusColor('idle')).toBe('text-text-secondary');

		expect(getAgentStatusColor('running')).toBe('text-vibe-teal border-vibe-teal/40 bg-vibe-teal/10');
		expect(getAgentStatusColor('completed')).toBe('text-accent-primary border-accent-primary/30 bg-accent-primary/10');
		expect(getAgentStatusColor('failed')).toBe('text-status-error border-status-error/30 bg-status-error/10');
		expect(getAgentStatusColor('cancelled')).toBe('text-status-warning border-status-warning/30 bg-status-warning/10');
		expect(getAgentStatusColor('idle')).toBe('text-text-tertiary border-surface-border bg-bg-tertiary');
	});

	it('maps transition states and task statuses to classes', () => {
		expect(getTransitionBadge('started')).toBe('bg-blue-500/20 text-blue-300');
		expect(getTransitionBadge('progress')).toBe('bg-vibe-teal/20 text-vibe-teal');
		expect(getTransitionBadge('completed')).toBe('bg-accent-primary/20 text-accent-primary');
		expect(getTransitionBadge('failed')).toBe('bg-status-error/20 text-status-error');
		expect(getTransitionBadge('cancelled')).toBe('bg-status-warning/20 text-status-warning');
		expect(getTransitionBadge('handoff')).toBe('bg-iris/20 text-iris');
		expect(getTransitionBadge('info')).toBe('bg-surface text-text-secondary');

		expect(getTaskRowClass('completed')).toBe('border-surface-border bg-bg-primary/80');
		expect(getTaskRowClass('running')).toBe('border-sky-400/40 bg-sky-400/10');
		expect(getTaskRowClass('failed')).toBe('border-status-error/40 bg-status-error/10');
		expect(getTaskRowClass('blocked')).toBe('border-status-warning/40 bg-status-warning/10');
		expect(getTaskRowClass('pending')).toBe('border-surface-border bg-bg-primary');

		expect(getTaskBadgeClass('completed')).toBe('bg-bg-secondary text-status-success border-status-success/30');
		expect(getTaskBadgeClass('running')).toBe('bg-sky-400/15 text-sky-300 border-sky-400/30');
		expect(getTaskBadgeClass('failed')).toBe('bg-status-error/20 text-status-error border-status-error/30');
		expect(getTaskBadgeClass('blocked')).toBe('bg-status-warning/20 text-status-warning border-status-warning/30');
		expect(getTaskBadgeClass('pending')).toBe('bg-surface text-text-tertiary border-surface-border');
	});

	it('formats execution duration from explicit timestamps', () => {
		const start = new Date('2026-04-29T00:00:00.000Z');
		expect(formatExecutionDuration(null)).toBe('0s');
		expect(formatExecutionDuration(start, new Date('2026-04-29T00:00:00.117Z'))).toBe('117ms');
		expect(formatExecutionDuration(start, new Date('2026-04-29T00:00:12.900Z'))).toBe('12s');
		expect(formatExecutionDuration(start, new Date('2026-04-29T00:02:05.000Z'))).toBe('2m 5s');
		expect(formatExecutionDuration(start, null, new Date('2026-04-29T00:01:01.000Z'))).toBe('1m 1s');
	});
});
