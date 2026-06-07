import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import {
	MEMORY_FAILURE_MODES,
	MEMORY_OUTCOMES,
	MEMORY_SOURCES,
	ensureMemoryQualityDir,
	getMemoryQualityPaths,
	loadMemoryQualityDataset,
	type MemoryFailureMode,
	type MemoryOutcome,
	type MemoryQualityDataset,
	type MemoryQualityPaths,
	type MemoryRecallEvent,
	type MemorySource
} from './memory-quality';

export interface ManualEvaluationInput {
	query?: unknown;
	source?: unknown;
	outcome?: unknown;
	latencyMs?: unknown;
	notes?: unknown;
	failureMode?: unknown;
	evaluator?: unknown;
}

export interface EvaluationValidationResult {
	valid: boolean;
	errors: Record<string, string>;
}

const MAX_QUERY_LENGTH = 600;
const MAX_NOTES_LENGTH = 1200;
const MAX_EVALUATOR_LENGTH = 80;
const MAX_LATENCY_MS = 120_000;

export function validateManualEvaluation(input: ManualEvaluationInput): EvaluationValidationResult {
	const errors: Record<string, string> = {};
	if (!isNonEmptyString(input.query)) errors.query = 'Query is required.';
	if (isNonEmptyString(input.query) && input.query.trim().length > MAX_QUERY_LENGTH) {
		errors.query = `Query must be ${MAX_QUERY_LENGTH} characters or fewer.`;
	}
	if (!MEMORY_SOURCES.includes(input.source as MemorySource)) errors.source = 'Choose a monitored source.';
	if (!MEMORY_OUTCOMES.includes(input.outcome as MemoryOutcome)) errors.outcome = 'Choose hit, miss, drift, or unsure.';

	const latency = Number(input.latencyMs);
	if (!Number.isFinite(latency) || latency < 0 || latency > MAX_LATENCY_MS) {
		errors.latencyMs = `Latency must be between 0 and ${MAX_LATENCY_MS}ms.`;
	}

	if (isNonEmptyString(input.notes) && input.notes.trim().length > MAX_NOTES_LENGTH) {
		errors.notes = `Notes must be ${MAX_NOTES_LENGTH} characters or fewer.`;
	}
	if (isNonEmptyString(input.evaluator) && input.evaluator.trim().length > MAX_EVALUATOR_LENGTH) {
		errors.evaluator = `Evaluator must be ${MAX_EVALUATOR_LENGTH} characters or fewer.`;
	}

	if (
		input.failureMode !== undefined &&
		input.failureMode !== null &&
		input.failureMode !== '' &&
		!MEMORY_FAILURE_MODES.includes(input.failureMode as MemoryFailureMode)
	) {
		errors.failureMode = 'Choose a supported failure mode.';
	}

	return { valid: Object.keys(errors).length === 0, errors };
}

export async function appendManualEvaluation(
	input: ManualEvaluationInput,
	paths: MemoryQualityPaths = getMemoryQualityPaths()
): Promise<{ dataset: MemoryQualityDataset; event?: MemoryRecallEvent; errors?: Record<string, string> }> {
	const validation = validateManualEvaluation(input);
	if (!validation.valid) {
		return { dataset: await loadMemoryQualityDataset(paths), errors: validation.errors };
	}

	await ensureMemoryQualityDir(paths);
	const existing = await readExistingEvaluations(paths.evaluationsFile);
	const event: MemoryRecallEvent = {
		id: `manual-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
		timestamp: new Date().toISOString(),
		query: String(input.query).trim(),
		source: input.source as MemorySource,
		outcome: input.outcome as MemoryOutcome,
		latencyMs: Number(input.latencyMs),
		failureMode: input.failureMode ? (input.failureMode as MemoryFailureMode) : null,
		notes: isNonEmptyString(input.notes) ? String(input.notes).trim() : '',
		evaluator: isNonEmptyString(input.evaluator) ? String(input.evaluator).trim() : 'operator',
		manual: true
	};

	await writeFile(paths.evaluationsFile, JSON.stringify([event, ...existing], null, 2), 'utf-8');
	return { dataset: await loadMemoryQualityDataset(paths), event };
}

async function readExistingEvaluations(filePath: string): Promise<MemoryRecallEvent[]> {
	if (!existsSync(filePath)) return [];
	try {
		const parsed = JSON.parse(await readFile(filePath, 'utf-8'));
		return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.events) ? parsed.events : [];
	} catch {
		return [];
	}
}

function isNonEmptyString(input: unknown): input is string {
	return typeof input === 'string' && input.trim().length > 0;
}
