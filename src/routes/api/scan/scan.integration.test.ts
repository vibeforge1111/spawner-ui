import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandRunnerMocks = vi.hoisted(() => ({
	validateProjectPath: vi.fn(() => ({ valid: true })),
	isToolAvailable: vi.fn(async (toolName: string) => toolName === 'gitleaks'),
	runCommand: vi.fn()
}));

vi.mock('$lib/server/command-runner', () => commandRunnerMocks);

import { POST } from './+server';

function routeEvent(body: unknown) {
	return {
		request: new Request('http://127.0.0.1/api/scan', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		url: new URL('http://127.0.0.1/api/scan'),
		getClientAddress: () => '127.0.0.1'
	};
}

describe('/api/scan', () => {
	beforeEach(() => {
		commandRunnerMocks.runCommand.mockReset();
		commandRunnerMocks.validateProjectPath.mockReturnValue({ valid: true });
		commandRunnerMocks.isToolAvailable.mockImplementation(async (toolName: string) => toolName === 'gitleaks');
	});

	it('redacts gitleaks match text from findings returned to callers', async () => {
		const matchedSecret = 'redacted-fixture-value-should-not-render-123456';
		commandRunnerMocks.runCommand.mockResolvedValueOnce({
			exitCode: 1,
			stdout: JSON.stringify([
				{
					Description: 'Hardcoded credential',
					RuleID: 'generic-api-key',
					Match: matchedSecret,
					File: 'src/config.ts',
					StartLine: 12
				}
			]),
			stderr: '',
			duration: 8
		});

		const response = await POST(routeEvent({
			projectPath: '/workspace/project',
			scanners: ['gitleaks']
		}) as never);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.results[0].findings[0]).toMatchObject({
			scanner: 'gitleaks',
			severity: 'critical',
			title: 'Hardcoded credential',
			description: 'Secret match redacted.',
			file: 'src/config.ts',
			line: 12,
			rule: 'generic-api-key'
		});
		expect(JSON.stringify(body)).not.toContain(matchedSecret);
	});

	it('does not return raw gitleaks stdout when finding output is malformed', async () => {
		const rawFindingText = 'raw finding contained redacted-fixture-value-should-not-render-654321';
		commandRunnerMocks.runCommand.mockResolvedValueOnce({
			exitCode: 1,
			stdout: rawFindingText,
			stderr: '',
			duration: 5
		});

		const response = await POST(routeEvent({
			projectPath: '/workspace/project',
			scanners: ['gitleaks']
		}) as never);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.results[0].findings[0]).toMatchObject({
			scanner: 'gitleaks',
			severity: 'high',
			title: 'Secrets detected (raw output)',
			description: 'Scanner reported secret findings but returned non-JSON output.'
		});
		expect(JSON.stringify(body)).not.toContain(rawFindingText);
	});
});
