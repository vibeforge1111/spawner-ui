import { get } from 'svelte/store';
import { afterEach, describe, expect, it } from 'vitest';
import { filteredRegistry, mcpStore } from './mcps.svelte';

const INITIAL_STATE = get(mcpStore);

describe('filteredRegistry ordering', () => {
	afterEach(() => mcpStore.set(INITIAL_STATE));

	it('sorts the derived view without mutating registry order', () => {
		const low = { id: 'low', name: 'Low', description: '', category: 'tools', subcategory: '', skills: [], capabilities: [], popularity: 1 };
		const high = { ...low, id: 'high', name: 'High', popularity: 10 };
		mcpStore.set({
			...INITIAL_STATE,
			registry: [low, high],
			filterCategory: 'all',
			filterSubcategory: null,
			searchQuery: ''
		} as never);

		expect(get(filteredRegistry).map((item) => item.id)).toEqual(['high', 'low']);
		expect(get(mcpStore).registry.map((item) => item.id)).toEqual(['low', 'high']);
	});
});
