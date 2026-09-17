import { describe, expect, it } from 'vitest';

import { add } from './math';

describe('add', () => {
  it('sums two numbers', () => {
    expect(add(2, 3)).toBe(6);
  });
});
