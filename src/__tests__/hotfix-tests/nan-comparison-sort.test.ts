import { describe, it, expect } from 'vitest';

describe('NaN comparison in sort', () => {
  it('should handle NaN values gracefully in comparison', () => {
    const values = [NaN, 3, 1, NaN, 2];
    const safeCompare = (a: number, b: number) => {
      if (isNaN(a) && isNaN(b)) return 0;
      if (isNaN(a)) return 1;
      if (isNaN(b)) return -1;
      return a - b;
    };
    const sorted = [...values].sort(safeCompare);
    expect(sorted).toEqual([1, 2, 3, NaN, NaN]);
  });
});
