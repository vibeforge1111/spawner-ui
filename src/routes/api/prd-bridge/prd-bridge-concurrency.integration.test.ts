/**
 * Two-request concurrency regression for the PRD bridge.
 *
 * /api/prd-bridge/write historically stored the pending PRD and request
 * metadata in singleton files (pending-prd.md, pending-request.json), so two
 * concurrent write->result flows cross-contaminated each other. Pending state
 * is now requestId-scoped (spawner-state/pending-requests/) with the singleton
 * kept as a back-compat pointer. This test runs two simultaneous
 * write->result flows with different requestIds and proves each flow sees its
 * own PRD content and its own canonical result (no collision).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { POST as writePrd } from './write/+server';
import { GET as getResult, POST as postResult } from './result/+server';
import { buildServerGovernorDecisionAuthority } from '$lib/server/harness-authority';

const TEST_API_KEY = 'prd-bridge-concurrency-test-secret';
const originalMcpApiKey = process.env.MCP_API_KEY;
const originalBridgeApiKey = process.env.SPARK_BRIDGE_API_KEY;
const originalAutoProvider = process.env.SPAWNER_PRD_AUTO_PROVIDER;
const originalStateDir = process.env.SPAWNER_STATE_DIR;

let testSpawnerDir: string;

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function writeAuthority(requestId: string) {
	return buildServerGovernorDecisionAuthority({
		source: 'prd-bridge-concurrency-test',
		reason: 'Two-request PRD bridge concurrency regression.',
		toolName: 'spawner.prd.write',
		mutationClass: 'writes_files',
		requestId,
		target: requestId
	});
}

function postEvent(url: string, body: unknown) {
	const parsedUrl = new URL(url);
	return {
		request: new Request(parsedUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
			body: JSON.stringify(body)
		}),
		url: parsedUrl,
		getClientAddress: () => '127.0.0.1'
	};
}

function getEvent(url: string) {
	const parsedUrl = new URL(url);
	return {
		request: new Request(parsedUrl, { headers: { 'x-api-key': TEST_API_KEY } }),
		url: parsedUrl,
		getClientAddress: () => '127.0.0.1'
	};
}

function analysisResult(requestId: string, projectName: string, taskTitle: string) {
	return {
		requestId,
		success: true,
		projectName,
		projectType: 'direct-build',
		complexity: 'simple',
		infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
		techStack: { framework: 'Existing Spawner UI', language: 'TypeScript' },
		tasks: [{ id: 'TAS-1', title: taskTitle, skills: [], dependencies: [] }],
		skills: []
	};
}

describe('/api/prd-bridge two-request concurrency', () => {
	beforeEach(async () => {
		testSpawnerDir = await mkdtemp(path.join(tmpdir(), 'spawner-prd-concurrency-'));
		process.env.SPAWNER_STATE_DIR = testSpawnerDir;
		process.env.MCP_API_KEY = TEST_API_KEY;
		process.env.SPARK_BRIDGE_API_KEY = TEST_API_KEY;
		// Keep the flow deterministic: no auto-analysis worker, results arrive
		// only through the provider-result callback below.
		process.env.SPAWNER_PRD_AUTO_PROVIDER = 'none';
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		restoreEnv('MCP_API_KEY', originalMcpApiKey);
		restoreEnv('SPARK_BRIDGE_API_KEY', originalBridgeApiKey);
		restoreEnv('SPAWNER_PRD_AUTO_PROVIDER', originalAutoProvider);
		restoreEnv('SPAWNER_STATE_DIR', originalStateDir);
		if (testSpawnerDir && existsSync(testSpawnerDir)) {
			await rm(testSpawnerDir, { recursive: true, force: true });
		}
	});

	it('keeps two simultaneous write->result flows isolated per requestId', async () => {
		const requestA = 'tg-build-concurrent-apple-1788222222221';
		const requestB = 'tg-build-concurrent-banana-1788222222222';
		const contentA = '# Concurrent Apple\n\nBuild a static landing page about apples with a hero section and menu.';
		const contentB = '# Concurrent Banana\n\nBuild a static landing page about bananas with a hero section and menu.';

		const [writeResponseA, writeResponseB] = await Promise.all([
			writePrd(postEvent('http://localhost/api/prd-bridge/write', {
				content: contentA,
				requestId: requestA,
				projectName: 'Concurrent Apple',
				buildMode: 'direct',
				executionAuthority: writeAuthority(requestA)
			}) as never),
			writePrd(postEvent('http://localhost/api/prd-bridge/write', {
				content: contentB,
				requestId: requestB,
				projectName: 'Concurrent Banana',
				buildMode: 'direct',
				executionAuthority: writeAuthority(requestB)
			}) as never)
		]);
		expect(writeResponseA.status).toBe(200);
		expect(writeResponseB.status).toBe(200);

		// Each flow keeps its own requestId-scoped PRD content.
		const scopedPrdA = await readFile(
			path.join(testSpawnerDir, 'pending-requests', `${requestA}.md`),
			'utf-8'
		);
		const scopedPrdB = await readFile(
			path.join(testSpawnerDir, 'pending-requests', `${requestB}.md`),
			'utf-8'
		);
		expect(scopedPrdA).toContain('apples');
		expect(scopedPrdA).not.toContain('bananas');
		expect(scopedPrdB).toContain('bananas');
		expect(scopedPrdB).not.toContain('apples');

		// Each flow keeps its own requestId-scoped pending request record.
		const scopedRequestA = JSON.parse(
			await readFile(path.join(testSpawnerDir, 'pending-requests', `${requestA}.json`), 'utf-8')
		);
		const scopedRequestB = JSON.parse(
			await readFile(path.join(testSpawnerDir, 'pending-requests', `${requestB}.json`), 'utf-8')
		);
		expect(scopedRequestA).toMatchObject({ requestId: requestA, projectName: 'Concurrent Apple' });
		expect(scopedRequestB).toMatchObject({ requestId: requestB, projectName: 'Concurrent Banana' });

		// Back-compat singleton pointer still exists and points at one of the
		// two requests (last writer wins) without breaking the other flow.
		const singleton = JSON.parse(
			await readFile(path.join(testSpawnerDir, 'pending-request.json'), 'utf-8')
		);
		expect([requestA, requestB]).toContain(singleton.requestId);

		// Simultaneous provider result callbacks bind per requestId.
		const [resultResponseA, resultResponseB] = await Promise.all([
			postResult(postEvent('http://localhost/api/prd-bridge/result', {
				requestId: requestA,
				result: analysisResult(requestA, 'Concurrent Apple', 'Build the apple landing page')
			}) as never),
			postResult(postEvent('http://localhost/api/prd-bridge/result', {
				requestId: requestB,
				result: analysisResult(requestB, 'Concurrent Banana', 'Build the banana landing page')
			}) as never)
		]);
		expect(resultResponseA.status).toBe(200);
		expect(resultResponseB.status).toBe(200);

		// Each flow reads back its own result, never the other request's.
		const [readA, readB] = await Promise.all([
			getResult(getEvent(`http://localhost/api/prd-bridge/result?requestId=${requestA}`) as never),
			getResult(getEvent(`http://localhost/api/prd-bridge/result?requestId=${requestB}`) as never)
		]);
		const bodyA = await readA.json();
		const bodyB = await readB.json();

		expect(bodyA.found).toBe(true);
		expect(bodyA.result).toMatchObject({
			requestId: requestA,
			projectName: 'Concurrent Apple',
			tasks: [expect.objectContaining({ title: 'Build the apple landing page' })]
		});
		expect(bodyB.found).toBe(true);
		expect(bodyB.result).toMatchObject({
			requestId: requestB,
			projectName: 'Concurrent Banana',
			tasks: [expect.objectContaining({ title: 'Build the banana landing page' })]
		});
		expect(JSON.stringify(bodyA)).not.toContain('banana');
		expect(JSON.stringify(bodyB)).not.toContain('apple');
	});
});
