import { describe, expect, it } from 'vitest';

import { add, clamp } from './math';

describe('clamp', () => {
  it('returns a value inside the range unchanged', () => {
    expect(clamp(5, { min: 0, max: 10 })).toBe(5);
  });

  it('pulls a value back to the nearest bound', () => {
    expect(clamp(-1, { min: 0, max: 10 })).toBe(0);
  });

  it('pulls a value back to the nearest bound', () => {
    expect(clamp(11, { min: 0, max: 10 })).toBe(10);
  });
});

describe('add', () => {
  it('sums two numbers', () => {
    expect(add(2, 3)).toBe(5);
  });
});
