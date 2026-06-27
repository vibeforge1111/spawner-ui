/**
 * Codex CLI Provider Client
 *
 * Spawns `codex exec` as a child process on Windows (no tmux dependency).
 * Captures stdout/stderr and emits progress events.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderResult, ProviderClientOptions } from './types';
import { createBridgeEvent } from './types';
import { resolveCliBinary } from '../cli-resolver';
import { spawnHidden } from '../hidden-process';
import {
	assertHighAgencyWorkerAllowed,
	highAgencyWorkersAllowed,
	HIGH_AGENCY_WORKERS_ENV,
	resolveCodexSandbox
} from '../high-agency-workers';
import { spawnerStateDir } from '../spawner-state';
import { prepareProviderWorkingDirectory } from '$lib/services/spark-agent-bridge';
import { BoundedProcessOutput } from '../bounded-process-output';

export interface CodexCliOptions extends ProviderClientOptions {
	workingDirectory?: string;
}

const CODEX_TERMINATION_GRACE_MS = 5000;

export interface CodexCliCommand {
	binary: 'codex' | string;
	args: string[];
}

export interface ParseCodexCliCommandOptions {
	allowHighAgency?: boolean;
	env?: Record<string, string | undefined>;
}

interface PromptPersistence {
	exists: (path: string) => boolean;
	mkdir: (path: string) => void;
	write: (path: string, value: string) => void;
}

const promptPersistence: PromptPersistence = {
	exists: existsSync,
	mkdir: (path) => mkdirSync(path, { recursive: true }),
	write: (path, value) => writeFileSync(path, value, 'utf-8')
};

export function persistCodexPrompt(
	promptsDir: string,
	promptFile: string,
	prompt: string,
	persistence: PromptPersistence = promptPersistence
): boolean {
	try {
		if (!persistence.exists(promptsDir)) persistence.mkdir(promptsDir);
		persistence.write(promptFile, prompt);
		return true;
	} catch {
		return false;
	}
}

function isSafeCommandToken(value: string): boolean {
	return /^[A-Za-z0-9._:/@+=-]+$/.test(value);
}

export function parseCodexCliCommand(
	commandTemplate: string,
	options: ParseCodexCliCommandOptions = {}
): CodexCliCommand {
	const tokens = commandTemplate.split(/\s+/).filter(Boolean);
	if (tokens.some((token) => !isSafeCommandToken(token))) {
		throw new Error('Codex command template contains unsafe shell characters');
	}
	if (tokens[0] !== 'codex' || tokens[1] !== 'exec') {
		throw new Error('Codex command template must start with: codex exec');
	}
	if (tokens.length === 3 && tokens[2] === '--yolo') {
		const allowHighAgency = options.allowHighAgency ?? highAgencyWorkersAllowed();
		if (!allowHighAgency) {
			throw new Error(`codex exec high-agency mode requires ${HIGH_AGENCY_WORKERS_ENV}=1`);
		}
		return { binary: 'codex', args: ['exec', '--skip-git-repo-check', '--yolo'] };
	}
	if (tokens[2] === '--model' && tokens[3]) {
		const args = ['exec', '--skip-git-repo-check', '--model', tokens[3]];
		let sandboxSpecified = false;
		for (let i = 4; i < tokens.length; i += 2) {
			const flag = tokens[i];
			const value = tokens[i + 1];
			if (!value) {
				throw new Error(
					'Codex command template must be: codex exec --model <model> [--profile <profile>] [--sandbox read-only|workspace-write|danger-full-access]'
				);
			}
			if (flag === '--profile' || flag === '-p') {
				args.push(flag, value);
				continue;
			}
			if (flag === '--sandbox') {
				args.push('--sandbox', resolveCodexSandbox({ ...(options.env || process.env), SPARK_CODEX_SANDBOX: value }));
				sandboxSpecified = true;
				continue;
			}
			throw new Error(
				'Codex command template must be: codex exec --model <model> [--profile <profile>] [--sandbox read-only|workspace-write|danger-full-access]'
			);
		}
		if (!sandboxSpecified) {
			args.push('--sandbox', resolveCodexSandbox(options.env));
		}
		return { binary: 'codex', args };
	}
	throw new Error('Codex command template must be: codex exec --model <model> [--profile <profile>] [--sandbox read-only|workspace-write|danger-full-access]');
}

export async function isCliBinaryAvailable(binaryName: 'codex'): Promise<boolean> {
	return resolveCliBinary(binaryName) !== null;
}

export async function executeCodexCliRequest(
	options: CodexCliOptions,
	prompt: string
): Promise<ProviderResult> {
	const { provider, missionId, signal, onEvent, workingDirectory } = options;
	const startTime = Date.now();

	onEvent(
		createBridgeEvent('task_started', options, {
			message: `${provider.label} starting (model: ${provider.model})`,
			data: { provider: provider.id, model: provider.model }
		})
	);

	// Detect the binary name from the command template
	const commandTemplate = provider.commandTemplate || 'codex exec --model {model}';
	const model = provider.model || 'gpt-5.5';
	let command: CodexCliCommand;
	try {
		command = parseCodexCliCommand(commandTemplate.replace('{model}', model));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onEvent(
			createBridgeEvent('error', options, {
				message,
				data: { error: message }
			})
		);
		return { success: false, error: message, durationMs: Date.now() - startTime };
	}
	if (command.args.includes('--yolo')) {
		let approval;
		try {
			approval = assertHighAgencyWorkerAllowed(workingDirectory);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			onEvent(
				createBridgeEvent('error', options, {
					message,
					data: { error: message }
				})
			);
			return { success: false, error: message, durationMs: Date.now() - startTime };
		}
		onEvent(
			createBridgeEvent('worker_high_agency_approved', options, {
				message: `${provider.label} high-agency worker approved`,
				data: {
					provider: provider.id,
					workingDirectory: approval.workingDirectory,
					workspaceRoot: approval.workspaceRoot,
					externalProjectPathsAllowed: approval.externalProjectPathsAllowed
				}
			})
		);
	}

	const resolvedBinary = resolveCliBinary('codex');
	if (!resolvedBinary) {
		const error = `${provider.label} CLI "${command.binary}" not found in PATH`;
		onEvent(
			createBridgeEvent('error', options, {
				message: error,
				data: { error }
			})
		);
		return { success: false, error, durationMs: Date.now() - startTime };
	}

	// Write prompt to file for reference
	const promptsDir = join(spawnerStateDir(), 'prompts');
	const promptFile = join(promptsDir, `${missionId}-${provider.id}.md`);
	if (!persistCodexPrompt(promptsDir, promptFile, prompt)) {
		const error = 'Unable to persist Codex prompt';
		onEvent(
			createBridgeEvent('error', options, {
				message: error,
				data: { error }
			})
		);
		return { success: false, error, durationMs: Date.now() - startTime };
	}

	return new Promise<ProviderResult>((resolve) => {
		let cwd: string;
		try {
			cwd = prepareProviderWorkingDirectory(workingDirectory);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			resolve({ success: false, error: message, durationMs: Date.now() - startTime });
			return;
		}

		const stdout = new BoundedProcessOutput('OUTPUT');
		const stderr = new BoundedProcessOutput('STDERR');
		let lastProgressEmit = Date.now();
		let killed = false;
		let killTimeout: ReturnType<typeof setTimeout> | null = null;

		const child = spawnHidden(resolvedBinary, command.args, {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env }
		});

		// Send prompt via stdin
		if (child.stdin) {
			child.stdin.write(prompt);
			child.stdin.end();
		}

		// Handle abort signal. Detach the listener once the child exits so the
		// AbortController does not pin the dead-process closure when the signal
		// is reused across many missions.
		let abortHandler: (() => void) | null = null;
		const releaseAbortListener = () => {
			if (signal && abortHandler) {
				signal.removeEventListener('abort', abortHandler);
				abortHandler = null;
			}
		};
		if (signal) {
			abortHandler = () => {
				killed = true;
				try {
					child.kill('SIGTERM');
				} catch {
					// Process may have already exited
				}
				killTimeout = setTimeout(() => {
					try {
						child.kill('SIGKILL');
					} catch {
						// Process may have already exited after SIGTERM.
					}
				}, CODEX_TERMINATION_GRACE_MS);
			};
			signal.addEventListener('abort', abortHandler, { once: true });
		}

		child.stdout?.on('data', (data: Buffer) => {
			const chunk = data.toString();
			stdout.append(chunk);

			// Emit progress periodically
			const now = Date.now();
			if (now - lastProgressEmit > 3000) {
				const lines = stdout.toString().split('\n').filter(Boolean);
				onEvent(
					createBridgeEvent('task_progress', options, {
						progress: Math.min(80, Math.floor(lines.length * 5)),
						message: `${provider.label}: processing... (${lines.length} output lines)`
					})
				);
				lastProgressEmit = now;
			}
		});

		child.stderr?.on('data', (data: Buffer) => {
			stderr.append(data.toString());
		});

		child.on('error', (err) => {
			releaseAbortListener();
			if (killTimeout) {
				clearTimeout(killTimeout);
				killTimeout = null;
			}
			onEvent(
				createBridgeEvent('task_failed', options, {
					message: `${provider.label} process error: ${err.message}`,
					data: {
						success: false,
						error: err.message,
						provider: provider.id,
						providerLabel: provider.label
					}
				})
			);
			resolve({
				success: false,
				error: `Process error: ${err.message}`,
				durationMs: Date.now() - startTime
			});
		});

		child.on('close', (code) => {
			releaseAbortListener();
			if (killTimeout) {
				clearTimeout(killTimeout);
				killTimeout = null;
			}
			if (killed) {
				resolve({
					success: false,
					error: 'Cancelled',
					durationMs: Date.now() - startTime
				});
				return;
			}

			const success = code === 0;
			const response = stdout.toString().trim();
			const stderrText = stderr.toString();

			if (success) {
				onEvent(
					createBridgeEvent('task_completed', options, {
						message: `${provider.label} completed (exit code ${code})`,
						data: { success: true, responseLength: response.length }
					})
				);
			} else {
				onEvent(
					createBridgeEvent('task_failed', options, {
						message: `${provider.label} exited with code ${code}: ${stderrText.slice(0, 500)}`,
						data: {
							success: false,
							error: `Exit code ${code}: ${stderrText.slice(0, 500)}`,
							exitCode: code,
							stderr: stderrText.slice(0, 500),
							provider: provider.id,
							providerLabel: provider.label
						}
					})
				);
			}

			resolve({
				success,
				response,
				error: success ? undefined : `Exit code ${code}: ${stderrText.slice(0, 500)}`,
				durationMs: Date.now() - startTime
			});
		});
	});
}
