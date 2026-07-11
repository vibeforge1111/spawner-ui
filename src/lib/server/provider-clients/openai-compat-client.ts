/**
 * OpenAI-Compatible Provider Client
 *
 * Reusable client for any OpenAI-compatible chat completions API:
 * Minimax, OpenAI, Kimi, OpenRouter, Ollama, etc.
 */

import type { ProviderResult, ProviderClientOptions, ChatMessage } from './types';
import { createBridgeEvent } from './types';
import { parseRetryAfterMs } from './retry-after';

export interface OpenAICompatOptions extends ProviderClientOptions {
	apiKey: string;
}

interface StreamChunkChoice {
	delta?: { content?: string; role?: string };
	finish_reason?: string | null;
	index?: number;
}

interface StreamChunk {
	id?: string;
	choices?: StreamChunkChoice[];
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

export async function executeOpenAICompatRequest(
	options: OpenAICompatOptions,
	messages: ChatMessage[],
	streaming = true
): Promise<ProviderResult> {
	const { provider, apiKey, missionId, signal, onEvent } = options;
	const baseUrl = provider.baseUrl || 'https://api.openai.com/v1';
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
			// NOTE: This fetch() has no AbortController. Long-running servers can hang the request indefinitely. Add { signal: AbortSignal.timeout(30000) } to bound the wait.
			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
				},
				body: JSON.stringify({
					model: provider.model,
					messages,
					stream: streaming,
					max_tokens: 16384
				}),
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
				return await handleStreamingResponse(options, response, startTime);
			} else {
				return await handleNonStreamingResponse(options, response, startTime);
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

	const failureMessage = lastError || `${provider.label} failed after ${MAX_RETRIES} retries`;
	onEvent(
		createBridgeEvent('task_failed', options, {
			message: `${provider.label} failed after ${MAX_RETRIES} attempts: ${lastError}`,
			data: {
				success: false,
				error: failureMessage,
				provider: provider.id,
				providerLabel: provider.label
			}
		})
	);

	return {
		success: false,
		error: failureMessage,
		durationMs: Date.now() - startTime
	};
}

async function handleStreamingResponse(
	options: OpenAICompatOptions,
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
				if (payload === '[DONE]') continue;

				try {
					const chunk: StreamChunk = JSON.parse(payload);
					const content = chunk.choices?.[0]?.delta?.content;
					if (content) {
						fullContent += content;
					}
					if (chunk.usage) {
						tokenUsage = {
							prompt: chunk.usage.prompt_tokens || 0,
							completion: chunk.usage.completion_tokens || 0,
							total: chunk.usage.total_tokens || 0
						};
					}
				} catch {
					// Skip malformed chunks
				}
			}

			// Emit progress every 2 seconds to avoid flooding
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
			data: {
				success: true,
				responseLength: fullContent.length,
				response: fullContent,
				provider: provider.id,
				providerLabel: provider.label
			}
		})
	);

	return {
		success: true,
		response: fullContent,
		tokenUsage,
		durationMs: Date.now() - startTime
	};
}

async function handleNonStreamingResponse(
	options: OpenAICompatOptions,
	response: Response,
	startTime: number
): Promise<ProviderResult> {
	const { provider, onEvent } = options;
	const data = await response.json();

	const content = data.choices?.[0]?.message?.content || '';
	const usage = data.usage;
	const tokenUsage = usage
		? {
				prompt: usage.prompt_tokens || 0,
				completion: usage.completion_tokens || 0,
				total: usage.total_tokens || 0
			}
		: undefined;

	onEvent(
		createBridgeEvent('task_completed', options, {
			message: `${provider.label} completed (${content.length} chars)`,
			data: {
				success: true,
				responseLength: content.length,
				response: content,
				provider: provider.id,
				providerLabel: provider.label
			}
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
