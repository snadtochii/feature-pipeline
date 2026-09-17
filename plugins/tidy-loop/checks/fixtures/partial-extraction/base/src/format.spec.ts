import { describe, expect, it } from 'vitest';

import { pad } from './format';

describe('pad', () => {
  it('left-pads to the requested width', () => {
    expect(pad('7', 3)).toBe('  7');
  });

  it('leaves text at or over the width alone', () => {
    expect(pad('1234', 3)).toBe('1234');
  });
});
