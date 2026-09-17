import { describe, expect, it } from 'vitest';

import { pad } from './format';

describe('pad', () => {
  it('pads to the requested width', () => {
    expect(pad('7', 3)).toBe('  7');
  });

  it('leaves a long enough string alone', () => {
    expect(pad('1234', 3)).toBe('1234');
  });
});
