import { describe, expect, it } from 'vitest';
import type { PortType } from '$lib/types/skill';
import {
	arePortTypesCompatible,
	generatePorts,
	getPortColor,
	getPortColorClass,
	getPortIncompatibilityMessage
} from './ports';

describe('generatePorts', () => {
	it('returns the base input + output for a plain skill with no extras', () => {
		const { inputs, outputs } = generatePorts({ category: 'marketing' });

		expect(inputs).toHaveLength(1);
		expect(inputs[0]).toMatchObject({ id: 'input', required: true, type: 'text' });
		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toMatchObject({ id: 'output', required: true, type: 'text' });
	});

	it('adds context + config inputs for complex configurable skills', () => {
		const { inputs } = generatePorts({
			category: 'ai-ml', // complex category
			tags: ['api'] // configurable tag
		});

		const ids = inputs.map((p) => p.id);
		expect(ids).toContain('input');
		expect(ids).toContain('context');
		expect(ids).toContain('config');
		// context + config must be optional, not required
		expect(inputs.find((p) => p.id === 'context')?.required).toBe(false);
		expect(inputs.find((p) => p.id === 'config')?.required).toBe(false);
	});

	it('emits handoff outputs capped at two, preserving the destination skill id', () => {
		const { outputs } = generatePorts({
			category: 'marketing',
			handoffs: [
				{ trigger: 't1', to: 'design-skill-figma-export' },
				{ trigger: 't2', to: 'data-skill-sheets-sync' },
				{ trigger: 't3', to: 'should-not-appear' }
			]
		});

		const handoffPorts = outputs.filter((p) => p.id.startsWith('handoff-'));
		expect(handoffPorts).toHaveLength(2);
		expect(handoffPorts[0]).toMatchObject({
			id: 'handoff-0',
			type: 'skill',
			skillId: 'design-skill-figma-export'
		});
		// Label truncated to first two dash-segments per generatePorts contract.
		expect(handoffPorts[0].label).toBe('design-skill');
		expect(handoffPorts[1].skillId).toBe('data-skill-sheets-sync');
		expect(outputs.find((p) => p.id === 'handoff-2')).toBeUndefined();
	});

	it('appends an error output for development/integration categories only', () => {
		const dev = generatePorts({ category: 'development' });
		const integ = generatePorts({ category: 'integrations' });
		const marketing = generatePorts({ category: 'marketing' });

		expect(dev.outputs.some((p) => p.id === 'error')).toBe(true);
		expect(integ.outputs.some((p) => p.id === 'error')).toBe(true);
		expect(marketing.outputs.some((p) => p.id === 'error')).toBe(false);
	});

	it('promotes a skill to complex via a recognised tag even when the category is simple', () => {
		const { inputs } = generatePorts({
			category: 'marketing',
			tags: ['LLM'] // tag match is case-insensitive
		});

		expect(inputs.some((p) => p.id === 'context')).toBe(true);
	});
});

describe('getPortColorClass / getPortColor', () => {
	it('returns the canonical class for each known port type', () => {
		const cases: Array<[PortType, string]> = [
			['text', 'port-text'],
			['number', 'port-number'],
			['boolean', 'port-boolean'],
			['object', 'port-object'],
			['array', 'port-array'],
			['any', 'port-any'],
			['skill', 'port-skill']
		];
		for (const [type, expected] of cases) {
			expect(getPortColorClass(type)).toBe(expected);
		}
	});

	it('returns a non-empty hex colour for every known port type', () => {
		const types: PortType[] = ['text', 'number', 'boolean', 'object', 'array', 'any', 'skill'];
		for (const t of types) {
			expect(getPortColor(t)).toMatch(/^#[0-9A-Fa-f]{6}$/);
		}
	});
});

describe('arePortTypesCompatible', () => {
	it('treats `any` as universally compatible in either direction', () => {
		expect(arePortTypesCompatible('any', 'text')).toBe(true);
		expect(arePortTypesCompatible('object', 'any')).toBe(true);
	});

	it('always allows same-type connections', () => {
		expect(arePortTypesCompatible('text', 'text')).toBe(true);
		expect(arePortTypesCompatible('skill', 'skill')).toBe(true);
	});

	it('lets skill outputs connect to skill, object, or text inputs', () => {
		expect(arePortTypesCompatible('skill', 'skill')).toBe(true);
		expect(arePortTypesCompatible('skill', 'object')).toBe(true);
		expect(arePortTypesCompatible('skill', 'text')).toBe(true);
		expect(arePortTypesCompatible('skill', 'number')).toBe(false);
		expect(arePortTypesCompatible('skill', 'array')).toBe(false);
	});

	it('lets object inputs accept primitive and structural source types', () => {
		expect(arePortTypesCompatible('text', 'object')).toBe(true);
		expect(arePortTypesCompatible('array', 'object')).toBe(true);
		expect(arePortTypesCompatible('number', 'object')).toBe(true);
	});

	it('limits array inputs to object or array sources', () => {
		expect(arePortTypesCompatible('object', 'array')).toBe(true);
		expect(arePortTypesCompatible('array', 'array')).toBe(true);
		expect(arePortTypesCompatible('text', 'array')).toBe(false);
		expect(arePortTypesCompatible('number', 'array')).toBe(false);
	});

	it('coerces number/boolean to text inputs but rejects array/object', () => {
		expect(arePortTypesCompatible('number', 'text')).toBe(true);
		expect(arePortTypesCompatible('boolean', 'text')).toBe(true);
		expect(arePortTypesCompatible('object', 'text')).toBe(false);
		expect(arePortTypesCompatible('array', 'text')).toBe(false);
	});
});

describe('getPortIncompatibilityMessage', () => {
	it('returns an empty string when the pair is compatible', () => {
		expect(getPortIncompatibilityMessage('text', 'text')).toBe('');
		expect(getPortIncompatibilityMessage('any', 'array')).toBe('');
	});

	it('explains the rejection by naming both types when incompatible', () => {
		const message = getPortIncompatibilityMessage('array', 'text');
		expect(message).toContain('array');
		expect(message).toContain('text');
		expect(message).toMatch(/cannot connect/i);
	});
});
