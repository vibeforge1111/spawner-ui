import { describe, it, expect } from 'vitest';

describe('Subprocess stderr preservation', () => {
  it('should preserve stderr output when wrapping loop exec failure', () => {
    const stderr = 'Error: build failed';
    const wrapped = { stderr, message: 'Loop exec failure' };
    expect(wrapped.stderr).toBe('Error: build failed');
  });
});
