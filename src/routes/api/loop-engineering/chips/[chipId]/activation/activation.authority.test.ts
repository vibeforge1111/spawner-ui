import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServerGovernorDecisionAuthority, buildServerTurnIntentVNextAuthority } from '$lib/server/harness-authority';
import { listActivationRules } from '$lib/server/loop-engineering-control-plane';
import { POST } from './+server';

const originalSpawnerStateDir = process.env.SPAWNER_STATE_DIR;
let cleanupDir: string | null = null;

function event(body?: unknown) {
	return {
		params: { chipId: 'domain-chip-prd-writing-proof-loop' },
		request: new Request('http://127.0.0.1:3333/api/loop-engineering/chips/domain-chip-prd-writing-proof-loop/activation', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		url: new URL('http://127.0.0.1:3333/api/loop-engineering/chips/domain-chip-prd-writing-proof-loop/activation'),
		getClientAddress: () => '127.0.0.1'
	};
}

function governorAuthority() {
	return buildServerGovernorDecisionAuthority({
		source: 'loop-engineering-activation-test',
		reason: 'Focused Loop Engineering activation staging regression.',
		toolName: 'spawner.loop_engineering.activation.stage',
		mutationClass: 'writes_files',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

function bareVNextAuthority() {
	return buildServerTurnIntentVNextAuthority({
		source: 'loop-engineering-activation-test',
		reason: 'Focused Loop Engineering activation staging regression.',
		toolName: 'spawner.loop_engineering.activation.stage',
		mutationClass: 'writes_files',
		actorKind: 'human',
		actorIdRef: 'spawner-ui.test'
	});
}

describe('/api/loop-engineering/chips/[chipId]/activation', () => {
	beforeEach(async () => {
		cleanupDir = await mkdtemp(path.join(os.tmpdir(), 'spawner-loop-activation-route-'));
		process.env.SPAWNER_STATE_DIR = cleanupDir;
	});

	afterEach(async () => {
		if (originalSpawnerStateDir) process.env.SPAWNER_STATE_DIR = originalSpawnerStateDir;
		else delete process.env.SPAWNER_STATE_DIR;
		if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true });
		cleanupDir = null;
	});

	it('blocks activation staging without native Governor authority', async () => {
		const response = await POST(event({ useCase: 'PRD creation', mode: 'suggested' }) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.code).toBe('harness_authority_blocked');
		expect(body.authority.reasonCodes).toContain('missing_harness_authority');
	});

	it('blocks bare VNext activation authority', async () => {
		const response = await POST(event({ useCase: 'PRD creation', mode: 'suggested', executionAuthority: bareVNextAuthority() }) as never);
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.authority.source).toBe('turn_intent_vnext');
		expect(body.authority.reasonCodes).toContain('native_governor_required');
	});

	it('stages per-use-case activation without enabling automatic use', async () => {
		const response = await POST(event({
			useCase: 'PRD creation and review',
			mode: 'suggested',
			surfaces: ['telegram', 'spawner', 'codex'],
			triggerPatterns: ['write a PRD'],
			nonTriggerPatterns: ['code review'],
			riskPolicy: 'review_packet',
			sourceSurface: 'telegram',
			executionAuthority: governorAuthority()
		}) as never);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.commandResult).toMatchObject({
			action: 'activation_requested',
			changed: true,
			launchedMission: false,
			eventId: body.event.id
		});
		expect(body.activationRule).toMatchObject({
			useCase: 'PRD creation and review',
			mode: 'suggested',
			status: 'staged',
			approvalRequired: true
		});
		expect(body.event).toMatchObject({
			sourceSurface: 'telegram',
			evaluatorSeparated: false
		});
		const rules = await listActivationRules('domain-chip-prd-writing-proof-loop');
		expect(rules).toHaveLength(1);
		expect(rules[0].surfaces).toEqual(['telegram', 'spawner', 'codex']);
	});
});
