import { describe, expect, it } from 'vitest';
import { toPierreLayout } from './diffLayout';

describe('toPierreLayout', () => {
  it('maps stacked to unified and split to split', () => {
    expect(toPierreLayout('stacked')).toBe('unified');
    expect(toPierreLayout('split')).toBe('split');
  });
});
