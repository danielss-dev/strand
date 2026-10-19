import { describe, expect, it } from 'vitest';

import { t } from './i18n';

import {
  beginDrag,
  branchFromDataset,
  cherryPickGitArgs,
  commitDragFromRows,
  commitFromDataset,
  commitIndexByHash,
  commitZone,
  dragBlocksHistory,
  dragCursor,
  dragMergeArgs,
  dragRebaseArgs,
  finishDrag,
  hitFromDataset,
  MENU_MERGE_PREFIX,
  MENU_REBASE_PREFIX,
  moveDrag,
  pushGitArgs,
  resolveBranchDrop,
  rebaseSeedMessageKey,
  resolveCherryPick,
  resolveGitDrop,
  resolvePushDrop,
  resolveRebaseDrop,
  runAfterDropCheckout,
  linearTipHashes,
  upstreamBranchName,
  type BranchHit,
  type DragBranch,
} from './gitDrag';

const feature: DragBranch = {
  kind: 'local-branch',
  ref: 'feature',
  label: 'feature',
  isHead: false,
  upstreamRemote: null,
  upstreamBranch: null,
};
const mainHit: BranchHit = { kind: 'local-branch', ref: 'main', label: 'main', isHead: true };
const featureHit: BranchHit = { kind: 'local-branch', ref: 'feature', label: 'feature', isHead: false };
const originMain: BranchHit = { kind: 'remote-branch', ref: 'origin/main', label: 'origin/main', isHead: false };
const originFeature: DragBranch = {
  kind: 'remote-branch',
  ref: 'origin/feature',
  label: 'origin/feature',
  isHead: false,
  upstreamRemote: null,
  upstreamBranch: null,
};

describe('drop-target resolution', () => {
  it('reads branch rows and tag/remote hits from dataset attributes', () => {
    expect(branchFromDataset({
      gitSource: 'local-branch',
      gitRef: 'feature',
      gitLabel: 'feature',
      gitHead: '1',
      gitUpstreamRemote: 'origin',
      gitUpstreamBranch: 'feature',
    })).toEqual({
      kind: 'local-branch',
      ref: 'feature',
      label: 'feature',
      isHead: true,
      upstreamRemote: 'origin',
      upstreamBranch: 'feature',
    });
    expect(hitFromDataset({ gitDrop: 'tag', gitRef: 'refs/tags/v1', gitLabel: 'v1' })).toEqual({
      kind: 'tag',
      ref: 'refs/tags/v1',
      label: 'v1',
      isHead: false,
    });
    expect(branchFromDataset({ gitSource: 'commit' })).toBeNull();
    expect(hitFromDataset({})).toBeNull();
  });

  it('drops feature on main as merge-into-main and rebase-main-onto-feature', () => {
    const intent = resolveBranchDrop(feature, mainHit, null);
    expect(intent).toMatchObject({
      draggedRef: 'feature',
      droppedRef: 'main',
      checkout: null,
      mergeRef: 'feature',
      mergeInto: 'main',
      rebaseOnto: 'feature',
      rebaseBranch: 'main',
    });
    expect(dragMergeArgs(intent!)).toEqual([...MENU_MERGE_PREFIX, 'feature']);
    expect(dragRebaseArgs(intent!)).toEqual([...MENU_REBASE_PREFIX, 'feature']);
    expect(dragCursor(intent)).toBe('copy');
    expect(t('drag.git.branchBody', {
      dragged: intent!.draggedLabel,
      dropped: intent!.droppedLabel,
      mergeRef: intent!.mergeRef,
      mergeInto: intent!.mergeInto,
      rebaseBranch: intent!.rebaseBranch,
      rebaseOnto: intent!.rebaseOnto,
    })).toBe('Dropped feature on main. Merge feature into main, or rebase main onto feature.');
  });

  it('swaps the verbs when main is dropped on feature', () => {
    const main: DragBranch = { ...feature, ref: 'main', label: 'main', isHead: true };
    expect(resolveBranchDrop(main, featureHit, null)).toMatchObject({
      checkout: 'feature',
      mergeRef: 'main',
      mergeInto: 'feature',
      rebaseOnto: 'main',
      rebaseBranch: 'feature',
    });
  });

  it('merges a remote branch into the local target and rebases the target onto it', () => {
    expect(resolveBranchDrop(originFeature, mainHit, null)).toMatchObject({
      checkout: null,
      mergeRef: 'origin/feature',
      mergeInto: 'main',
      rebaseOnto: 'origin/feature',
      rebaseBranch: 'main',
    });
  });

  it('moves the local branch when it is dropped on a remote-tracking branch', () => {
    const headFeature: DragBranch = { ...feature, isHead: true };
    expect(resolveBranchDrop(headFeature, originMain, null)).toMatchObject({
      checkout: null,
      mergeRef: 'origin/main',
      mergeInto: 'feature',
      rebaseOnto: 'origin/main',
      rebaseBranch: 'feature',
    });
    const other: DragBranch = { ...feature, isHead: false };
    expect(resolveBranchDrop(other, originMain, null)?.checkout).toBe('feature');
  });

  it('rejects a branch dropped on itself, on a tag, on a remote, or onto another remote branch', () => {
    expect(resolveBranchDrop(feature, { ...featureHit }, null)).toBeNull();
    expect(resolveBranchDrop(feature, { kind: 'tag', ref: 'refs/tags/v1', label: 'v1', isHead: false }, null)).toBeNull();
    expect(resolveBranchDrop(feature, { kind: 'remote', ref: 'origin', label: 'origin', isHead: false }, null)).toBeNull();
    expect(resolveBranchDrop(originFeature, originMain, null)).toBeNull();
    expect(dragCursor(null)).toBe('no-drop');
  });

  it('rejects every drop while any Git operation is in progress', () => {
    expect(dragBlocksHistory(null)).toBe(false);
    for (const op of ['merge', 'rebase', 'cherry-pick', 'revert', 'mailbox', 'bisect'] as const) {
      expect(dragBlocksHistory(op)).toBe(true);
      expect(resolveBranchDrop(feature, mainHit, op)).toBeNull();
      expect(resolveGitDrop(feature, mainHit, op)).toBeNull();
    }
  });

  it('pushes a local branch onto a remote and offers to create a missing upstream', () => {
    const origin: BranchHit = { kind: 'remote', ref: 'origin', label: 'origin', isHead: false };
    const intent = resolvePushDrop(feature, origin, null);
    expect(intent).toEqual({
      kind: 'push',
      branch: 'feature',
      remote: 'origin',
      remoteBranch: 'feature',
      offerUpstream: true,
    });
    const menu = ['push', '--progress', '--set-upstream', '--', 'origin', 'refs/heads/feature:refs/heads/feature'];
    expect(pushGitArgs(intent!, true)).toEqual(menu);
    expect(resolveGitDrop(feature, origin, null)).toEqual(intent);
    expect(t('drag.git.pushBody', { branch: 'feature', remote: 'origin', destination: 'feature' }))
      .toBe('Push feature to origin/feature.');
    expect(t('drag.git.pushUpstream', { upstream: 'origin/feature', branch: 'feature' }))
      .toBe('Set origin/feature as the upstream for feature.');
  });

  it('keeps an existing upstream on that remote and does not prompt to create one', () => {
    const tracked: DragBranch = {
      ...feature,
      upstreamRemote: 'origin',
      upstreamBranch: 'feature',
    };
    expect(resolvePushDrop(tracked, { kind: 'remote', ref: 'origin', label: 'origin', isHead: false }, null))
      .toMatchObject({ remoteBranch: 'feature', offerUpstream: false });
    const elsewhere: DragBranch = { ...feature, upstreamRemote: 'other', upstreamBranch: 'feature' };
    expect(resolvePushDrop(elsewhere, { kind: 'remote', ref: 'origin', label: 'origin', isHead: false }, null))
      .toMatchObject({ remoteBranch: 'feature', offerUpstream: false });
  });

  it('does not push a remote-tracking branch or push while a rebase is paused', () => {
    const origin: BranchHit = { kind: 'remote', ref: 'origin', label: 'origin', isHead: false };
    expect(resolvePushDrop(originFeature, origin, null)).toBeNull();
    expect(resolveGitDrop(feature, origin, 'rebase')).toBeNull();
    expect(resolveGitDrop(feature, origin, 'merge')).toBeNull();
  });

  it('cherry-picks dragged commits onto a local branch, oldest first', () => {
    const older = { hash: 'aaa', short: 'aaa1111', parents: ['root'], index: 2, rewrite: true };
    const newer = { hash: 'bbb', short: 'bbb2222', parents: ['aaa'], index: 0, rewrite: true };
    const source = commitDragFromRows([newer, older]);
    expect(source?.commits.map((commit) => commit.hash)).toEqual(['aaa', 'bbb']);
    const intent = resolveCherryPick(source!, mainHit, null);
    expect(intent).toMatchObject({
      hashes: ['aaa', 'bbb'],
      label: 'aaa1111, bbb2222',
      branch: 'main',
      checkout: null,
      mainline: null,
      blockedMerge: null,
    });
    expect(cherryPickGitArgs(intent!.hashes)).toEqual(['cherry-pick', '--', 'aaa', 'bbb']);
    expect(t('drag.git.cherryBody', { commits: intent!.label, branch: 'main' }))
      .toBe('Cherry-pick aaa1111, bbb2222 onto main.');
    const other: BranchHit = { kind: 'local-branch', ref: 'feature', label: 'feature', isHead: false };
    expect(resolveCherryPick(source!, other, null)?.checkout).toBe('feature');
  });

  it('sends a single merge commit through the mainline dialog and blocks a mixed selection', () => {
    const merge = commitDragFromRows([{ hash: 'mmm', short: 'mmm3333', parents: ['a', 'b'], index: 0, rewrite: false }])!;
    expect(resolveCherryPick(merge, mainHit, null)?.mainline).toEqual({
      hash: 'mmm', short: 'mmm3333', parents: ['a', 'b'],
    });
    const mixed = commitDragFromRows([
      { hash: 'mmm', short: 'mmm3333', parents: ['a', 'b'], index: 1, rewrite: false },
      { hash: 'ccc', short: 'ccc4444', parents: ['mmm'], index: 0, rewrite: true },
    ])!;
    expect(resolveCherryPick(mixed, mainHit, null)?.blockedMerge).toBe('mmm3333');
    expect(resolveCherryPick(mixed, originMain, null)).toBeNull();
    expect(resolveCherryPick(mixed, mainHit, 'merge')).toBeNull();
  });

  it('reads commit rows and classifies squash versus reorder zones', () => {
    expect(commitFromDataset({
      gitSource: 'commit',
      gitHash: 'abc',
      gitShort: 'abc1234',
      gitParents: 'p1 p2',
      gitIndex: '4',
    })).toEqual({ hash: 'abc', short: 'abc1234', parents: ['p1', 'p2'], index: 4, rewrite: false });
    expect(commitZone(2, 28)).toBe('before');
    expect(commitZone(14, 28)).toBe('squash');
    expect(commitZone(26, 28)).toBe('after');
    expect(resolveGitDrop(
      commitDragFromRows([{ hash: 'abc', short: 'abc1234', parents: ['p'], index: 1, rewrite: true }])!,
      { kind: 'tag', ref: 'refs/tags/v1', label: 'v1', isHead: false },
      null,
    )).toBeNull();
  });

  it('opens a prefilled rebase when a linear-tip commit is reordered or squashed', () => {
    const older = { hash: 'bbb', short: 'bbb2222', parents: ['aaa'], index: 1, rewrite: true };
    const newer = { hash: 'ccc', short: 'ccc3333', parents: ['bbb'], index: 0, rewrite: true };
    const source = commitDragFromRows([newer])!;
    const ontoOlder = resolveRebaseDrop(source, { ...older, kind: 'commit', zone: 'after' }, null);
    expect(ontoOlder?.seed).toMatchObject({
      move: ['ccc'],
      mode: 'reorder',
      anchor: 'bbb',
      place: 'before',
      base: 'bbb^',
      baseLabel: 'bbb2222',
    });
    expect(t(rebaseSeedMessageKey(ontoOlder!.seed), {
      commits: ontoOlder!.seed.moveLabel,
      target: ontoOlder!.seed.anchorLabel,
    })).toBe('Move ccc3333 to be older than bbb2222. Review this rebase plan — nothing runs until you start it.');
    const squash = resolveRebaseDrop(source, { ...older, kind: 'commit', zone: 'squash' }, null);
    expect(squash?.seed.mode).toBe('squash');
    expect(squash?.seed.place).toBe('after');
    expect(t(rebaseSeedMessageKey(squash!.seed), {
      commits: squash!.seed.moveLabel,
      target: squash!.seed.anchorLabel,
    })).toBe('Squash ccc3333 into bbb2222. Review this rebase plan — nothing runs until you start it.');
  });

  it('rejects a no-op reorder, a drop on itself, an off-tip commit, and a paused rebase', () => {
    const older = { hash: 'bbb', short: 'bbb2222', parents: ['aaa'], index: 1, rewrite: true };
    const newer = { hash: 'ccc', short: 'ccc3333', parents: ['bbb'], index: 0, rewrite: true };
    const source = commitDragFromRows([newer])!;
    expect(resolveRebaseDrop(source, { ...older, kind: 'commit', zone: 'before' }, null)).toBeNull();
    expect(resolveRebaseDrop(source, { ...newer, kind: 'commit', zone: 'squash' }, null)).toBeNull();
    expect(resolveRebaseDrop(source, { ...older, kind: 'commit', zone: 'after', rewrite: false }, null)).toBeNull();
    expect(resolveRebaseDrop(commitDragFromRows([{ ...newer, rewrite: false }])!, {
      ...older, kind: 'commit', zone: 'after',
    }, null)).toBeNull();
    expect(resolveRebaseDrop(source, { ...older, kind: 'commit', zone: 'after' }, 'rebase')).toBeNull();
    expect(resolveRebaseDrop(source, { ...older, kind: 'commit', zone: 'squash' }, 'merge')).toBeNull();
    const commits = [
      { hash: 'mmm', parents: ['aaa', 'zzz'] },
      { hash: 'ccc', parents: ['mmm'] },
      { hash: 'bbb', parents: ['aaa'] },
      { hash: 'aaa', parents: [] },
    ];
    expect([...linearTipHashes(commits, 'ccc')]).toEqual(['ccc']);
    expect([...linearTipHashes(commits, 'bbb')]).toEqual(['bbb', 'aaa']);
  });

  it('orders a multi-selection by commit-list index, not graph row', () => {
    // Graph rows interleave stashes; row numbers would be c3=1, c2=3, c1=4
    // while the selection uses commit-list positions.
    const rows = [
      { hash: 's0', stash: { index: 0 } },
      { hash: 'c3' },
      { hash: 's1', stash: { index: 1 } },
      { hash: 'c2' },
      { hash: 'c1' },
    ];
    const commits = rows.filter((row) => !row.stash).map((row) => row.hash);
    const index = commitIndexByHash(rows);
    expect([...index]).toEqual(commits.map((hash, at) => [hash, at]));
    const row = (hash: string, parent: string) => (
      { hash, short: hash, parents: [parent], index: index.get(hash)!, rewrite: true }
    );
    const c3 = row('c3', 'c2');
    const c2 = row('c2', 'c1');
    const c1 = row('c1', 'c0');
    const intent = resolveRebaseDrop(commitDragFromRows([c3, c1])!, { ...c2, kind: 'commit', zone: 'squash' }, null);
    expect(intent?.seed.base).toBe('c1^');
    expect(intent?.seed.move).toEqual(['c1', 'c3']);
  });

  it('splits an upstream short name after the remote', () => {
    expect(upstreamBranchName({ name: 'origin/feature/auth', remote: 'origin' })).toBe('feature/auth');
    expect(upstreamBranchName({ name: 'feature', remote: 'origin' })).toBe('feature');
  });
});

describe('drag confirm gate', () => {
  it('Escape cancels an in-progress drag with no intent', () => {
    let session = beginDrag(feature, 0, 0);
    session = moveDrag(session, { x: 20, y: 0, intent: resolveBranchDrop(feature, mainHit, null) });
    expect(session.status).toBe('dragging');
    expect(finishDrag(session, false)).toBeNull();
  });

  it('a release before the threshold, or over a rejected target, confirms nothing', () => {
    const armed = beginDrag(feature, 10, 10);
    expect(moveDrag(armed, { x: 12, y: 10, intent: null }).status).toBe('armed');
    expect(finishDrag(armed, true)).toBeNull();
    const dragging = moveDrag(armed, { x: 40, y: 10, intent: null });
    expect(finishDrag(dragging, true)).toBeNull();
  });

  it('a release over a branch confirms that drop and nothing earlier', () => {
    const armed = beginDrag(feature, 0, 0);
    const dragging = moveDrag(armed, {
      x: 8,
      y: 0,
      intent: resolveBranchDrop(feature, mainHit, null),
    });
    const chosen = finishDrag(dragging, true);
    expect(chosen?.kind).toBe('branch');
    if (chosen?.kind === 'branch') expect(chosen.mergeRef).toBe('feature');
  });

  it('Escape cancels a reorder drag before the rebase editor opens', () => {
    const newer = { hash: 'ccc', short: 'ccc3333', parents: ['bbb'], index: 0, rewrite: true };
    const older = { hash: 'bbb', short: 'bbb2222', parents: ['aaa'], index: 1, rewrite: true };
    const intent = resolveRebaseDrop(
      commitDragFromRows([newer])!,
      { ...older, kind: 'commit', zone: 'after' },
      null,
    );
    let session = beginDrag(commitDragFromRows([newer])!, 0, 0);
    session = moveDrag(session, { x: 20, y: 0, intent });
    expect(finishDrag(session, false)).toBeNull();
    expect(finishDrag(session, true)?.kind).toBe('rebase');
  });
});

describe('drop checkout', () => {
  const idle = async () => null;

  it('runs the step on the current branch without a checkout', async () => {
    const calls: string[] = [];
    const result = await runAfterDropCheckout(null, 'main', async (name) => { calls.push(name); }, async () => 'ok', idle);
    expect(result).toBe('ok');
    expect(calls).toEqual([]);
  });

  it('keeps the target branch when the step succeeds or pauses', async () => {
    const calls: string[] = [];
    const paused = await runAfterDropCheckout(
      'feature', 'main', async (name) => { calls.push(name); }, async () => true, idle,
    );
    expect(paused).toBe(true);
    expect(calls).toEqual(['feature']);
  });

  it('switches back to the original branch when the step fails', async () => {
    const calls: string[] = [];
    await expect(runAfterDropCheckout('feature', 'main', async (name) => { calls.push(name); }, async () => {
      throw { message: 'boom' };
    }, idle)).rejects.toEqual({ message: t('drag.git.restored', { error: 'boom', branch: 'main' }) });
    expect(calls).toEqual(['feature', 'main']);
  });

  it('stays on the target branch when the failure left an operation in progress', async () => {
    for (const op of ['cherry-pick', 'merge', 'rebase', 'revert'] as const) {
      const calls: string[] = [];
      await expect(runAfterDropCheckout('feature', 'main', async (name) => { calls.push(name); }, async () => {
        throw { message: 'boom' };
      }, async () => op)).rejects.toEqual({ message: t('drag.git.pausedOn', { error: 'boom', branch: 'feature' }) });
      expect(calls).toEqual(['feature']);
    }
    expect(t('drag.git.pausedOn', { error: 'boom', branch: 'feature' })).toContain('paused on feature');
  });

  it('stays on the target branch when the operation state cannot be read', async () => {
    const calls: string[] = [];
    await expect(runAfterDropCheckout('feature', 'main', async (name) => { calls.push(name); }, async () => {
      throw new Error('boom');
    }, async () => { throw new Error('meta failed'); })).rejects.toEqual({
      message: t('drag.git.leftOn', { error: 'boom', branch: 'feature' }),
    });
    expect(calls).toEqual(['feature']);
  });

  it('says it left a detached start on the target branch', async () => {
    const calls: string[] = [];
    await expect(runAfterDropCheckout('feature', null, async (name) => { calls.push(name); }, async () => {
      throw new Error('boom');
    }, idle)).rejects.toEqual({ message: t('drag.git.leftOn', { error: 'boom', branch: 'feature' }) });
    expect(calls).toEqual(['feature']);
    expect(t('drag.git.leftOn', { error: 'boom', branch: 'feature' })).toBe('boom — left on feature.');
  });

  it('says so when switching back fails too', async () => {
    const checkout = async (name: string) => { if (name === 'main') throw new Error('locked'); };
    await expect(runAfterDropCheckout('feature', 'main', checkout, async () => {
      throw new Error('boom');
    }, idle)).rejects.toEqual({ message: t('drag.git.restoreFailed', { error: 'boom', branch: 'main' }) });
  });

  it('does not run the step when the checkout itself fails', async () => {
    let ran = false;
    await expect(runAfterDropCheckout('feature', 'main', async () => { throw new Error('dirty'); }, async () => {
      ran = true;
    }, idle)).rejects.toThrow('dirty');
    expect(ran).toBe(false);
  });
});
