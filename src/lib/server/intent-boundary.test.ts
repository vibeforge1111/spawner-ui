import { describe, expect, it } from 'vitest';
import { evaluateExecutionIntentBoundary } from './intent-boundary';

describe('execution intent boundary', () => {
	it('blocks meta-language word hijacks across Spark terms', () => {
		for (const prompt of [
			'mission, build, Codex, schedule, and provider are words here, not a request',
			'build appears in this sentence as meta-language; stay in chat and explain the boundary',
			'Bug report: schedule hijacked routing before; do not create a mission',
			'QA case for provider: words alone should not execute'
		]) {
			const verdict = evaluateExecutionIntentBoundary(prompt);

			expect(verdict).toMatchObject({
				allowed: false,
				reasonCode: 'conversation_only_boundary'
			});
			expect(verdict.reasons).toContain('meta_language_boundary');
		}
	});

	it('blocks denied creation or scaffold language before provider dispatch', () => {
		const verdict = evaluateExecutionIntentBoundary(
			'Build a chip is a phrase here; do not scaffold anything or create a mission.'
		);

		expect(verdict).toMatchObject({
			allowed: false,
			reasonCode: 'conversation_only_boundary'
		});
		expect(verdict.reasons).toContain('meta_language_boundary');
		expect(verdict.reasons).toContain('execution_denial_boundary');
	});

	it('still allows clear execution requests', () => {
		const verdict = evaluateExecutionIntentBoundary(
			'Build a tiny no-edit smoke mission that replies SPARK_QA_NO_EDIT_OK.'
		);

		expect(verdict).toEqual({
			allowed: true,
			reasonCode: 'execution_intent_present',
			reasons: []
		});
	});

	it('allows explicit no-edit Spawner probes with file safety constraints', () => {
		const verdict = evaluateExecutionIntentBoundary(
			'Reply with exactly: SPARK_INTENT_BOUNDARY_POSITIVE_OK. Do not edit files. Do not create files. This is a no-edit Spawner golden-path health probe.'
		);

		expect(verdict).toEqual({
			allowed: true,
			reasonCode: 'execution_intent_present',
			reasons: []
		});
	});
});
