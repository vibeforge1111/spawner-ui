import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PRIVATE_ENV = vi.hoisted((): Record<string, string | undefined> => ({}));
vi.mock('$env/dynamic/private', () => ({ env: PRIVATE_ENV }));

import { POST } from './+server';
import {
	buildServerGovernorDecisionAuthority,
	buildServerTurnIntentVNextAuthority
} from '$lib/server/harness-authority';

const originalFetch = globalThis.fetch;
const TEST_API_KEY = 'analyze-test-secret';

function event(
	body: unknown,
	apiKey: string | null = TEST_API_KEY,
	url = 'http://127.0.0.1:3333/api/analyze',
	clientAddress = '127.0.0.1'
) {
	const headers = new Headers({ 'content-type': 'application/json' });
	if (apiKey) headers.set('x-api-key', apiKey);
	return {
		request: new Request(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body)
		}),
		url: new URL(url),
		getClientAddress: () => clientAddress,
		cookies: { get: () => undefined }
	};
}

function claudeResponse() {
	return new Response(
		JSON.stringify({
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						technologies: ['SvelteKit'],
						features: ['Project analysis'],
						domains: ['web-app'],
						suggestedSkills: [{ id: 'sveltekit', reason: 'Needed for the app.', tier: 1 }],
						complexity: 'moderate',
						summary: 'Build a governed Spark app analyzer.',
						workflowOrder: ['sveltekit'],
						questions: []
					})
				}
			]
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);
}

function governorAuthority() {
	return buildServerGovernorDecisionAuthority({
		source: 'analyze-authority-test',
		reason: 'Focused external analysis authority regression.',
		toolName: 'spawner.analyze',
		mutationClass: 'external_network',
		requestId: 'analyze-authority-test',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test',
		target: 'Analyze a project.',
		externalNetwork: true
	});
}

function bareVNextAuthority() {
	return buildServerTurnIntentVNextAuthority({
		source: 'analyze-authority-test',
		reason: 'Focused external analysis authority regression.',
		toolName: 'spawner.analyze',
		mutationClass: 'external_network',
		requestId: 'analyze-authority-test',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test',
		target: 'Analyze a project.',
		externalNetwork: true
	});
}

describe('/api/analyze authority contract', () => {
	beforeEach(() => {
		PRIVATE_ENV.ANTHROPIC_API_KEY = 'test-anthropic-key';
		PRIVATE_ENV.MCP_API_KEY = TEST_API_KEY;
		globalThis.fetch = vi.fn(async () => claudeResponse()) as typeof fetch;
	});

	afterEach(() => {
		delete PRIVATE_ENV.ANTHROPIC_API_KEY;
		delete PRIVATE_ENV.MCP_API_KEY;
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('rejects unauthenticated non-local analysis before local fallback or external calls', async () => {
		const response = await POST(
			event(
				{ goal: 'Analyze this startup app.' },
				null,
				'https://spawner.example.com/api/analyze',
				'203.0.113.10'
			) as never
		);

		expect(response.status).toBe(401);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('rejects unauthenticated local analysis before local fallback or external calls', async () => {
		const response = await POST(event({ goal: 'Analyze this startup app.' }, null) as never);

		expect(response.status).toBe(401);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('blocks external Claude analysis without Harness authority', async () => {
		const response = await POST(event({ goal: 'Analyze this startup app.' }) as never);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('blocks bare VNext authority for external Claude analysis', async () => {
		const response = await POST(
			event({
				goal: 'Analyze this startup app.',
				executionAuthority: bareVNextAuthority()
			}) as never
		);

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('allows external Claude analysis with native Governor authority', async () => {
		const response = await POST(
			event({
				goal: 'Analyze this startup app.',
				executionAuthority: governorAuthority()
			}) as never
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.success).toBe(true);
		expect(body.source).toBe('claude');
		expect(body.analysis.summary).toBe('Build a governed Spark app analyzer.');
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		const request = vi.mocked(globalThis.fetch).mock.calls[0][1];
		const claudeBody = JSON.parse(String(request?.body)) as {
			system: Array<{ type: string; text: string; cache_control: { type: string } }>;
			messages: Array<{ role: string; content: string }>;
		};
		expect(claudeBody.system[0].cache_control).toEqual({ type: 'ephemeral' });
		expect(claudeBody.system[0].text).toContain('Available Skills');
		expect(claudeBody.messages).toEqual([
			{ role: 'user', content: '## Project Description\nAnalyze this startup app.' }
		]);
	});
});
