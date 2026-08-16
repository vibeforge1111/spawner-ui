import { describe, it, expect } from 'vitest';
import { sanitizedChildEnv } from './sanitized-env';

describe('sanitizedChildEnv', () => {
	it('removes standard API key variables', () => {
		const env = sanitizedChildEnv();
		expect(env).not.toHaveProperty('OPENAI_API_KEY');
		expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
	});

	it('removes variables matching sensitive patterns', () => {
		const env = sanitizedChildEnv();
		for (const key of Object.keys(env)) {
			expect(key).not.toMatch(/API_KEY$/i);
			expect(key).not.toMatch(/SECRET$/i);
			expect(key).not.toMatch(/TOKEN$/i);
			expect(key).not.toMatch(/PASSWORD$/i);
		}
	});

	it('keeps SPARK_* variables', () => {
		const env = sanitizedChildEnv();
		for (const key of Object.keys(env)) {
			if (key.startsWith('SPARK_')) {
				expect(env[key]).toBeDefined();
			}
		}
	});

	it('keeps system essentials like PATH, HOME', () => {
		const env = sanitizedChildEnv();
		expect(env).toHaveProperty('PATH');
		expect(env).toHaveProperty('HOME');
	});

	it('applies overrides on top of sanitized env', () => {
		const env = sanitizedChildEnv({ MY_VAR: 'hello', FORCE_COLOR: '0' });
		expect(env.MY_VAR).toBe('hello');
		expect(env.FORCE_COLOR).toBe('0');
	});

	it('overrides take precedence over sanitized base', () => {
		const env = sanitizedChildEnv({ PATH: '/custom/path' });
		expect(env.PATH).toBe('/custom/path');
	});

	it('does not include undefined values', () => {
		const env = sanitizedChildEnv();
		for (const value of Object.values(env)) {
			expect(value).not.toBeUndefined();
		}
	});
});
