import type { RequestEvent } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PRIVATE_ENV = vi.hoisted((): Record<string, string | undefined> => ({
	EVENTS_API_KEY: 'events-key',
	MCP_API_KEY: 'mcp-key',
	SPARK_BRIDGE_API_KEY: 'bridge-key'
}));

vi.mock('$env/dynamic/private', () => ({ env: PRIVATE_ENV }));

import { GET as getBoard } from './board/+server';
import { GET as getStatus } from './status/+server';
import { GET as getTrace } from './trace/+server';
import { GET as getResults } from './results/+server';

let stateDir = '';
const originalStateDir = process.env.SPAWNER_STATE_DIR;

function resetEnv() {
	PRIVATE_ENV.EVENTS_API_KEY = 'events-key';
	PRIVATE_ENV.MCP_API_KEY = 'mcp-key';
	PRIVATE_ENV.SPARK_BRIDGE_API_KEY = 'bridge-key';
	PRIVATE_ENV.EVENTS_ALLOWED_ORIGINS = '';
	if (originalStateDir === undefined) delete process.env.SPAWNER_STATE_DIR;
	else process.env.SPAWNER_STATE_DIR = originalStateDir;
}

function event(url: string, clientAddress = '127.0.0.1', headers: Record<string, string> = {}): RequestEvent {
	return {
		request: new Request(url, { headers: { accept: 'application/json', ...headers } }),
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

async function writeOverduePendingRequest(requestId: string): Promise<void> {
	await mkdir(stateDir, { recursive: true });
	await writeFile(
		path.join(stateDir, 'pending-request.json'),
		JSON.stringify(
			{
				requestId,
				missionId: `mission-${requestId}`,
				projectName: 'Loopback Read Recovery Probe',
				status: 'pending',
				autoAnalysis: {
					status: 'running',
					startedAt: '2026-06-08T18:00:00.000Z',
					timeoutMs: 1000,
					deadlineAt: '2026-06-08T18:00:01.000Z'
				}
			},
			null,
			2
		),
		'utf-8'
	);
}

describe('mission-control read route auth', () => {
	afterEach(async () => {
		resetEnv();
		if (stateDir && existsSync(stateDir)) {
			await rm(stateDir, { recursive: true, force: true });
		}
		stateDir = '';
	});

	it('allows local loopback reads without a key', async () => {
		await expect(getBoard(event('http://127.0.0.1:3333/api/mission-control/board') as never)).resolves.toMatchObject({ status: 200 });
		await expect(getStatus(event('http://127.0.0.1:3333/api/mission-control/status') as never)).resolves.toMatchObject({ status: 200 });
		await expect(getTrace(event('http://127.0.0.1:3333/api/mission-control/trace') as never)).resolves.toMatchObject({ status: 200 });

		const missingResults = await getResults(event('http://127.0.0.1:3333/api/mission-control/results') as never);
		expect(missingResults.status).toBe(400);
	});

	it('keeps non-local reads gated without credentials', async () => {
		const response = await getBoard(event('https://spawner.example.com/api/mission-control/board', '203.0.113.10') as never);

		expect(response.status).toBe(401);
	});

	it('lets the authenticated Spark bridge read terminal trace results for Telegram delivery', async () => {
		const response = await getTrace(
			event('https://spawner.example.com/api/mission-control/trace?missionId=missing', '203.0.113.10', {
				'x-api-key': 'bridge-key'
			}) as never
		);

		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload.authorityBoundary).toBeUndefined();
	});

	it('rejects the wrong Spark bridge key for non-local trace reads', async () => {
		const response = await getTrace(
			event('https://spawner.example.com/api/mission-control/trace?missionId=missing', '203.0.113.10', {
				'x-api-key': 'wrong-bridge-key'
			}) as never
		);

		expect(response.status).toBe(401);
	});

	it('does not let local no-key reads recover or mutate overdue PRD pending state', async () => {
		stateDir = await mkdtemp(path.join(tmpdir(), 'mission-control-read-auth-'));
		process.env.SPAWNER_STATE_DIR = stateDir;

		await writeOverduePendingRequest('board-loopback-read');
		const boardResponse = await getBoard(event('http://127.0.0.1:3333/api/mission-control/board') as never);
		expect(boardResponse.status).toBe(200);
		let pending = JSON.parse(await readFile(path.join(stateDir, 'pending-request.json'), 'utf-8'));
		expect(pending).toMatchObject({
			requestId: 'board-loopback-read',
			status: 'pending',
			autoAnalysis: { status: 'running' }
		});
		expect(existsSync(path.join(stateDir, 'mission-control.json'))).toBe(false);

		await writeOverduePendingRequest('status-loopback-read');
		const statusResponse = await getStatus(event('http://127.0.0.1:3333/api/mission-control/status') as never);
		expect(statusResponse.status).toBe(200);
		pending = JSON.parse(await readFile(path.join(stateDir, 'pending-request.json'), 'utf-8'));
		expect(pending).toMatchObject({
			requestId: 'status-loopback-read',
			status: 'pending',
			autoAnalysis: { status: 'running' }
		});
		expect(existsSync(path.join(stateDir, 'mission-control.json'))).toBe(false);
	});
});
