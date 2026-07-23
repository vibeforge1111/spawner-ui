import { describe, expect, it } from 'vitest';
import { configuredPreviewPort } from './project-preview-config';

describe('configuredPreviewPort', () => {
	it('accepts a bounded --port value when no explicit environment port is set', () => {
		expect(configuredPreviewPort({}, ['tsx', 'project-preview-server.ts', '--port', '6123'])).toBe(
			6123
		);
	});

	it('keeps the explicit environment port authoritative', () => {
		expect(
			configuredPreviewPort(
				{ SPARK_PROJECT_PREVIEW_PORT: '7001' },
				['tsx', 'project-preview-server.ts', '--port', '6123']
			)
		).toBe(7001);
	});

	it('rejects invalid CLI ports and falls back to the configured URL or local default', () => {
		expect(
			configuredPreviewPort(
				{ SPARK_PROJECT_PREVIEW_URL: 'http://127.0.0.1:7444' },
				['tsx', 'project-preview-server.ts', '--port', '70000']
			)
		).toBe(7444);
		expect(configuredPreviewPort({}, ['tsx', 'project-preview-server.ts', '--port', '0'])).toBe(
			5555
		);
	});
});
