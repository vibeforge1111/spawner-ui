import { describe, expect, it } from 'vitest';
import { extractTraceRef, normalizeTraceRef, traceRefFromMissionId } from './trace-ref';

describe('normalizeTraceRef', () => {
	it('accepts a sane trace ref of safe characters', () => {
		expect(normalizeTraceRef('trace:spawner-prd:mission-123')).toBe('trace:spawner-prd:mission-123');
		expect(normalizeTraceRef('trace.dotted/slashed_underscored-dashed:09')).toBe(
			'trace.dotted/slashed_underscored-dashed:09'
		);
	});

	it('trims surrounding whitespace before validating', () => {
		expect(normalizeTraceRef('   trace:abc   ')).toBe('trace:abc');
	});

	it('rejects non-string values', () => {
		expect(normalizeTraceRef(undefined)).toBeNull();
		expect(normalizeTraceRef(null)).toBeNull();
		expect(normalizeTraceRef(42)).toBeNull();
		expect(normalizeTraceRef({ traceRef: 'trace:abc' })).toBeNull();
	});

	it('rejects empty strings and oversize strings', () => {
		expect(normalizeTraceRef('')).toBeNull();
		expect(normalizeTraceRef('   ')).toBeNull();
		expect(normalizeTraceRef('x'.repeat(181))).toBeNull();
		expect(normalizeTraceRef('x'.repeat(180))).toBe('x'.repeat(180));
	});

	it('rejects strings carrying unsafe punctuation or whitespace', () => {
		expect(normalizeTraceRef('trace:has space')).toBeNull();
		expect(normalizeTraceRef('trace:has;semicolon')).toBeNull();
		expect(normalizeTraceRef('trace:has|pipe')).toBeNull();
		expect(normalizeTraceRef('trace:emoji-🤖')).toBeNull();
	});
});

describe('traceRefFromMissionId', () => {
	it('renders a deterministic trace ref for a mission id', () => {
		expect(traceRefFromMissionId('mission-1777456803045')).toBe(
			'trace:spawner-prd:mission-1777456803045'
		);
	});

	it('trims whitespace from the mission id before building the ref', () => {
		expect(traceRefFromMissionId('   mission-1   ')).toBe('trace:spawner-prd:mission-1');
	});

	it('returns null for missing or blank ids', () => {
		expect(traceRefFromMissionId(null)).toBeNull();
		expect(traceRefFromMissionId(undefined)).toBeNull();
		expect(traceRefFromMissionId('')).toBeNull();
		expect(traceRefFromMissionId('   ')).toBeNull();
	});
});

describe('extractTraceRef', () => {
	it('returns the first normalized trace ref it finds across the supplied sources', () => {
		expect(extractTraceRef({ traceRef: 'trace:a' })).toBe('trace:a');
		expect(extractTraceRef({ trace_ref: 'trace:b' })).toBe('trace:b');
		expect(extractTraceRef(null, { other: 1 }, { traceRef: 'trace:c' })).toBe('trace:c');
	});

	it('looks one level deep inside a relay payload', () => {
		expect(extractTraceRef({ relay: { traceRef: 'trace:relay-a' } })).toBe('trace:relay-a');
		expect(extractTraceRef({ relay: { trace_ref: 'trace:relay-b' } })).toBe('trace:relay-b');
	});

	it('returns null when no source carries a usable trace ref', () => {
		expect(extractTraceRef(null, undefined, { other: 'no-trace-here' }, { relay: {} })).toBeNull();
		expect(extractTraceRef()).toBeNull();
	});

	it('prefers traceRef over trace_ref on the same record', () => {
		expect(extractTraceRef({ traceRef: 'trace:winner', trace_ref: 'trace:loser' })).toBe(
			'trace:winner'
		);
	});

	it('rejects unsafe trace ref values during normalisation', () => {
		expect(extractTraceRef({ traceRef: 'trace:has space' })).toBeNull();
		expect(extractTraceRef({ relay: { traceRef: 'trace:has;semicolon' } })).toBeNull();
	});
});
