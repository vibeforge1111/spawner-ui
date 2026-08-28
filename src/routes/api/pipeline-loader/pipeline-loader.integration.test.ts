import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'path';
import { existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { GET, POST, DELETE } from './+server';

let testSpawnerDir: string;
let pendingLoadFile: string;
let lastLoadFile: string;
let archivedLoadFile: string;
const TEST_API_KEY = 'pipeline-loader-route-test-secret';
const originalMcpApiKey = process.env.MCP_API_KEY;

async function resetTestSpawnerDir() {
	delete process.env.SPAWNER_STATE_DIR;
	if (testSpawnerDir && existsSync(testSpawnerDir)) {
		await rm(testSpawnerDir, { recursive: true, force: true });
	}
}

describe('/api/pipeline-loader integration', () => {
	beforeEach(async () => {
		await resetTestSpawnerDir();
		testSpawnerDir = await mkdtemp(path.join(tmpdir(), 'spawner-pipeline-loader-'));
		process.env.SPAWNER_STATE_DIR = testSpawnerDir;
		process.env.MCP_API_KEY = TEST_API_KEY;
		pendingLoadFile = path.join(testSpawnerDir, 'pending-load.json');
		lastLoadFile = path.join(testSpawnerDir, 'last-canvas-load.json');
		archivedLoadFile = path.join(testSpawnerDir, 'canvas-loads', 'pipe-fixed-id.json');
	});

	afterEach(async () => {
		await resetTestSpawnerDir();
		if (originalMcpApiKey === undefined) delete process.env.MCP_API_KEY;
		else process.env.MCP_API_KEY = originalMcpApiKey;
	});

	function routeEvent(
		url: string,
		body?: unknown,
		method = 'GET',
		options: { auth?: boolean; clientAddress?: string } = {}
	) {
		const auth = options.auth !== false;
		return {
			request: new Request(url, {
				method,
				headers: {
					'Content-Type': 'application/json',
					...(auth ? { 'x-api-key': TEST_API_KEY } : {})
				},
				body: body === undefined ? undefined : JSON.stringify(body)
			}),
			url: new URL(url),
			getClientAddress: () => options.clientAddress || '127.0.0.1'
		};
	}

	it('consumes pending load on GET and preserves queued pipeline ID', async () => {
		const payload = {
			pipelineId: 'pipe-fixed-id',
			pipelineName: 'Queued Pipeline',
			nodes: [{ skill: { id: 'api-design' }, position: { x: 100, y: 100 } }],
			connections: [],
			source: 'prd',
			autoRun: true
		};

		const postResponse = await POST({
			...routeEvent('http://localhost/api/pipeline-loader', payload, 'POST')
		} as never);
		expect(postResponse.status).toBe(200);
		expect(existsSync(pendingLoadFile)).toBe(true);
		expect(existsSync(lastLoadFile)).toBe(true);
		expect(existsSync(archivedLoadFile)).toBe(true);

		const firstGet = await GET({
			...routeEvent('http://localhost/api/pipeline-loader')
		} as never);
		expect(firstGet.status).toBe(200);
		const firstBody = await firstGet.json();
		expect(firstBody.pending).toBe(true);
		expect(firstBody.load.pipelineId).toBe('pipe-fixed-id');
		expect(firstBody.load.autoRun).toBe(true);
		expect(existsSync(pendingLoadFile)).toBe(false);
		expect(existsSync(lastLoadFile)).toBe(true);

		const latestGet = await GET({
			...routeEvent('http://localhost/api/pipeline-loader?latest=true')
		} as never);
		expect(latestGet.status).toBe(200);
		const latestBody = await latestGet.json();
		expect(latestBody.pending).toBe(true);
		expect(latestBody.load.pipelineId).toBe('pipe-fixed-id');
		expect(existsSync(lastLoadFile)).toBe(true);

		const secondGet = await GET({
			...routeEvent('http://localhost/api/pipeline-loader')
		} as never);
		expect(secondGet.status).toBe(200);
		const secondBody = await secondGet.json();
		expect(secondBody.pending).toBe(false);
	});

	it('does not consume a pending load when an explicit pipeline filter does not match', async () => {
		const payload = {
			pipelineId: 'pipe-target-project',
			pipelineName: 'Target Project Pipeline',
			nodes: [],
			connections: [],
			source: 'prd-bridge',
			autoRun: true
		};

		const postResponse = await POST({
			...routeEvent('http://localhost/api/pipeline-loader', payload, 'POST')
		} as never);
		expect(postResponse.status).toBe(200);

		const mismatchGet = await GET({
			...routeEvent('http://localhost/api/pipeline-loader?pipeline=pipe-other-project')
		} as never);
		expect(mismatchGet.status).toBe(200);
		const mismatchBody = await mismatchGet.json();
		expect(mismatchBody.pending).toBe(false);
		expect(existsSync(pendingLoadFile)).toBe(true);

		const matchGet = await GET({
			...routeEvent('http://localhost/api/pipeline-loader?pipeline=pipe-target-project')
		} as never);
		expect(matchGet.status).toBe(200);
		const matchBody = await matchGet.json();
		expect(matchBody.pending).toBe(true);
		expect(matchBody.load.pipelineId).toBe('pipe-target-project');
		expect(existsSync(pendingLoadFile)).toBe(false);
	});

	it('preserves Spark relay and build metadata for canvas auto-run', async () => {
		const payload = {
			pipelineId: 'pipe-spark-relay',
			pipelineName: 'Spark Relay Pipeline',
			nodes: [{ skill: { id: 'frontend', name: 'Frontend', category: 'frontend' }, position: { x: 100, y: 100 } }],
			connections: [],
			source: 'prd-bridge',
			buildMode: 'advanced_prd',
			buildModeReason: 'User explicitly requested advanced PRD mode.',
			executionPrompt: 'Build the relay project.',
			autoRun: true,
			executionAuthority: {
				schema_version: 'governor-decision-v1',
				outcome: 'execute'
			},
			relay: {
				chatId: '8319079055',
				userId: 'spark-user',
				requestId: 'tg-build-test',
				goal: 'Build the relay project.',
				autoRun: true,
				executionAuthority: {
					schema_version: 'governor-decision-v1',
					outcome: 'execute'
				},
				buildMode: 'advanced_prd',
				buildModeReason: 'User explicitly requested advanced PRD mode.'
			}
		};

		const postResponse = await POST({
			...routeEvent('http://localhost/api/pipeline-loader', payload, 'POST')
		} as never);
		expect(postResponse.status).toBe(200);

		const latestGet = await GET({
			...routeEvent('http://localhost/api/pipeline-loader?latest=true')
		} as never);
		expect(latestGet.status).toBe(200);
		const latestBody = await latestGet.json();
		expect(latestBody.pending).toBe(true);
		expect(latestBody.load.pipelineId).toBe('pipe-spark-relay');
		expect(latestBody.load.source).toBe('prd-bridge');
		expect(latestBody.load.buildMode).toBe('advanced_prd');
		expect(latestBody.load.buildModeReason).toBe('User explicitly requested advanced PRD mode.');
		expect(latestBody.load.executionPrompt).toBe('Build the relay project.');
		expect(latestBody.load.relay).toMatchObject({
			chatId: '8319079055',
			userId: 'spark-user',
			requestId: 'tg-build-test',
			goal: 'Build the relay project.',
			autoRun: true,
			buildMode: 'advanced_prd',
			buildModeReason: 'User explicitly requested advanced PRD mode.'
		});
		expect(latestBody.load.executionAuthority).toBeUndefined();
		expect(latestBody.load.relay.executionAuthority).toBeUndefined();
	});

	it('allows local read-only canvas recovery without an API key', async () => {
		const payload = {
			pipelineId: 'pipe-fixed-id',
			pipelineName: 'Local Canvas Recovery',
			nodes: [{ skill: { id: 'local-canvas' }, position: { x: 100, y: 100 } }],
			connections: [],
			source: 'prd-bridge',
			autoRun: true
		};

		const postResponse = await POST({
			...routeEvent('http://localhost/api/pipeline-loader', payload, 'POST')
		} as never);
		expect(postResponse.status).toBe(200);

		const latestGet = await GET({
			...routeEvent('http://localhost/api/pipeline-loader?latest=true&pipeline=pipe-fixed-id', undefined, 'GET', {
				auth: false
			})
			} as never);
			expect(latestGet.status).toBe(401);
	});

	it('does not let local no-key reads consume pending loads or receive execution payloads', async () => {
		const payload = {
			pipelineId: 'pipe-local-render-only',
			pipelineName: 'Local Render Only Pipeline',
			nodes: [{ skill: { id: 'local-render' }, position: { x: 100, y: 100 } }],
			connections: [],
			source: 'prd-bridge',
			executionPrompt: 'Build from this private prompt.',
			autoRun: true,
			relay: {
				chatId: '8319079055',
				userId: 'spark-user',
				requestId: 'tg-build-local-render-only'
			}
		};

		const postResponse = await POST({
			...routeEvent('http://localhost/api/pipeline-loader', payload, 'POST')
		} as never);
		expect(postResponse.status).toBe(200);
		expect(existsSync(pendingLoadFile)).toBe(true);

		const localGet = await GET({
			...routeEvent('http://localhost/api/pipeline-loader', undefined, 'GET', {
				auth: false
			})
			} as never);
			expect(localGet.status).toBe(401);
	});

	it('blocks non-local read-only canvas recovery without an API key', async () => {
		const response = await GET({
			...routeEvent('http://spawner.example/api/pipeline-loader?latest=true', undefined, 'GET', {
				auth: false,
				clientAddress: '203.0.113.10'
			})
		} as never);

		expect(response.status).toBe(401);
	});

	it('recovers the requested pipeline from archive instead of unrelated latest load', async () => {
		const firstPayload = {
			pipelineId: 'pipe-fixed-id',
			pipelineName: 'Archived Target Pipeline',
			nodes: [{ skill: { id: 'target-node' }, position: { x: 100, y: 100 } }],
			connections: [],
			source: 'prd-bridge',
			autoRun: true
		};
		const secondPayload = {
			pipelineId: 'pipe-newer-project',
			pipelineName: 'Newer Unrelated Pipeline',
			nodes: [{ skill: { id: 'newer-node' }, position: { x: 100, y: 100 } }],
			connections: [],
			source: 'prd-bridge',
			autoRun: true
		};

		expect(await POST(routeEvent('http://localhost/api/pipeline-loader', firstPayload, 'POST') as never)).toHaveProperty(
			'status',
			200
		);
		expect(await POST(routeEvent('http://localhost/api/pipeline-loader', secondPayload, 'POST') as never)).toHaveProperty(
			'status',
			200
		);

		const requestedGet = await GET({
			...routeEvent('http://localhost/api/pipeline-loader?latest=true&pipeline=pipe-fixed-id', undefined, 'GET', {
				auth: false
			})
			} as never);
			expect(requestedGet.status).toBe(401);
	});

	it('clears pending load with DELETE', async () => {
		const postResponse = await POST({
			...routeEvent('http://localhost/api/pipeline-loader', {
				pipelineId: 'pipe-delete-id',
				pipelineName: 'Delete Pipeline'
			}, 'POST')
		} as never);
		expect(postResponse.status).toBe(200);
		expect(existsSync(pendingLoadFile)).toBe(true);

		const deleteResponse = await DELETE(routeEvent('http://localhost/api/pipeline-loader', undefined, 'DELETE') as never);
		expect(deleteResponse.status).toBe(200);
		expect(existsSync(pendingLoadFile)).toBe(false);
	});

	it('blocks unauthenticated queue mutation', async () => {
		const response = await POST({
			request: new Request('http://localhost/api/pipeline-loader', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					pipelineId: 'pipe-no-auth',
					pipelineName: 'No Auth Pipeline'
				})
			}),
			url: new URL('http://localhost/api/pipeline-loader'),
			getClientAddress: () => '127.0.0.1'
		} as never);

		expect(response.status).toBe(401);
		expect(existsSync(pendingLoadFile)).toBe(false);
	});
});
