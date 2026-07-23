import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { addService } from './services.svelte';
import { _generatePipelineIdForTests } from './pipelines.svelte';
import { addFeedback, createInstance, mcpStore } from './mcps.svelte';
import { addNode, canvasState } from './canvas.svelte';
import { syncClient } from '$lib/services/sync-client';

beforeEach(() => {
	mcpStore.update((state) => ({
		...state,
		registry: [
			{
				id: 'packet-204-mcp',
				name: 'Packet 204 MCP',
				description: 'Production ID proof',
				category: 'Development',
				subcategory: 'Testing',
				official: false,
				popularity: 1,
				skills: [],
				capabilities: ['custom']
			}
		],
		instances: [],
		pendingFeedback: []
	}));
	canvasState.update((state) => ({ ...state, nodes: [], connections: [] }));
});

describe('packet 204 production ID paths', () => {
	it('creates service and pipeline IDs with the production generators', () => {
		expect(addService('API', 'https://example.test').id).toMatch(
			/^service-\d+-[0-9a-f]{8}$/
		);
		expect(_generatePipelineIdForTests()).toMatch(/^pipe-[0-9a-z]+-[0-9a-f]{8}$/);
	});

	it('creates MCP instance and feedback IDs through public operations', () => {
		const instance = createInstance('packet-204-mcp');
		const feedback = addFeedback({
			mcpId: instance.id,
			mcpName: instance.name,
			triggerType: 'manual',
			targetType: 'general',
			feedbackType: 'packet_204',
			metrics: {},
			sentiment: 'neutral',
			summary: 'Production feedback ID proof',
			confidenceImpact: 0,
			learningsAffected: [],
			newLearningsCreated: []
		});

		expect(instance.id).toMatch(/^mcp_\d+_[0-9a-f]{9}$/);
		expect(feedback.id).toMatch(/^feedback_\d+_[0-9a-f]{9}$/);
		expect(get(mcpStore).pendingFeedback.at(-1)?.id).toBe(feedback.id);
	});

	it('creates canvas node IDs through the public canvas operation', () => {
		const id = addNode(
			{
				id: 'packet-204-skill',
				name: 'Packet 204',
				description: 'Production node ID proof',
				category: 'development',
				tier: 'free',
				tags: [],
				triggers: []
			},
			{ x: 10, y: 20 }
		);

		expect(id).toMatch(/^node-\d+-[0-9a-f]{8}$/);
		expect(get(canvasState).nodes.at(-1)?.id).toBe(id);
	});

	it('initializes the real sync singleton with a crypto-backed client ID', () => {
		const clientId = (syncClient as unknown as { clientId: string }).clientId;
		expect(clientId).toMatch(/^spawner-ui-\d+-[0-9a-f]{8}$/);
	});
});
