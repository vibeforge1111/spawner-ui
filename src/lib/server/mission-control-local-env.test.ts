import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localEnvValue } from './mission-control-relay';

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe('mission-control local .env reads', () => {
	it('reads the newest matching value from a regular project file', () => {
		const root = mkdtempSync(join(tmpdir(), 'spawner-local-env-'));
		roots.push(root);
		writeFileSync(join(root, '.env'), 'TELEGRAM_RELAY_SECRET=old\nTELEGRAM_RELAY_SECRET=\"new\"\n');

		expect(localEnvValue('TELEGRAM_RELAY_SECRET', root)).toBe('new');
	});

	it('refuses a .env symbolic link instead of reading outside the project', () => {
		const root = mkdtempSync(join(tmpdir(), 'spawner-local-env-'));
		const outside = mkdtempSync(join(tmpdir(), 'spawner-local-env-outside-'));
		roots.push(root, outside);
		writeFileSync(join(outside, 'secrets'), 'TELEGRAM_RELAY_SECRET=outside-secret\n');
		symlinkSync(join(outside, 'secrets'), join(root, '.env'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		expect(localEnvValue('TELEGRAM_RELAY_SECRET', root)).toBeNull();
		expect(warn).toHaveBeenCalledWith(
			'[MissionControl] Refusing to read a non-regular or symbolic-link .env file'
		);
	});
});
