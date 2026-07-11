/**
 * Security Scanner API — Runs Gitleaks, Trivy, and OpenGrep
 *
 * POST /api/scan
 *   body: { projectPath, scanners?: ('gitleaks' | 'trivy' | 'opengrep')[] }
 *
 * Each scanner is checked for availability before running.
 * Missing scanners are reported as unavailable (not errors).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { enforceRateLimit, requireControlAuth } from '$lib/server/mcp-auth';
import { validateProjectPath, runCommand, isToolAvailable } from '$lib/server/command-runner';

const SCANNER_TIMEOUT_MS = 60_000; // 60 seconds per scanner

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

type ScannerName = 'gitleaks' | 'trivy' | 'opengrep';

const ALL_SCANNERS: ScannerName[] = ['gitleaks', 'trivy', 'opengrep'];

export const POST: RequestHandler = async (event) => {
	try {
		const unauthorized = requireControlAuth(event, {
			surface: 'SecurityScan',
			apiKeyEnvVar: 'SPAWNER_SCAN_API_KEY',
			fallbackApiKeyEnvVar: 'MCP_API_KEY',
			apiKeyQueryParam: 'apiKey',
			apiKeyCookieName: 'spawner_events_api_key',
			allowLoopbackWithoutKey: false,
			allowedOriginsEnvVar: 'SPAWNER_ALLOWED_ORIGINS'
		});
		if (unauthorized) return unauthorized;

		const rateLimited = enforceRateLimit(event, {
			scope: 'security_scan',
			limit: 12,
			windowMs: 60_000
		});
		if (rateLimited) return rateLimited;

		const body = await event.request.json().catch(() => null);
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			return json({ error: 'Malformed JSON body' }, { status: 400 });
		}
		const { projectPath, scanners } = body as {
			projectPath: string;
			scanners?: unknown[];
		};

		const validation = validateProjectPath(projectPath);
		if (!validation.valid) {
			return json({ error: validation.error }, { status: 400 });
		}

		// Security: Validate scanner names at runtime - TypeScript types are erased, so
		// user-supplied values must be explicitly checked against the allowed set
		const validatedScanners: ScannerName[] = [];
		if (scanners && scanners.length > 0) {
			for (const s of scanners) {
				if (typeof s === 'string' && (ALL_SCANNERS as string[]).includes(s)) {
					validatedScanners.push(s as ScannerName);
				} else {
					return json({ error: `Invalid scanner: ${String(s)}. Allowed: ${ALL_SCANNERS.join(', ')}` }, { status: 400 });
				}
			}
		}
		const requestedScanners = validatedScanners.length > 0 ? validatedScanners : ALL_SCANNERS;
		const scanStart = Date.now();

		// Run all scanners in parallel
		const results = await Promise.all(
			requestedScanners.map((scanner) => runScanner(scanner, projectPath))
		);

		const allFindings = results.flatMap((r) => r.findings);
		const criticalCount = allFindings.filter((f) => f.severity === 'critical').length;
		const highCount = allFindings.filter((f) => f.severity === 'high').length;

		const response: ScanResponse = {
			results,
			totalFindings: allFindings.length,
			criticalCount,
			highCount,
			canShip: criticalCount === 0,
			duration: Date.now() - scanStart
		};

		return json(response);
	} catch (err) {
		return json(
			{ error: `Scan failed: ${err instanceof Error ? err.message : String(err)}` },
			{ status: 500 }
		);
	}
};

async function runScanner(scanner: ScannerName, projectPath: string): Promise<ScanResult> {
	const start = Date.now();

	switch (scanner) {
		case 'gitleaks':
			return runGitleaks(projectPath, start);
		case 'trivy':
			return runTrivy(projectPath, start);
		case 'opengrep':
			return runOpengrep(projectPath, start);
		default:
			return {
				scanner,
				success: false,
				available: false,
				findings: [],
				duration: 0,
				error: `Unknown scanner: ${scanner}`
			};
	}
}

async function runGitleaks(projectPath: string, start: number): Promise<ScanResult> {
	const available = await isToolAvailable('gitleaks');
	if (!available) {
		return { scanner: 'gitleaks', success: true, available: false, findings: [], duration: Date.now() - start, error: 'gitleaks not installed' };
	}

	try {
		const result = await runCommand(
			'gitleaks',
			['detect', '--source', projectPath, '--report-format', 'json', '--report-path', '-', '--no-git'],
			projectPath,
			SCANNER_TIMEOUT_MS
		);

		const findings: ScanFinding[] = [];

		// Exit code 1 = leaks found, 0 = no leaks
		if (result.exitCode === 1 && result.stdout.trim()) {
			try {
				const leaks = JSON.parse(result.stdout);
				if (Array.isArray(leaks)) {
					for (const leak of leaks) {
						findings.push({
							scanner: 'gitleaks',
							severity: 'critical',
							title: leak.Description || leak.RuleID || 'Secret detected',
							description: `Match: ${(leak.Match || '').slice(0, 80)}...`,
							file: leak.File,
							line: leak.StartLine,
							rule: leak.RuleID
						});
					}
				}
			} catch {
				// JSON parse failed — still report as findings present
				findings.push({
					scanner: 'gitleaks',
					severity: 'high',
					title: 'Secrets detected (raw output)',
					description: result.stdout.slice(0, 200)
				});
			}
		}

		return {
			scanner: 'gitleaks',
			success: true,
			available: true,
			findings,
			duration: Date.now() - start
		};
	} catch (err) {
		return {
			scanner: 'gitleaks',
			success: false,
			available: true,
			findings: [],
			duration: Date.now() - start,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

async function runTrivy(projectPath: string, start: number): Promise<ScanResult> {
	const available = await isToolAvailable('trivy');
	if (!available) {
		return { scanner: 'trivy', success: true, available: false, findings: [], duration: Date.now() - start, error: 'trivy not installed' };
	}

	try {
		const result = await runCommand(
			'trivy',
			['fs', projectPath, '--format', 'json', '--severity', 'HIGH,CRITICAL'],
			projectPath,
			SCANNER_TIMEOUT_MS
		);

		const findings: ScanFinding[] = [];

		if (result.stdout.trim()) {
			try {
				const report = JSON.parse(result.stdout);
				const results = report.Results || [];
				for (const r of results) {
					const vulns = r.Vulnerabilities || [];
					for (const v of vulns) {
						findings.push({
							scanner: 'trivy',
							severity: mapTrivySeverity(v.Severity),
							title: `${v.VulnerabilityID}: ${v.PkgName}@${v.InstalledVersion}`,
							description: v.Title || v.Description || 'Vulnerability detected',
							file: r.Target,
							rule: v.VulnerabilityID
						});
					}
				}
			} catch {
				// JSON parse failed
				if (result.exitCode !== 0) {
					findings.push({
						scanner: 'trivy',
						severity: 'info',
						title: 'Scan completed with warnings',
						description: result.stderr.slice(0, 200) || result.stdout.slice(0, 200)
					});
				}
			}
		}

		return {
			scanner: 'trivy',
			success: result.exitCode === 0,
			available: true,
			findings,
			duration: Date.now() - start
		};
	} catch (err) {
		return {
			scanner: 'trivy',
			success: false,
			available: true,
			findings: [],
			duration: Date.now() - start,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

async function runOpengrep(projectPath: string, start: number): Promise<ScanResult> {
	// Try opengrep first, fall back to semgrep
	let toolName = 'opengrep';
	let available = await isToolAvailable('opengrep');
	if (!available) {
		toolName = 'semgrep';
		available = await isToolAvailable('semgrep');
	}
	if (!available) {
		return { scanner: 'opengrep', success: true, available: false, findings: [], duration: Date.now() - start, error: 'opengrep/semgrep not installed' };
	}

	try {
		const result = await runCommand(
			toolName,
			['scan', '--config', 'auto', '--json', projectPath],
			projectPath,
			SCANNER_TIMEOUT_MS
		);

		const findings: ScanFinding[] = [];

		if (result.stdout.trim()) {
			try {
				const report = JSON.parse(result.stdout);
				const results = report.results || [];
				for (const r of results) {
					findings.push({
						scanner: 'opengrep',
						severity: mapOpenGrepSeverity(r.extra?.severity || r.extra?.metadata?.severity),
						title: r.check_id || 'Finding',
						description: r.extra?.message || r.extra?.metadata?.message || 'Issue detected',
						file: r.path,
						line: r.start?.line,
						rule: r.check_id
					});
				}
			} catch {
				if (result.exitCode !== 0) {
					findings.push({
						scanner: 'opengrep',
						severity: 'info',
						title: 'Scan completed with warnings',
						description: result.stderr.slice(0, 200) || result.stdout.slice(0, 200)
					});
				}
			}
		}

		return {
			scanner: 'opengrep',
			success: true,
			available: true,
			findings,
			duration: Date.now() - start
		};
	} catch (err) {
		return {
			scanner: 'opengrep',
			success: false,
			available: true,
			findings: [],
			duration: Date.now() - start,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

function mapTrivySeverity(severity?: string): ScanFinding['severity'] {
	switch (severity?.toUpperCase()) {
		case 'CRITICAL': return 'critical';
		case 'HIGH': return 'high';
		case 'MEDIUM': return 'medium';
		case 'LOW': return 'low';
		default: return 'info';
	}
}

function mapOpenGrepSeverity(severity?: string): ScanFinding['severity'] {
	switch (severity?.toUpperCase()) {
		case 'ERROR': return 'high';
		case 'WARNING': return 'medium';
		case 'INFO': return 'info';
		default: return 'medium';
	}
}
