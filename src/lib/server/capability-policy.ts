import { env } from '$env/dynamic/private';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { hostedUiSessionIsValid } from '$lib/server/hosted-ui-auth';

export type CapabilityActorKind = 'telegram-user' | 'local-user' | 'hosted-user' | 'system-job';
export type CapabilitySurface = 'telegram' | 'cli' | 'spawner' | 'scanner' | 'mcp' | 'memory' | 'pro';
export type SparkCapability =
	| 'canvas.read'
	| 'canvas.write'
	| 'mission.status'
	| 'mission.command'
	| 'mission.start'
	| 'worker.run'
	| 'provider.execute'
	| 'mcp.list'
	| 'mcp.connect'
	| 'mcp.disconnect'
	| 'mcp.call_tool'
	| 'scanner.scan'
	| 'filesystem.write'
	| 'filesystem.outside_workspace'
	| 'shell.execute'
	| 'secrets.read'
	| 'deploy.publish';

export interface CapabilityEnvelope {
	actorId: string;
	actorKind: CapabilityActorKind;
	surface: CapabilitySurface;
	capability: SparkCapability;
	target: string;
	reason: string;
	requestId: string;
	accessLevel: number;
	approvalId?: string;
}

interface CapabilityEnvelopeInput {
	actorId?: string | null;
	actorKind?: CapabilityActorKind;
	surface: CapabilitySurface;
	capability: SparkCapability;
	target: string;
	reason: string;
	requestId?: string | null;
	accessLevel?: number;
	approvalId?: string | null;
}

const MIN_ACCESS_LEVEL: Record<SparkCapability, number> = {
	'canvas.read': 1,
	'canvas.write': 2,
	'mission.status': 1,
	'mission.command': 2,
	'mission.start': 4,
	'worker.run': 4,
	'provider.execute': 4,
	'mcp.list': 1,
	'mcp.connect': 4,
	'mcp.disconnect': 4,
	'mcp.call_tool': 4,
	'scanner.scan': 4,
	'filesystem.write': 4,
	'filesystem.outside_workspace': 4,
	'shell.execute': 4,
	'secrets.read': 4,
	'deploy.publish': 4
};

const LOCAL_RUNTIME_CAPABILITIES = new Set<SparkCapability>([
	'worker.run',
	'provider.execute',
	'scanner.scan',
	'mcp.connect',
	'mcp.disconnect',
	'mcp.call_tool',
	'filesystem.write',
	'filesystem.outside_workspace',
	'shell.execute',
	'secrets.read',
	'deploy.publish'
]);

const HUMAN_APPROVAL_CAPABILITIES = new Set<SparkCapability>([
	'filesystem.outside_workspace',
	'shell.execute',
	'secrets.read',
	'deploy.publish'
]);

export class CapabilityPolicyError extends Error {
	status = 403;
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'CapabilityPolicyError';
		this.code = code;
	}
}

function requiredText(value: string | null | undefined): string {
	return typeof value === 'string' ? value.trim() : '';
}

function actorFromRequest(event: RequestEvent): Pick<CapabilityEnvelope, 'actorId' | 'actorKind' | 'accessLevel'> {
	const headerActor = requiredText(event.request.headers.get('x-spark-actor'));
	if (headerActor) { console.warn('[capability-policy] Ignored spoofed x-spark-actor header:', headerActor); }
	if (event.cookies && hostedUiSessionIsValid(event.cookies, env)) {
		return {
			actorId: 'hosted-ui-session',
			actorKind: 'hosted-user',
			accessLevel: 1
		};
	}

	return {
		actorId: 'local-control',
		actorKind: 'local-user',
		accessLevel: 4
	};
}

export function createCapabilityEnvelope(event: RequestEvent, input: CapabilityEnvelopeInput): CapabilityEnvelope {
	const requestActor = actorFromRequest(event);
	return {
		actorId: requiredText(input.actorId) || requestActor.actorId,
		actorKind: requestActor.actorKind === 'hosted-user' ? 'hosted-user' : input.actorKind || requestActor.actorKind,
		surface: input.surface,
		capability: input.capability,
		target: requiredText(input.target),
		reason: requiredText(input.reason),
		requestId: requiredText(input.requestId) || requiredText(event.request.headers.get('x-request-id')) || randomUUID(),
		accessLevel: typeof input.accessLevel === 'number' && Number.isFinite(input.accessLevel)
			? input.accessLevel
			: requestActor.accessLevel,
		approvalId: requiredText(input.approvalId) || undefined
	};
}

export function assertCapability(envelope: CapabilityEnvelope): CapabilityEnvelope {
	for (const field of ['actorId', 'surface', 'capability', 'target', 'reason', 'requestId'] as const) {
		if (!requiredText(String(envelope[field] ?? ''))) {
			throw new CapabilityPolicyError('capability_envelope_incomplete', `Capability envelope is missing ${field}.`);
		}
	}

	const requiredAccessLevel = MIN_ACCESS_LEVEL[envelope.capability];
	if (envelope.accessLevel < requiredAccessLevel) {
		throw new CapabilityPolicyError(
			'capability_access_level_too_low',
			`${envelope.capability} requires access level ${requiredAccessLevel}.`
		);
	}

	if (
		LOCAL_RUNTIME_CAPABILITIES.has(envelope.capability) &&
		(envelope.actorKind === 'hosted-user' || envelope.surface === 'pro')
	) {
		throw new CapabilityPolicyError(
			'hosted_entitlement_cannot_unlock_local_runtime',
			'Hosted or Pro identity cannot unlock local runtime, filesystem, MCP, secret, shell, or deploy capabilities.'
		);
	}

	if (HUMAN_APPROVAL_CAPABILITIES.has(envelope.capability) && !envelope.approvalId) {
		throw new CapabilityPolicyError(
			'capability_human_approval_required',
			`${envelope.capability} requires an explicit human approval id.`
		);
	}

	return envelope;
}
