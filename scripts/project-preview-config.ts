const DEFAULT_PROJECT_PREVIEW_PORT = 5555;

function validPort(value: unknown): number | null {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export function configuredPreviewPort(
	env: Record<string, string | undefined> = process.env,
	argv: string[] = process.argv
): number {
	const explicitPort = validPort(env.SPARK_PROJECT_PREVIEW_PORT);
	if (explicitPort !== null) return explicitPort;

	const cliIndex = argv.indexOf('--port');
	const cliPort = cliIndex >= 0 ? validPort(argv[cliIndex + 1]) : null;
	if (cliPort !== null) return cliPort;

	try {
		const urlPort = validPort(new URL(env.SPARK_PROJECT_PREVIEW_URL || '').port);
		if (urlPort !== null) return urlPort;
	} catch {
		// Fall through to the local default.
	}
	return DEFAULT_PROJECT_PREVIEW_PORT;
}
