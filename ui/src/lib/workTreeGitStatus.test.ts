import { describe, expect, it } from 'vitest';

import type { WorkTreeEntry } from './types';
import { workTreeGitStatus } from './workTreeGitStatus';

describe('workTreeGitStatus', () => {
  it('collapses a fully ignored tree into one muted directory status', () => {
    const entries: WorkTreeEntry[] = [
      { path: 'node_modules/.bin/tool', status: null, ignored: true },
      { path: 'node_modules/.pnpm/package.json', status: null, ignored: true },
      { path: 'node_modules/@tauri-apps/cli/index.js', status: null, ignored: true },
      { path: 'src/index.ts', status: 'MODIFIED', ignored: false },
    ];

    expect(workTreeGitStatus(entries)).toEqual([
      { path: 'node_modules/', status: 'ignored' },
      { path: 'src/index.ts', status: 'modified' },
    ]);
  });

  it('keeps ignored files explicit when their parent also contains tracked files', () => {
    const entries: WorkTreeEntry[] = [
      { path: '.env', status: null, ignored: true },
      { path: 'src/generated/cache.bin', status: null, ignored: true },
      { path: 'src/index.ts', status: null, ignored: false },
    ];

    expect(workTreeGitStatus(entries)).toEqual([
      { path: 'src/generated/', status: 'ignored' },
      { path: '.env', status: 'ignored' },
    ]);
  });
});
