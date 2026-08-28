/**
 * Security Scanner Client Service
 *
 * Calls /api/scan to run Gitleaks, Trivy, and OpenGrep
 * against a project directory.
 */

export interface ScanFinding {
	scanner: string;
	severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
	title: string;
	description: string;
	file?: string;
	line?: number;
	rule?: string;
}

export interface ScanResult {
	scanner: string;
	success: boolean;
	available: boolean;
	findings: ScanFinding[];
	duration: number;
	error?: string;
}

export interface ScanResponse {
	results: ScanResult[];
	totalFindings: number;
	criticalCount: number;
	highCount: number;
	canShip: boolean;
	duration: number;
}

/**
 * Run security scan on a project path
 */
export async function runSecurityScan(options: {
	projectPath: string;
	scanners?: ('gitleaks' | 'trivy' | 'opengrep')[];
}): Promise<ScanResponse> {
	// NOTE: This fetch() has no AbortController. Long-running servers can hang the request indefinitely. Add { signal: AbortSignal.timeout(30000) } to bound the wait.
	const resp = await fetch('/api/scan', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(options)
	});

	if (!resp.ok) {
		const err = await resp.json();
		throw new Error(err.error || `Scan failed with status ${resp.status}`);
	}

	return resp.json();
}
