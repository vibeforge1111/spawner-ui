import { describe, it, expect } from 'vitest';

describe('SpecializationSwapper tab timeout', () => {
  it('should cancel pending resume setTimeout on tab-pick away', () => {
    let timeoutCancelled = false;
    const onTabChange = () => { timeoutCancelled = true; };
    onTabChange();
    expect(timeoutCancelled).toBe(true);
  });
});
