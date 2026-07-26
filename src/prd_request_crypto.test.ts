import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrdRequestId } from './lib/services/prd-bridge';

afterEach(() => vi.restoreAllMocks());

describe('PRD request ID generation', () => {
	it('matches prd-<ts>-<hex8> format', () => {
		expect(createPrdRequestId()).toMatch(/^prd-\d+-[0-9a-f]{8}$/);
	});
	it('uses crypto.randomUUID rather than Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue('87654321-1234-4123-8123-123456789abc');
		const requestId = createPrdRequestId();
		expect(spy).not.toHaveBeenCalled();
		expect(uuid).toHaveBeenCalledOnce();
		expect(requestId).toMatch(/^prd-\d+-87654321$/);
	});
});
