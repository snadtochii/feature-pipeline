import { describe, expect, it } from 'vitest';

import { clamp } from './range';

describe('clamp', () => {
  it('clamps above the maximum', () => {
    expect(clamp(12, { min: 0, max: 10 })).toBe(10);
  });

  it('clamps below the minimum', () => {
    expect(clamp(-2, { min: 0, max: 10 })).toBe(0);
  });

  it('clamps below the minimum', () => {
    expect(clamp(-40, { min: -1, max: 10 })).toBe(-1);
  });
});
