import { describe, expect, it } from 'vitest';
import {
	buildLoopComputedEvidenceFields,
	LOOP_COMPUTED_EVIDENCE_WAIT_MS,
	LOOP_ENGINEERING_AUTO_REFRESH_MS,
	shouldAutoRefreshLoopEngineering
} from './client-actions';

describe('Loop Engineering client actions', () => {
	it('builds provider-backed computed evidence fields with separate dispatch authority', () => {
		const fields = buildLoopComputedEvidenceFields({
			action: 'benchmark-execute',
			requestId: 'spawner-loop-benchmark-execute-123',
			target: 'domain-chip-prd-writing-proof-loop',
			generatorProviderId: 'codex',
			evaluatorProviderId: 'zai'
		});

		expect(fields).toMatchObject({
			evidenceMode: 'computed',
			providerBacked: true,
			generatorProviderId: 'codex',
			evaluatorProviderId: 'zai',
			waitForCompletionMs: LOOP_COMPUTED_EVIDENCE_WAIT_MS
		});
		const authority = fields.dispatchExecutionAuthority as any;
		expect(authority).toMatchObject({
			schema_version: 'governor-decision-v1',
			outcome: 'execute',
			selected_move: 'execute_action'
		});
		expect(authority.envelope).toMatchObject({
			schema_version: 'turn-intent-envelope-vnext',
			selected_move: 'execute_action',
			surface: 'spawner'
		});
		expect(authority.envelope.proposed_actions[0]).toMatchObject({
			action_type: 'launch_mission',
			capability_id: 'capability:spawner-ui:spawner.dispatch',
			requires_confirmation: false
		});
		expect(authority.envelope.proposed_actions[0].args_ref).toMatchObject({
			path_or_uri: 'spawner://actions/spawner.dispatch/spawner-loop-benchmark-execute-123-provider-proof',
			redaction_class: 'metadata_only'
		});
		expect(authority.authorizations[0]).toMatchObject({
			verdict: 'allow',
			capability_id: 'capability:spawner-ui:spawner.dispatch'
		});
		expect(authority.authorizations[0].restrictions).toMatchObject({
			network_allowed: false,
			write_allowed: true,
			publish_allowed: false
		});
	});

	it('keeps auto-refresh bounded to visible idle control-plane pages', () => {
		expect(LOOP_ENGINEERING_AUTO_REFRESH_MS).toBeGreaterThanOrEqual(5_000);
		expect(shouldAutoRefreshLoopEngineering({})).toBe(true);
		expect(shouldAutoRefreshLoopEngineering({ documentVisible: false })).toBe(false);
		expect(shouldAutoRefreshLoopEngineering({ refreshing: true })).toBe(false);
		expect(shouldAutoRefreshLoopEngineering({ actionLoading: 'loop-execute' })).toBe(false);
		expect(shouldAutoRefreshLoopEngineering({ autoRefresh: false })).toBe(false);
	});
});
