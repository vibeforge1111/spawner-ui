import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe('structured logger', () => {
	it('emits one parseable JSON record with context and arguments when enabled', () => {
		vi.stubEnv('JSON_LOGGING', '1');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		logger.scope('Scheduler').warn('retry delayed', { attempt: 2 });

		expect(warn).toHaveBeenCalledTimes(1);
		const record = JSON.parse(String(warn.mock.calls[0][0]));
		expect(record).toMatchObject({
			level: 'warn',
			context: 'Scheduler',
			message: 'retry delayed',
			args: [{ attempt: 2 }]
		});
		expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
	});

	it('falls back safely when an argument cannot be JSON serialized', () => {
		vi.stubEnv('JSON_LOGGING', '1');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const circular: { self?: unknown } = {};
		circular.self = circular;

		expect(() => logger.warn('circular', circular)).not.toThrow();
		expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
			level: 'warn',
			message: 'circular',
			args: ['[object Object]']
		});
	});

	it('preserves the existing human-readable format when JSON logging is disabled', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		logger.warn('plain warning', 7);

		expect(warn).toHaveBeenCalledWith('[WARN ]', 'plain warning', 7);
	});
});
