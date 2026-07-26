import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendAgentEvent, buildMissionControlAgentEvent } from './lib/server/agent-event-ledger';

const originalStateDir = process.env.SPAWNER_STATE_DIR;

afterEach(() => {
	if (originalStateDir === undefined) delete process.env.SPAWNER_STATE_DIR;
	else process.env.SPAWNER_STATE_DIR = originalStateDir;
	vi.restoreAllMocks();
});

async function appendRealEvent() {
	process.env.SPAWNER_STATE_DIR = await mkdtemp(path.join(tmpdir(), 'spawner-ledger-crypto-'));
	return appendAgentEvent(buildMissionControlAgentEvent({
		eventType: 'mission_started',
		missionId: 'mission-crypto-proof',
		missionName: 'Crypto proof',
		taskId: null,
		taskName: null,
		progress: 0,
		summary: 'Started.',
		timestamp: new Date().toISOString(),
		source: 'test'
	}));
}

describe('audit ledger event_id generation', () => {
	it('matches agent-<ts>-<hex8> format in the real ledger entry', async () => {
		expect((await appendRealEvent()).event_id).toMatch(/^agent-\d+-[0-9a-f]{8}$/);
	});
	it('uses crypto.randomUUID rather than Math.random in the real append path', async () => {
		const spy = vi.spyOn(Math, 'random');
		const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4123-8123-123456789abc');
		const entry = await appendRealEvent();
		expect(spy).not.toHaveBeenCalled();
		expect(uuid).toHaveBeenCalledOnce();
		expect(entry.event_id).toMatch(/^agent-\d+-12345678$/);
	});
});
