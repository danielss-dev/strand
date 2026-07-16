import { describe, expect, it } from 'vitest';

import { directoryEntries } from './directoryEntries';

describe('directoryEntries', () => {
  const files = [
    { path: 'src/lib/item10.ts', status: null },
    { path: 'src/lib/item2.ts', status: 'MODIFIED' as const },
    { path: 'src/app.ts', status: null },
    { path: 'src/assets/logo.svg', status: 'ADDED' as const },
    { path: 'README.md', status: null },
  ];

  it('returns immediate folders before files and aggregates descendants', () => {
    expect(directoryEntries(files, 'src')).toEqual([
      {
        kind: 'directory',
        name: 'assets',
        path: 'src/assets/',
        status: null,
        fileCount: 1,
        changedCount: 1,
      },
      {
        kind: 'directory',
        name: 'lib',
        path: 'src/lib/',
        status: null,
        fileCount: 2,
        changedCount: 1,
      },
      {
        kind: 'file',
        name: 'app.ts',
        path: 'src/app.ts',
        status: null,
        fileCount: 1,
        changedCount: 0,
      },
    ]);
  });

  it('supports the repository root and natural file ordering', () => {
    expect(directoryEntries(files, '').map((entry) => entry.name)).toEqual(['src', 'README.md']);
    expect(directoryEntries(files, 'src/lib').map((entry) => entry.name)).toEqual([
      'item2.ts',
      'item10.ts',
    ]);
  });
});
