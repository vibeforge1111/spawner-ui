/**
 * Tests for safeJsonParse
 *
 * Covers 15 PRs (#261, #260, #259, #258, #257, #256, #255, #254, #253,
 * #252, #251, #250, #249, #248, #247) that added safeJsonParse() calls.
 *
 * safeJsonParse wraps JSON.parse + Zod validation, returning undefined
 * on failure instead of throwing.
 */
import { describe, it, expect } from 'vitest';
import { safeJsonParse } from '$lib/types/schemas';
import { z } from 'zod';

describe('safeJsonParse', () => {
	// === Valid JSON + Valid Zod Schema ===

	it('returns parsed data for valid JSON matching the schema', () => {
		const schema = z.object({ name: z.string(), count: z.number() });
		const result = safeJsonParse('{"name":"test","count":42}', schema);
		expect(result).toEqual({ name: 'test', count: 42 });
	});

	it('returns parsed data for a primitive schema (string)', () => {
		const result = safeJsonParse('"hello"', z.string());
		expect(result).toBe('hello');
	});

	it('returns parsed data for a primitive schema (number)', () => {
		const result = safeJsonParse('42', z.number());
		expect(result).toBe(42);
	});

	it('returns parsed data for an array schema', () => {
		const schema = z.array(z.string());
		const result = safeJsonParse('["a","b","c"]', schema);
		expect(result).toEqual(['a', 'b', 'c']);
	});

	it('returns parsed data for a passthrough object', () => {
		const schema = z.object({ id: z.string() }).passthrough();
		const result = safeJsonParse('{"id":"abc","extra":"value"}', schema);
		expect(result).toEqual({ id: 'abc', extra: 'value' });
	});

	// === Invalid JSON (JSON.parse fails) ===

	it('returns undefined for malformed JSON', () => {
		const result = safeJsonParse('not json', z.any());
		expect(result).toBeUndefined();
	});

	it('returns undefined for empty string', () => {
		const result = safeJsonParse('', z.any());
		expect(result).toBeUndefined();
	});

	it('returns undefined for truncated JSON', () => {
		const result = safeJsonParse('{"key": "value"', z.any());
		expect(result).toBeUndefined();
	});

	it('returns undefined for JSON with trailing garbage', () => {
		const result = safeJsonParse('42 extra', z.any());
		expect(result).toBeUndefined();
	});

	// === Valid JSON but Zod Validation fails ===

	it('returns undefined when parsed JSON fails schema validation (wrong type)', () => {
		const schema = z.object({ name: z.string() });
		const result = safeJsonParse('{"name": 123}', schema);
		expect(result).toBeUndefined();
	});

	it('returns undefined when parsed JSON is missing required fields', () => {
		const schema = z.object({ name: z.string(), email: z.string() });
		const result = safeJsonParse('{"name":"test"}', schema);
		expect(result).toBeUndefined();
	});

	it('returns undefined when parsed JSON is null but schema expects object', () => {
		const schema = z.object({ name: z.string() });
		const result = safeJsonParse('null', schema);
		expect(result).toBeUndefined();
	});

	it('returns undefined when parsed JSON is wrong primitive type', () => {
		const result = safeJsonParse('"hello"', z.number());
		expect(result).toBeUndefined();
	});

	it('returns undefined when parsed array fails array element validation', () => {
		const schema = z.array(z.number());
		const result = safeJsonParse('["a","b"]', schema);
		expect(result).toBeUndefined();
	});

	it('returns undefined for deeply nested validation failure', () => {
		const schema = z.object({
			user: z.object({
				age: z.number().min(0).max(150)
			})
		});
		const result = safeJsonParse('{"user":{"age":200}}', schema);
		expect(result).toBeUndefined();
	});

	// === Edge cases ===

	it('handles boolean values correctly', () => {
		expect(safeJsonParse('true', z.boolean())).toBe(true);
		expect(safeJsonParse('false', z.boolean())).toBe(false);
	});

	it('handles null literal schema', () => {
		const result = safeJsonParse('null', z.null());
		expect(result).toBeNull();
	});

	it('handles union schemas with valid data', () => {
		const schema = z.union([z.string(), z.number()]);
		expect(safeJsonParse('"text"', schema)).toBe('text');
		expect(safeJsonParse('99', schema)).toBe(99);
	});

	it('returns undefined for union schemas with invalid data', () => {
		const schema = z.union([z.string(), z.number()]);
		const result = safeJsonParse('[1,2,3]', schema);
		expect(result).toBeUndefined();
	});

	it('does not throw on any input', () => {
		const inputs = [
			'',
			'not json',
			'{"a":}',
			'[1,2',
			'undefined',
			'{broken',
			'',
			'   ',
			'\n',
			'null',
			'function(){}'
		];
		for (const input of inputs) {
			expect(() => safeJsonParse(input, z.any())).not.toThrow();
		}
	});
});
