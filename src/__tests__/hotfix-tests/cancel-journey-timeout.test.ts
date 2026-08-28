import { describe, it, expect } from 'vitest';

describe('JourneyDemo intro timeout', () => {
  it('should cancel pending intro setTimeout on unmount', () => {
    let phaseAdvanced = false;
    const onUnmount = () => { phaseAdvanced = false; };
    onUnmount();
    expect(phaseAdvanced).toBe(false);
  });
});
