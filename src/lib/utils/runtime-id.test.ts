import { describe, expect, it, vi } from 'vitest';
import {
	createCanvasConnectionId,
	createCanvasNodeId,
	createPrdRequestId,
	createQueuedPipelineId
} from './runtime-id';

describe('runtime IDs used by Welcome and Canvas', () => {
	it.each([
		['queued pipeline', createQueuedPipelineId, /^pipe-[0-9a-f-]{36}$/],
		['PRD request', createPrdRequestId, /^prd-[0-9a-f-]{36}$/],
		['canvas node', createCanvasNodeId, /^node-[0-9a-f-]{36}$/],
		['canvas connection', createCanvasConnectionId, /^conn-[0-9a-f-]{36}$/]
	])('creates a crypto-backed %s ID through the production helper', (_label, createId, pattern) => {
		const randomSpy = vi.spyOn(Math, 'random');
		const ids = new Set(Array.from({ length: 100 }, () => createId()));

		expect(ids.size).toBe(100);
		expect([...ids].every((id) => pattern.test(id))).toBe(true);
		expect(randomSpy).not.toHaveBeenCalled();
		randomSpy.mockRestore();
	});
});
