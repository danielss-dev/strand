import { describe, expect, it } from 'vitest';

import { plural } from './plural';

describe('plural', () => {
  it('uses the singular for one', () => {
    expect(plural(1, 'file')).toBe('1 file');
  });
  it('uses the plural for other counts', () => {
    expect(plural(0, 'file')).toBe('0 files');
    expect(plural(2, 'file')).toBe('2 files');
  });
  it('accepts an irregular plural', () => {
    expect(plural(2, 'entry', 'entries')).toBe('2 entries');
  });
});
