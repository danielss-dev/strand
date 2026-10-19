import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cherryPickGitArgs,
  commitDragFromRows,
  dragMergeArgs,
  dragRebaseArgs,
  pushGitArgs,
  resolveBranchDrop,
  resolveCherryPick,
  resolvePushDrop,
  resolveRebaseDrop,
  type BranchHit,
  type DragBranch,
} from '../src/lib/gitDrag';
import { applyRebaseSeed } from '../src/lib/rebase';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Drag',
  GIT_AUTHOR_EMAIL: 'drag@example.com',
  GIT_COMMITTER_NAME: 'Drag',
  GIT_COMMITTER_EMAIL: 'drag@example.com',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
};

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env }).trim();
}

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'strand-drag-'));
  roots.push(dir);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['commit', '--allow-empty', '-m', 'root']);
  git(dir, ['switch', '-c', 'feature']);
  git(dir, ['commit', '--allow-empty', '-m', 'feature change']);
  git(dir, ['switch', 'main']);
  git(dir, ['commit', '--allow-empty', '-m', 'main change']);
  return dir;
}

function signature(dir: string): string {
  return [
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['log', '--format=%s', '--topo-order']),
    git(dir, ['rev-parse', 'HEAD^{tree}']),
  ].join('\n');
}

const feature: DragBranch = {
  kind: 'local-branch',
  ref: 'feature',
  label: 'feature',
  isHead: false,
  upstreamRemote: null,
  upstreamBranch: null,
};
const mainBranch: DragBranch = { ...feature, ref: 'main', label: 'main', isHead: true };
const mainHit: BranchHit = { kind: 'local-branch', ref: 'main', label: 'main', isHead: true };
const featureHit: BranchHit = { kind: 'local-branch', ref: 'feature', label: 'feature', isHead: false };

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('drag branch actions match the menu git commands', () => {
  it('merging feature onto main matches Merge into main', () => {
    const intent = resolveBranchDrop(feature, mainHit, null);
    expect(intent?.checkout).toBeNull();
    const menu = ['merge', '--no-edit', '--', 'feature'];
    expect(dragMergeArgs(intent!)).toEqual(menu);

    const viaMenu = fixture();
    const viaDrag = fixture();
    git(viaMenu, menu);
    git(viaDrag, dragMergeArgs(intent!));
    expect(signature(viaDrag)).toBe(signature(viaMenu));
    expect(git(viaDrag, ['log', '-1', '--format=%s'])).toBe("Merge branch 'feature'");
  });

  it('rebasing feature onto main matches Rebase main onto this', () => {
    const intent = resolveBranchDrop(feature, mainHit, null);
    const menu = ['rebase', '--', 'feature'];
    expect(dragRebaseArgs(intent!)).toEqual(menu);

    const viaMenu = fixture();
    const viaDrag = fixture();
    git(viaMenu, menu);
    git(viaDrag, dragRebaseArgs(intent!));
    expect(signature(viaDrag)).toBe(signature(viaMenu));
    expect(git(viaDrag, ['log', '--format=%s'])).toBe('main change\nfeature change\nroot');
  });

  it('dropping main onto feature matches checkout then the feature menu', () => {
    const intent = resolveBranchDrop(mainBranch, featureHit, null);
    expect(intent).toMatchObject({ checkout: 'feature', mergeRef: 'main', rebaseOnto: 'main' });

    const mergeMenu = fixture();
    const mergeDrag = fixture();
    for (const dir of [mergeMenu, mergeDrag]) git(dir, ['switch', '--', 'feature']);
    git(mergeMenu, ['merge', '--no-edit', '--', 'main']);
    git(mergeDrag, dragMergeArgs(intent!));
    expect(signature(mergeDrag)).toBe(signature(mergeMenu));

    const rebaseMenu = fixture();
    const rebaseDrag = fixture();
    for (const dir of [rebaseMenu, rebaseDrag]) git(dir, ['switch', '--', 'feature']);
    git(rebaseMenu, ['rebase', '--', 'main']);
    git(rebaseDrag, dragRebaseArgs(intent!));
    expect(signature(rebaseDrag)).toBe(signature(rebaseMenu));
  });

  it('pushing feature onto origin sets the upstream the menu push would', () => {
    const intent = resolvePushDrop(feature, { kind: 'remote', ref: 'origin', label: 'origin', isHead: false }, null);
    expect(intent).toMatchObject({ branch: 'feature', remote: 'origin', remoteBranch: 'feature', offerUpstream: true });
    const menu = ['push', '--progress', '--set-upstream', '--', 'origin', 'refs/heads/feature:refs/heads/feature'];
    expect(pushGitArgs(intent!, true)).toEqual(menu);

    const viaMenu = pushFixture();
    const viaDrag = pushFixture();
    git(viaMenu.local, menu);
    git(viaDrag.local, pushGitArgs(intent!, true));
    expect(pushed(viaDrag.local)).toBe(pushed(viaMenu.local));
    expect(git(viaDrag.local, ['rev-parse', 'feature'])).toBe(git(viaDrag.local, ['rev-parse', 'refs/remotes/origin/feature']));
    expect(git(viaDrag.local, ['config', '--get', 'branch.feature.remote'])).toBe('origin');
    expect(git(viaDrag.local, ['config', '--get', 'branch.feature.merge'])).toBe('refs/heads/feature');
  });

  it('cherry-picking onto main matches the graph menu command', () => {
    const sample = fileFeature();
    const hash = git(sample, ['rev-parse', 'feature']);
    const source = commitDragFromRows([{ hash, short: hash.slice(0, 7), parents: [], index: 0, rewrite: true }]);
    const intent = resolveCherryPick(source!, mainHit, null);
    expect(cherryPickGitArgs(intent!.hashes)).toEqual(['cherry-pick', '--', hash]);

    const viaMenu = fileFeature();
    const viaDrag = fileFeature();
    git(viaMenu, ['cherry-pick', '--', git(viaMenu, ['rev-parse', 'feature'])]);
    git(viaDrag, cherryPickGitArgs([git(viaDrag, ['rev-parse', 'feature'])]));
    expect(git(viaDrag, ['log', '--format=%s'])).toBe(git(viaMenu, ['log', '--format=%s']));
    expect(git(viaDrag, ['rev-parse', 'HEAD^{tree}'])).toBe(git(viaMenu, ['rev-parse', 'HEAD^{tree}']));
    expect(git(viaDrag, ['log', '-1', '--format=%s'])).toBe('add note');
  });

  it('reordering onto an older commit matches a hand-edited rebase todo', () => {
    const viaDrag = linearFixture();
    const viaMenu = linearFixture();
    const drag = rebasePlan(viaDrag, 'reorder');
    const menu = handPlan(viaMenu, 'reorder');
    expect(drag.steps.map((step) => step.action)).toEqual(menu.steps.map((step) => step.action));
    runRebase(viaDrag, drag.base, drag.steps);
    runRebase(viaMenu, menu.base, menu.steps);
    expect(git(viaDrag, ['log', '--format=%s'])).toBe(git(viaMenu, ['log', '--format=%s']));
    expect(git(viaDrag, ['log', '--format=%s'])).toBe('B\nC\nA');
  });

  it('squashing into a commit matches a hand-edited rebase todo and does not run before the plan exists', () => {
    const sample = linearFixture();
    const intent = rebaseIntent(sample, 'squash');
    expect(intent.seed.mode).toBe('squash');
    expect(intent.seed.place).toBe('after');

    const viaDrag = linearFixture();
    const viaMenu = linearFixture();
    const drag = rebasePlan(viaDrag, 'squash');
    const menu = handPlan(viaMenu, 'squash');
    expect(drag.steps.map((step) => step.action)).toEqual(['pick', 'squash']);
    expect(drag.steps.map((step) => step.action)).toEqual(menu.steps.map((step) => step.action));
    runRebase(viaDrag, drag.base, drag.steps);
    runRebase(viaMenu, menu.base, menu.steps);
    expect(git(viaDrag, ['log', '--format=%s'])).toBe(git(viaMenu, ['log', '--format=%s']));
    expect(git(viaDrag, ['log', '--format=%s'])).toBe('B\nA');
    expect(git(viaDrag, ['show', 'HEAD:c.txt'])).toBe('C');
  });
});

function fileFeature(): string {
  const dir = fixture();
  git(dir, ['switch', 'feature']);
  writeFileSync(join(dir, 'note.txt'), 'from feature\n');
  git(dir, ['add', 'note.txt']);
  git(dir, ['commit', '-m', 'add note']);
  git(dir, ['switch', 'main']);
  return dir;
}

function pushFixture(): { local: string } {
  const root = mkdtempSync(join(tmpdir(), 'strand-drag-push-'));
  roots.push(root);
  const remote = join(root, 'origin.git');
  const local = join(root, 'local');
  mkdirSync(local, { recursive: true });
  git(root, ['init', '--bare', '-b', 'main', remote]);
  git(local, ['init', '-b', 'main']);
  git(local, ['commit', '--allow-empty', '-m', 'root']);
  git(local, ['remote', 'add', 'origin', remote]);
  git(local, ['push', '--set-upstream', 'origin', 'HEAD']);
  git(local, ['switch', '-c', 'feature']);
  git(local, ['commit', '--allow-empty', '-m', 'feature change']);
  return { local };
}

function linearFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'strand-drag-line-'));
  roots.push(dir);
  git(dir, ['init', '-b', 'main']);
  for (const name of ['A', 'B', 'C'] as const) {
    writeFileSync(join(dir, `${name.toLowerCase()}.txt`), `${name}\n`);
    git(dir, ['add', `${name.toLowerCase()}.txt`]);
    git(dir, ['commit', '-m', name]);
  }
  return dir;
}

function tip(dir: string): { a: string; b: string; c: string } {
  return {
    c: git(dir, ['rev-parse', 'HEAD']),
    b: git(dir, ['rev-parse', 'HEAD~1']),
    a: git(dir, ['rev-parse', 'HEAD~2']),
  };
}

function rebaseIntent(dir: string, mode: 'reorder' | 'squash') {
  const { a, b, c } = tip(dir);
  const intent = resolveRebaseDrop(
    commitDragFromRows([{ hash: c, short: 'ccc3333', parents: [b], index: 0, rewrite: true }])!,
    {
      kind: 'commit',
      hash: b,
      short: 'bbb2222',
      parents: [a],
      index: 1,
      zone: mode === 'squash' ? 'squash' : 'after',
      rewrite: true,
    },
    null,
  );
  if (!intent?.seed.base) throw new Error('expected a rebase base');
  return intent;
}

function rebasePlan(dir: string, mode: 'reorder' | 'squash') {
  const intent = rebaseIntent(dir, mode);
  const entries = git(dir, ['log', '--reverse', '--format=%H', `${intent.seed.base}..HEAD`])
    .split('\n')
    .filter(Boolean)
    .map((oid) => ({ oid }));
  const steps = applyRebaseSeed(entries, intent.seed);
  if (!steps) throw new Error('seed did not apply');
  return { base: intent.seed.base!, steps };
}

function handPlan(dir: string, mode: 'reorder' | 'squash') {
  const { b, c } = tip(dir);
  return {
    base: `${b}^`,
    steps: mode === 'squash'
      ? [{ oid: b, action: 'pick' as const }, { oid: c, action: 'squash' as const }]
      : [{ oid: c, action: 'pick' as const }, { oid: b, action: 'pick' as const }],
  };
}

function runRebase(dir: string, base: string, steps: { oid: string; action: string }[]) {
  const editor = join(dir, 'seq.mjs');
  writeFileSync(
    editor,
    `import { writeFileSync } from 'node:fs';\nconst steps = ${JSON.stringify(steps)};\nwriteFileSync(process.argv[2], steps.map((step) => step.action + ' ' + step.oid).join('\\n') + '\\n');\n`,
  );
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'rebase', '-i', '--', base], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, GIT_SEQUENCE_EDITOR: `node ${editor}` },
  });
}

function pushed(local: string): string {
  return [
    git(local, ['rev-parse', 'feature']),
    git(local, ['rev-parse', 'refs/remotes/origin/feature']),
    git(local, ['config', '--get', 'branch.feature.remote']),
    git(local, ['config', '--get', 'branch.feature.merge']),
  ].join('\n');
}
