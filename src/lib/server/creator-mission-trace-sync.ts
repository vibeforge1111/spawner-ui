import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnerStateDir } from './spawner-state';
import type {
	CreatorMissionTrace,
	CreatorStageStatus,
	CreatorValidationCommandResult,
	CreatorValidationRun
} from './creator-mission';

interface CreatorMissionLifecycleEvent {
	type?: string;
	missionId?: string;
	taskId?: string | null;
	taskName?: string | null;
	message?: string | null;
	timestamp?: string;
	data?: Record<string, unknown>;
}

interface BenchmarkEvidence {
	baseline_score?: unknown;
	candidate_score?: unknown;
	delta?: unknown;
	held_out_verdict?: unknown;
	held_out_pass?: unknown;
}

const TERMINAL_EVENT_STATUS: Record<string, CreatorStageStatus> = {
	mission_failed: 'failed',
	mission_cancelled: 'blocked',
	task_failed: 'failed',
	task_cancelled: 'blocked'
};

function creatorMissionPath(missionId: string, stateDir = spawnerStateDir()): string {
	return path.join(stateDir, 'creator-missions', `${missionId}.json`);
}

function creatorWorkspaceRoots(): string[] {
	const roots = [
		process.env.SPARK_CREATOR_WORKSPACE_ROOT,
		process.env.SPAWNER_WORKSPACE_ROOT,
		process.env.SPARK_WORKSPACE_ROOT,
		path.join(homedir(), 'Desktop'),
		path.resolve(process.cwd(), '..'),
		process.cwd()
	]
		.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
		.map((value) => path.resolve(value));
	return Array.from(new Set(roots));
}

function resolveCreatorRepoRoot(repo: string): string {
	if (path.isAbsolute(repo)) return repo;
	const roots = creatorWorkspaceRoots();
	for (const root of roots) {
		const candidate = path.join(root, repo);
		if (existsSync(candidate)) return candidate;
	}
	return path.join(roots[0] || process.cwd(), repo);
}

function numberOrNull(value: unknown): number | null {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function boolFromHeldOut(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') return value.trim().toLowerCase() === 'pass';
	return false;
}

function readJsonFile<T>(filePath: string): T | null {
	try {
		// NOTE: existsSync check then use is a TOCTOU pattern in concurrent code. The file may be deleted between the check and the read. Consider using try/catch ENOENT or async fs.promises.access.
		if (!existsSync(filePath)) return null;
		return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
	} catch {
		return null;
	}
}

function writeTrace(trace: CreatorMissionTrace, stateDir = spawnerStateDir()): void {
	const target = creatorMissionPath(trace.mission_id, stateDir);
	const tmp = target + '.tmp';
	writeFileSync(tmp, JSON.stringify(trace, null, 2), 'utf-8');
	renameSync(tmp, target);
}

function addUnique(target: string[], values: string[]): string[] {
	const seen = new Set(target);
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		target.push(value);
		seen.add(value);
	}
	return target;
}

function existingManifestOutputs(trace: CreatorMissionTrace): { repoChanges: string[]; benchmarkRefs: string[] } {
	const repoChanges: string[] = [];
	const benchmarkRefs: string[] = [];

	for (const manifest of trace.artifact_manifests || []) {
		if (!manifest.repo) continue;
		const repoRoot = resolveCreatorRepoRoot(manifest.repo);
		for (const output of manifest.outputs || []) {
			const outputPath = path.join(repoRoot, output);
			if (!existsSync(outputPath)) continue;
			const ref = `${manifest.repo}/${output}`.replace(/\\/g, '/');
			repoChanges.push(ref);
			if (manifest.artifact_type === 'benchmark_pack' || /benchmark|score|validation/i.test(output)) {
				benchmarkRefs.push(ref);
			}
		}

		const artifactDir = path.join(repoRoot, 'artifacts');
		if (existsSync(artifactDir) && statSync(artifactDir).isDirectory()) {
			for (const file of readdirSync(artifactDir)) {
				if (!/score|benchmark|validation/i.test(file) || !file.endsWith('.json')) continue;
				benchmarkRefs.push(`${manifest.repo}/artifacts/${file}`.replace(/\\/g, '/'));
			}
		}
	}

	return { repoChanges, benchmarkRefs };
}

function findValidationLedger(trace: CreatorMissionTrace): Record<string, unknown> | null {
	for (const manifest of trace.artifact_manifests || []) {
		if (!manifest.repo) continue;
		const ledger = readJsonFile<Record<string, unknown>>(path.join(resolveCreatorRepoRoot(manifest.repo), 'validation-ledger.json'));
		if (ledger) return ledger;
	}
	return null;
}

function updateBenchmarkSummary(trace: CreatorMissionTrace, ledger: Record<string, unknown> | null): void {
	const evidence = ledger?.benchmark_evidence as BenchmarkEvidence | undefined;
	if (!evidence || typeof evidence !== 'object') return;

	trace.benchmark_summary = {
		baseline_score: numberOrNull(evidence.baseline_score),
		candidate_score: numberOrNull(evidence.candidate_score),
		delta: numberOrNull(evidence.delta),
		held_out_pass: boolFromHeldOut(evidence.held_out_verdict ?? evidence.held_out_pass)
	};
}

function validationStatusFromLedger(ledger: Record<string, unknown> | null): CreatorValidationRun['status'] {
	const gates = ledger?.gate_ledger && typeof ledger.gate_ledger === 'object'
		? (ledger.gate_ledger as Record<string, { status?: unknown }>)
		: {};
	const statuses = Object.values(gates).map((gate) => String(gate?.status || '').toLowerCase());
	if (statuses.some((status) => status === 'fail' || status === 'failed')) return 'failed';
	if (statuses.some((status) => status === 'blocked')) return 'blocked';
	return 'passed';
}

function synthesizeValidationRun(
	trace: CreatorMissionTrace,
	completedAt: string,
	ledger: Record<string, unknown> | null
): CreatorValidationRun | null {
	if (!ledger) return null;
	const status = validationStatusFromLedger(ledger);
	const results: CreatorValidationCommandResult[] = (trace.artifact_manifests || []).map((manifest) => ({
		artifact_id: manifest.artifact_id,
		artifact_type: manifest.artifact_type,
		repo: manifest.repo,
		command: 'provider lifecycle artifact validation',
		cwd: resolveCreatorRepoRoot(manifest.repo),
		status: status === 'passed' ? 'passed' : status === 'blocked' ? 'skipped' : 'failed',
		exit_code: status === 'passed' ? 0 : null,
		stdout_tail: 'Validation ledger recorded by the completed creator mission.',
		stderr_tail: '',
		error: status === 'passed' ? null : 'Creator validation ledger did not pass cleanly.'
	}));

	return {
		schema_version: 'spark-creator-validation-run.v1',
		run_id: `creator-validation-${trace.mission_id}-lifecycle`,
		mission_id: trace.mission_id,
		started_at: trace.updated_at || trace.created_at,
		completed_at: completedAt,
		status,
		results
	};
}

function stageForEvent(eventType: string, trace: CreatorMissionTrace): string {
	if (eventType === 'mission_completed') {
		return trace.validation_runs?.length || trace.benchmark_summary?.candidate_score != null
			? 'validation_completed'
			: 'execution_completed';
	}
	if (eventType === 'mission_failed') return 'execution_failed';
	if (eventType === 'mission_cancelled') return 'execution_cancelled';
	if (eventType === 'dispatch_started' || eventType === 'mission_started') return 'execution_started';
	if (eventType === 'task_started' || eventType === 'task_progress' || eventType === 'progress') return 'execution_running';
	if (eventType === 'task_failed') return 'execution_failed';
	if (eventType === 'task_cancelled') return 'execution_cancelled';
	return trace.current_stage;
}

export function syncCreatorMissionTraceFromLifecycleEvent(
	event: CreatorMissionLifecycleEvent,
	stateDir = spawnerStateDir()
): CreatorMissionTrace | null {
	const missionId = typeof event.missionId === 'string' ? event.missionId.trim() : '';
	if (!missionId.startsWith('mission-creator-')) return null;

	const tracePath = creatorMissionPath(missionId, stateDir);
	const trace = readJsonFile<CreatorMissionTrace>(tracePath);
	if (!trace) return null;

	const eventType = typeof event.type === 'string' ? event.type : '';
	const timestamp = typeof event.timestamp === 'string' && event.timestamp.trim()
		? event.timestamp
		: new Date().toISOString();

	const { repoChanges, benchmarkRefs } = existingManifestOutputs(trace);
	addUnique(trace.repo_changes, repoChanges);
	addUnique(trace.benchmarks, benchmarkRefs);

	const ledger = findValidationLedger(trace);
	updateBenchmarkSummary(trace, ledger);

	if (eventType === 'mission_completed' && (trace.validation_runs || []).length === 0) {
		const run = synthesizeValidationRun(trace, timestamp, ledger);
		if (run) {
			trace.validation_runs = [run];
		}
	}

	if (eventType === 'mission_completed') {
		const latestValidation = (trace.validation_runs || []).at(-1);
		if (latestValidation?.status === 'passed') {
			trace.stage_status = 'validated';
		} else if (latestValidation?.status === 'failed') {
			trace.stage_status = 'failed';
		} else if (latestValidation?.status === 'blocked') {
			trace.stage_status = 'blocked';
		}
	} else if (TERMINAL_EVENT_STATUS[eventType]) {
		const terminalStatus = TERMINAL_EVENT_STATUS[eventType];
		trace.stage_status = terminalStatus;
	} else if (['dispatch_started', 'mission_started', 'task_started', 'task_progress', 'progress'].includes(eventType)) {
		trace.stage_status = 'running';
	}

	if (eventType === 'mission_completed' && trace.stage_status === 'validated') {
		trace.publish_readiness = 'workspace_validated';
	}

	if (eventType === 'mission_failed' || eventType === 'task_failed') {
		const message = typeof event.message === 'string' && event.message.trim()
			? event.message.trim()
			: 'Creator mission failed during execution.';
		if (!trace.blockers.includes(message)) {
			trace.blockers.push(message);
		}
	}

	trace.current_stage = stageForEvent(eventType, trace);
	trace.updated_at = timestamp;
	writeTrace(trace, stateDir);
	return trace;
}
