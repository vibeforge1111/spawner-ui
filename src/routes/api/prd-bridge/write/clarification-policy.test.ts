import { describe, expect, it } from 'vitest';
import { _resolvePrdCodexCommandTemplate, _shouldRequestBriefClarification } from './+server';

describe('PRD bridge clarification policy', () => {
	it('lets concrete direct static builds continue without clarification', () => {
		const content = [
			'# Cafe Landing Page',
			'',
			'Build mode: direct',
			'Build mode reason: compact static build.',
			'',
			'Build a tiny static landing page for a cafe with a menu section.'
		].join('\n');

		expect(_shouldRequestBriefClarification({
			content,
			buildMode: 'direct',
			openQuestions: ['Should the cafe feel modern or rustic?']
		})).toBe(false);
	});

	it('still asks on vague short builds', () => {
		expect(_shouldRequestBriefClarification({
			content: 'Build something cool.',
			buildMode: 'direct',
			openQuestions: ['Who is this for?']
		})).toBe(true);
	});

	it('respects force dispatch and missing questions', () => {
		expect(_shouldRequestBriefClarification({
			content: 'Build something cool.',
			buildMode: 'direct',
			openQuestions: ['Who is this for?'],
			forceDispatch: true
		})).toBe(false);

		expect(_shouldRequestBriefClarification({
			content: 'Build something cool.',
			buildMode: 'direct',
			openQuestions: []
		})).toBe(false);
	});

	it('uses Level 5 Codex sandbox for PRD analysis without weakening explicit overrides', () => {
		expect(_resolvePrdCodexCommandTemplate('gpt-5.5', {})).toBe(
			'codex exec --model gpt-5.5 --profile speed --sandbox workspace-write'
		);
		expect(
			_resolvePrdCodexCommandTemplate('gpt-5.5', {
				SPARK_CODEX_SANDBOX: 'danger-full-access',
				SPARK_ALLOW_HIGH_AGENCY_WORKERS: '1'
			})
		).toBe('codex exec --model gpt-5.5 --profile speed --sandbox danger-full-access');
		expect(
			_resolvePrdCodexCommandTemplate('gpt-5.5', {
				SPAWNER_PRD_CODEX_COMMAND_TEMPLATE:
					'codex exec --model {model} --sandbox workspace-write'
			})
		).toBe('codex exec --model gpt-5.5 --sandbox workspace-write');
	});
});
