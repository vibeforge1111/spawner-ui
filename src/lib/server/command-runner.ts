/**
 * Shared Command Runner - Server-side utilities for executing commands
 *
 * Used by /api/verify and /api/scan routes.
 * Handles direct process execution, timeouts, and output truncation.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { commandTimeoutMs } from './timeout-config';
import { sanitizeChildProcessEnv } from './child-process-env';
import { externalProjectPathsAllowed, resolveContainedPath, sparkWorkspaceRoot } from './spark-run-workspace';
import { BoundedProcessOutput } from './bounded-process-output';

export const MAX_OUTPUT_LENGTH = 5000;
export const COMMAND_TIMEOUT_MS = commandTimeoutMs();
const SIGTERM_GRACE_MS = 5000;
const LOCAL_USER_PATH_RE =
	/(?<![\w/\\])(?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\s'"<>]+|\/(?:Users|home)\/[^\s'"<>]+)/gi;

export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	duration: number;
}

export function truncateOutput(output: string): string {
	const redacted = output.replace(LOCAL_USER_PATH_RE, '[local path]');
	if (redacted.length <= MAX_OUTPUT_LENGTH) return redacted;
	return redacted.slice(-MAX_OUTPUT_LENGTH) + '\n...(truncated)';
}

/**
 * Validate project path: must be absolute, must exist, and must stay inside the Spark workspace root by default.
 */
export function validateProjectPath(projectPath: string): { valid: boolean; error?: string } {
	if (!projectPath || typeof projectPath !== 'string') {
		return { valid: false, error: 'projectPath is required' };
	}
	if (!isAbsolute(projectPath)) {
		return { valid: false, error: 'projectPath must be absolute' };
	}
	if (!existsSync(projectPath)) {
		return { valid: false, error: `Project directory does not exist: ${projectPath}` };
	}
	if (!externalProjectPathsAllowed()) {
		try {
			resolveContainedPath(sparkWorkspaceRoot(), projectPath, 'Project path');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { valid: false, error: message };
		}
	}
	return { valid: true };
}

interface SpawnCommand {
	command: string;
	args: string[];
}

const OPAQUE_PAYLOAD_FLAGS = new Map<string, Set<string>>([
	['bash', new Set(['-c'])],
	['sh', new Set(['-c'])],
	['zsh', new Set(['-c'])],
	['cmd', new Set(['/c'])],
	['cmd.exe', new Set(['/c'])],
	['powershell', new Set(['-command', '-encodedcommand'])],
	['powershell.exe', new Set(['-command', '-encodedcommand'])],
	['pwsh', new Set(['-command', '-encodedcommand'])],
	['pwsh.exe', new Set(['-command', '-encodedcommand'])],
	['node', new Set(['-e', '--eval', '-p', '--print'])],
	['node.exe', new Set(['-e', '--eval', '-p', '--print'])],
	['python', new Set(['-c'])],
	['python.exe', new Set(['-c'])],
	['python3', new Set(['-c'])],
	['python3.exe', new Set(['-c'])],
	['py', new Set(['-c'])],
	['py.exe', new Set(['-c'])]
]);

function commandExecutableName(command: string): string {
	return basename(command).toLowerCase().replace(/^["']|["']$/g, '');
}

export function opaqueCommandPayloadReason(command: string, args: string[]): string | null {
	const commandName = commandExecutableName(command);
	const blockedFlags = OPAQUE_PAYLOAD_FLAGS.get(commandName);
	if (!blockedFlags) return null;
	const flag = args.find((arg) => {
		const normalized = arg.trim().toLowerCase();
		if (blockedFlags.has(normalized)) return true;
		return ['bash', 'sh', 'zsh'].includes(commandName) && /^-[a-z]*c[a-z]*$/.test(normalized);
	});
	if (!flag) return null;
	return `Opaque command payload flag "${flag}" is blocked for ${commandName}.`;
}

function packageManagerCliPath(executable: string): string | null {
	const npmExecPath = process.env.npm_execpath;
	if (npmExecPath && existsSync(npmExecPath)) {
		const execName = basename(npmExecPath).toLowerCase();
		const execDir = dirname(npmExecPath);
		if (executable === 'npm' && execName === 'npm-cli.js') return npmExecPath;
		if (executable === 'npx') {
			const npxCliPath = join(execDir, 'npx-cli.js');
			return existsSync(npxCliPath) ? npxCliPath : null;
		}
		if (executable === 'pnpm' && execName.includes('pnpm')) return npmExecPath;
	}

	const nodeDir = dirname(process.execPath);
	const npmBinDir = join(nodeDir, 'node_modules', 'npm', 'bin');
	const candidate = executable === 'npx' ? join(npmBinDir, 'npx-cli.js') : join(npmBinDir, 'npm-cli.js');
	if ((executable === 'npm' || executable === 'npx') && existsSync(candidate)) return candidate;
	return null;
}

export function resolveSpawnCommand(command: string, args: string[]): SpawnCommand {
	if (process.platform !== 'win32') return { command, args };

	const normalizedCommand = command.toLowerCase().replace(/\.(cmd|bat)$/i, '');
	if (normalizedCommand === 'where') return { command: 'where.exe', args };
	if (['npm', 'npx', 'pnpm'].includes(normalizedCommand)) {
		const cliPath = packageManagerCliPath(normalizedCommand);
		if (cliPath) return { command: process.execPath, args: [cliPath, ...args] };
	}
	return { command, args };
}

/**
 * Run a command in the given directory with timeout
 */
export function runCommand(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number = COMMAND_TIMEOUT_MS
): Promise<CommandResult> {
	return new Promise((res) => {
		const start = Date.now();
		const stdout = new BoundedProcessOutput('OUTPUT');
		const stderr = new BoundedProcessOutput('STDERR');
		let resolved = false;
		const payloadReason = opaqueCommandPayloadReason(command, args);
		if (payloadReason) {
			res({
				exitCode: 1,
				stdout: '',
				stderr: payloadReason,
				duration: Date.now() - start
			});
			return;
		}
		const spawnCommand = resolveSpawnCommand(command, args);

		const child = spawn(spawnCommand.command, spawnCommand.args, {
			cwd,
			shell: false,
			timeout: timeoutMs,
			env: sanitizeChildProcessEnv(process.env, { FORCE_COLOR: '0', CI: 'true' }),
			windowsHide: true
		});

		// Node sends SIGTERM when the spawn `timeout` fires. If the child ignores
		// SIGTERM (npm/test shells with their own signal handlers, hung worker
		// pools), `close` never fires and the API caller waits indefinitely.
		// Schedule a SIGKILL escalation that fires only if the child is still
		// running after the SIGTERM grace window.
		const sigkillTimer = setTimeout(() => {
			try {
				child.kill('SIGKILL');
			} catch {
				// Child may already have exited after SIGTERM.
			}
		}, timeoutMs + SIGTERM_GRACE_MS);

		child.stdout?.on('data', (data: Buffer) => {
			stdout.append(data.toString());
		});

		child.stderr?.on('data', (data: Buffer) => {
			stderr.append(data.toString());
		});

		child.on('close', (code) => {
			clearTimeout(sigkillTimer);
			if (!resolved) {
				resolved = true;
				res({
					exitCode: code ?? 1,
					stdout: truncateOutput(stdout.toString()),
					stderr: truncateOutput(stderr.toString()),
					duration: Date.now() - start
				});
			}
		});

		child.on('error', (err) => {
			clearTimeout(sigkillTimer);
			if (!resolved) {
				resolved = true;
				res({
					exitCode: 1,
					stdout: '',
					stderr: err.message,
					duration: Date.now() - start
				});
			}
		});
	});
}

/**
 * Check if a CLI tool is available on the system
 * Uses 'where' on Windows, 'which' on Unix
 */
export async function isToolAvailable(toolName: string): Promise<boolean> {
	const isWindows = process.platform === 'win32';
	const checkCmd = isWindows ? 'where.exe' : 'which';
	const result = await runCommand(checkCmd, [toolName], process.cwd(), 10_000);
	return result.exitCode === 0;
}

/**
 * Detect the right typecheck command for the project
 */
export async function detectTypecheckCommand(projectPath: string): Promise<{ command: string; args: string[] }> {
	const pkgPath = join(projectPath, 'package.json');
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };

			// SvelteKit projects use svelte-check
			if (deps['svelte-check'] || deps['@sveltejs/kit']) {
				return { command: 'npx', args: ['svelte-check', '--tsconfig', './tsconfig.json'] };
			}

			if (deps['typescript']) {
				return { command: 'npx', args: ['tsc', '--noEmit'] };
			}
		} catch (err) {
			console.warn('[command-runner] dependency check failed:', err);
			// fall through
		}
	}
	return { command: 'npx', args: ['tsc', '--noEmit'] };
}

/**
 * Check if a test script exists in package.json
 */
export async function hasTestScript(projectPath: string): Promise<boolean> {
	const pkgPath = join(projectPath, 'package.json');
	if (!existsSync(pkgPath)) return false;
	try {
		const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
		return !!(pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1');
	} catch (err) {
		console.warn('[command-runner] package.json parse failed:', err);
		return false;
	}
}

/**
 * Parse test counts from output (vitest/jest)
 */
export function parseTestCounts(output: string): { passed: number; failed: number } {
	let passed = 0;
	let failed = 0;

	const vitestMatch = output.match(/(\d+)\s+passed/i);
	if (vitestMatch) passed = parseInt(vitestMatch[1], 10);
	const vitestFailMatch = output.match(/(\d+)\s+failed/i);
	if (vitestFailMatch) failed = parseInt(vitestFailMatch[1], 10);

	const jestMatch = output.match(/Tests:\s*(?:(\d+)\s*failed,?\s*)?(\d+)\s*passed/i);
	if (jestMatch) {
		if (jestMatch[1]) failed = parseInt(jestMatch[1], 10);
		passed = parseInt(jestMatch[2], 10);
	}

	return { passed, failed };
}

/**
 * Count TypeScript errors from output
 */
export function parseErrorCount(output: string): number {
	const svelteMatch = output.match(/found\s+(\d+)\s+error/i);
	if (svelteMatch) return parseInt(svelteMatch[1], 10);

	const tscMatch = output.match(/Found\s+(\d+)\s+error/i);
	if (tscMatch) return parseInt(tscMatch[1], 10);

	const tsErrors = (output.match(/: error TS/g) || []).length;
	if (tsErrors > 0) return tsErrors;

	return 0;
}

/**
 * Ensure a resolved path is within the project directory (path traversal safety)
 */
export function isPathWithinProject(filePath: string, projectPath: string): boolean {
	try {
		resolveContainedPath(projectPath, filePath, 'File path');
		return true;
	} catch {
		return false;
	}
}
