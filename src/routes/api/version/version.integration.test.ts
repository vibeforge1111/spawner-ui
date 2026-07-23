import { describe, expect, it } from 'vitest';
import packageMetadata from '../../../../package.json';
import { GET } from './+server';

describe('GET /api/version', () => {
	it('reports the package identity instead of a duplicated version constant', async () => {
		const response = await GET({} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			name: packageMetadata.name,
			version: packageMetadata.version
		});
	});
});
