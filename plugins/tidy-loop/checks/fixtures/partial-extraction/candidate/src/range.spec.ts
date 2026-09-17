import { describe, expect, it } from 'vitest';

import { clamp } from './range';

describe('clamp (extracted)', () => {
  it('returns a value inside the range unchanged', () => {
    expect(clamp(5, { min: 0, max: 10 })).toBe(5);
  });

  it('pulls a value back to the nearest bound', () => {
    expect(clamp(11, { min: 0, max: 10 })).toBe(10);
  });
});
