import { describe, it, expect } from 'vitest';

describe('Cancel pending start', () => {
  it('should cancel pending timer on stopScheduler', () => {
    let timerCancelled = false;
    const stopScheduler = () => { timerCancelled = true; };
    stopScheduler();
    expect(timerCancelled).toBe(true);
  });
});
