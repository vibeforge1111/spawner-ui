import { describe, expect, it } from 'vitest';
import { buildConfigFromRegistry, isValidNpmPackageSpec } from './client';

describe('MCP registry npm package boundary', () => {
	it.each([
		'server-package',
		'server-package@1.2.3',
		'server-package@^1.2.3',
		'@modelcontextprotocol/server-memory',
		'@scope/server@next'
	])('accepts a bounded npm package spec: %s', (value) => {
		expect(isValidNpmPackageSpec(value)).toBe(true);
	});

	it.each([
		'--package=attacker',
		'../local-package',
		'@scope/../../attacker',
		'https://attacker.example/pkg.tgz',
		'pkg;touch-owned',
		' package'
	])('rejects an unsafe package spec: %s', (value) => {
		expect(isValidNpmPackageSpec(value)).toBe(false);
		expect(() => buildConfigFromRegistry('custom', value)).toThrow('MCP npm package name is invalid');
	});

	it('passes a valid package as one npx argument', () => {
		expect(buildConfigFromRegistry('custom', '@scope/server@1.2.3')).toMatchObject({
			command: 'npx',
			args: ['-y', '@scope/server@1.2.3']
		});
	});
});
