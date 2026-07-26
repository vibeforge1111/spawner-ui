import { describe, expect, it } from 'vitest';
import {
	buildClientGovernorDecisionAuthority,
	buildClientTurnIntentVNextAuthority
} from './harness-authority-client';

describe('harness authority client', () => {
	it('does not mint TurnIntent or Governor authority in a client module', () => {
		expect(() => buildClientTurnIntentVNextAuthority({
			source: 'mission-board.schedule.create',
			reason: 'Browser-side authority minting regression.',
			toolName: 'spawner.schedule.create',
			mutationClass: 'creates_schedule',
			target: 'mission'
		})).toThrow('Browser clients cannot create Harness authority');

		expect(() => buildClientGovernorDecisionAuthority({
			source: 'execution-panel.dispatch',
			reason: 'Browser-side authority minting regression.',
			toolName: 'spawner.dispatch',
			mutationClass: 'launches_mission',
			target: 'mission-dispatch-governor'
		})).toThrow('Browser clients must not mint GovernorDecisionV1 authority');
	});
});
