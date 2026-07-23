import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPendingPRDResult } from './prd-bridge';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('pending PRD response boundaries', () => {
	it('stops before parsing a non-success pending response', async () => {
		const fetchMock = vi.fn(async () => new Response('upstream failure', { status: 503 }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(checkPendingPRDResult()).resolves.toBeNull();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('stops before parsing a non-success result response', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ pending: true, requestId: 'request-1' }))
			.mockResolvedValueOnce(new Response('upstream failure', { status: 502 }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(checkPendingPRDResult()).resolves.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
