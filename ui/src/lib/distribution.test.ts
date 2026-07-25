import { describe, expect, it } from 'vitest';

import { distributionChannel } from './distribution';

describe('distributionChannel', () => {
  it('recognizes the Microsoft Store MSIX build', () => {
    expect(distributionChannel('msix')).toBe('msix');
  });

  it('fails closed to the direct distribution channel', () => {
    expect(distributionChannel(undefined)).toBe('direct');
    expect(distributionChannel('unexpected')).toBe('direct');
  });
});
