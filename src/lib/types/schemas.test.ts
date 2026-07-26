/**
 * Schema Tests
 *
 * Tests for Zod runtime validation schemas.
 * H70 Skills Applied: test-architect, typescript-strict
 *
 * Following test-architect patterns:
 * - Test valid data passes
 * - Test invalid data fails with specific errors
 * - Test edge cases (missing fields, wrong types)
 * - Test helper functions
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	safeJsonParse,
	parseJsonWithDefault,
	CanvasStoreSavedStateSchema,
	PipelineDataSchema,
	SkillSchema,
	BridgeEventSchema,
	ClientBridgeEventSchema,
	StoredSkillSchema
} from './schemas';
import { z } from 'zod';

beforeEach(() => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// =============================================================================
// safeJsonParse Tests
// =============================================================================

describe('safeJsonParse', () => {
	const TestSchema = z.object({
		id: z.string(),
		value: z.number()
	});

	it('parses valid JSON matching schema', () => {
		const json = '{"id": "test-1", "value": 42}';
		const result = safeJsonParse(json, TestSchema);

		expect(result).toEqual({ id: 'test-1', value: 42 });
	});

	it('returns undefined for invalid JSON syntax', () => {
		const json = '{ invalid json }';
		const result = safeJsonParse(json, TestSchema, 'test-context');

		expect(result).toBeUndefined();
	});

	it('returns undefined for JSON not matching schema', () => {
		const json = '{"id": 123, "value": "not a number"}';
		const result = safeJsonParse(json, TestSchema);

		expect(result).toBeUndefined();
	});

	it('returns undefined for missing required fields', () => {
		const json = '{"id": "test-1"}';
		const result = safeJsonParse(json, TestSchema);

		expect(result).toBeUndefined();
	});

	it('handles null input gracefully', () => {
		// JSON.parse(null) returns null, which won't match most schemas
		const result = safeJsonParse('null', TestSchema);
		expect(result).toBeUndefined();
	});

	it('handles empty string gracefully', () => {
		const result = safeJsonParse('', TestSchema);
		expect(result).toBeUndefined();
	});
});

describe('parseJsonWithDefault', () => {
	const TestSchema = z.object({
		name: z.string()
	});

	const defaultValue = { name: 'default' };

	it('returns parsed value for valid JSON', () => {
		const json = '{"name": "custom"}';
		const result = parseJsonWithDefault(json, TestSchema, defaultValue);

		expect(result).toEqual({ name: 'custom' });
	});

	it('returns default for invalid JSON', () => {
		const json = 'not valid json';
		const result = parseJsonWithDefault(json, TestSchema, defaultValue);

		expect(result).toEqual(defaultValue);
	});

	it('returns default for schema mismatch', () => {
		const json = '{"name": 123}';
		const result = parseJsonWithDefault(json, TestSchema, defaultValue);

		expect(result).toEqual(defaultValue);
	});
});

// =============================================================================
// Canvas Schema Tests
// =============================================================================

describe('CanvasStoreSavedStateSchema', () => {
	const validState = {
		nodes: [
			{
				id: 'node-1',
				skillId: 'skill-1',
				skill: { id: 'skill-1', name: 'Test Skill' },
				position: { x: 100, y: 200 }
			}
		],
		connections: [
			{
				id: 'conn-1',
				sourceNodeId: 'node-1',
				sourcePortId: 'out',
				targetNodeId: 'node-2',
				targetPortId: 'in'
			}
		],
		zoom: 1.5,
		pan: { x: 50, y: 75 }
	};

	it('validates correct canvas state', () => {
		const result = CanvasStoreSavedStateSchema.safeParse(validState);
		expect(result.success).toBe(true);
	});

	it('rejects missing nodes array', () => {
		const invalid = { ...validState, nodes: undefined };
		const result = CanvasStoreSavedStateSchema.safeParse(invalid);
		expect(result.success).toBe(false);
	});

	it('rejects invalid position coordinates', () => {
		const invalid = {
			...validState,
			nodes: [{
				...validState.nodes[0],
				position: { x: 'not a number', y: 200 }
			}]
		};
		const result = CanvasStoreSavedStateSchema.safeParse(invalid);
		expect(result.success).toBe(false);
	});

	it('accepts optional savedAt field', () => {
		const withSavedAt = { ...validState, savedAt: '2024-01-15T10:00:00Z' };
		const result = CanvasStoreSavedStateSchema.safeParse(withSavedAt);
		expect(result.success).toBe(true);
	});

	it('accepts queued node status from execution startup', () => {
		const withQueuedNode = {
			...validState,
			nodes: [{
				...validState.nodes[0],
				status: 'queued'
			}]
		};
		const result = CanvasStoreSavedStateSchema.safeParse(withQueuedNode);
		expect(result.success).toBe(true);
	});
});

// =============================================================================
// Skill Schema Tests
// =============================================================================

describe('SkillSchema', () => {
	it('validates minimal skill', () => {
		const skill = { id: 'skill-1', name: 'Test Skill' };
		const result = SkillSchema.safeParse(skill);
		expect(result.success).toBe(true);
	});

	it('validates full skill with all optional fields', () => {
		const skill = {
			id: 'skill-1',
			name: 'Test Skill',
			description: 'A test skill',
			category: 'testing',
			tags: ['test', 'example'],
			triggers: ['test this', 'run test'],
			layer: 1
		};
		const result = SkillSchema.safeParse(skill);
		expect(result.success).toBe(true);
	});

	it('rejects skill without id', () => {
		const skill = { name: 'Test Skill' };
		const result = SkillSchema.safeParse(skill);
		expect(result.success).toBe(false);
	});

	it('rejects skill without name', () => {
		const skill = { id: 'skill-1' };
		const result = SkillSchema.safeParse(skill);
		expect(result.success).toBe(false);
	});
});

// =============================================================================
// StoredSkill Schema Tests (for localStorage security)
// =============================================================================

describe('StoredSkillSchema', () => {
	const validStoredSkill = {
		id: 'generated-123',
		name: 'Custom Skill',
		description: 'A custom skill',
		category: 'development',
		tier: 'free',
		tags: ['custom'],
		triggers: ['custom skill']
	};

	it('validates stored skill from localStorage', () => {
		const result = StoredSkillSchema.safeParse(validStoredSkill);
		expect(result.success).toBe(true);
	});

	it('rejects skill with missing required fields', () => {
		const invalid = { id: 'skill-1', name: 'Test' };
		const result = StoredSkillSchema.safeParse(invalid);
		expect(result.success).toBe(false);
	});

	it('validates optional handoffs array', () => {
		const withHandoffs = {
			...validStoredSkill,
			handoffs: [{ trigger: 'need auth', to: 'auth-skill' }]
		};
		const result = StoredSkillSchema.safeParse(withHandoffs);
		expect(result.success).toBe(true);
	});
});

// =============================================================================
// BridgeEvent Schema Tests
// =============================================================================

describe('BridgeEventSchema', () => {
	it('validates mission_started event', () => {
		const event = {
			type: 'mission_started',
			data: { missionId: 'mission-1' },
			timestamp: new Date().toISOString()
		};
		const result = BridgeEventSchema.safeParse(event);
		expect(result.success).toBe(true);
	});

	it('validates event without optional fields', () => {
		const event = { type: 'task_completed' };
		const result = BridgeEventSchema.safeParse(event);
		expect(result.success).toBe(true);
	});

	it('rejects invalid event type', () => {
		const event = { type: 'invalid_type' };
		const result = BridgeEventSchema.safeParse(event);
		expect(result.success).toBe(false);
	});
});

describe('ClientBridgeEventSchema', () => {
	it('accepts custom provider sources', () => {
		const event = {
			type: 'provider_feedback',
			missionId: 'mission-1',
			timestamp: new Date().toISOString(),
			source: 'kimi',
			data: {
				provider: 'kimi',
				summary: 'Looks good'
			}
		};
		const result = ClientBridgeEventSchema.safeParse(event);
		expect(result.success).toBe(true);
	});
});

// =============================================================================
// Pipeline Schema Tests
// =============================================================================

describe('PipelineDataSchema', () => {
	it('validates pipeline with defaults', () => {
		const pipeline = {
			nodes: [],
			connections: []
		};
		const result = PipelineDataSchema.safeParse(pipeline);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.zoom).toBe(1);
			expect(result.data.pan).toEqual({ x: 0, y: 0 });
		}
	});

	it('validates pipeline with custom zoom and pan', () => {
		const pipeline = {
			nodes: [],
			connections: [],
			zoom: 2.0,
			pan: { x: 100, y: 200 }
		};
		const result = PipelineDataSchema.safeParse(pipeline);
		expect(result.success).toBe(true);
	});
});
