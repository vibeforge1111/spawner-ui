import { describe, expect, it } from 'vitest';
import { cloneCanvasSelectionForClipboard } from './canvas.svelte';
import type { CanvasNode } from './canvas.svelte';

describe('cloneCanvasSelectionForClipboard', () => {
	it('returns an isolated clone for serializable canvas state', () => {
		const nodes = [{
			id: 'node-1',
			skillId: 'skill-1',
			skill: { id: 'skill-1', name: 'Skill' },
			position: { x: 1, y: 2 }
		}] as CanvasNode[];
		const clone = cloneCanvasSelectionForClipboard(nodes, []);
		expect(clone).not.toBeNull();
		expect(clone?.nodes).not.toBe(nodes);
		expect(clone?.nodes[0].position).not.toBe(nodes[0].position);
	});

	it('returns null instead of throwing for non-serializable state', () => {
		const nodes = [{ id: 'node-1', unsafe: 1n }] as never;
		expect(cloneCanvasSelectionForClipboard(nodes, [])).toBeNull();
	});
});
