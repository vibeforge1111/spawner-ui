import { describe, expect, it } from 'vitest';
import type { PortType } from '$lib/types/skill';
import {
	arePortTypesCompatible,
	generatePorts,
	getPortColor,
	getPortColorClass,
	getPortIncompatibilityMessage,
} from './ports';

describe('generatePorts', () => {
	it('returns a base input and output port for every skill', () => {
		const { inputs, outputs } = generatePorts({ category: 'marketing' });
		expect(inputs[0].id).toBe('input');
		expect(inputs[0].required).toBe(true);
		expect(outputs[0].id).toBe('output');
		expect(outputs[0].required).toBe(true);
	});

	it('adds a context port for complex categories', () => {
		const { inputs } = generatePorts({ category: 'ai-ml' });
		expect(inputs.some((p) => p.id === 'context')).toBe(true);
	});

	it('adds a config port for configurable categories', () => {
		const { inputs } = generatePorts({ category: 'integrations' });
		expect(inputs.some((p) => p.id === 'config')).toBe(true);
	});

	it('adds handoff outputs (capped at 2) when a skill declares handoffs', () => {
		const { outputs } = generatePorts({
			category: 'development',
			handoffs: [
				{ trigger: 'on-done', to: 'skill-a' },
				{ trigger: 'on-fail', to: 'skill-b' },
				{ trigger: 'on-other', to: 'skill-c' },
			],
		});
		const handoffs = outputs.filter((p) => p.id.startsWith('handoff-'));
		expect(handoffs).toHaveLength(2);
		expect(handoffs[0].skillId).toBe('skill-a');
	});

	it('adds an error output for development-family skills', () => {
		const { outputs } = generatePorts({ category: 'development' });
		expect(outputs.some((p) => p.id === 'error')).toBe(true);
	});

	it('does not add an error output for non-development categories', () => {
		const { outputs } = generatePorts({ category: 'marketing' });
		expect(outputs.some((p) => p.id === 'error')).toBe(false);
	});

	it('treats RAG/LLM/orchestration/workflow tags as complex', () => {
		const { inputs } = generatePorts({ category: 'marketing', tags: ['LLM'] });
		expect(inputs.some((p) => p.id === 'context')).toBe(true);
	});

	it('treats api/database/auth/config tags as configurable', () => {
		const { inputs } = generatePorts({ category: 'marketing', tags: ['DATABASE'] });
		expect(inputs.some((p) => p.id === 'config')).toBe(true);
	});
});

describe('getPortColorClass and getPortColor', () => {
	it('maps every known PortType to a stable class', () => {
		const types: PortType[] = ['text', 'number', 'boolean', 'object', 'array', 'any', 'skill'];
		for (const type of types) {
			expect(getPortColorClass(type)).toMatch(/^port-/);
		}
	});

	it('returns hex color values for every known PortType', () => {
		const types: PortType[] = ['text', 'number', 'boolean', 'object', 'array', 'any', 'skill'];
		for (const type of types) {
			expect(getPortColor(type)).toMatch(/^#[0-9A-Fa-f]{6}$/);
		}
	});
});

describe('arePortTypesCompatible', () => {
	it('treats any as compatible with everything', () => {
		expect(arePortTypesCompatible('any', 'text')).toBe(true);
		expect(arePortTypesCompatible('object', 'any')).toBe(true);
	});

	it('treats matching types as compatible', () => {
		expect(arePortTypesCompatible('text', 'text')).toBe(true);
		expect(arePortTypesCompatible('object', 'object')).toBe(true);
	});

	it('lets skill outputs connect to skill, object, and text inputs', () => {
		expect(arePortTypesCompatible('skill', 'skill')).toBe(true);
		expect(arePortTypesCompatible('skill', 'object')).toBe(true);
		expect(arePortTypesCompatible('skill', 'text')).toBe(true);
		expect(arePortTypesCompatible('skill', 'number')).toBe(false);
	});

	it('lets object input accept most source types', () => {
		expect(arePortTypesCompatible('text', 'object')).toBe(true);
		expect(arePortTypesCompatible('array', 'object')).toBe(true);
	});

	it('lets text input accept primitives', () => {
		expect(arePortTypesCompatible('number', 'text')).toBe(true);
		expect(arePortTypesCompatible('boolean', 'text')).toBe(true);
		expect(arePortTypesCompatible('object', 'text')).toBe(false);
	});

	it('lets array input accept object and array sources only', () => {
		expect(arePortTypesCompatible('object', 'array')).toBe(true);
		expect(arePortTypesCompatible('array', 'array')).toBe(true);
		expect(arePortTypesCompatible('text', 'array')).toBe(false);
	});
});

describe('getPortIncompatibilityMessage', () => {
	it('returns an empty string when types are compatible', () => {
		expect(getPortIncompatibilityMessage('text', 'text')).toBe('');
		expect(getPortIncompatibilityMessage('any', 'object')).toBe('');
	});

	it('produces a human-readable message when types do not match', () => {
		const msg = getPortIncompatibilityMessage('text', 'array');
		expect(msg).toMatch(/Cannot connect text output to array input/);
	});
});
