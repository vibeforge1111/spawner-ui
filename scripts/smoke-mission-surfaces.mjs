#!/usr/bin/env node

import {
	createHarnessCoreActionEnvelopeVNext,
	createHarnessCoreAuthorizedGovernorDecision,
	signHarnessCoreGovernorDecision
} from '@spark/harness-core';
import { createServer } from 'node:http';

const baseUrl = (process.env.SPAWNER_SMOKE_BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
const apiKey = process.env.EVENTS_API_KEY || process.env.MCP_API_KEY || '';
const governorHmacKey = process.env.SPARK_GOVERNOR_HMAC_KEY || '';
const governorHmacKeyId = process.env.SPARK_GOVERNOR_HMAC_KEY_ID || 'local';
const stamp = Date.now();
const requestId = `smoke-surfaces-${stamp}`;
const missionId = `mission-${stamp}`;
const projectName = 'Spark Mission Surface Smoke';
const tasks = [
	{
		id: 'task-1-plan-route',
		title: 'Plan route smoke',
		summary: 'Create the project canvas and planned mission tasks.',
		skills: ['observability'],
		dependencies: [],
		acceptanceCriteria: ['Canvas can be opened from a mission-scoped URL.'],
		verificationCommands: ['npm run smoke:routes']
	},
	{
		id: 'task-2-verify-surfaces',
		title: 'Verify mission surfaces',
		summary: 'Check Kanban, mission detail, trace, and Spark agent surfaces.',
		skills: ['api-design'],
		dependencies: ['task-1-plan-route'],
		acceptanceCriteria: ['Trace reports a completed mission with 100% task progress.'],
		verificationCommands: ['npm run smoke:mission-surfaces']
	}
];

function url(path) {
	return `${baseUrl}${path}`;
}

function governedAuthority({ toolName, mutationClass, reason }) {
	const envelope = createHarnessCoreActionEnvelopeVNext({
		surface: 'spawner',
		ownerSystem: 'spawner-ui',
		source: 'smoke-script',
		reason,
		toolName,
		mutationClass,
		requestId,
		actorKind: 'human',
		actorIdRef: 'spawner-smoke',
		target: requestId,
		publishes: false,
		externalNetwork: false,
		requiresHumanConfirmation: false,
		confidence: 1
	});
	const decision = createHarnessCoreAuthorizedGovernorDecision({
		envelope,
		tool_name: toolName,
		restrictions: {
			network_allowed: false,
			write_allowed: mutationClass === 'writes_files' || mutationClass === 'launches_mission',
			publish_allowed: false
		}
	});
	return governorHmacKey
		? signHarnessCoreGovernorDecision(decision, {
				key: governorHmacKey,
				key_id: governorHmacKeyId
			})
		: decision;
}

function startLocalProvider() {
	return new Promise((resolve, reject) => {
		const server = createServer(async (request, response) => {
			if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
				response.writeHead(404).end();
				return;
			}
			for await (const _chunk of request) {
				// Drain the request before returning the deterministic local response.
			}
			response.writeHead(200, {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache'
			});
			response.end(
				`data: ${JSON.stringify({
					choices: [{ delta: { content: 'Local mission surface smoke completed.' } }]
				})}\n\ndata: [DONE]\n\n`
			);
		});
		const onError = (error) => reject(error);
		server.once('error', onError);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', onError);
			const address = server.address();
			if (!address || typeof address === 'string') {
				reject(new Error('Local provider did not bind to a TCP port'));
				return;
			}
			server.unref();
			resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/v1` });
		});
	});
}

function parseJson(text, path) {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${path} returned malformed JSON: ${message}; body=${text.slice(0, 300)}`);
	}
}

async function postJson(path, body) {
	const headers = { 'Content-Type': 'application/json' };
	if (apiKey) headers['x-api-key'] = apiKey;
	const response = await fetch(url(path), {
		method: 'POST',
		headers,
		body: JSON.stringify(body)
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${path} returned ${response.status}: ${text.slice(0, 300)}`);
	}
	return parseJson(text, path);
}

async function getJson(path) {
	const response = await fetch(url(path));
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${path} returned ${response.status}: ${text.slice(0, 300)}`);
	}
	return parseJson(text, path);
}

async function getHtml(path, expectedPathname) {
	const response = await fetch(url(path));
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${path} returned ${response.status}: ${text.slice(0, 300)}`);
	}
	if (expectedPathname && new URL(response.url).pathname !== expectedPathname) {
		throw new Error(`${path} redirected to ${new URL(response.url).pathname}`);
	}
	if (!text.trim().startsWith('<!doctype html>') && !response.headers.get('content-type')?.includes('text/html')) {
		throw new Error(`${path} did not return HTML`);
	}
	return text;
}

async function waitFor(description, probe, timeoutMs = 6000) {
	const started = Date.now();
	let lastError = null;
	while (Date.now() - started < timeoutMs) {
		try {
			const result = await probe();
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`${description} did not become true${lastError ? `: ${lastError.message}` : ''}`);
}

function findMission(board, bucket) {
	return (board?.[bucket] || []).find((entry) => entry.missionId === missionId);
}

const checks = [];
async function check(name, fn) {
	try {
		const detail = await fn();
		checks.push({ name, ok: true, detail });
	} catch (error) {
		checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
	}
}

const localProvider = await startLocalProvider();

await check('create governed pending PRD request', async () => {
	const result = await postJson('/api/prd-bridge/write', {
		content: [
			'# Spark Mission Surface Smoke',
			'',
			'Exercise the local PRD, Canvas, Kanban, mission detail, trace, and Spark agent surfaces.',
			'Do not dispatch a real provider, use external network access, or publish anything.'
		].join('\n'),
		requestId,
		projectName,
		buildMode: 'direct',
		buildLane: 'direct',
		forceDispatch: true,
		executionAuthority: governedAuthority({
			toolName: 'spawner.prd.write',
			mutationClass: 'writes_files',
			reason: 'Exercise the governed PRD-to-mission surface flow in an isolated runtime.'
		})
	});
	if (result?.success !== true) throw new Error('Governed pending request was not created');
	return requestId;
});

await check('store PRD result', async () => {
	const result = await postJson('/api/prd-bridge/result', {
		requestId,
		result: {
			success: true,
			projectName,
			executionPrompt: 'Synthetic smoke mission. Do not dispatch a real provider.',
			tasks
		}
	});
	if (result?.success !== true) throw new Error('PRD result was not stored');
	return requestId;
});

await check('load mission canvas without auto-run', async () => {
	const result = await postJson('/api/prd-bridge/load-to-canvas', {
		requestId,
		missionId,
		autoRun: false,
		buildMode: 'direct',
		telegramRelay: { profile: 'smoke', port: 3333 },
		chatId: 'smoke-chat',
		userId: 'smoke-user',
		goal: 'Run Mission Control surface smoke.'
	});
	if (result?.success !== true) throw new Error('Canvas load failed');
	if (result?.canvasUrl !== `/canvas?pipeline=prd-${requestId}&mission=${missionId}`) {
		throw new Error(`Unexpected canvasUrl: ${result?.canvasUrl}`);
	}
	return result.canvasUrl;
});

await check('complete an authenticated local provider dispatch', async () => {
	const provider = {
		id: 'openai',
		label: 'Local OpenAI-Compatible Smoke',
		model: 'smoke-model',
		enabled: true,
		kind: 'openai_compat',
		eventSource: 'local-smoke-provider',
		capabilities: ['review'],
		executesFilesystem: false,
		requiresApiKey: true,
		apiKeyEnv: 'OPENAI_API_KEY',
		baseUrl: localProvider.baseUrl
	};
	const result = await postJson('/api/dispatch', {
		executionPack: {
			enabled: true,
			strategy: 'single',
			primaryProviderId: provider.id,
			providers: [provider],
			assignments: {
				[provider.id]: {
					providerId: provider.id,
					mode: 'review',
					taskIds: tasks.map((task) => task.id)
				}
			},
			mcpTaskPlans: Object.fromEntries(
				tasks.map((task) => [
					task.id,
					{
						taskId: task.id,
						taskTitle: task.title,
						status: 'not_needed',
						requiredCapabilities: [],
						toolCalls: []
					}
				])
			),
			blockedTaskIds: [],
			masterPrompt: `Mission: ${projectName}`,
			providerPrompts: {
				[provider.id]: 'Return one short sentence confirming the isolated mission surface smoke.'
			},
			launchCommands: {},
			createdAt: new Date().toISOString(),
			missionId
		},
		apiKeys: { [provider.id]: 'local-smoke-provider-key' },
		relay: {
			requestId,
			traceRef: `trace:spawner-prd:${missionId}`,
			pipelineId: `prd-${requestId}`,
			autoRun: true
		},
		executionAuthority: governedAuthority({
			toolName: 'spawner.dispatch',
			mutationClass: 'launches_mission',
			reason: 'Authorize a loopback-only provider session for the isolated mission surface smoke.'
		})
	});
	if (result?.success !== true || result?.missionId !== missionId) {
		throw new Error(`Local provider dispatch did not start: ${JSON.stringify(result)}`);
	}
	return missionId;
});

await check('Kanban board shows completed task rollup', async () => {
	const entry = await waitFor('completed board entry', async () => {
		const body = await getJson('/api/mission-control/board');
		if (body?.ok !== true) throw new Error('Board response was not ok');
		return findMission(body.board, 'completed');
	});
	if (
		entry.taskStatusCounts?.completed < tasks.length ||
		entry.taskStatusCounts?.completed !== entry.taskStatusCounts?.total ||
		entry.taskStatusCounts?.failed !== 0 ||
		entry.taskStatusCounts?.cancelled !== 0
	) {
		throw new Error(`Unexpected task counts: ${JSON.stringify(entry.taskStatusCounts)}`);
	}
	return `${entry.taskStatusCounts.completed}/${entry.taskStatusCounts.total} complete`;
});

await check('Mission detail link resolves to canonical Kanban view', async () => {
	await getHtml(`/missions/${missionId}`, '/kanban');
	return `/kanban?mission=${missionId}`;
});

await check('Canvas route stays mission-scoped', async () => {
	await getHtml(`/canvas?pipeline=prd-${requestId}&mission=${missionId}`, '/canvas');
	return `/canvas?pipeline=prd-${requestId}&mission=${missionId}`;
});

await check('Trace stitches mission, canvas, kanban, and dispatch', async () => {
	const trace = await waitFor('completed trace', async () => {
		const body = await getJson(`/api/mission-control/trace?missionId=${missionId}&requestId=${requestId}`);
		if (body?.ok !== true) throw new Error('Trace response was not ok');
		return body.phase === 'completed' ? body : null;
	});
	if (trace.progress?.percent !== 100) throw new Error(`Trace progress was ${trace.progress?.percent}`);
	if (trace.surfaces?.canvas?.pipelineId !== `prd-${requestId}`) {
		throw new Error(`Trace canvas pipeline mismatch: ${trace.surfaces?.canvas?.pipelineId}`);
	}
	if (trace.surfaces?.kanban?.bucket !== 'completed') {
		throw new Error(`Trace Kanban bucket mismatch: ${trace.surfaces?.kanban?.bucket}`);
	}
	if (
		trace.surfaces?.dispatch?.allComplete !== true ||
		trace.surfaces?.dispatch?.anyFailed !== false ||
		trace.surfaces?.dispatch?.providers?.openai !== 'completed'
	) {
		throw new Error(`Trace dispatch state mismatch: ${JSON.stringify(trace.surfaces?.dispatch)}`);
	}
	if (trace.timeline?.[0]?.eventType !== 'mission_completed') {
		throw new Error(`Trace timeline did not end with mission_completed: ${trace.timeline?.[0]?.eventType}`);
	}
	return `${trace.phase} ${trace.progress.percent}%`;
});

await check('Spark agent canvas-state API remains reachable', async () => {
	const body = await getJson('/api/spark-agent/canvas-state');
	if (body?.success !== true) throw new Error('Spark agent canvas-state was not successful');
	return body.hasUpdate ? 'snapshot available' : 'no snapshot yet';
});

for (const result of checks) {
	const line = result.ok ? `PASS ${result.name}` : `FAIL ${result.name}`;
	const detail = result.detail ? ` - ${result.detail}` : '';
	(result.ok ? console.log : console.error)(`${line}${detail}`);
}

if (checks.some((result) => !result.ok)) {
	process.exitCode = 1;
}

await new Promise((resolve) => localProvider.server.close(resolve));
