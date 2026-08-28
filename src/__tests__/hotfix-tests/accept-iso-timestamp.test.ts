import { describe, it, expect } from 'vitest';

describe('SyncMessageSchema ISO timestamp', () => {
  it('should accept both Date and ISO-string timestamps', () => {
    const isoString = '2025-06-03T12:00:00.000Z';
    const dateObj = new Date(isoString);
    const parseTimestamp = (v: Date | string) => typeof v === 'string' ? new Date(v) : v;
    expect(parseTimestamp(isoString)).toEqual(dateObj);
    expect(parseTimestamp(dateObj)).toEqual(dateObj);
  });
});
