import { describe, expect, it } from 'vitest';

import type { FileDiff, FileStatus } from '../../../lib/types';
import type { RepositorySnapshot } from '../../capabilities';
import {
  buildAgentSessionRecap,
  classifyRiskyPath,
  diffStatusToRecap,
  extractTodosFromPatch,
  recapKindLabel,
  recapMissingPatchPaths,
  recapUnloadedPatchKey,
  RECAP_PATCH_SCAN_LIMIT,
  statusKindToRecap,
  unionDiffs,
  uniqueDiffs,
} from './recap';

const repo: RepositorySnapshot = {
  path: '/src/strand',
  name: 'strand',
  branch: 'agent/fix',
  head: 'abc1234',
  dirty: true,
};

function status(path: string, kind: FileStatus['kind'] = 'MODIFIED'): FileStatus {
  return { path, kind, staged: false };
}

function diff(path: string, patch: string, loaded = true): FileDiff {
  return {
    path,
    old_path: null,
    status: 'modified',
    adds: 1,
    dels: 0,
    binary: false,
    patch,
    patchLoaded: loaded,
    revision: path,
  };
}

describe('classifyRiskyPath', () => {
  it('flags env, keys, auth, and migrations without matching author/keyboard', () => {
    expect(classifyRiskyPath('.env')).toBe(true);
    expect(classifyRiskyPath('.env.local')).toBe(true);
    expect(classifyRiskyPath('deploy/id_ed25519')).toBe(true);
    expect(classifyRiskyPath('certs/prod.pem')).toBe(true);
    expect(classifyRiskyPath('src/auth/session.ts')).toBe(true);
    expect(classifyRiskyPath('db/migrations/001.sql')).toBe(true);
    expect(classifyRiskyPath('src/keyboard.ts')).toBe(false);
    expect(classifyRiskyPath('src/author.ts')).toBe(false);
    expect(classifyRiskyPath('package.json')).toBe(false);
  });
});

describe('extractTodosFromPatch', () => {
  it('reads added TODO markers and ignores deletions and file headers', () => {
    const patch = [
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,4 @@',
      '-// TODO: old leftover',
      '+function run() {',
      '+  // TODO: wire the broker',
      '+  // FIXME follow up',
      ' keep',
    ].join('\n');
    expect(extractTodosFromPatch('src/app.ts', patch)).toEqual([
      { path: 'src/app.ts', text: 'TODO: wire the broker' },
      { path: 'src/app.ts', text: 'FIXME: follow up' },
    ]);
  });
});

describe('buildAgentSessionRecap', () => {
  it('returns a no-repository state without crashing', () => {
    const recap = buildAgentSessionRecap({
      repo: null,
      linkedWorktree: false,
      baselineShort: null,
      status: [status('src/app.ts')],
      diffs: [],
    });
    expect(recap.state).toBe('no-repository');
    expect(recap.files).toEqual([]);
  });

  it('returns empty when the worktree has no files or diffs', () => {
    const recap = buildAgentSessionRecap({
      repo: { ...repo, dirty: false },
      linkedWorktree: true,
      baselineShort: 'ab12cd',
      status: [],
      diffs: [],
    });
    expect(recap.state).toBe('empty');
    expect(recap.linkedWorktree).toBe(true);
    expect(recap.baselineShort).toBe('ab12cd');
  });

  it('unions status and review diffs, flags risky paths, and scans loaded patches', () => {
    const recap = buildAgentSessionRecap({
      repo,
      linkedWorktree: true,
      baselineShort: 'ab12cd',
      status: [
        status('src/app.ts'),
        status('src/auth/login.ts', 'ADDED'),
        status('notes.md', 'UNTRACKED'),
      ],
      diffs: [
        diff('src/app.ts', '+// TODO: leftover\n keep'),
        diff('src/committed.ts', '', false),
        {
          ...diff('legacy.ts', '+const x = 1'),
          status: 'deleted',
        },
      ],
    });
    expect(recap.state).toBe('ready');
    expect(recap.files.map((file) => file.path)).toEqual([
      'legacy.ts',
      'notes.md',
      'src/app.ts',
      'src/auth/login.ts',
      'src/committed.ts',
    ]);
    expect(recap.risky.map((file) => file.path)).toEqual(['src/auth/login.ts']);
    expect(recap.todos).toEqual([{ path: 'src/app.ts', text: 'TODO: leftover' }]);
    expect(recap.patchesScanned).toBe(2);
  });

  it('keeps TODOs from a loaded local patch when a review summary shares the path', () => {
    const recap = buildAgentSessionRecap({
      repo,
      linkedWorktree: false,
      baselineShort: 'ab12cd',
      status: [status('src/app.ts')],
      diffs: uniqueDiffs(
        [diff('src/app.ts', '+// TODO: local leftover')],
        [diff('src/app.ts', '', false)],
      ),
    });
    expect(recap.todos).toEqual([{ path: 'src/app.ts', text: 'TODO: local leftover' }]);
    expect(recap.patchesScanned).toBe(1);
  });

  it('scans TODOs from both sides of a partial stage', () => {
    const recap = buildAgentSessionRecap({
      repo,
      linkedWorktree: false,
      baselineShort: null,
      status: [status('src/app.ts')],
      diffs: unionDiffs(
        [diff('src/app.ts', '+// TODO: unstaged side')],
        [diff('src/app.ts', '+// TODO: staged side')],
        [diff('src/app.ts', '', false)],
      ),
    });
    expect(recap.todos).toEqual([
      { path: 'src/app.ts', text: 'TODO: unstaged side' },
      { path: 'src/app.ts', text: 'TODO: staged side' },
    ]);
    expect(recap.patchesScanned).toBe(2);
  });
});

describe('uniqueDiffs', () => {
  it('prefers a loaded patch over a later review summary', () => {
    const loaded = diff('src/app.ts', '+// TODO: keep');
    const summary = diff('src/app.ts', '', false);
    expect(uniqueDiffs([loaded], [summary])).toEqual([loaded]);
    expect(uniqueDiffs([summary], [loaded])).toEqual([loaded]);
  });
});

describe('recapMissingPatchPaths', () => {
  it('requests review-only paths when local pools are empty', () => {
    expect(recapMissingPatchPaths([], [], [diff('committed.ts', '', false)])).toEqual({
      unstaged: [],
      staged: [],
      review: ['committed.ts'],
    });
  });

  it('does not drop the unloaded unstaged side of a partial stage', () => {
    expect(recapMissingPatchPaths(
      [diff('src/app.ts', '', false)],
      [diff('src/app.ts', '+already loaded', true)],
      [],
    )).toEqual({
      unstaged: ['src/app.ts'],
      staged: [],
      review: [],
    });
  });

  it('caps each pool at RECAP_PATCH_SCAN_LIMIT', () => {
    const review = Array.from({ length: RECAP_PATCH_SCAN_LIMIT + 4 }, (_, index) => (
      diff(`file-${index}.ts`, '', false)
    ));
    expect(recapMissingPatchPaths([], [], review).review).toHaveLength(RECAP_PATCH_SCAN_LIMIT);
  });
});

describe('recapUnloadedPatchKey', () => {
  it('changes when a loaded path becomes unloaded so the loader re-runs', () => {
    const loaded = recapUnloadedPatchKey([diff('src/app.ts', '+keep', true)], [], []);
    const unloaded = recapUnloadedPatchKey([diff('src/app.ts', '', false)], [], []);
    expect(loaded).toBe('');
    expect(unloaded).not.toBe(loaded);
    expect(unloaded).toContain('src/app.ts');
  });

  it('changes when a new unloaded path appears', () => {
    const before = recapUnloadedPatchKey([diff('a.ts', '', false)], [], []);
    const after = recapUnloadedPatchKey(
      [diff('a.ts', '', false), diff('b.ts', '', false)],
      [],
      [],
    );
    expect(before).not.toBe(after);
  });
});

describe('kind mapping', () => {
  it('maps every status and diff variant', () => {
    expect(statusKindToRecap('ADDED')).toBe('added');
    expect(statusKindToRecap('MODIFIED')).toBe('modified');
    expect(statusKindToRecap('DELETED')).toBe('deleted');
    expect(statusKindToRecap('RENAMED')).toBe('renamed');
    expect(statusKindToRecap('UNTRACKED')).toBe('untracked');
    expect(statusKindToRecap('CONFLICTED')).toBe('conflicted');
    expect(diffStatusToRecap('copied')).toBe('modified');
    expect(diffStatusToRecap('typechange')).toBe('modified');
    expect(recapKindLabel('conflicted')).toBe('conflicted');
  });
});
