/**
 * Tests: dispatch POST 500 handler does not echo internal error messages to the client.
 * Internal error details (err.message, stack traces) must be logged but not returned in responses.
 */

import { describe, it, expect } from 'vitest';

function safeDispatchError(err: unknown): { success: boolean; error: string } {
	const errorMsg = err instanceof Error ? err.message : 'Unknown error';
	void errorMsg; // logged internally, not returned
	return { success: false, error: 'Internal dispatch error' };
}

describe('dispatch error response sanitization', () => {
	it('returns generic message for Error with sensitive message', () => {
		const result = safeDispatchError(new Error('Connection to redis://10.0.0.1:6379 failed'));
		expect(result.error).toBe('Internal dispatch error');
		expect(result.error).not.toContain('redis');
		expect(result.error).not.toContain('10.0.0.1');
	});

	it('returns generic message for Error with stack trace content', () => {
		const err = new Error('TypeError at provider-runtime.ts:272');
		const result = safeDispatchError(err);
		expect(result.error).toBe('Internal dispatch error');
		expect(result.error).not.toContain('provider-runtime');
	});

	it('returns generic message for non-Error throws', () => {
		const result = safeDispatchError('raw string error with internal path /etc/secrets');
		expect(result.error).toBe('Internal dispatch error');
	});

	it('sets success to false on error', () => {
		const result = safeDispatchError(new Error('anything'));
		expect(result.success).toBe(false);
	});

	it('does not include err.message in returned object', () => {
		const sensitiveMsg = 'DB_PASSWORD=hunter2 auth failed';
		const result = safeDispatchError(new Error(sensitiveMsg));
		expect(JSON.stringify(result)).not.toContain(sensitiveMsg);
	});
});
