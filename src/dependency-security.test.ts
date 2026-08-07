import { describe, expect, it } from 'vitest';
import packageMetadata from '../package.json';
import shrinkwrap from '../npm-shrinkwrap.json';

describe('release dependency security pins', () => {
	it('keeps the patched PostCSS floor and Hono runtime override', () => {
		expect(packageMetadata.devDependencies.postcss).toBe('^8.5.23');
		expect(packageMetadata.overrides['@hono/node-server']).toBe('2.0.11');
	});

	it('keeps audited transitive dependencies on patched releases', () => {
		expect(shrinkwrap.packages['node_modules/fast-uri']?.version).toBe('3.1.5');
		expect(shrinkwrap.packages['node_modules/hono']?.version).toBe('4.12.34');
		expect(shrinkwrap.packages['node_modules/ip-address']?.version).toBe('10.4.0');
	});
});
