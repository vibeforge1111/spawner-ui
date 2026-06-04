import type { BridgeEvent } from '$lib/services/event-bridge';
import type { MultiLLMProviderConfig } from '$lib/services/multi-llm-orchestrator';
import { assertHighAgencyWorkerAllowed, resolveCodexSandbox } from '$lib/server/high-agency-workers';
import { resolveSparkRunProjectPath } from '$lib/server/spark-run-workspace';
import { sparkHarnessTimeoutMs } from '$lib/server/timeout-config';
import type { ProviderResult } from './types';
import { createBridgeEvent } from './types';

export interface SparkHarnessOptions {
	provider: MultiLLMProviderConfig;
	missionId: string;
	prompt: string;
	workingDirectory?: string;
	signal?: AbortSignal;
	onEvent: (event: BridgeEvent) => void;
}

interface SparkTaskStatus {
	task_id?: string;
	status?: string;
	result?: {
		output?: string;
		error?: string;
		metadata?: Record<string, unknown>;
	};
	error?: string;
}

interface AssignedCanvasTask {
	id: string;
	title: string;
}

const DEFAULT_SPARK_HARNESS_URL = 'http://127.0.0.1:8011';
const POLL_INTERVAL_MS = 1500;
const STATUS_POLL_MAX_TRANSIENT_FAILURES = 3;
const DEFAULT_TIMEOUT_MS = sparkHarnessTimeoutMs();

export async function executeSparkHarnessRequest(options: SparkHarnessOptions): Promise<ProviderResult> {
	const { provider, missionId, prompt, workingDirectory, signal, onEvent } = options;
	const startedAt = Date.now();
	const sparkHarnessUrl = resolveSparkHarnessUrl();
	const bridgeBackend = provider.sparkExecutionBridge || 'codex';
	const requestedWorkspace = extractTargetWorkspace(prompt) || workingDirectory;
	const assignedTasks = extractAssignedCanvasTasks(prompt);

	onEvent(
		createBridgeEvent('task_started', options, {
			message: `${provider.label} starting through Spark ${bridgeBackend} bridge`,
			data: {
				provider: provider.id,
				providerLabel: provider.label,
				sparkBridge: bridgeBackend,
				model: provider.model
			}
		})
	);

	if (bridgeBackend !== 'codex') {
		return {
			success: false,
			error: `Spark execution bridge "${bridgeBackend}" is not wired in Spawner yet`,
			durationMs: Date.now() - startedAt
		};
	}

	try {
		const executorModel = resolveCodexExecutorModel();
		const codexSandbox = resolveCodexSandbox();
		const resolvedWorkspace = requestedWorkspace ? resolveSparkRunProjectPath(requestedWorkspace) : undefined;
		if (codexSandbox === 'danger-full-access') {
			const approval = assertHighAgencyWorkerAllowed(resolvedWorkspace);
			onEvent(
				createBridgeEvent('worker_high_agency_approved', options, {
					message: `${provider.label} high-agency Spark bridge approved`,
					data: {
						provider: provider.id,
						workingDirectory: approval.workingDirectory,
						workspaceRoot: approval.workspaceRoot,
						externalProjectPathsAllowed: approval.externalProjectPathsAllowed,
						codexSandbox
					}
				})
			);
		}
		const sparkInstruction = buildSparkBuilderInstruction(prompt, resolvedWorkspace);
		const isolateBuilderHome = shouldIsolateCodexBuilderHomeForInstruction(sparkInstruction);
		const taskId = await submitSparkTask({
			baseUrl: sparkHarnessUrl,
			instruction: sparkInstruction,
			requestedModel: provider.model,
			executorModel,
			workspace: resolvedWorkspace,
			codexSandbox,
			isolateBuilderHome,
			provider,
			missionId,
			signal
		});

		onEvent(
			createBridgeEvent('task_progress', options, {
				progress: 5,
				message: `${provider.label}: Spark accepted task ${taskId}`,
				data: { sparkTaskId: taskId, sparkBridge: bridgeBackend }
			})
		);

		const result = await waitForSparkTask({
			baseUrl: sparkHarnessUrl,
			taskId,
			provider,
			missionId,
			assignedTasks,
			signal,
			onEvent,
			startedAt
		});

		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onEvent(
			createBridgeEvent('task_failed', options, {
				message: `${provider.label}: Spark bridge failed: ${message}`,
				data: {
					success: false,
					error: message,
					provider: provider.id,
					providerLabel: provider.label,
					sparkBridge: bridgeBackend
				}
			})
		);
		return { success: false, error: message, durationMs: Date.now() - startedAt };
	}
}

function resolveSparkHarnessUrl(): string {
	return (
		process.env.SPARK_AGENT_HARNESS_URL ||
		process.env.SPARK_HARNESS_URL ||
		DEFAULT_SPARK_HARNESS_URL
	).replace(/\/+$/, '');
}

function resolveCodexExecutorModel(): string | undefined {
	const value = process.env.SPARK_CODEX_EXECUTOR_MODEL || process.env.SPAWNER_SPARK_CODEX_MODEL;
	return value?.trim() || undefined;
}

function extractTargetWorkspace(prompt: string): string | undefined {
	const patterns = [
		/Target workspace:\s*`([^`]+)`/i,
		/Target workspace:\s*([^\r\n]+)/i,
		/Create\s+([A-Za-z]:\\[^\r\n]+?)\s+with\b/i,
		/build this at\s+([A-Za-z]:\\[^:\r\n]+):/i
	];

	for (const pattern of patterns) {
		const match = prompt.match(pattern);
		const value = match?.[1]?.trim();
		if (value) return value.replace(/[.,;]+$/, '');
	}

	return undefined;
}

function buildSparkBuilderInstruction(prompt: string, workspace?: string): string {
	const tasksSection = extractBetween(prompt, 'Assigned tasks:', 'H70 skill loading');
	const verificationSection = extractBetween(prompt, 'Verify Before Reporting Complete', 'Mission Completion Gate');
	const targetWorkspace = workspace ? `Target workspace: ${workspace}` : undefined;
	const taskText = tasksSection?.trim() || prompt.trim();
	const isAdvancedBuild = /Build mode:\s*advanced_prd/i.test(prompt);
	const saysNoBuildStep = /\bno build step\b/i.test(prompt);
	const isFastStaticSmoke =
		/\bBuild lane:\s*fast_direct\b/i.test(prompt) ||
		/\bsingle-file-static-web-app\b/i.test(prompt) ||
		/\bquick smoke path\b/i.test(prompt) ||
		/\b(?:one|single)[-\s]?file\b/i.test(prompt) ||
		/\bkeep it fast and simple\b/i.test(prompt);
	const verificationText = saysNoBuildStep
		? [
				'No-build static project verification:',
				'- Do not run npm install, npm run build, npx tsc, or create package/build/typecheck files unless the user explicitly requested them.',
				'- Verify requested files with file existence and content checks.',
				'- For JavaScript, run node --check app.js when app.js exists.',
				'- Confirm direct index.html launch remains possible with relative styles.css and app.js references.',
				...(isFastStaticSmoke
					? [
							'- Fast-lane budget: do not spend more than 15 seconds discovering browser tooling.',
							'- Prefer exact file/content checks for the requested marker, embedded style/script, and file-scope constraints.',
							'- Browser smoke is optional when no standard harness is immediately available; do not install browser tooling, start a dev server, or keep a browser session open just to verify direct-open index.html.',
							'- Treat build and typecheck as not applicable for direct-open static pages unless the user explicitly requested a build system.'
						]
					: [])
			].join('\n')
		: verificationSection?.trim();
	const filePolicy = isAdvancedBuild
		? 'Advanced PRD mode: follow the task/acceptance plan and create supporting source/docs files when they are necessary to finish the project. Keep explicit constraints authoritative; if the request says "No build step", do not add package.json, lockfiles, build config, or verification-only helper files unless explicitly requested.'
		: saysNoBuildStep
			? 'Direct no-build mode: only create files explicitly requested by the user. Do not add package.json, lockfiles, build config, or verification-only helper files unless explicitly requested.'
			: 'Direct mode: keep file creation tightly scoped to the request; add only files that are necessary for a complete working result and explain them in changed_files.';

	return [
		'Build the project described below now. The complete request is in this prompt; do not look for a separate spec, request file, commit, branch, README, or remote.',
		'An empty or freshly initialized repository is expected for new projects and is not a blocker.',
		'Create or modify the requested files directly in the target workspace.',
		filePolicy,
		isFastStaticSmoke
			? 'Fast direct lane: do not load Codex skills, do not read local SKILL.md files, and do not call H70 skill endpoints. Treat the listed skills as routing labels only and start by creating the requested file.'
			: undefined,
		targetWorkspace,
		'Do not treat "Provider Prompt" headings as the user request; the actionable work is the task list below.',
		'',
		'Task list:',
		taskText,
		verificationText ? `\nVerification requirements:\n${verificationText}` : undefined,
		'',
		'Return one JSON object with status, changed_files, verification, and exact_commands.'
	]
		.filter((part): part is string => typeof part === 'string' && part.length > 0)
		.join('\n');
}

function shouldIsolateCodexBuilderHomeForInstruction(instruction: string): boolean {
	return (
		/\bFast direct lane:\s*do not load Codex skills\b/i.test(instruction) ||
		/\bBuild lane:\s*fast_direct\b/i.test(instruction) ||
		/\bsingle-file-static-web-app\b/i.test(instruction) ||
		/\bkeep it fast and simple\b/i.test(instruction)
	);
}

function extractBetween(text: string, start: string, end: string): string | undefined {
	const startIndex = text.indexOf(start);
	if (startIndex === -1) return undefined;
	const contentStart = startIndex + start.length;
	const endIndex = text.indexOf(end, contentStart);
	return endIndex === -1 ? text.slice(contentStart) : text.slice(contentStart, endIndex);
}

function extractAssignedCanvasTasks(prompt: string): AssignedCanvasTask[] {
	const tasksSection = extractBetween(prompt, 'Assigned tasks:', 'H70 skill loading') || '';
	const tasks: AssignedCanvasTask[] = [];
	const pattern = /^\s*\d+\.\s+(.+?)\s+\(id:\s*([^)]+)\)/gm;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(tasksSection))) {
		const title = match[1]?.trim();
		const id = match[2]?.trim().split(/\s+/)[0];
		if (id && title) {
			tasks.push({ id, title });
		}
	}
	return tasks;
}

async function submitSparkTask(input: {
	baseUrl: string;
	instruction: string;
	requestedModel?: string;
	executorModel?: string;
	workspace?: string;
	codexSandbox: string;
	isolateBuilderHome?: boolean;
	provider: MultiLLMProviderConfig;
	missionId: string;
	signal?: AbortSignal;
}): Promise<string> {
	const response = await fetch(`${input.baseUrl}/v1/tasks`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			instruction: input.instruction,
			priority: 10,
			context: {
				_requested_model: input.executorModel || null,
				_requested_workspace: input.workspace || null,
				_codex_sandbox: input.codexSandbox,
				_codex_isolate_builder_home: Boolean(input.isolateBuilderHome),
				_spark_mode: 'builder_task',
				spawner_mission_id: input.missionId,
				spawner_provider_id: input.provider.id,
				requested_llm_provider: input.provider.id,
				requested_llm_model: input.requestedModel || null,
				executor_provider: 'codex',
				executor_model: input.executorModel || null
			},
			metadata: {
				surface: 'builder',
				spark_mode: 'builder_task',
				requested_backend: 'codex',
				requested_llm_provider: input.provider.id,
				requested_llm_model: input.requestedModel || null,
				executor_provider: 'codex',
				executor_model: input.executorModel || null,
				spawner_mission_id: input.missionId
			},
			spark_surface: 'builder',
			spark_mode: 'builder_task',
			spark_task: {
				mode: 'builder_task',
				goal: input.instruction.slice(0, 2000),
				project_path: input.workspace || null,
				preferred_runtime: input.provider.sparkExecutionBridge || 'codex',
				acceptance_criteria: [
					'Create or modify the requested files in the target workspace.',
					'Run a lightweight verification step appropriate for the project.'
				]
			},
			required_capabilities: ['file_operations', 'shell_commands']
		}),
		signal: input.signal
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		const detail = body.slice(0, 500);
		if (response.status === 404) {
			throw new Error(
				`Spark harness rejected task (HTTP 404 not found): ${detail}. ` +
				`The configured Spark harness base URL (${input.baseUrl}) does not expose /v1/spark-tasks; ` +
				`check the Spark harness provider URL in Mission Control settings.`
			);
		}
		if (response.status === 401 || response.status === 403) {
			throw new Error(
				`Spark harness rejected task (HTTP ${response.status}): ${detail}. ` +
				`The harness rejected the request credentials; rotate the harness token in the active provider settings.`
			);
		}
		throw new Error(`Spark harness rejected task (HTTP ${response.status}): ${detail}`);
	}

	const data = (await response.json()) as { task_id?: string };
	if (!data.task_id) {
		throw new Error('Spark harness did not return a task_id');
	}
	return data.task_id;
}

async function waitForSparkTask(input: {
	baseUrl: string;
	taskId: string;
	provider: MultiLLMProviderConfig;
	missionId: string;
	assignedTasks: AssignedCanvasTask[];
	startedAt: number;
	signal?: AbortSignal;
	onEvent: (event: BridgeEvent) => void;
}): Promise<ProviderResult> {
	const { baseUrl, taskId, provider, missionId, assignedTasks, startedAt, signal, onEvent } = input;
	let lastStatus = '';
	let progress = 10;
	let activeTaskIndex = -1;
	const completedTaskIds = new Set<string>();

	const emitTaskEvent = (
		type: 'task_started' | 'task_progress' | 'task_completed' | 'task_failed',
		task: AssignedCanvasTask,
		extra: Partial<BridgeEvent>
	) => {
		onEvent(
			createBridgeEvent(type, { provider, missionId, onEvent, signal }, {
				taskId: task.id,
				taskName: task.title,
				...extra,
				data: {
					provider: provider.id,
					providerLabel: provider.label,
					sparkTaskId: taskId,
					...((extra.data as Record<string, unknown> | undefined) || {})
				}
			})
		);
	};

	const startVisualTask = (index: number) => {
		const task = assignedTasks[index];
		if (!task || activeTaskIndex === index || completedTaskIds.has(task.id)) return;
		activeTaskIndex = index;
		emitTaskEvent('task_started', task, {
			message: `${provider.label}: started ${task.title}`,
			data: { visualTaskIndex: index + 1, visualTaskCount: assignedTasks.length }
		});
	};

	const completeVisualTask = (index: number, success = true) => {
		const task = assignedTasks[index];
		if (!task || completedTaskIds.has(task.id)) return;
		completedTaskIds.add(task.id);
		emitTaskEvent(success ? 'task_completed' : 'task_failed', task, {
			message: success
				? `${provider.label}: completed ${task.title}`
				: `${provider.label}: failed ${task.title}`,
			data: {
				success,
				visualTaskIndex: index + 1,
				visualTaskCount: assignedTasks.length,
				verification: success ? { sparkBridge: true } : undefined
			}
		});
	};

	const syncVisualTaskProgress = (visualProgress: number, state: string) => {
		if (assignedTasks.length === 0) return;
		if (state === 'completed') {
			for (let i = 0; i < assignedTasks.length; i += 1) {
				if (i > activeTaskIndex && !completedTaskIds.has(assignedTasks[i].id)) startVisualTask(i);
				completeVisualTask(i, true);
			}
			return;
		}
		if (['failed', 'cancelled', 'timeout', 'timed_out'].includes(state)) {
			if (activeTaskIndex < 0) startVisualTask(0);
			completeVisualTask(Math.max(activeTaskIndex, 0), false);
			return;
		}

		const targetIndex = Math.max(
			0,
			Math.min(
				assignedTasks.length - 1,
				Math.floor((Math.max(visualProgress, 5) / 100) * assignedTasks.length)
			)
		);
		for (let i = 0; i <= targetIndex; i += 1) {
			if (i > activeTaskIndex) {
				if (activeTaskIndex >= 0) completeVisualTask(activeTaskIndex, true);
				startVisualTask(i);
			}
		}
		const activeTask = assignedTasks[activeTaskIndex];
		if (activeTask) {
			emitTaskEvent('task_progress', activeTask, {
				progress: Math.max(5, Math.min(95, visualProgress)),
				message: `${provider.label}: ${activeTask.title} is ${state}`,
				data: { sparkStatus: state }
			});
		}
	};

	let consecutiveStatusFailures = 0;
	let lastStatusError: Error | null = null;
	while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
		if (signal?.aborted) {
			return { success: false, error: 'Cancelled', durationMs: Date.now() - startedAt };
		}

		let status: SparkTaskStatus;
		try {
			status = await getSparkTaskStatus(baseUrl, taskId, signal);
			consecutiveStatusFailures = 0;
			lastStatusError = null;
		} catch (err) {
			if (signal?.aborted) {
				return { success: false, error: 'Cancelled', durationMs: Date.now() - startedAt };
			}
			consecutiveStatusFailures += 1;
			lastStatusError = err instanceof Error ? err : new Error(String(err));
			if (consecutiveStatusFailures >= STATUS_POLL_MAX_TRANSIENT_FAILURES) {
				throw lastStatusError;
			}
			await sleep(POLL_INTERVAL_MS, signal);
			continue;
		}
		const state = (status.status || 'unknown').toLowerCase();
		if (state !== 'completed') {
			syncVisualTaskProgress(progress, state);
		}
		if (state !== lastStatus) {
			lastStatus = state;
			progress = state === 'running' ? Math.max(progress, 25) : progress;
			onEvent(
				createBridgeEvent('task_progress', { provider, missionId, onEvent, signal }, {
					progress,
					message: `${provider.label}: Spark task ${taskId} is ${state}`,
					data: { sparkTaskId: taskId, sparkStatus: state }
				})
			);
		}

		if (state === 'completed') {
			const output = status.result?.output || '';
			const sparkOutput = extractSparkOutput(status);
			const changedFiles = extractChangedFiles(status);
			const blocked =
				typeof sparkOutput?.status === 'string' &&
				['blocked', 'failed'].includes(sparkOutput.status.toLowerCase());
			const verifierOnlyBlocked = blocked && changedFiles.length > 0 && isVerifierOnlyBlocked(status);
			if ((blocked && !verifierOnlyBlocked) || changedFiles.length === 0) {
				const error =
					typeof sparkOutput?.summary === 'string' && sparkOutput.summary.trim()
						? sparkOutput.summary.trim()
						: changedFiles.length === 0
							? 'Spark task completed without changing any files'
							: `Spark task ended with status ${sparkOutput?.status}`;
				onEvent(
					createBridgeEvent('task_failed', { provider, missionId, onEvent, signal }, {
						message: `${provider.label}: ${error}`,
						data: {
							success: false,
							error,
							provider: provider.id,
							providerLabel: provider.label,
							sparkTaskId: taskId,
							sparkStatus: state,
							sparkBridge: provider.sparkExecutionBridge || 'codex',
							metadata: status.result?.metadata || {}
						}
					})
				);
				syncVisualTaskProgress(progress, 'failed');
				return { success: false, error, durationMs: Date.now() - startedAt };
			}
			syncVisualTaskProgress(100, 'completed');
			onEvent(
				createBridgeEvent('task_completed', { provider, missionId, onEvent, signal }, {
					message: verifierOnlyBlocked
						? `${provider.label}: Spark task completed; ignored planning-literal verifier warning (${output.length} chars)`
						: `${provider.label}: Spark task completed (${output.length} chars)`,
					data: {
						success: true,
						response: output,
						responseLength: output.length,
						provider: provider.id,
						providerLabel: provider.label,
						sparkTaskId: taskId,
						sparkBridge: provider.sparkExecutionBridge || 'codex',
						metadata: status.result?.metadata || {}
					}
				})
			);
			return { success: true, response: output, durationMs: Date.now() - startedAt };
		}

		if (['failed', 'cancelled', 'timeout', 'timed_out'].includes(state)) {
			const error = status.error || status.result?.error || `Spark task ${taskId} ended with status ${state}`;
			onEvent(
				createBridgeEvent('task_failed', { provider, missionId, onEvent, signal }, {
					message: `${provider.label}: ${error}`,
					data: {
						success: false,
						error,
						provider: provider.id,
						providerLabel: provider.label,
						sparkTaskId: taskId,
						sparkStatus: state
					}
				})
			);
			return { success: false, error, durationMs: Date.now() - startedAt };
		}

		await sleep(POLL_INTERVAL_MS, signal);
		progress = Math.min(90, progress + 3);
	}

	return {
		success: false,
		error: `Spark task ${taskId} timed out after ${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s`,
		durationMs: Date.now() - startedAt
	};
}

async function getSparkTaskStatus(
	baseUrl: string,
	taskId: string,
	signal?: AbortSignal
): Promise<SparkTaskStatus> {
	const response = await fetch(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, { signal });
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		const detail = body.slice(0, 300);
		if (response.status === 404) {
			throw new Error(
				`Spark status request failed (HTTP 404 not found): ${detail}. ` +
				`Task ${taskId} is unknown to the harness; the task id may have been pruned or the harness URL is wrong.`
			);
		}
		throw new Error(`Spark status request failed (HTTP ${response.status}): ${detail}`);
	}
	return (await response.json()) as SparkTaskStatus;
}

function parseSparkOutput(output: string): Record<string, unknown> | null {
	if (!output.trim()) return null;
	try {
		const parsed = JSON.parse(output) as unknown;
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function extractSparkOutput(status: SparkTaskStatus): Record<string, unknown> | null {
	const metadata = status.result?.metadata || {};
	const metadataOutput = metadata.spark_output;
	if (metadataOutput && typeof metadataOutput === 'object') {
		return metadataOutput as Record<string, unknown>;
	}
	return parseSparkOutput(status.result?.output || '');
}

function extractChangedFiles(status: SparkTaskStatus): string[] {
	const metadata = status.result?.metadata || {};
	const metadataFiles = metadata.changed_files;
	if (Array.isArray(metadataFiles)) {
		const changed = metadataFiles.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
		if (changed.length > 0) return changed;
	}
	const sparkOutput = metadata.spark_output;
	if (sparkOutput && typeof sparkOutput === 'object') {
		const changed = (sparkOutput as Record<string, unknown>).changed_files;
		if (Array.isArray(changed)) {
			return changed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
		}
	}
	const parsed = parseSparkOutput(status.result?.output || '');
	const changed = parsed?.changed_files;
	return Array.isArray(changed)
		? changed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
		: [];
}

function isVerifierOnlyBlocked(status: SparkTaskStatus): boolean {
	const metadata = status.result?.metadata || {};
	const verification = metadata.builder_local_verification;
	if (!verification || typeof verification !== 'object') return false;
	const failures = (verification as Record<string, unknown>).failures;
	if (!Array.isArray(failures) || failures.length === 0) return false;
	return failures.every(
		(item) =>
			typeof item === 'string' &&
			item.startsWith("Required text '") &&
			item.endsWith('was not found in the changed workspace files.')
	);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('Cancelled'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('Cancelled'));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
