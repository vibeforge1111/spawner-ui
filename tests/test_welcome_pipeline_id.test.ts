import { describe, it, expect } from 'vitest';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createQueuedPipelineId(): string {
	return `pipe-${crypto.randomUUID()}`;
}

describe('createQueuedPipelineId', () => {
	it('starts with pipe- prefix', () => {
		expect(createQueuedPipelineId()).toMatch(/^pipe-/);
	});
	it('contains a valid UUID v4', () => {
		const id = createQueuedPipelineId();
		expect(UUID_RE.test(id.slice(5))).toBe(true);
	});
	it('does not use Math.random', () => {
		const src = createQueuedPipelineId.toString();
		expect(src).not.toContain('Math.random');
	});
	it('generates 1000 unique IDs', () => {
		const ids = Array.from({ length: 1000 }, () => createQueuedPipelineId());
		expect(new Set(ids).size).toBe(1000);
	});
	it('is a plain string', () => {
		expect(typeof createQueuedPipelineId()).toBe('string');
	});
});
