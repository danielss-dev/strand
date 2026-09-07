import { describe, expect, it } from 'vitest';
import { compareBranchDefaults } from './compareBranchDefaults';

describe('compareBranchDefaults', () => {
  const defaults = {
    localNames: ['feature', 'master', 'main'],
    remoteNames: ['origin/feature'],
    currentBranch: 'feature',
    upstream: 'origin/feature',
  };

  it('prefers upstream and keeps current on the To side', () => {
    expect(compareBranchDefaults(defaults)).toEqual({ from: 'origin/feature', to: 'feature' });
  });

  it.each([null, 'origin/deleted', 'feature'])('prefers main when upstream is unusable (%s)', (upstream) => {
    expect(compareBranchDefaults({ ...defaults, upstream })).toEqual({ from: 'main', to: 'feature' });
  });

  it('falls back to master', () => {
    expect(compareBranchDefaults({ ...defaults, localNames: ['feature', 'master'], upstream: null }))
      .toEqual({ from: 'master', to: 'feature' });
  });

  it('never compares current with itself when current is main', () => {
    expect(compareBranchDefaults({ ...defaults, currentBranch: 'main', upstream: null }))
      .toEqual({ from: 'master', to: 'main' });
  });

  it('uses the first other branch while preserving current direction', () => {
    expect(compareBranchDefaults({ ...defaults, localNames: ['other', 'feature'], upstream: null }))
      .toEqual({ from: 'other', to: 'feature' });
  });

  it.each([null, 'missing'])('uses the first pair without an available current branch (%s)', (currentBranch) => {
    expect(compareBranchDefaults({ ...defaults, currentBranch }))
      .toEqual({ from: 'feature', to: 'master' });
  });

  it('supports remote-only branches while detached', () => {
    expect(compareBranchDefaults({ localNames: [], remoteNames: ['origin/a', 'origin/b'], currentBranch: null, upstream: null }))
      .toEqual({ from: 'origin/a', to: 'origin/b' });
  });

  it.each([[], ['main'], ['main', 'main']].map((localNames) => ({ localNames })))('requires two distinct available branches: $localNames', ({ localNames }) => {
    expect(compareBranchDefaults({ localNames, remoteNames: [], currentBranch: null, upstream: null })).toBeNull();
  });
});
