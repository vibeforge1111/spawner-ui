/**
 * Structured Logger
 *
 * Provides consistent logging with log levels that respect environment.
 * In production, only warnings and errors are shown.
 * In development, all logs are shown.
 */

const LOG_LEVELS = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

// In production and tests, only show warnings and errors.
// Vitest runs with DEV semantics, so check MODE first to keep green test output readable.
const currentLevel: LogLevel = import.meta.env.MODE === 'test' ? 'warn' : import.meta.env.DEV ? 'debug' : 'warn';

function shouldLog(level: LogLevel): boolean {
	return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatPrefix(level: LogLevel, context?: string): string {
	const levelStr = level.toUpperCase().padEnd(5);
	return context ? `[${levelStr}][${context}]` : `[${levelStr}]`;
}

function jsonLoggingEnabled(): boolean {
	return typeof process !== 'undefined' && process.env?.JSON_LOGGING === '1';
}

function writeLog(level: LogLevel, msg: string, context?: string, ...args: unknown[]): void {
	const writer =
		level === 'debug'
			? console.debug
			: level === 'info'
				? console.info
				: level === 'warn'
					? console.warn
					: console.error;
	if (!jsonLoggingEnabled()) {
		writer(formatPrefix(level, context), msg, ...args);
		return;
	}

	const entry = { level, context, message: msg, args, timestamp: new Date().toISOString() };
	try {
		writer(JSON.stringify(entry));
	} catch {
		writer(JSON.stringify({ ...entry, args: args.map((arg) => String(arg)) }));
	}
}

export const logger = {
	/**
	 * Debug logs - only shown in development
	 * Use for detailed debugging information
	 */
	debug: (msg: string, ...args: unknown[]): void => {
		if (shouldLog('debug')) {
			writeLog('debug', msg, undefined, ...args);
		}
	},

	/**
	 * Info logs - only shown in development
	 * Use for general information about application flow
	 */
	info: (msg: string, ...args: unknown[]): void => {
		if (shouldLog('info')) {
			writeLog('info', msg, undefined, ...args);
		}
	},

	/**
	 * Warning logs - shown in all environments
	 * Use for potentially problematic situations
	 */
	warn: (msg: string, ...args: unknown[]): void => {
		if (shouldLog('warn')) {
			writeLog('warn', msg, undefined, ...args);
		}
	},

	/**
	 * Error logs - always shown
	 * Use for errors and exceptions
	 */
	error: (msg: string, ...args: unknown[]): void => {
		writeLog('error', msg, undefined, ...args);
	},

	/**
	 * Create a scoped logger with a context prefix
	 * @example const log = logger.scope('CanvasSync');
	 */
	scope: (context: string) => ({
		debug: (msg: string, ...args: unknown[]): void => {
			if (shouldLog('debug')) {
				writeLog('debug', msg, context, ...args);
			}
		},
		info: (msg: string, ...args: unknown[]): void => {
			if (shouldLog('info')) {
				writeLog('info', msg, context, ...args);
			}
		},
		warn: (msg: string, ...args: unknown[]): void => {
			if (shouldLog('warn')) {
				writeLog('warn', msg, context, ...args);
			}
		},
		error: (msg: string, ...args: unknown[]): void => {
			writeLog('error', msg, context, ...args);
		}
	})
};

export default logger;
