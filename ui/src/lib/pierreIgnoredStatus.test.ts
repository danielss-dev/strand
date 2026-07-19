import { describe, expect, it } from 'vitest';

import {
  applyFileTreeGitStatusPatch,
  resolveFileTreeGitStatusState,
} from '../../node_modules/@pierre/trees/dist/model/gitStatus.js';

describe('Pierre ignored status patch', () => {
  it('mutes ignored directories without marking ancestors as changed', () => {
    const initial = resolveFileTreeGitStatusState([
      { path: '.claude/worktrees/', status: 'ignored' },
      { path: 'src/index.ts', status: 'modified' },
    ]);

    expect(initial?.ignoredDirectoryPaths).toContain('.claude/worktrees/');
    expect(initial?.directoriesWithChanges).not.toContain('.claude/');
    expect(initial?.directoriesWithChanges).toContain('src/');

    const modified = applyFileTreeGitStatusPatch(initial, {
      set: [{ path: '.claude/worktrees/', status: 'modified' }],
    });
    expect(modified?.directoriesWithChanges).toContain('.claude/');

    const ignoredAgain = applyFileTreeGitStatusPatch(modified, {
      set: [{ path: '.claude/worktrees/', status: 'ignored' }],
    });
    expect(ignoredAgain?.directoriesWithChanges).not.toContain('.claude/');

    const removed = applyFileTreeGitStatusPatch(ignoredAgain, {
      remove: ['.claude/worktrees/'],
    });
    expect(removed?.directoriesWithChanges).not.toContain('.claude/');
  });
});
