import type { MissionLog } from './mcp-client';
import type { AgentRuntimeStatus, ExecutionStatus, TaskTransitionEvent } from './mission-executor';
import type { TaskRowStatus } from './execution-task-rows';

export function splitExecutionGoals(text: string): string[] {
	return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function sortAgentRuntimeByFreshness(agents: AgentRuntimeStatus[]): AgentRuntimeStatus[] {
	const updatedMs = (value: string | null | undefined): number => {
		const parsed = Date.parse(value || '');
		return Number.isFinite(parsed) ? parsed : 0;
	};
	return agents.slice().sort((a, b) => updatedMs(b.updatedAt) - updatedMs(a.updatedAt));
}

export function getLogColor(type: MissionLog['type']): string {
	switch (type) {
		case 'complete':
			return 'text-accent-primary';
		case 'error':
			return 'text-status-error';
		case 'handoff':
			return 'text-status-warning';
		case 'start':
		case 'progress':
		default:
			return 'text-text-secondary';
	}
}

export function getLogIcon(type: MissionLog['type']): string {
	switch (type) {
		case 'complete':
			return '\u25a0';
		case 'error':
			return '\u2715';
		case 'handoff':
			return '\u25b8';
		case 'start':
			return '\u25b6';
		case 'progress':
		default:
			return '\u25aa';
	}
}

export function getStatusColor(status: ExecutionStatus): string {
	switch (status) {
		case 'completed':
			return 'text-accent-primary';
		case 'failed':
			return 'text-status-error';
		case 'running':
		case 'creating':
			return 'text-vibe-teal';
		case 'paused':
			return 'text-blue-400';
		case 'cancelled':
			return 'text-gray-400';
		default:
			return 'text-text-secondary';
	}
}

export function getAgentStatusColor(status: AgentRuntimeStatus['status']): string {
	switch (status) {
		case 'running':
			return 'text-vibe-teal border-vibe-teal/40 bg-vibe-teal/10';
		case 'completed':
			return 'text-accent-primary border-accent-primary/30 bg-accent-primary/10';
		case 'failed':
			return 'text-status-error border-status-error/30 bg-status-error/10';
		case 'cancelled':
			return 'text-status-warning border-status-warning/30 bg-status-warning/10';
		default:
			return 'text-text-tertiary border-surface-border bg-bg-tertiary';
	}
}

export function getTransitionBadge(state: TaskTransitionEvent['state']): string {
	switch (state) {
		case 'started':
			return 'bg-blue-500/20 text-blue-300';
		case 'progress':
			return 'bg-vibe-teal/20 text-vibe-teal';
		case 'completed':
			return 'bg-accent-primary/20 text-accent-primary';
		case 'failed':
			return 'bg-status-error/20 text-status-error';
		case 'cancelled':
			return 'bg-status-warning/20 text-status-warning';
		case 'handoff':
			return 'bg-iris/20 text-iris';
		default:
			return 'bg-surface text-text-secondary';
	}
}

export function getTaskRowClass(status: TaskRowStatus): string {
	switch (status) {
		case 'completed':
			return 'border-surface-border bg-bg-primary/80';
		case 'running':
			return 'border-sky-400/40 bg-sky-400/10';
		case 'failed':
			return 'border-status-error/40 bg-status-error/10';
		case 'blocked':
			return 'border-status-warning/40 bg-status-warning/10';
		default:
			return 'border-surface-border bg-bg-primary';
	}
}

export function getTaskBadgeClass(status: TaskRowStatus): string {
	switch (status) {
		case 'completed':
			return 'bg-bg-secondary text-status-success border-status-success/30';
		case 'running':
			return 'bg-sky-400/15 text-sky-300 border-sky-400/30';
		case 'failed':
			return 'bg-status-error/20 text-status-error border-status-error/30';
		case 'blocked':
			return 'bg-status-warning/20 text-status-warning border-status-warning/30';
		default:
			return 'bg-surface text-text-tertiary border-surface-border';
	}
}

export function formatExecutionDuration(
	startTime?: Date | null,
	endTime?: Date | null,
	now = new Date()
): string {
	if (!startTime) return '0s';
	const end = endTime || now;
	const durationMs = end.getTime() - startTime.getTime();
	if (durationMs < 1000) return `${durationMs}ms`;
	const seconds = Math.floor(durationMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
}
