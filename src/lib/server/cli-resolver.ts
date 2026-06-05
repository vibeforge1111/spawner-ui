import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export type SparkCliBinary = 'claude' | 'codex';

function configuredCliPath(binaryName: SparkCliBinary): string | null {
	const upper = binaryName.toUpperCase();
	const candidates = [
		process.env[`${upper}_PATH`],
		process.env[`SPARK_${upper}_PATH`],
		process.env[`SPAWNER_${upper}_PATH`]
	];

	for (const candidate of candidates) {
		const value = candidate?.trim();
		if (!value) continue;
		if (value.includes('/') || value.includes('\\')) {
			return existsSync(value) ? value : null;
		}
		// Bare name (no path separator): the env var is asking us to trust
		// PATH resolution. Confirm the bare name actually resolves on PATH
		// before returning it, otherwise resolveCliBinary returns a string
		// that execFileSync will reject with ENOENT — and isCliBinaryAvailable
		// will have already lied to the caller about availability.
		const locator = process.platform === 'win32' ? 'where.exe' : 'which';
		try {
			execFileSync(locator, [value], {
				stdio: ['ignore', 'ignore', 'ignore'],
				windowsHide: true,
				timeout: 5000
			});
			return value;
		} catch {
			return null;
		}
	}

	return null;
}

export function resolveCliBinary(binaryName: SparkCliBinary): string | null {
	const configured = configuredCliPath(binaryName);
	if (configured) return configured;

	try {
		const locator = process.platform === 'win32' ? 'where.exe' : 'which';
		const output = execFileSync(locator, [binaryName], {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore'],
			windowsHide: true,
			timeout: 5000
		});
		const matches = output
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		if (matches.length === 0) return null;
		if (process.platform === 'win32') {
			return matches.find((line) => line.toLowerCase().endsWith('.cmd')) || matches[0] || null;
		}
		return matches[0] || null;
	} catch {
		return null;
	}
}

export function isCliBinaryAvailable(binaryName: SparkCliBinary): boolean {
	return resolveCliBinary(binaryName) !== null;
}
