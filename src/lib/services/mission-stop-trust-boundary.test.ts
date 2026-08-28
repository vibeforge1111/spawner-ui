/**
 * Trust-boundary tests for the mission.stop command path.
 *
 * The boundary: POST /api/spark-agent/command (external input)
 *   → isAllowedCommand gate (rejects unknown commands)
 *   → dispatchCommand switch (routes to handleMissionStop)
 *   → handleMissionStop (sets status='cancelled', error=null unconditionally)
 *
 * These tests verify that user-supplied params CANNOT cross the boundary
 * to override the hardcoded 'cancelled' status or inject an error string.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { POST as startSession } from '../../routes/api/spark-agent/session/start/+server';
import { POST as command } from '../../routes/api/spark-agent/command/+server';
import { sparkAgentBridge } from './spark-agent-bridge';
import { getConnections } from './mcp/client';

afterEach(() => {
	getConnections().clear();
	sparkAgentBridge.resetForTests();
});

// ---------------------------------------------------------------------------
// Helper: create a session with a built + started mission
// ---------------------------------------------------------------------------

async function setupRunningMission(): Promise<string> {
	const startRes = await startSession({
		request: new Request('http://localhost/api/spark-agent/session/start', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ actor: 'trust-boundary-test' })
		})
	} as never);
	const { session } = await startRes.json();
	const sessionId = session.id as string;

	const makeCommand = (cmd: string, params?: Record<string, unknown>) =>
		command({
			request: new Request('http://localhost/api/spark-agent/command', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId, command: cmd, params: params ?? {} })
			})
		} as never);

	await makeCommand('canvas.create_pipeline', { name: 'Trust Boundary Pipeline' });
	await makeCommand('canvas.add_skill', {
		nodeId: 'node-a',
		skillId: 'planner',
		skillName: 'Planner',
		description: 'Plan step'
	});
	await makeCommand('canvas.add_skill', {
		nodeId: 'node-b',
		skillId: 'executor',
		skillName: 'Executor',
		description: 'Execute step'
	});
	await makeCommand('canvas.add_connection', { sourceNodeId: 'node-a', targetNodeId: 'node-b' });
	await makeCommand('mission.build', { name: 'Trust Boundary Mission' });
	await makeCommand('mission.start');
	return sessionId;
}

// ---------------------------------------------------------------------------
// Core fix: mission.stop emits 'cancelled', not 'failed'
// ---------------------------------------------------------------------------

describe('mission.stop trust boundary — cancelled status fix', () => {
	it('mission.stop sets status=cancelled and error=null (not failed)', async () => {
		const sessionId = await setupRunningMission();

		const stopRes = await command({
			request: new Request('http://localhost/api/spark-agent/command', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId, command: 'mission.stop' })
			})
		} as never);

		expect(stopRes.status).toBe(200);
		const body = await stopRes.json();
		expect(body.success).toBe(true);
		expect(body.data.mission.status).toBe('cancelled');
		expect(body.data.mission.error).toBeNull();
	});

	it('status is not failed after stop (regression guard)', async () => {
		const sessionId = await setupRunningMission();

		await command({
			request: new Request('http://localhost/api/spark-agent/command', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId, command: 'mission.stop' })
			})
		} as never);

		const statusRes = await command({
			request: new Request('http://localhost/api/spark-agent/command', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId, command: 'mission.status' })
			})
		} as never);

		const body = await statusRes.json();
		expect(body.data.mission.status).not.toBe('failed');
		expect(body.data.mission.status).toBe('cancelled');
	});
});

// ---------------------------------------------------------------------------
// Hostile-input tests: params cannot override status or inject an error
// ---------------------------------------------------------------------------

describe('mission.stop trust boundary — hostile params rejected', () => {
	it('params.status injection attempt cannot override cancelled', async () => {
		// Attacker sends the pre-fix values in params hoping to restore failed behavior
		const sessionId = await setupRunningMission();

		const stopRes = await command({
			request: new Request('http://localhost/api/spark-agent/command', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sessionId,
					command: 'mission.stop',
					params: { status: 'failed' }     // hostile: attempt to set status=failed
				})
			})
		} as never);

		const body = await stopRes.json();
		expect(body.data.mission.status).toBe('cancelled');   // hardcoded, not from params
		expect(body.data.mission.status).not.toBe('failed');
	});

	it('params.error injection attempt cannot inject an error string', async () => {
		const sessionId = await setupRunningMission();

		const stopRes = await command({
			request: new Request('http://localhost/api/spark-agent/command', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sessionId,
					command: 'mission.stop',
					params: { error: 'Stopped by Spark agent command' }  // hostile: pre-fix string
				})
			})
		} as never);

		const body = await stopRes.json();
		expect(body.data.mission.error).toBeNull();           // hardcoded null, not from params
	});

	it('combined hostile params (status + error override) both ignored', async () => {
		const sessionId = await setupRunningMission();

		const stopRes = await command({
			request: new Request('http://localhost/api/spark-agent/command', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sessionId,
					command: 'mission.stop',
					params: {
						status: 'completed',                   // hostile: not cancelled
						error: 'malicious error payload'       // hostile: non-null error
					}
				})
			})
		} as never);

		const body = await stopRes.json();
		expect(body.data.mission.status).toBe('cancelled');
		expect(body.data.mission.error).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Boundary / edge cases
// ---------------------------------------------------------------------------

describe('mission.stop trust boundary — edge cases', () => {
	it('mission.stop on a session with no mission built returns an error', async () => {
		// Start a session but never build a mission
		const startRes = await startSession({
			request: new Request('http://localhost/api/spark-agent/session/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			})
		} as never);
		const { session } = await startRes.json();

		const stopRes = await command({
			request: new Request('http://localhost/api/spark-agent/command', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId: session.id, command: 'mission.stop' })
			})
		} as never);

		const body = await stopRes.json();
		expect(body.success).toBe(false);
		expect(body.error).toMatch(/mission/i);    // error mentions mission context
	});

	it('unknown command name is rejected at the allowlist boundary (not forwarded to bridge)', async () => {
		const startRes = await startSession({
			request: new Request('http://localhost/api/spark-agent/session/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			})
		} as never);
		const { session } = await startRes.json();

		const stopRes = await command({
			request: new Request('http://localhost/api/spark-agent/command', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sessionId: session.id,
					command: 'mission.force_complete'   // not in SPARK_AGENT_ALLOWED_COMMANDS
				})
			})
		} as never);

		expect(stopRes.status).toBe(400);
		const body = await stopRes.json();
		expect(body.success).toBe(false);
		expect(body.error).toMatch(/unsupported command/i);
	});

	it('session scope mismatch header is rejected before reaching the bridge', async () => {
		const startRes = await startSession({
			request: new Request('http://localhost/api/spark-agent/session/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			})
		} as never);
		const { session } = await startRes.json();

		const stopRes = await command({
			request: new Request('http://localhost/api/spark-agent/command', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-spark-agent-session-id': 'different-session-id'   // mismatch
				},
				body: JSON.stringify({ sessionId: session.id, command: 'mission.stop' })
			})
		} as never);

		expect(stopRes.status).toBe(403);
	});

	it('non-localhost request without API key is rejected at auth boundary', async () => {
		const stopRes = await command({
			request: new Request('https://external.example.com/api/spark-agent/command', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId: 'any', command: 'mission.stop' })
			})
		} as never);

		expect(stopRes.status).toBe(401);
	});
});
