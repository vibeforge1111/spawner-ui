import { spawn } from 'node:child_process';

const PORT = Number(process.env.SPARK_HOSTED_LOCK_SMOKE_PORT || 3374);
const BASE_URL = process.env.SPARK_HOSTED_LOCK_BASE_URL || `http://127.0.0.1:${PORT}`;
const startedHere = !process.env.SPARK_HOSTED_LOCK_BASE_URL;
const hostedClientAddress = '203.0.113.10';
const publicAppPaths = ['/canvas', '/kanban', '/trace', '/skills', '/settings', '/missions', '/spark-live/login'];
const publicApiPaths = ['/api/mission-control/board', '/api/spark/run', '/api/prd-bridge/pending'];

function fail(message) {
	console.error(`hosted-lock smoke failed: ${message}`);
	process.exitCode = 1;
}

async function waitForServer(child) {
	const deadline = Date.now() + 15_000;
	let lastError;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`server exited before smoke test started with code ${child.exitCode}`);
		}
		try {
			const response = await fetch(BASE_URL, { redirect: 'manual' });
			if (response.status > 0) return;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw lastError || new Error('server did not start before timeout');
}

async function expectStatus(path, expectedStatus, init = {}) {
	const response = await fetch(`${BASE_URL}${path}`, {
		redirect: 'manual',
		...init,
		headers: {
			accept: 'text/html',
			'x-forwarded-for': hostedClientAddress,
			...(init.headers || {})
		}
	});
	if (response.status !== expectedStatus) {
		fail(`${path} returned ${response.status}, expected ${expectedStatus}`);
	}
	return response;
}

async function runSmoke() {
	let child;
	if (startedHere) {
		child = spawn(process.execPath, ['build'], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				PORT: String(PORT),
				ADDRESS_HEADER: 'x-forwarded-for',
				XFF_DEPTH: '1',
				SPARK_LIVE_CONTAINER: '1',
				SPARK_HOSTED_PRIVATE_PREVIEW: '',
				SPARK_WORKSPACE_ID: '',
				SPARK_UI_API_KEY: ''
			}
		});

		child.stdout.on('data', (chunk) => process.stdout.write(chunk));
		child.stderr.on('data', (chunk) => process.stderr.write(chunk));
		await waitForServer(child);
	}

	const root = await expectStatus('/', 200);
	const rootHtml = await root.text();
	if (!rootHtml.includes('Spawner is not public access yet')) {
		fail('root did not render the locked public preview shell');
	}
	for (const href of ['href="/canvas"', 'href="/kanban"', 'href="/trace"', 'href="/skills"', 'href="/settings"']) {
		if (rootHtml.includes(href)) {
			fail(`root leaked app navigation link ${href}`);
		}
	}
	if (root.headers.get('x-frame-options') !== 'DENY') {
		fail('root is missing X-Frame-Options: DENY');
	}
	if (!root.headers.get('content-security-policy')?.includes("frame-ancestors 'none'")) {
		fail('root is missing hosted Content-Security-Policy frame guard');
	}

	for (const path of publicAppPaths) {
		await expectStatus(path, 503);
	}
	for (const path of publicApiPaths) {
		await expectStatus(path, 503, { headers: { accept: 'application/json' } });
	}

	const csrfProbe = await fetch(`${BASE_URL}/spark-live/login`, {
		method: 'POST',
		redirect: 'manual',
		headers: {
			origin: 'https://evil.example',
			'sec-fetch-site': 'cross-site',
			'x-forwarded-for': hostedClientAddress,
			'content-type': 'application/x-www-form-urlencoded'
		},
		body: 'workspaceId=bad&uiKey=bad'
	});
	if (csrfProbe.status !== 403) {
		fail(`/spark-live/login cross-site POST returned ${csrfProbe.status}, expected 403`);
	}

	if (process.exitCode) return;
	console.log('hosted-lock smoke passed');

	if (child) {
		child.kill();
	}
}

runSmoke()
	.catch((error) => {
		fail(error instanceof Error ? error.message : String(error));
	})
	.finally(() => {
		if (startedHere) {
			setTimeout(() => process.exit(process.exitCode || 0), 250);
		}
	});
