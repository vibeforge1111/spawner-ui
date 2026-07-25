import { describe, expect, it } from 'vitest';
import packageMetadata from '../package.json';

describe('release artifact contents', () => {
	it('ships the runtime skill catalog used by tier enforcement and canvas materialization', () => {
		expect(packageMetadata.files).toContain('static');
	});
});
