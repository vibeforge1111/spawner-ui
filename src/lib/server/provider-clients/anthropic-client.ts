/**
 * Anthropic Provider Client
 *
 * Direct Anthropic API client for Claude as a server-dispatched provider.
 * Follows the same pattern as src/routes/api/analyze/+server.ts.
 */

import type { ProviderResult, ProviderClientOptions } from './types';
import { createBridgeEvent } from './types';
import { parseRetryAfterMs } from './retry-after';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

export interface AnthropicClientOptions extends ProviderClientOptions {
	apiKey: string;
}

interface AnthropicStreamEvent {
	type: string;
	delta?: { type?: string; text?: string };
	content_block?: { type?: string; text?: string };
	message?: {
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	usage?: { input_tokens?: number; output_tokens?: number };
}

export async function executeAnthropicRequest(
	options: AnthropicClientOptions,
	prompt: string,
	systemPrompt?: string,
	streaming = true
): Promise<ProviderResult> {
	const { provider, apiKey, signal, onEvent } = options;
	const startTime = Date.now();

	onEvent(
		createBridgeEvent('task_started', options, {
			message: `${provider.label} starting (model: ${provider.model})`,
			data: { provider: provider.id, model: provider.model }
		})
	);

	let lastError: string | undefined;

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		if (signal?.aborted) {
			return { success: false, error: 'Cancelled', durationMs: Date.now() - startTime };
		}

		try {
			const body: Record<string, unknown> = {
				model: provider.model,
				max_tokens: 16384,
				stream: streaming,
				messages: [{ role: 'user', content: prompt }]
			};
			if (systemPrompt) {
				body.system = systemPrompt;
			}

			const response = await fetch(ANTHROPIC_API_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': apiKey,
					'anthropic-version': ANTHROPIC_VERSION
				},
				body: JSON.stringify(body),
				signal
			});

			if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
				const retryAfter = response.headers.get('retry-after');
				const delay = parseRetryAfterMs(retryAfter, RETRY_BASE_MS * Math.pow(2, attempt));
				lastError = `HTTP ${response.status} from ${provider.label}`;
				onEvent(
					createBridgeEvent('task_progress', options, {
						message: `${provider.label}: retrying after ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES})`,
						progress: 0
					})
				);
				await sleep(delay, signal);
				continue;
			}

			if (!response.ok) {
				const errorText = await response.text().catch(() => 'unknown error');
				return {
					success: false,
					error: `${provider.label} API error ${response.status}: ${errorText.slice(0, 500)}`,
					durationMs: Date.now() - startTime
				};
			}

			if (streaming && response.body) {
				return await handleAnthropicStream(options, response, startTime);
			} else {
				return await handleAnthropicNonStreaming(options, response, startTime);
			}
		} catch (err) {
			if (signal?.aborted) {
				return { success: false, error: 'Cancelled', durationMs: Date.now() - startTime };
			}
			lastError = err instanceof Error ? err.message : String(err);
			if (attempt < MAX_RETRIES - 1) {
				await sleep(RETRY_BASE_MS * Math.pow(2, attempt), signal);
			}
		}
	}

	onEvent(
		createBridgeEvent('error', options, {
			message: `${provider.label} failed after ${MAX_RETRIES} attempts: ${lastError}`,
			data: { error: lastError }
		})
	);

	return {
		success: false,
		error: lastError || `${provider.label} failed after ${MAX_RETRIES} retries`,
		durationMs: Date.now() - startTime
	};
}

async function handleAnthropicStream(
	options: AnthropicClientOptions,
	response: Response,
	startTime: number
): Promise<ProviderResult> {
	const { provider, onEvent } = options;
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let fullContent = '';
	let buffer = '';
	let lastProgressEmit = Date.now();
	let tokenUsage: ProviderResult['tokenUsage'];

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || !trimmed.startsWith('data: ')) continue;
				const payload = trimmed.slice(6);

				try {
					const event: AnthropicStreamEvent = JSON.parse(payload);

					if (event.type === 'content_block_delta' && event.delta?.text) {
						fullContent += event.delta.text;
					}

					if (event.type === 'message_delta' && event.usage) {
						tokenUsage = {
							prompt: event.usage.input_tokens ?? tokenUsage?.prompt ?? 0,
							completion: event.usage.output_tokens ?? tokenUsage?.completion ?? 0,
							total:
								(event.usage.input_tokens ?? tokenUsage?.prompt ?? 0) +
								(event.usage.output_tokens ?? tokenUsage?.completion ?? 0)
						};
					}

					if (event.type === 'message_start' && event.message?.usage) {
						const u = event.message.usage;
						tokenUsage = {
							prompt: u.input_tokens || 0,
							completion: u.output_tokens || 0,
							total: (u.input_tokens || 0) + (u.output_tokens || 0)
						};
					}
				} catch {
					// Skip malformed chunks
				}
			}

			// Emit progress every 2 seconds
			const now = Date.now();
			if (now - lastProgressEmit > 2000) {
				const progress = Math.min(90, Math.floor((fullContent.length / 8000) * 100));
				onEvent(
					createBridgeEvent('task_progress', options, {
						progress,
						message: `${provider.label}: streaming response (${fullContent.length} chars)...`
					})
				);
				lastProgressEmit = now;
			}
		}
	} catch (err) {
		if (options.signal?.aborted) {
			return { success: false, error: 'Cancelled', durationMs: Date.now() - startTime };
		}
		throw err;
	}

	onEvent(
		createBridgeEvent('task_completed', options, {
			message: `${provider.label} completed (${fullContent.length} chars)`,
			data: { success: true, responseLength: fullContent.length }
		})
	);

	return {
		success: true,
		response: fullContent,
		tokenUsage,
		durationMs: Date.now() - startTime
	};
}

async function handleAnthropicNonStreaming(
	options: AnthropicClientOptions,
	response: Response,
	startTime: number
): Promise<ProviderResult> {
	const { provider, onEvent } = options;
	const rawBody = await response.text().catch(() => '');
	let data: { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } } | null = null;
	try {
		data = rawBody ? JSON.parse(rawBody) : null;
	} catch {
		return {
			success: false,
			error: `${provider.label} returned HTTP ${response.status} OK but the body was not JSON: ${rawBody.slice(0, 300)}`,
			durationMs: Date.now() - startTime
		};
	}
	if (!data) data = {};

	const textContent = data.content?.find(
		(c: { type: string }) => c.type === 'text'
	);
	const content = textContent?.text || '';
	const usage = data.usage;
	const tokenUsage = usage
		? {
				prompt: usage.input_tokens || 0,
				completion: usage.output_tokens || 0,
				total: (usage.input_tokens || 0) + (usage.output_tokens || 0)
			}
		: undefined;

	onEvent(
		createBridgeEvent('task_completed', options, {
			message: `${provider.label} completed (${content.length} chars)`,
			data: { success: true, responseLength: content.length }
		})
	);

	return {
		success: true,
		response: content,
		tokenUsage,
		durationMs: Date.now() - startTime
	};
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('Cancelled'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('Cancelled'));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
