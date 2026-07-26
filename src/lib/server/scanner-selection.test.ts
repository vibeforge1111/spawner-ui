import { describe, expect, it } from 'vitest';
import { parseScannerSelection } from './scanner-selection';

describe('parseScannerSelection', () => {
	it('defaults missing and empty selections to every supported scanner', () => {
		expect(parseScannerSelection(undefined)).toEqual({
			ok: true,
			scanners: ['gitleaks', 'trivy', 'opengrep']
		});
		expect(parseScannerSelection([])).toEqual({
			ok: true,
			scanners: ['gitleaks', 'trivy', 'opengrep']
		});
	});

	it('accepts supported scanners and removes duplicates without reordering', () => {
		expect(parseScannerSelection(['trivy', 'gitleaks', 'trivy'])).toEqual({
			ok: true,
			scanners: ['trivy', 'gitleaks']
		});
	});

	it.each([
		['a scalar', 'trivy'],
		['an unknown name', ['unknown']],
		['a non-string entry', ['trivy', { name: 'gitleaks' }]]
	])('rejects %s at the request boundary', (_label, value) => {
		const result = parseScannerSelection(value);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).not.toContain('[object Object]');
		}
	});
});
