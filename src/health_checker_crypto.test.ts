import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHealthCheck } from './lib/services/health-checker';

afterEach(() => vi.restoreAllMocks());

describe('health check ID generation', () => {
	it('matches check-<ts>-<hex8> format in a real health-check record', () => {
		const check = createHealthCheck('service-1', { status: 'healthy', responseTime: 12 });
		expect(check.id).toMatch(/^check-\d+-[0-9a-f]{8}$/);
	});
	it('uses crypto.randomUUID rather than Math.random in the real creation path', () => {
		const spy = vi.spyOn(Math, 'random');
		const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue('abcdef12-1234-4123-8123-123456789abc');
		const check = createHealthCheck('service-1', { status: 'healthy', responseTime: 12 });
		expect(spy).not.toHaveBeenCalled();
		expect(uuid).toHaveBeenCalledOnce();
		expect(check.id).toMatch(/^check-\d+-abcdef12$/);
	});
});
