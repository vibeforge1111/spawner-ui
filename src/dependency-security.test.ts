import { describe, expect, it } from 'vitest';
import packageMetadata from '../package.json';

describe('release dependency security pins', () => {
	it('keeps the patched PostCSS floor and Hono runtime override', () => {
		expect(packageMetadata.devDependencies.postcss).toBe('^8.5.23');
		expect(packageMetadata.overrides['@hono/node-server']).toBe('2.0.11');
	});
});
