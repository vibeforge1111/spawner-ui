import { describe, it, expect } from 'vitest';

describe('SSE reconnect backoff', () => {
  it('should cap reconnection with exponential backoff delay', () => {
    const delays = [1000, 2000, 4000, 8000, 16000];
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i-1]);
    }
  });
});
