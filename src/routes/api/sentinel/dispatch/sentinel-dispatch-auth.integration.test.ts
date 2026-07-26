import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PRIVATE_ENV = vi.hoisted((): Record<string, string | undefined> => ({
	EVENTS_API_KEY: 'events-key',
	MCP_API_KEY: 'mcp-key'
}));

vi.mock('$env/dynamic/private', () => ({ env: PRIVATE_ENV }));

import { GET, POST } from './+server';

function resetEnv() {
	PRIVATE_ENV.EVENTS_API_KEY = 'events-key';
	PRIVATE_ENV.MCP_API_KEY = 'mcp-key';
	PRIVATE_ENV.EVENTS_ALLOWED_ORIGINS = '';
}

function event(url: string, init: RequestInit = {}, clientAddress = '127.0.0.1'): RequestEvent {
	const headers = new Headers(init.headers);
	if (!headers.has('accept')) headers.set('accept', 'application/json');
	return {
		request: new Request(url, { ...init, headers }),
		url: new URL(url),
		getClientAddress: () => clientAddress,
		cookies: {
			get: vi.fn(),
			getAll: vi.fn(() => []),
			set: vi.fn(),
			delete: vi.fn(),
			serialize: vi.fn()
		}
	} as unknown as RequestEvent;
}

describe('/api/sentinel/dispatch auth boundary', () => {
	afterEach(resetEnv);

	it('allows local reads without opening local dispatch writes', async () => {
		const localRead = await GET(event('http://127.0.0.1:3333/api/sentinel/dispatch') as never);
		expect(localRead.status).toBe(200);

		const localWrite = await POST(
			event('http://127.0.0.1:3333/api/sentinel/dispatch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ actions: [] })
			}) as never
		);
		expect(localWrite.status).toBe(401);
	});

	it('redacts sentinel reasons and URLs from local no-key reads', async () => {
		const write = await POST(
			event('http://127.0.0.1:3333/api/sentinel/dispatch', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': 'events-key'
				},
				body: JSON.stringify({
					source: 'spark-pr-sentinel',
					generated_at: '2026-06-09T00:00:00Z',
					summary: { open_prs: 1 },
					actions: [
						{
							kind: 'pr_review',
							id: 'pr#1',
							priority: 'P0_SECURITY',
							title: 'Review Harness authority bypass',
							reasons: ['Private reason should need control auth'],
							url: 'https://github.com/private/repo/pull/1'
						}
					]
				})
			}) as never
		);
		expect(write.status).toBe(200);

		const localRead = await GET(event('http://127.0.0.1:3333/api/sentinel/dispatch') as never);
		expect(localRead.status).toBe(200);
		const localBody = await localRead.json();

		expect(localBody.authorityBoundary).toMatchObject({
			payload: 'queue_summary',
			reasons: 'requires_control_auth',
			url: 'requires_control_auth'
		});
		expect(localBody.actions[0]).toMatchObject({
			kind: 'pr_review',
			id: 'pr#1',
			priority: 'P0_SECURITY',
			title: 'Review Harness authority bypass'
		});
		expect(localBody.actions[0].reasons).toBeUndefined();
		expect(localBody.actions[0].url).toBeUndefined();
		expect(JSON.stringify(localBody)).not.toContain('Private reason');
		expect(JSON.stringify(localBody)).not.toContain('github.com/private');

		const keyedRead = await GET(
			event('http://127.0.0.1:3333/api/sentinel/dispatch', {
				headers: { 'x-api-key': 'events-key' }
			}) as never
		);
		expect(keyedRead.status).toBe(200);
		const keyedBody = await keyedRead.json();
		expect(keyedBody.authorityBoundary).toBeUndefined();
		expect(keyedBody.actions[0].reasons).toEqual(['Private reason should need control auth']);
		expect(keyedBody.actions[0].url).toBe('https://github.com/private/repo/pull/1');
	});

	it('keeps non-local reads gated without credentials', async () => {
		const response = await GET(
			event('https://spawner.example.com/api/sentinel/dispatch', {}, '203.0.113.10') as never
		);

		expect(response.status).toBe(401);
	});

	it('bounds the retained action history at 100 entries', async () => {
		for (let batch = 0; batch < 3; batch += 1) {
			const actions = Array.from({ length: 50 }, (_, index) => ({
				kind: 'pr_review',
				id: `retention-${batch}-${index}`,
				priority: 'P2_MAINTENANCE',
				title: `Retention action ${batch}-${index}`,
				reasons: ['Retention boundary proof']
			}));
			const response = await POST(
				event('http://127.0.0.1:3333/api/sentinel/dispatch', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-api-key': 'events-key'
					},
					body: JSON.stringify({
						source: 'spark-pr-sentinel',
						generated_at: '2026-07-24T00:00:00Z',
						summary: { open_prs: actions.length },
						actions
					})
				}) as never
			);
			expect(response.status).toBe(200);
		}

		const read = await GET(
			event('http://127.0.0.1:3333/api/sentinel/dispatch?limit=100', {
				headers: { 'x-api-key': 'events-key' }
			}) as never
		);
		expect(read.status).toBe(200);
		const body = await read.json();
		expect(body.total).toBe(100);
		expect(body.count).toBe(100);
		expect(body.actions).toHaveLength(100);
		expect(body.actions[0].id).toBe('retention-2-49');
	});
});
