export const ALL_SCANNERS = ['gitleaks', 'trivy', 'opengrep'] as const;

export type ScannerName = (typeof ALL_SCANNERS)[number];

export type ScannerSelection =
	| { ok: true; scanners: ScannerName[] }
	| { ok: false; error: string };

const SCANNER_NAMES = new Set<string>(ALL_SCANNERS);

export function parseScannerSelection(value: unknown): ScannerSelection {
	if (value === undefined || (Array.isArray(value) && value.length === 0)) {
		return { ok: true, scanners: [...ALL_SCANNERS] };
	}
	if (!Array.isArray(value)) {
		return { ok: false, error: 'scanners must be an array' };
	}

	const scanners: ScannerName[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const scanner = value[index];
		if (typeof scanner !== 'string' || !SCANNER_NAMES.has(scanner)) {
			return {
				ok: false,
				error: `Invalid scanner at index ${index}. Allowed scanners: ${ALL_SCANNERS.join(', ')}`
			};
		}
		if (!scanners.includes(scanner as ScannerName)) {
			scanners.push(scanner as ScannerName);
		}
	}

	return { ok: true, scanners };
}
