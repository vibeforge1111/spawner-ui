import { describe, it, expect, vi } from 'vitest';

function generateFeedbackId(): string {
	return `feedback_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`;
}

describe('feedback record ID generation', () => {
	it('matches feedback_<ts>_<hex9> format', () => {
		expect(generateFeedbackId()).toMatch(/^feedback_\d+_[0-9a-f]{9}$/);
	});
	it('produces 500 unique IDs', () => {
		expect(new Set(Array.from({ length: 500 }, generateFeedbackId)).size).toBe(500);
	});
	it('does not call Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		generateFeedbackId();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('prefix is feedback_', () => {
		expect(generateFeedbackId().startsWith('feedback_')).toBe(true);
	});
	it('suffix is 9 hex chars', () => {
		expect(generateFeedbackId().split('_').slice(-1)[0]).toMatch(/^[0-9a-f]{9}$/);
	});
});
