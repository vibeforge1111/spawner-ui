import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import {
	ProjectPreviewError,
	mimeTypeForProjectPreview,
	resolveProjectPreviewAsset
} from '../src/lib/server/project-preview.ts';

function configuredPreviewPort(): number {
	const explicitPort = Number(process.env.SPARK_PROJECT_PREVIEW_PORT || '');
	if (Number.isFinite(explicitPort) && explicitPort > 0) return Math.trunc(explicitPort);

	const cliIndex = process.argv.indexOf('--port');
	if (cliIndex !== -1 && process.argv.length > cliIndex + 1) {
		const cliPort = Number(process.argv[cliIndex + 1]);
		if (Number.isFinite(cliPort) && cliPort > 0) return Math.trunc(cliPort);
	}

	const rawUrl = process.env.SPARK_PROJECT_PREVIEW_URL || 'http://127.0.0.1:5555';
	try {
		const parsed = new URL(rawUrl);
		const parsedPort = Number(parsed.port);
		if (Number.isFinite(parsedPort) && parsedPort > 0) return parsedPort;
	} catch {
		// Fall through to the default local preview port.
	}
	return 5555;
}

function textResponse(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		}
	});
}

async function handleRequest(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === '/' || url.pathname === '/health') {
		return textResponse(200, 'Spark project preview server is running.');
	}

	const match = url.pathname.match(/^\/preview\/([^/]+)(?:\/(.*))?$/);
	if (!match?.[1]) {
		return textResponse(404, 'Project preview route not found.');
	}

	try {
		const asset = resolveProjectPreviewAsset({
			token: match[1],
			assetPath: match[2] ? decodeURIComponent(match[2]) : 'index.html'
		});
		if (request.method === 'HEAD') {
			return new Response(null, {
				headers: {
					'content-type': mimeTypeForProjectPreview(asset.filePath),
					'cache-control': 'no-store',
					'x-spark-preview-root': asset.projectRoot
				}
			});
		}
		return new Response(await readFile(asset.filePath), {
			headers: {
				'content-type': mimeTypeForProjectPreview(asset.filePath),
				'cache-control': 'no-store',
				'x-spark-preview-root': asset.projectRoot
			}
		});
	} catch (error) {
		if (error instanceof ProjectPreviewError) {
			return textResponse(error.status, error.message);
		}
		throw error;
	}
}

const port = configuredPreviewPort();
const server = createServer(async (req, res) => {
	try {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
			res.end('Method not allowed.');
			return;
		}
		const response = await handleRequest(new Request(`http://127.0.0.1:${port}${req.url || '/'}`, {
			method: req.method
		}));
		res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
		if (req.method === 'HEAD') {
			res.end();
			return;
		}
		res.end(Buffer.from(await response.arrayBuffer()));
	} catch (error) {
		console.error('[project-preview-server]', error);
		res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('Project preview server error.');
	}
});

server.listen(port, '127.0.0.1', () => {
	console.log(`Spark project previews running at http://127.0.0.1:${port}`);
});
