import { describe, expect, it } from 'vitest';

import { mean } from './stats';

describe('mean', () => {
  it('averages the values', () => {
    expect(mean([2, 4, 6], { min: 0, max: 10 })).toBe(4);
  });

  it('falls back to the lower bound on an empty list', () => {
    expect(mean([], { min: 1, max: 10 })).toBe(1);
  });
});
