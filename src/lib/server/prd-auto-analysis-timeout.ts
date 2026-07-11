import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { relayMissionControlEvent } from './mission-control-relay';
import { reconcilePendingPrdCanonicalResult } from './prd-canonical-result-reconciliation';
import { spawnerStateDir } from './spawner-state';
import { extractTraceRef } from './trace-ref';
import { parseJsonOrFallback } from '$lib/utils/safe-json';
import { appendPrdTraceWithContinuity } from './prd-trace-proof-continuity';

const DEFAULT_AUTO_ANALYSIS_TIMEOUT_MS = 420_000;

type RecoveryReason =
	| 'pending_missing'
	| 'not_running'
	| 'deadline_missing'
	| 'not_overdue'
	| 'canonical_result_exists'
	| 'provisional_still_running'
	| 'provisional_grace_active'
	| 'recovered_timeout';

export interface PrdAutoAnalysisTimeoutRecovery {
	recovered: boolean;
	reason: RecoveryReason;
	requestId: string | null;
	missionId: string | null;
	deadlineAt: string | null;
}

interface RecoveryOptions {
	stateDir?: string;
	nowMs?: number;
	recoverySource?: string;
}

function configuredTimeoutMs(): number {
	const configured = Number.parseInt(process.env.SPAWNER_AUTO_ANALYSIS_TIMEOUT_MS || '', 10);
	return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_AUTO_ANALYSIS_TIMEOUT_MS;
}

function normalizeRequestId(requestId: string): string {
	return requestId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function missionIdFromRequestId(requestId: string): string {
	const normalized = normalizeRequestId(requestId);
	const stamp = normalized.match(/(\d{10,})$/)?.[1];
	return `mission-${stamp || normalized}`;
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function autoAnalysisDeadline(autoAnalysis: Record<string, unknown>): string | null {
	const explicit = stringValue(autoAnalysis.deadlineAt);
	if (explicit) return explicit;
	const startedAt = stringValue(autoAnalysis.startedAt);
	if (!startedAt) return null;
	const timeoutMs =
		typeof autoAnalysis.timeoutMs === 'number' && Number.isFinite(autoAnalysis.timeoutMs)
			? autoAnalysis.timeoutMs
			: configuredTimeoutMs();
	const parsed = Date.parse(startedAt);
	if (!Number.isFinite(parsed) || timeoutMs <= 0) return null;
	return new Date(parsed + timeoutMs).toISOString();
}

async function appendPrdTrace(
	stateDir: string,
	requestId: string,
	event: string,
	details: Record<string, unknown>
): Promise<void> {
	try {
		await appendPrdTraceWithContinuity({ stateDir, requestId, event, details });
	} catch {
		// Recovery should not fail because trace persistence is unavailable.
	}
}

export async function recoverOverduePrdAutoAnalysisFromPending(
	options: RecoveryOptions = {}
): Promise<PrdAutoAnalysisTimeoutRecovery> {
	const stateDir = options.stateDir ?? spawnerStateDir();
	const pendingRequestFile = join(stateDir, 'pending-request.json');
	const recoverySource = options.recoverySource ?? 'prd_auto_analysis_timeout_recovery';

	if (!existsSync(pendingRequestFile)) {
		return { recovered: false, reason: 'pending_missing', requestId: null, missionId: null, deadlineAt: null };
	}

	const pending = parseJsonOrFallback<Record<string, unknown>>(
		await readFile(pendingRequestFile, 'utf-8'),
		{},
		'prd-auto-timeout-recovery'
	);
	const requestId = stringValue(pending.requestId);
	const autoAnalysis = objectValue(pending.autoAnalysis);
	const missionId = stringValue(pending.missionId) || (requestId ? missionIdFromRequestId(requestId) : null);
	if (!requestId || !autoAnalysis || stringValue(autoAnalysis.status) !== 'running') {
		return { recovered: false, reason: 'not_running', requestId, missionId, deadlineAt: null };
	}

	const deadlineAt = autoAnalysisDeadline(autoAnalysis);
	const deadlineMs = deadlineAt ? Date.parse(deadlineAt) : Number.NaN;
	if (!Number.isFinite(deadlineMs)) {
		return { recovered: false, reason: 'deadline_missing', requestId, missionId, deadlineAt };
	}

	const nowMs = options.nowMs ?? Date.now();
	if (nowMs <= deadlineMs) {
		return { recovered: false, reason: 'not_overdue', requestId, missionId, deadlineAt };
	}

	const resultFile = join(stateDir, 'results', `${normalizeRequestId(requestId)}.json`);
	if (existsSync(resultFile)) {
		await reconcilePendingPrdCanonicalResult({ stateDir, requestId, source: recoverySource });
		return { recovered: false, reason: 'canonical_result_exists', requestId, missionId, deadlineAt };
	}

	const provisionalResultFile = join(stateDir, 'provisional-results', `${normalizeRequestId(requestId)}.json`);
	const provisionalDraftAvailable = existsSync(provisionalResultFile);
	if (provisionalDraftAvailable) {
		const graceMs =
			typeof autoAnalysis.timeoutMs === 'number' && Number.isFinite(autoAnalysis.timeoutMs)
				? autoAnalysis.timeoutMs
				: configuredTimeoutMs();
		if (nowMs <= deadlineMs + graceMs) {
			return { recovered: false, reason: 'provisional_grace_active', requestId, missionId, deadlineAt };
		}
	}

	const traceRef = extractTraceRef(pending);
	const projectName = stringValue(pending.projectName) || 'Pending PRD analysis';
	const buildMode = stringValue(pending.buildMode) || 'direct';
	const buildLane = stringValue(pending.buildLane) || stringValue(pending.build_lane) || 'direct';
	const timeoutMs =
		typeof autoAnalysis.timeoutMs === 'number' && Number.isFinite(autoAnalysis.timeoutMs)
			? autoAnalysis.timeoutMs
			: Math.max(0, deadlineMs - Date.parse(stringValue(autoAnalysis.startedAt) || deadlineAt || ''));

	await mkdir(join(stateDir, 'results'), { recursive: true });
	await mkdir(join(stateDir, 'provisional-results'), { recursive: true });

	const next = {
		...pending,
		status: 'timeout',
		updatedAt: new Date().toISOString(),
		reason: 'No canonical runtime analysis result written before timeout; recovered from persisted pending state.',
		autoAnalysis: {
			...autoAnalysis,
			status: 'timeout',
			timedOutAt: new Date().toISOString(),
			timeoutMs,
			expectedResultFile: resultFile,
			provisionalResultFile,
			provisionalDraftAvailable,
			canonicalResultAvailable: false,
			recoveredBy: recoverySource
		}
	};
	await writeFile(pendingRequestFile, JSON.stringify(next, null, 2), 'utf-8');

	const traceDetails = {
		...(traceRef ? { traceRef } : {}),
		timeoutMs,
		expectedResultFile: resultFile,
		provisionalResultFile,
		provisionalDraftAvailable,
		buildMode,
		buildLane,
		projectName,
		recovered: true,
		recoverySource
	};
	await appendPrdTrace(stateDir, requestId, 'watchdog_timeout', traceDetails);

	const failureData = {
		requestId,
		...(traceRef ? { traceRef } : {}),
		buildMode,
		buildLane,
		timeoutMs,
		expectedResultFile: resultFile,
		provisionalDraftAvailable,
		canonicalResultAvailable: false,
		autoAnalysisStatus: 'timeout',
		recoveredBy: recoverySource
	};
	await relayMissionControlEvent({
		type: 'task_failed',
		missionId: missionId ?? missionIdFromRequestId(requestId),
		missionName: projectName,
		taskName: 'PRD analysis',
		message: 'Canonical PRD analysis timed out before a provider result was written.',
		source: 'prd-bridge',
		data: failureData
	});
	await relayMissionControlEvent({
		type: 'mission_failed',
		missionId: missionId ?? missionIdFromRequestId(requestId),
		missionName: projectName,
		message: 'Spawner could not produce a canonical PRD analysis result before timeout.',
		source: 'prd-bridge',
		data: failureData
	});

	return { recovered: true, reason: 'recovered_timeout', requestId, missionId, deadlineAt };
}
