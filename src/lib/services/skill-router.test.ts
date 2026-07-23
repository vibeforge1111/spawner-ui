import { describe, expect, it } from 'vitest';
import { adjustScriptingDomains } from './skill-router';

describe('scripting domain adjustment', () => {
	it('routes a pure Python script to backend without frontend scaffolding', () => {
		expect(
			adjustScriptingDomains(['frontend'], 'Write a Python script that prints hello world.')
		).toEqual(['backend']);
	});

	it('keeps frontend when the scripting task explicitly asks for UI', () => {
		expect(
			adjustScriptingDomains(['frontend'], 'Build a Node.js service with a Svelte UI.')
		).toEqual(['frontend', 'backend']);
	});

	it('does not treat JavaScript as a Java boundary match', () => {
		expect(adjustScriptingDomains(['frontend'], 'Build a JavaScript landing page.')).toEqual([
			'frontend'
		]);
	});
});
