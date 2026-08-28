import { describe, expect, it } from 'vitest';
import { isSecretChildProcessEnvKey, sanitizeChildProcessEnv } from './child-process-env';

describe('child-process-env', () => {
	it('flags Spark, bot, and API key env names as secret', () => {
		expect(isSecretChildProcessEnvKey('SPARK_BRIDGE_API_KEY')).toBe(true);
		expect(isSecretChildProcessEnvKey('SPARK_HOME')).toBe(true);
		expect(isSecretChildProcessEnvKey('BOT_TOKEN')).toBe(true);
		expect(isSecretChildProcessEnvKey('OPENAI_API_KEY')).toBe(true);
		expect(isSecretChildProcessEnvKey('PATH')).toBe(false);
		expect(isSecretChildProcessEnvKey('NODE_ENV')).toBe(false);
	});

	it('drops secret env vars before child process spawn', () => {
		const env = sanitizeChildProcessEnv({
			PATH: '/usr/bin',
			NODE_ENV: 'test',
			SPARK_BRIDGE_API_KEY: 'bridge-secret',
			BOT_TOKEN: 'bot-secret',
			OPENAI_API_KEY: 'openai-secret'
		});

		expect(env).toEqual({
			PATH: '/usr/bin',
			NODE_ENV: 'test'
		});
	});

	it('applies explicit overrides after filtering the parent env', () => {
		const env = sanitizeChildProcessEnv(
			{
				PATH: '/usr/bin',
				SPARK_UI_API_KEY: 'ui-secret'
			},
			{
				FORCE_COLOR: '0',
				CI: 'true'
			}
		);

		expect(env).toEqual({
			PATH: '/usr/bin',
			FORCE_COLOR: '0',
			CI: 'true'
		});
	});
});
