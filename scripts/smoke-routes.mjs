#!/usr/bin/env node

const baseUrl = (process.env.SPAWNER_SMOKE_BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');

const checks = [
	{ path: '/', kind: 'html' },
	{ path: '/kanban', kind: 'html' },
	{ path: '/missions/mission-smoke-route', kind: 'html', finalPath: '/kanban' },
	{ path: '/canvas', kind: 'html' },
	{ path: '/trace', kind: 'html' },
	{ path: '/api/mission-control/board', kind: 'json', okKey: 'ok' },
	{ path: '/api/mission-control/trace', kind: 'json', okKey: 'ok' },
	{ path: '/api/spark-agent/canvas-state', kind: 'json', okKey: 'success' }
];

async function smokeCheck(check) {
	const url = `${baseUrl}${check.path}`;
	const response = await fetch(url);
	const contentType = response.headers.get('content-type') || '';
	if (!response.ok) {
		throw new Error(`${check.path} returned ${response.status}`);
	}
	if (check.finalPath && new URL(response.url).pathname !== check.finalPath) {
		throw new Error(`${check.path} redirected to ${new URL(response.url).pathname}`);
	}

	if (check.kind === 'html') {
		const text = await response.text();
		if (!contentType.includes('text/html') && !text.trim().startsWith('<!doctype html>')) {
			throw new Error(`${check.path} did not return HTML`);
		}
		return { path: check.path, status: response.status, ok: true };
	}

	const body = await response.json();
	if (check.okKey && body?.[check.okKey] !== true) {
		throw new Error(`${check.path} JSON missing ${check.okKey}: true`);
	}
	return { path: check.path, status: response.status, ok: true };
}

const results = [];
for (const check of checks) {
	try {
		results.push(await smokeCheck(check));
	} catch (error) {
		results.push({
			path: check.path,
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}
}

for (const result of results) {
	if (result.ok) {
		console.log(`PASS ${result.path} (${result.status})`);
	} else {
		console.error(`FAIL ${result.path}: ${result.error}`);
	}
}

if (results.some((result) => !result.ok)) {
	process.exitCode = 1;
}
