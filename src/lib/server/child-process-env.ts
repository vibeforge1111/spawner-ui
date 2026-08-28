const SECRET_ENV_KEY_PATTERN = /^(SPARK_|BOT_)|API_KEY$/i;

export function isSecretChildProcessEnvKey(key: string): boolean {
	return SECRET_ENV_KEY_PATTERN.test(key);
}

export function sanitizeChildProcessEnv(
	source: NodeJS.ProcessEnv = process.env,
	overrides: Record<string, string | undefined> = {}
): Record<string, string> {
	const sanitized: Record<string, string> = {};

	for (const [key, value] of Object.entries(source)) {
		if (typeof value !== 'string' || value.length === 0) continue;
		if (isSecretChildProcessEnvKey(key)) continue;
		sanitized[key] = value;
	}

	for (const [key, value] of Object.entries(overrides)) {
		if (typeof value !== 'string' || value.length === 0) continue;
		sanitized[key] = value;
	}

	return sanitized;
}
