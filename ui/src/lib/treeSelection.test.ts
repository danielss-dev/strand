import { describe, expect, it } from 'vitest';

import {
  expandTreeSelection,
  resolveActiveTreeTargets,
  resolveTreeActionTargets,
} from './treeSelection';

const files = [
  'docs/guide.md',
  'src/app.ts',
  'src/lib/a.ts',
  'src/lib/b.ts',
  'standalone.ts',
];

describe('expandTreeSelection', () => {
  it('expands folders and keeps explicitly selected files', () => {
    expect(expandTreeSelection(files, ['src/lib/', 'standalone.ts'])).toEqual([
      'src/lib/a.ts',
      'src/lib/b.ts',
      'standalone.ts',
    ]);
  });

  it('deduplicates overlapping folder and file selections', () => {
    expect(expandTreeSelection(files, ['src/', 'src/lib/a.ts'])).toEqual([
      'src/app.ts',
      'src/lib/a.ts',
      'src/lib/b.ts',
    ]);
  });
});

describe('resolveTreeActionTargets', () => {
  it('acts on every selected folder and file when invoked inside the selection', () => {
    expect(
      resolveTreeActionTargets(files, ['src/lib/', 'standalone.ts'], 'standalone.ts'),
    ).toEqual(['src/lib/a.ts', 'src/lib/b.ts', 'standalone.ts']);
  });

  it('keeps an unselected context row scoped to that row', () => {
    expect(
      resolveTreeActionTargets(files, ['src/lib/', 'standalone.ts'], 'docs/'),
    ).toEqual(['docs/guide.md']);
  });
});

describe('resolveActiveTreeTargets', () => {
  it('expands an active folder when Pierre has not populated multi-selection', () => {
    expect(resolveActiveTreeTargets(files, [], 'src/')).toEqual([
      'src/app.ts',
      'src/lib/a.ts',
      'src/lib/b.ts',
    ]);
  });

  it('keeps a mixed expanded selection for view-level shortcuts', () => {
    expect(
      resolveActiveTreeTargets(
        files,
        ['src/lib/a.ts', 'src/lib/b.ts', 'standalone.ts'],
        'src/lib/',
      ),
    ).toEqual(['src/lib/a.ts', 'src/lib/b.ts', 'standalone.ts']);
  });

  it('falls back to the active row when the stored selection is stale', () => {
    expect(resolveActiveTreeTargets(files, ['docs/guide.md'], 'standalone.ts')).toEqual([
      'standalone.ts',
    ]);
  });
});
