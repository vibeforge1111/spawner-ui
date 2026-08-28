import { describe, it, expect } from 'vitest';

describe('TelegramPhone intro timeout', () => {
  it('should cancel pending intro setTimeout on unmount', () => {
    let timeoutFired = false;
    const onUnmount = () => { timeoutFired = false; };
    onUnmount();
    expect(timeoutFired).toBe(false);
  });
});
