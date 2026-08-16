import { sanitizedChildEnv } from "./sanitized-env";
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { spawnHidden, terminateProcessTree } from './hidden-process';
import type { AccessExecutionLaneId, AccessRunPolicy } from './access-execution-lanes';

export type AccessExecutionActionId =
	| 'workspace_setup'
	| 'docker_doctor'
	| 'docker_smoke'
	| 'level5_enable'
	| 'level5_disable';

export interface AccessExecutionAction {
	id: AccessExecutionActionId;
	label: string;
	laneId: AccessExecutionLaneId;
	command: string[];
	displayCommand: string;
	runPolicy: AccessRunPolicy;
	confirmation?: string;
	rollback?: string;
	timeoutMs: number;
}

export interface AccessExecutionCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	payload: Record<string, unknown> | null;
}

export interface AccessExecutionResult {
	success: boolean;
	action: AccessExecutionAction;
	result: AccessExecutionCommandResult;
}

export interface AccessExecutionRunner {
	(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<{
		exitCode: number;
		stdout: string;
		stderr: string;
		durationMs: number;
	}>;
}

export class AccessExecutionPolicyError extends Error {
	status = 428;

	constructor(
		message: string,
		readonly action: AccessExecutionAction
	) {
		super(message);
		this.name = 'AccessExecutionPolicyError';
	}
}

export const ACCESS_EXECUTION_ACTIONS: Record<AccessExecutionActionId, AccessExecutionAction> = {
	workspace_setup: {
		id: 'workspace_setup',
		label: 'Set up safe workspace',
		laneId: 'spark_workspace',
		command: ['access', 'setup', '--json'],
		displayCommand: 'spark access setup',
		runPolicy: 'auto_safe',
		timeoutMs: 60_000
	},
	docker_doctor: {
		id: 'docker_doctor',
		label: 'Check runner',
		laneId: 'docker',
		command: ['sandbox', 'docker', 'doctor', '--json'],
		displayCommand: 'spark sandbox docker doctor --json',
		runPolicy: 'auto_read_only',
		timeoutMs: 30_000
	},
	docker_smoke: {
		id: 'docker_smoke',
		label: 'Test sandbox',
		laneId: 'docker',
		command: ['sandbox', 'docker', 'smoke', '--json'],
		displayCommand: 'spark sandbox docker smoke --json',
		runPolicy: 'confirm_once',
		confirmation: 'Run Docker sandbox test',
		rollback: 'Docker smoke uses an ephemeral container; remove local images only with explicit cleanup approval.',
		timeoutMs: 180_000
	},
	level5_enable: {
		id: 'level5_enable',
		label: 'Confirm Access Level 5',
		laneId: 'level5_operator',
		command: ['access', 'setup', '--level', '5', '--enable-high-agency', '--json'],
		displayCommand: 'spark access setup --level 5 --enable-high-agency',
		runPolicy: 'explicit_opt_in',
		confirmation: 'Enable whole-computer operator mode',
		rollback: 'spark access disable-level5',
		timeoutMs: 60_000
	},
	level5_disable: {
		id: 'level5_disable',
		label: 'Return to Level 4',
		laneId: 'level5_operator',
		command: ['access', 'disable-level5', '--json'],
		displayCommand: 'spark access disable-level5',
		runPolicy: 'confirm_once',
		confirmation: 'Return to workspace sandbox',
		rollback: 'spark access setup --level 5 --enable-high-agency',
		timeoutMs: 60_000
	}
};

const MAX_ACTION_OUTPUT_LENGTH = 10_000;

function configuredSparkCliPath(): string | null {
	const candidates = [
		process.env.SPARK_CLI_PATH,
		process.env.SPARK_PATH,
		process.env.SPAWNER_SPARK_CLI_PATH
	];

	for (const candidate of candidates) {
		const value = candidate?.trim();
		if (!value) continue;
		if (value.includes('/') || value.includes('\\')) {
			return existsSync(value) ? value : null;
		}
		return value;
	}

	return null;
}

export function resolveSparkCliBinary(): string {
	const configured = configuredSparkCliPath();
	if (configured) return configured;

	try {
		const locator = process.platform === 'win32' ? 'where.exe' : 'which';
		const output = execFileSync(locator, ['spark'], {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore'],
			windowsHide: true,
			timeout: 5_000
		});
		const matches = output
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		if (process.platform === 'win32') {
			return matches.find((line) => line.toLowerCase().endsWith('.cmd')) || matches[0] || 'spark';
		}
		return matches[0] || 'spark';
	} catch (err) {
		console.warn('[access-execution-actions] spark binary lookup failed:', err);
		return 'spark';
	}
}

function truncateActionOutput(value: string): string {
	if (value.length <= MAX_ACTION_OUTPUT_LENGTH) return value;
	return `${value.slice(0, MAX_ACTION_OUTPUT_LENGTH)}\n...(truncated)`;
}

function parseJsonPayload(stdout: string): Record<string, unknown> | null {
	const trimmed = stdout.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function actionFromId(actionId: string): AccessExecutionAction | null {
	return Object.prototype.hasOwnProperty.call(ACCESS_EXECUTION_ACTIONS, actionId)
		? ACCESS_EXECUTION_ACTIONS[actionId as AccessExecutionActionId]
		: null;
}

function assertRunPolicySatisfied(
	action: AccessExecutionAction,
	input: { confirmed?: boolean; explicitOptIn?: string }
): void {
	if (action.runPolicy === 'auto_safe' || action.runPolicy === 'auto_read_only') return;
	if (action.runPolicy === 'confirm_once' && input.confirmed === true) return;
	if (action.runPolicy === 'explicit_opt_in' && input.explicitOptIn === action.confirmation) return;

	const message =
		action.runPolicy === 'explicit_opt_in'
			? `Action ${action.id} requires explicit opt-in: ${action.confirmation}`
			: `Action ${action.id} requires confirmation: ${action.confirmation}`;
	throw new AccessExecutionPolicyError(message, action);
}

async function defaultAccessExecutionRunner(
	command: string,
	args: string[],
	options: { cwd: string; timeoutMs: number }
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
	return new Promise((resolve) => {
		const start = Date.now();
		let stdout = '';
		let stderr = '';
		let settled = false;
		const child = spawnHidden(command, args, {
			cwd: options.cwd,
			env: sanitizedChildEnv({ FORCE_COLOR: "0", CI: "true" })
		});

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			terminateProcessTree(child);
			resolve({
				exitCode: 124,
				stdout: truncateActionOutput(stdout),
				stderr: truncateActionOutput(`${stderr}\nCommand timed out after ${options.timeoutMs}ms`.trim()),
				durationMs: Date.now() - start
			});
		}, options.timeoutMs);

		child.stdout?.on('data', (data: Buffer) => {
			stdout += data.toString('utf8');
		});

		child.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString('utf8');
		});

		child.on('close', (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode: code ?? 1,
				stdout: truncateActionOutput(stdout),
				stderr: truncateActionOutput(stderr),
				durationMs: Date.now() - start
			});
		});

		child.on('error', (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode: 1,
				stdout: '',
				stderr: error.message,
				durationMs: Date.now() - start
			});
		});
	});
}

export function listAccessExecutionActions(): AccessExecutionAction[] {
	return Object.values(ACCESS_EXECUTION_ACTIONS);
}

export function accessExecutionActionNeedsConfirmation(action: AccessExecutionAction): boolean {
	return action.runPolicy === 'confirm_once' || action.runPolicy === 'explicit_opt_in';
}

export async function runAccessExecutionAction(
	actionId: string,
	input: {
		confirmed?: boolean;
		explicitOptIn?: string;
		runner?: AccessExecutionRunner;
		cwd?: string;
	} = {}
): Promise<AccessExecutionResult> {
	const action = actionFromId(actionId);
	if (!action) {
		throw new Error(`Unsupported access execution action: ${actionId}`);
	}

	assertRunPolicySatisfied(action, input);

	const runner = input.runner || defaultAccessExecutionRunner;
	const command = resolveSparkCliBinary();
	const cwd = input.cwd || process.cwd();
	const result = await runner(command, action.command, {
		cwd,
		timeoutMs: action.timeoutMs
	});

	return {
		success: result.exitCode === 0,
		action,
		result: {
			...result,
			payload: parseJsonPayload(result.stdout)
		}
	};
}
