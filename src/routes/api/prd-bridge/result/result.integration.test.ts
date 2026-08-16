import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { GET, POST } from './+server';

let testSpawnerDir: string;
const TEST_API_KEY = 'prd-bridge-result-test-secret';
const originalMcpApiKey = process.env.MCP_API_KEY;

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function postResultEvent(
	body: unknown,
	apiKey: string | null = TEST_API_KEY,
	url = 'http://localhost/api/prd-bridge/result',
	clientAddress = '127.0.0.1'
) {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (apiKey) headers['x-api-key'] = apiKey;
	const parsedUrl = new URL(url);
	return {
		request: new Request(parsedUrl, {
			method: 'POST',
			headers,
			body: JSON.stringify(body)
		}),
		url: parsedUrl,
		getClientAddress: () => clientAddress
	};
}

function getResultEvent(
	requestId: string,
	apiKey: string | null = TEST_API_KEY,
	baseUrl = 'http://localhost/api/prd-bridge/result',
	clientAddress = '127.0.0.1'
) {
	const headers: Record<string, string> = {};
	if (apiKey) headers['x-api-key'] = apiKey;
	const url = new URL(`${baseUrl}?requestId=${requestId}`);
	return {
		request: new Request(url, { headers }),
		url,
		getClientAddress: () => clientAddress
	};
}

async function resetTestSpawnerDir() {
	delete process.env.SPAWNER_STATE_DIR;
	if (testSpawnerDir && existsSync(testSpawnerDir)) {
		await rm(testSpawnerDir, { recursive: true, force: true });
	}
}

describe('/api/prd-bridge/result integration', () => {
	beforeEach(async () => {
		await resetTestSpawnerDir();
		testSpawnerDir = await mkdtemp(path.join(tmpdir(), 'spawner-prd-result-'));
		process.env.SPAWNER_STATE_DIR = testSpawnerDir;
		process.env.MCP_API_KEY = TEST_API_KEY;
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await resetTestSpawnerDir();
		restoreEnv('MCP_API_KEY', originalMcpApiKey);
	});

	it('stores and reads PRD results from the configured Spawner state directory', async () => {
		const requestId = 'tg-build-state-dir-test';
		await writeFile(
			path.join(testSpawnerDir, 'pending-request.json'),
			JSON.stringify({ requestId, status: 'pending' }),
			'utf-8'
		);
		const result = {
			success: true,
			projectName: 'State Dir Test',
			projectType: 'clarification-understanding',
			complexity: 'simple',
			infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
			techStack: { framework: 'Existing Spawner UI', language: 'TypeScript' },
			tasks: [{ id: 'TAS-1', title: 'Keep state aligned', skills: [], dependencies: [] }],
			skills: [],
			metadata: {
				deterministicArtifactProof: {
					status: 'written',
					source: 'spawner_prd_deterministic_writer',
					proofHmacSha256: '0'.repeat(64)
				},
				providerMetric: 'retained'
			},
			executionPrompt: 'Acknowledge understanding and ask for missing details.'
		};

		const postResponse = await POST({
			...postResultEvent({ requestId, result })
		} as never);

		expect(postResponse.status).toBe(200);
		expect(existsSync(path.join(testSpawnerDir, 'results', `${requestId}.json`))).toBe(true);

		const getResponse = await GET(getResultEvent(requestId) as never);
		const body = await getResponse.json();

		expect(getResponse.status).toBe(200);
		expect(body.found).toBe(true);
		expect(body.result).toMatchObject({
			requestId,
			success: true,
			projectName: 'State Dir Test',
			tasks: result.tasks,
			instructionTextRedacted: true
		});
		const stored = await readFile(path.join(testSpawnerDir, 'results', `${requestId}.json`), 'utf-8');
		expect(stored).not.toContain('executionPrompt');
		expect(stored).not.toContain('Acknowledge understanding');
		expect(stored).not.toContain('deterministicArtifactProof');
		expect(stored).toContain('providerMetric');
	});

	it('rejects unauthenticated PRD result reads from non-local callers', async () => {
		const requestId = 'tg-build-unauth-result-read-test';
		await mkdir(path.join(testSpawnerDir, 'results'), { recursive: true });
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify({ requestId, success: true }),
			'utf-8'
		);

		const getResponse = await GET(
			getResultEvent(
				requestId,
				null,
				'https://spawner.example.com/api/prd-bridge/result',
				'203.0.113.10'
			) as never
		);

		expect(getResponse.status).toBe(401);
	});

	it('returns metadata only for local no-key PRD result reads', async () => {
		const requestId = 'tg-build-local-result-metadata-only';
		await mkdir(path.join(testSpawnerDir, 'results'), { recursive: true });
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			JSON.stringify(
				{
					requestId,
					success: true,
					projectName: 'Private Build Plan',
					projectType: 'direct-build',
					complexity: 'moderate',
					tasks: [{ id: 'TAS-1', title: 'Private task', skills: ['private-skill'] }],
					skills: ['private-skill'],
					metadata: {
						canonical: true,
						provisional: false,
						resultAuthority: 'provider_result'
					}
				},
				null,
				2
			),
			'utf-8'
		);

		const getResponse = await GET(getResultEvent(requestId, null) as never);
		const body = await getResponse.json();

		expect(getResponse.status).toBe(200);
		expect(body).toMatchObject({
			found: true,
			requestId,
			summary: {
				requestId,
				success: true,
				projectName: 'Private Build Plan',
				projectType: 'direct-build',
				complexity: 'moderate',
				taskCount: 1,
				skillCount: 1,
				metadata: {
					canonical: true,
					provisional: false,
					resultAuthority: 'provider_result'
				}
			},
			authorityBoundary: {
				payload: 'metadata_only',
				result: 'requires_control_auth'
			}
		});
		expect(body.result).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain('Private task');
		expect(JSON.stringify(body)).not.toContain('private-skill');
	});

	it('reads canonical result artifacts with a UTF-8 BOM prefix', async () => {
		const requestId = 'tg-build-bom-result-read-test';
		await mkdir(path.join(testSpawnerDir, 'results'), { recursive: true });
		await writeFile(
			path.join(testSpawnerDir, 'results', `${requestId}.json`),
			`\ufeff${JSON.stringify(
				{
					requestId,
					success: true,
					projectName: 'BOM Result',
					projectType: 'direct-build',
					complexity: 'moderate',
					tasks: [{ id: 'TAS-1', title: 'Read BOM artifact', skills: ['frontend-engineer'] }],
					skills: ['frontend-engineer']
				},
				null,
				2
			)}`,
			'utf-8'
		);

		const getResponse = await GET(getResultEvent(requestId) as never);
		const body = await getResponse.json();

		expect(getResponse.status).toBe(200);
		expect(body.found).toBe(true);
		expect(body.result).toMatchObject({
			requestId,
			success: true,
			projectName: 'BOM Result'
		});
		expect(body.result.tasks).toHaveLength(1);
	});

	it('rejects malformed result JSON with a useful error', async () => {
		const requestId = 'tg-build-malformed-result-test';
		await writeFile(
			path.join(testSpawnerDir, 'pending-request.json'),
			JSON.stringify({ requestId, status: 'pending' }),
			'utf-8'
		);
		const postResponse = await POST({
			...postResultEvent({ requestId, result: { success: true, projectName: 'Broken' } })
		} as never);
		const body = await postResponse.json();

		expect(postResponse.status).toBe(400);
		expect(body.error).toContain('Invalid PRD analysis result');
		expect(existsSync(path.join(testSpawnerDir, 'results', `${requestId}.json`))).toBe(false);
	});

	it('rejects results that do not bind to a governed pending request without storing artifacts', async () => {
		const requestId = 'tg-build-unbound-result-test';

		const postResponse = await POST({
			...postResultEvent({
				requestId,
				result: {
					success: true,
					projectName: 'Unbound Result',
					projectType: 'direct-build',
					complexity: 'simple',
					infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
					techStack: { framework: 'Existing Spawner UI', language: 'TypeScript' },
					tasks: [{ id: 'TAS-1', title: 'Should never store', skills: [], dependencies: [] }],
					skills: []
				}
			})
		} as never);
		const body = await postResponse.json();

		expect(postResponse.status).toBe(409);
		expect(body.code).toBe('prd_result_unbound');
		expect(existsSync(path.join(testSpawnerDir, 'results', `${requestId}.json`))).toBe(false);

		const traceRows = (await readFile(path.join(testSpawnerDir, 'prd-auto-trace.jsonl'), 'utf-8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(traceRows.find((row) => row.requestId === requestId)).toMatchObject({
			event: 'result_rejected_unbound'
		});
		const missionControlFile = path.join(testSpawnerDir, 'mission-control.json');
		if (existsSync(missionControlFile)) {
			const missionControl = JSON.parse(await readFile(missionControlFile, 'utf-8'));
			expect(
				missionControl.recent.filter(
					(entry: { requestId?: string | null }) => entry.requestId === requestId
				)
			).toEqual([]);
		}
	});

	it('rejects results whose requestId binds to a different pending request', async () => {
		const requestId = 'tg-build-mismatched-result-test';
		await writeFile(
			path.join(testSpawnerDir, 'pending-request.json'),
			JSON.stringify({ requestId: 'tg-build-some-other-request', status: 'pending' }),
			'utf-8'
		);

		const postResponse = await POST({
			...postResultEvent({
				requestId,
				result: {
					success: true,
					projectName: 'Mismatched Result',
					projectType: 'direct-build',
					complexity: 'simple',
					infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
					techStack: { framework: 'Existing Spawner UI', language: 'TypeScript' },
					tasks: [{ id: 'TAS-1', title: 'Should never store', skills: [], dependencies: [] }],
					skills: []
				}
			})
		} as never);
		const body = await postResponse.json();

		expect(postResponse.status).toBe(409);
		expect(body.code).toBe('prd_result_unbound');
		expect(existsSync(path.join(testSpawnerDir, 'results', `${requestId}.json`))).toBe(false);
	});

	it('emits trace and Mission Control events when a bound result is stored', async () => {
		const requestId = 'tg-build-bound-result-events-1788111111111';
		const missionId = 'mission-1788111111111';
		const traceRef = 'trace:spawner-prd:mission-1788111111111';
		await writeFile(
			path.join(testSpawnerDir, 'pending-request.json'),
			JSON.stringify({
				requestId,
				missionId,
				traceRef,
				projectName: 'Bound Result Events',
				pipelineId: `prd-${requestId}`,
				status: 'pending'
			}),
			'utf-8'
		);

		const postResponse = await POST({
			...postResultEvent({
				requestId,
				result: {
					success: true,
					projectName: 'Bound Result Events',
					projectType: 'direct-build',
					complexity: 'simple',
					infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
					techStack: { framework: 'Existing Spawner UI', language: 'TypeScript' },
					tasks: [{ id: 'TAS-1', title: 'Store bound result', skills: [], dependencies: [] }],
					skills: []
				}
			})
		} as never);
		const body = await postResponse.json();

		expect(postResponse.status).toBe(200);
		expect(body).toMatchObject({ success: true, requestId, traceRef });
		expect(existsSync(path.join(testSpawnerDir, 'results', `${requestId}.json`))).toBe(true);
		const stored = JSON.parse(await readFile(path.join(testSpawnerDir, 'results', `${requestId}.json`), 'utf-8'));
		expect(stored.traceRef).toBe(traceRef);

		const traceRows = (await readFile(path.join(testSpawnerDir, 'prd-auto-trace.jsonl'), 'utf-8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(traceRows.find((row) => row.requestId === requestId)).toMatchObject({
			event: 'canonical_result_stored',
			traceRef,
			missionId,
			pipelineId: `prd-${requestId}`
		});

		const missionControl = JSON.parse(
			await readFile(path.join(testSpawnerDir, 'mission-control.json'), 'utf-8')
		);
		const missionEvents = missionControl.recent.filter(
			(entry: { missionId?: string }) => entry.missionId === missionId
		);
		expect(missionEvents.length).toBeGreaterThan(0);
		expect(missionEvents[0]).toMatchObject({
			eventType: 'log',
			missionId,
			requestId,
			traceRef,
			pipelineId: `prd-${requestId}`,
			taskName: 'PRD analysis result'
		});
	});

	it('rejects unauthenticated canonical result writes from non-local callers without storing artifacts', async () => {
		const requestId = 'tg-build-unauth-result-test';
		const postResponse = await POST({
			...postResultEvent(
				{
					requestId,
					result: {
						success: true,
						projectName: 'Unauthorized Result',
						projectType: 'direct-build',
						complexity: 'simple',
						infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
						techStack: { framework: 'Existing Spawner UI', language: 'TypeScript' },
						tasks: [{ id: 'TAS-1', title: 'Should not store', skills: [], dependencies: [] }],
						skills: []
					}
				},
				null,
				'https://spawner.example.com/api/prd-bridge/result',
				'203.0.113.10'
			)
		} as never);

		expect(postResponse.status).toBe(401);
		expect(existsSync(path.join(testSpawnerDir, 'results', `${requestId}.json`))).toBe(false);
	});

	it('rejects unauthenticated canonical result writes from local loopback callers without storing artifacts', async () => {
		const requestId = 'tg-build-unauth-result-local-test';
		const postResponse = await POST({
			...postResultEvent(
				{
					requestId,
					result: {
						success: true,
						projectName: 'Unauthorized Local Result',
						projectType: 'direct-build',
						complexity: 'simple',
						infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
						techStack: { framework: 'Existing Spawner UI', language: 'TypeScript' },
						tasks: [{ id: 'TAS-1', title: 'Should not store locally', skills: [], dependencies: [] }],
						skills: []
					}
				},
				null
			)
		} as never);

		expect(postResponse.status).toBe(409);
		expect(existsSync(path.join(testSpawnerDir, 'results', `${requestId}.json`))).toBe(false);
	});

	it('uses pending request tier to strip pro skills from base result storage', async () => {
		const requestId = 'tg-base-skill-gate-test';
		await writeFile(
			path.join(testSpawnerDir, 'pending-request.json'),
			JSON.stringify({ requestId, tier: 'base' }),
			'utf-8'
		);

		const postResponse = await POST({
			...postResultEvent({
				requestId,
				result: {
					success: true,
					projectName: 'Base Skill Gate',
					projectType: 'direct-build',
					complexity: 'simple',
					infrastructure: { needsAuth: false, needsDatabase: false, needsAPI: false },
					techStack: { framework: 'Existing Spawner UI', language: 'TypeScript' },
					tasks: [
						{
							id: 'TAS-1',
							title: 'Build the base surface',
							skills: ['frontend-engineer', 'threejs-3d-graphics'],
							dependencies: []
						}
					],
					skills: ['frontend-engineer', 'threejs-3d-graphics']
				}
			})
		} as never);

		expect(postResponse.status).toBe(200);
		const stored = JSON.parse(await readFile(path.join(testSpawnerDir, 'results', `${requestId}.json`), 'utf-8'));
		expect(stored.tasks[0].skills).toEqual(['frontend-engineer']);
		expect(stored.skills).toEqual(['frontend-engineer']);
		expect(stored.metadata.skillGate).toMatchObject({
			applied: true,
			tier: 'base'
		});
	});
});
