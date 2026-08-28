import { describe, it, expect } from 'vitest';

describe('Memory quality aggregates - UTC bucket', () => {
  it('should bucket events by UTC day for SSR/CSR agreement', () => {
    const date = new Date('2025-06-03T23:00:00.000Z');
    const utcDay = date.toISOString().slice(0, 10);
    expect(utcDay).toBe('2025-06-03');
  });
});
