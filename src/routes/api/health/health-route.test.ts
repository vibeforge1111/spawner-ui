import { describe, expect, it } from 'vitest';
import { GET } from './+server';

function routeEvent(url: string, init?: RequestInit) {
	return {
		request: new Request(url, init),
		url: new URL(url),
		cookies: {
			get: () => undefined
		},
		getClientAddress: () => '127.0.0.1'
	};
}

describe('/api/health', () => {
	it('returns status ok on GET', async () => {
		const response = await GET(routeEvent('http://127.0.0.1/api/health') as never);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ status: 'ok' });
	});
});
