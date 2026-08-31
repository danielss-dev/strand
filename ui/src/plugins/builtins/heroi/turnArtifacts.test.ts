import { describe, expect, it } from 'vitest';

import {
  fileChangesFromActivities,
  groupFileChanges,
  relativizeRepoPath,
  toolCallSummary,
  type HeroiActivityLike,
} from './turnArtifacts';

function activity(
  partial: Partial<HeroiActivityLike> & Pick<HeroiActivityLike, 'id' | 'label'>,
): HeroiActivityLike {
  return {
    state: 'done',
    ...partial,
  };
}

describe('relativizeRepoPath', () => {
  it('strips the project root when the activity used an absolute path', () => {
    expect(relativizeRepoPath('/repo/src/App.tsx', '/repo')).toBe('src/App.tsx');
    expect(relativizeRepoPath('src/App.tsx', '/repo')).toBe('src/App.tsx');
  });
});

describe('fileChangesFromActivities', () => {
  it('reads Codex file_change payloads as added / changed / deleted', () => {
    const changes = fileChangesFromActivities([
      activity({
        id: 'fc-1',
        label: 'Editing files',
        detail: JSON.stringify({
          changes: [
            { path: 'docs/new.md', kind: 'add' },
            { path: 'src/App.tsx', kind: 'update' },
            { path: 'tmp/old.txt', kind: 'delete' },
          ],
        }),
      }),
    ], '/repo');
    expect(groupFileChanges(changes)).toEqual({
      added: ['docs/new.md'],
      changed: ['src/App.tsx'],
      deleted: ['tmp/old.txt'],
    });
  });

  it('reads Claude Write/Edit tool inputs and Cursor write envelopes', () => {
    const changes = fileChangesFromActivities([
      activity({
        id: 'w1',
        label: 'Using Write',
        detail: JSON.stringify({ file_path: 'ui/src/plugins/builtins/heroi/HeroiView.tsx', content: '...' }),
      }),
      activity({
        id: 'e1',
        label: 'Using Edit',
        detail: JSON.stringify({ file_path: 'ui/src/styles/features.css', old_string: 'a', new_string: 'b' }),
      }),
      activity({
        id: 'c1',
        label: 'Editing files',
        detail: JSON.stringify({
          writeToolCall: { args: { path: '/repo/scripts/delete_tenant.sql' } },
        }),
      }),
    ], '/repo');
    expect(groupFileChanges(changes)).toEqual({
      added: ['scripts/delete_tenant.sql', 'ui/src/plugins/builtins/heroi/HeroiView.tsx'],
      changed: ['ui/src/styles/features.css'],
      deleted: [],
    });
  });

  it('ignores Read/Glob/Bash payloads so the list stays mutation-only', () => {
    const changes = fileChangesFromActivities([
      activity({
        id: 'bash',
        label: 'Using Bash',
        detail: JSON.stringify({ command: 'pnpm test', description: 'run tests' }),
      }),
      activity({
        id: 'read',
        label: 'Using Read',
        detail: JSON.stringify({ file_path: 'README.md' }),
      }),
      activity({
        id: 'glob',
        label: 'Using Glob',
        detail: JSON.stringify({ glob_pattern: '**/*.ts' }),
      }),
    ]);
    expect(changes).toEqual([]);
  });
});

describe('toolCallSummary', () => {
  it('counts running and failed tool rows for the grouped control', () => {
    expect(toolCallSummary([
      activity({ id: '1', label: 'Using Bash', state: 'done' }),
      activity({ id: '2', label: 'Using Read', state: 'running' }),
      activity({ id: '3', label: 'Using Grep', state: 'error' }),
    ])).toEqual({ total: 3, running: 1, failed: 1 });
  });
});
