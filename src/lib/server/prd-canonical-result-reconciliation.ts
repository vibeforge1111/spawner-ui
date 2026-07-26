import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { spawnerStateDir } from './spawner-state';
import { parseJsonOrFallback } from '$lib/utils/safe-json';
import { appendPrdTraceWithContinuity } from './prd-trace-proof-continuity';

type ReconciliationReason =
	| 'pending_missing'
	| 'request_missing'
	| 'request_mismatch'
	| 'canonical_result_missing'
	| 'already_complete'
	| 'canonical_result_reconciled';

interface ReconciliationOptions {
	stateDir?: string;
	requestId?: string;
	source?: string;
}

export interface PrdCanonicalResultReconciliation {
	reconciled: boolean;
	reason: ReconciliationReason;
	requestId: string | null;
	resultFile: string | null;
}

function normalizeRequestId(requestId: string): string {
	return requestId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
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
		// State reconciliation must not fail because trace persistence is unavailable.
	}
}

export async function reconcilePendingPrdCanonicalResult(
	options: ReconciliationOptions = {}
): Promise<PrdCanonicalResultReconciliation> {
	const stateDir = options.stateDir ?? spawnerStateDir();
	const pendingRequestFile = join(stateDir, 'pending-request.json');
	const source = options.source ?? 'prd_canonical_result_reconciliation';

	if (!existsSync(pendingRequestFile)) {
		return { reconciled: false, reason: 'pending_missing', requestId: null, resultFile: null };
	}

	const pending = parseJsonOrFallback<Record<string, unknown>>(
		await readFile(pendingRequestFile, 'utf-8'),
		{},
		'prd-canonical-result-reconciliation'
	);
	const requestId = stringValue(pending.requestId);
	if (!requestId) {
		return { reconciled: false, reason: 'request_missing', requestId: null, resultFile: null };
	}
	if (options.requestId && requestId !== options.requestId) {
		return { reconciled: false, reason: 'request_mismatch', requestId, resultFile: null };
	}

	const normalizedRequestId = normalizeRequestId(requestId);
	const resultFile = join(stateDir, 'results', `${normalizedRequestId}.json`);
	if (!existsSync(resultFile)) {
		return { reconciled: false, reason: 'canonical_result_missing', requestId, resultFile };
	}

	const autoAnalysis = objectValue(pending.autoAnalysis) ?? {};
	if (
		stringValue(pending.status) === 'processed' &&
		stringValue(autoAnalysis.status) === 'complete' &&
		autoAnalysis.canonicalResultAvailable === true
	) {
		return { reconciled: false, reason: 'already_complete', requestId, resultFile };
	}

	const result = parseJsonOrFallback<Record<string, unknown>>(
		await readFile(resultFile, 'utf-8'),
		{},
		'prd-canonical-result'
	);
	const resultSuccess = booleanValue(result.success, true);
	const now = new Date().toISOString();
	const provisionalResultFile = join(stateDir, 'provisional-results', `${normalizedRequestId}.json`);
	const next = {
		...pending,
		status: 'processed',
		processedAt: stringValue(pending.processedAt) ?? now,
		updatedAt: now,
		reason: 'Canonical provider result is available.',
		autoAnalysis: {
			...autoAnalysis,
			status: 'complete',
			finishedAt: stringValue(autoAnalysis.finishedAt) ?? now,
			success: resultSuccess,
			canonicalResultAvailable: true,
			resultFileName: `${normalizedRequestId}.json`,
			expectedResultFile: resultFile,
			provisionalResultFile,
			provisionalDraftAvailable: existsSync(provisionalResultFile),
			reconciledBy: source
		}
	};
	await writeFile(pendingRequestFile, JSON.stringify(next, null, 2), 'utf-8');
	await appendPrdTrace(stateDir, requestId, 'canonical_result_reconciled', {
		source,
		resultFile,
		resultFileName: `${normalizedRequestId}.json`,
		canonicalResultAvailable: true,
		resultSuccess
	});

	return { reconciled: true, reason: 'canonical_result_reconciled', requestId, resultFile };
}
