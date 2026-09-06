import { describe, expect, it } from 'vitest';
import { positiveDepth } from './cloneOptions';

describe('positiveDepth', () => {
  it('accepts bounded whole numbers and rejects lossy or invalid input', () => {
    expect(positiveDepth('1')).toBe(1);
    expect(positiveDepth('4294967295')).toBe(4294967295);
    for (const value of ['', '0', '-1', '1.5', '2e3', '4294967296', 'NaN', '--all']) {
      expect(positiveDepth(value)).toBeNull();
    }
  });
});
