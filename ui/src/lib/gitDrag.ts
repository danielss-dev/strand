/**
 * Drop-target resolution for sidebar / graph Git drags.
 *
 * A branch dropped on a local branch uses the dragged branch's context-menu
 * verbs: merge the dragged ref into the target, or rebase the target onto the
 * dragged ref. A local branch dropped on a remote-tracking branch moves the
 * local branch instead (merge the remote ref in, or rebase onto it) — a
 * remote-tracking branch cannot be checked out. Nothing here runs Git; the
 * confirm dialog does, through the same `merge` / `rebase` commands as the menus.
 */

import { t } from './i18n';

export const DRAG_THRESHOLD_PX = 5;

/** `Repo::merge(ref, Auto)` — `git merge --no-edit -- <ref>`. */
export const MENU_MERGE_PREFIX = ['merge', '--no-edit', '--'] as const;
/** `Repo::rebase(onto)` — `git rebase -- <onto>`. */
export const MENU_REBASE_PREFIX = ['rebase', '--'] as const;

export type HistoryOperation =
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'merge'
  | 'mailbox'
  | 'bisect'
  | null;

export interface DragBranch {
  kind: 'local-branch' | 'remote-branch';
  ref: string;
  label: string;
  isHead: boolean;
  upstreamRemote: string | null;
  upstreamBranch: string | null;
}

export interface BranchHit {
  kind: 'local-branch' | 'remote-branch' | 'remote' | 'tag';
  ref: string;
  label: string;
  isHead: boolean;
}

/** Local branch dropped on a remote. `offerUpstream` is the "create upstream" prompt. */
export interface PushIntent {
  kind: 'push';
  branch: string;
  remote: string;
  remoteBranch: string;
  offerUpstream: boolean;
}

export interface DragCommit {
  hash: string;
  short: string;
  parents: string[];
  /** Graph row index, newest first. Higher means older. */
  index: number;
  /** On the linear first-parent tip, so a reorder/squash can rewrite it. */
  rewrite: boolean;
}

export interface CommitDrag {
  kind: 'commits';
  commits: DragCommit[];
}

export type DragSource = DragBranch | CommitDrag;

export interface CommitHit {
  kind: 'commit';
  hash: string;
  short: string;
  parents: string[];
  index: number;
  zone: 'before' | 'after' | 'squash';
  rewrite: boolean;
}

/** Plan handed to the interactive rebase editor. Nothing here runs Git. */
export interface RebaseSeed {
  move: string[];
  mode: 'reorder' | 'squash';
  anchor: string;
  /** Where `move` sits relative to `anchor` in the oldest-first todo. */
  place: 'before' | 'after';
  moveLabel: string;
  anchorLabel: string;
  /** Parent rev of the oldest involved commit, or null when that commit is a root. */
  base: string | null;
  baseLabel: string;
}

export interface RebaseIntent {
  kind: 'rebase';
  seed: RebaseSeed;
}

export type DropHit = BranchHit | CommitHit;

/** Commits dropped on a local branch. Hashes are oldest-first, matching the graph menu. */
export interface CherryPickIntent {
  kind: 'cherry-pick';
  hashes: string[];
  label: string;
  branch: string;
  checkout: string | null;
  /** One merge commit: the existing mainline dialog picks the parent. */
  mainline: { hash: string; short: string; parents: string[] } | null;
  /** Short hash when a multi-selection includes a merge and must not run. */
  blockedMerge: string | null;
}

export type DropIntent = BranchIntent | PushIntent | CherryPickIntent | RebaseIntent;

/** Confirmed branch drop. `checkout` runs only after the user picks Merge or Rebase. */
export interface BranchIntent {
  kind: 'branch';
  draggedRef: string;
  draggedLabel: string;
  droppedRef: string;
  droppedLabel: string;
  /** Local branch to check out before the verb. Null when it is already HEAD. */
  checkout: string | null;
  /** `git merge --no-edit -- <mergeRef>` into `mergeInto`. */
  mergeRef: string;
  mergeInto: string;
  /** `git rebase -- <rebaseOnto>` while `rebaseBranch` is checked out. */
  rebaseOnto: string;
  rebaseBranch: string;
}

export type DragSession =
  | { status: 'idle' }
  | { status: 'armed'; x: number; y: number; source: DragSource }
  | { status: 'dragging'; source: DragSource; intent: DropIntent | null };

export function upstreamBranchName(upstream: { name: string; remote: string }): string {
  const prefix = `${upstream.remote}/`;
  return upstream.name.startsWith(prefix) ? upstream.name.slice(prefix.length) : upstream.name;
}

/** Any paused merge, rebase, cherry-pick, revert, am or bisect blocks every drop. */
export function dragBlocksHistory(operation: HistoryOperation): boolean {
  return operation !== null;
}

/**
 * Run a drop's Git step on `branch`, checking it out first when set. If the
 * step fails after that checkout, re-read the repo's operation: when one is
 * in progress the failure left it paused on `branch`, so stay there for
 * Continue/Abort, and when that can't be read, stay too; otherwise switch
 * back to `original` (best effort). Either
 * way, say so in the error. A conflict pause is a result, not a failure, so
 * it stays on `branch`.
 */
export async function runAfterDropCheckout<T>(
  branch: string | null,
  original: string | null,
  checkout: (name: string) => Promise<unknown>,
  step: () => Promise<T>,
  readOperation: () => Promise<HistoryOperation>,
): Promise<T> {
  if (!branch) return step();
  await checkout(branch);
  try {
    return await step();
  } catch (caught) {
    const message = caught && typeof caught === 'object' && 'message' in caught
      ? String((caught as { message: unknown }).message)
      : String(caught);
    let operation: HistoryOperation;
    try {
      operation = await readOperation();
    } catch {
      // Unknown state: switching branches could carry a paused operation along.
      throw { message: t('drag.git.leftOn', { error: message, branch }) };
    }
    if (operation !== null) throw { message: t('drag.git.pausedOn', { error: message, branch }) };
    if (!original) throw { message: t('drag.git.leftOn', { error: message, branch }) };
    if (original === branch) throw { message };
    try {
      await checkout(original);
    } catch {
      throw { message: t('drag.git.restoreFailed', { error: message, branch: original }) };
    }
    throw { message: t('drag.git.restored', { error: message, branch: original }) };
  }
}

export function branchFromDataset(dataset: Record<string, string | undefined>): DragBranch | null {
  const kind = dataset.gitSource;
  if (kind !== 'local-branch' && kind !== 'remote-branch') return null;
  const ref = dataset.gitRef;
  const label = dataset.gitLabel;
  if (!ref || !label) return null;
  return {
    kind,
    ref,
    label,
    isHead: dataset.gitHead === '1',
    upstreamRemote: dataset.gitUpstreamRemote ?? null,
    upstreamBranch: dataset.gitUpstreamBranch ?? null,
  };
}

export function hitFromDataset(dataset: Record<string, string | undefined>): BranchHit | null {
  const kind = dataset.gitDrop;
  if (kind !== 'local-branch' && kind !== 'remote-branch' && kind !== 'remote' && kind !== 'tag') return null;
  const ref = dataset.gitRef;
  const label = dataset.gitLabel;
  if (!ref || !label) return null;
  return { kind, ref, label, isHead: dataset.gitHead === '1' };
}

export function resolveBranchDrop(
  source: DragBranch,
  hit: BranchHit | null,
  operation: HistoryOperation,
): BranchIntent | null {
  if (dragBlocksHistory(operation) || !hit) return null;
  if (hit.kind === 'tag' || hit.kind === 'remote') return null;
  if (source.ref === hit.ref) return null;

  if (hit.kind === 'local-branch') {
    return {
      kind: 'branch',
      draggedRef: source.ref,
      draggedLabel: source.label,
      droppedRef: hit.ref,
      droppedLabel: hit.label,
      checkout: hit.isHead ? null : hit.ref,
      mergeRef: source.ref,
      mergeInto: hit.label,
      rebaseOnto: source.ref,
      rebaseBranch: hit.label,
    };
  }

  if (source.kind === 'local-branch') {
    return {
      kind: 'branch',
      draggedRef: source.ref,
      draggedLabel: source.label,
      droppedRef: hit.ref,
      droppedLabel: hit.label,
      checkout: source.isHead ? null : source.ref,
      mergeRef: hit.ref,
      mergeInto: source.label,
      rebaseOnto: hit.ref,
      rebaseBranch: source.label,
    };
  }

  return null;
}

/** Drop a local branch on a remote folder. Remote-tracking rows stay merge/rebase targets. */
export function resolvePushDrop(
  source: DragBranch,
  hit: BranchHit | null,
  operation: HistoryOperation,
): PushIntent | null {
  if (dragBlocksHistory(operation) || !hit) return null;
  if (source.kind !== 'local-branch' || hit.kind !== 'remote') return null;
  const trackedHere = source.upstreamRemote === hit.ref && source.upstreamBranch != null;
  return {
    kind: 'push',
    branch: source.ref,
    remote: hit.ref,
    remoteBranch: trackedHere ? source.upstreamBranch! : source.ref,
    offerUpstream: source.upstreamRemote == null,
  };
}

export function commitZone(offsetY: number, height: number): 'before' | 'after' | 'squash' {
  const edge = Math.min(8, Math.max(height, 0) * 0.25);
  if (offsetY <= edge) return 'before';
  if (offsetY >= height - edge) return 'after';
  return 'squash';
}

export function commitFromDataset(dataset: Record<string, string | undefined>): DragCommit | null {
  if (dataset.gitSource !== 'commit' && dataset.gitDrop !== 'commit') return null;
  const hash = dataset.gitHash;
  const short = dataset.gitShort;
  if (!hash || !short) return null;
  const index = Number(dataset.gitIndex);
  return {
    hash,
    short,
    parents: dataset.gitParents ? dataset.gitParents.split(' ').filter(Boolean) : [],
    index: Number.isFinite(index) ? index : 0,
    rewrite: dataset.gitRewrite === '1',
  };
}

/** Commits on the linear first-parent suffix of `tip`. A merge stops the walk. */
export function linearTipHashes(
  commits: readonly { hash: string; parents: string[] }[],
  tip: string | null,
): Set<string> {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const out = new Set<string>();
  let hash = tip;
  let guard = 0;
  while (hash && guard++ <= commits.length) {
    const commit = byHash.get(hash);
    if (!commit || out.has(hash) || commit.parents.length > 1) break;
    out.add(hash);
    hash = commit.parents[0];
  }
  return out;
}

/**
 * Drag index per commit hash, counting graph rows but skipping stash rows, so
 * it matches the position in the commit list. Rows and multi-selections must
 * compare on this, never on the graph row number.
 */
export function commitIndexByHash(rows: readonly { hash: string; stash?: unknown }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (!row.stash) out.set(row.hash, out.size);
  }
  return out;
}

/** Oldest-first, matching `selectedCommitsOldestFirst`. A selected row drags the whole selection. */
export function commitDragFromRows(rows: DragCommit[]): CommitDrag | null {
  if (rows.length === 0) return null;
  const commits = [...rows].sort((a, b) => b.index - a.index);
  return { kind: 'commits', commits };
}

export function resolveCherryPick(
  source: CommitDrag,
  hit: DropHit | null,
  operation: HistoryOperation,
): CherryPickIntent | null {
  if (dragBlocksHistory(operation) || !hit || hit.kind !== 'local-branch' || source.commits.length === 0) return null;
  const merges = source.commits.filter((commit) => commit.parents.length > 1);
  const only = source.commits.length === 1 ? source.commits[0] : null;
  return {
    kind: 'cherry-pick',
    hashes: source.commits.map((commit) => commit.hash),
    label: source.commits.map((commit) => commit.short).join(', '),
    branch: hit.ref,
    checkout: hit.isHead ? null : hit.ref,
    mainline: only && only.parents.length > 1
      ? { hash: only.hash, short: only.short, parents: only.parents }
      : null,
    blockedMerge: source.commits.length > 1 && merges.length > 0 ? merges[0].short : null,
  };
}

/** `Repo::cherry_pick` without a mainline: `git cherry-pick -- <oid…>`. */
export function cherryPickGitArgs(hashes: string[]): string[] {
  return ['cherry-pick', '--', ...hashes];
}

/**
 * Drop commits on another commit of the current linear tip. The top edge places
 * them newer than the target, the bottom edge older, and the middle squashes
 * them into it. A no-op reorder, a drop on itself, or a commit off that tip
 * resolves to null so the cursor stays no-drop.
 */
export function resolveRebaseDrop(
  source: CommitDrag,
  hit: CommitHit | null,
  operation: HistoryOperation,
): RebaseIntent | null {
  if (dragBlocksHistory(operation) || !hit || source.commits.length === 0) return null;
  if (!hit.rewrite || source.commits.some((commit) => !commit.rewrite)) return null;
  if (source.commits.some((commit) => commit.hash === hit.hash)) return null;
  const ordered = [...source.commits].sort((a, b) => b.index - a.index);
  const mode = hit.zone === 'squash' ? 'squash' : 'reorder';
  const place = hit.zone === 'after' ? 'before' : 'after';
  const involved = [...ordered, hit];
  const oldest = involved.reduce((a, b) => (a.index >= b.index ? a : b));
  const seed: RebaseSeed = {
    move: ordered.map((commit) => commit.hash),
    mode,
    anchor: hit.hash,
    place,
    moveLabel: ordered.length === 1 ? ordered[0].short : ordered.map((commit) => commit.short).join(', '),
    anchorLabel: hit.short,
    base: oldest.parents.length > 0 ? `${oldest.hash}^` : null,
    baseLabel: oldest.short,
  };
  if (mode === 'reorder' && rebaseOrderIsUnchanged(ordered, hit, place)) return null;
  return { kind: 'rebase', seed };
}

function rebaseOrderIsUnchanged(
  ordered: readonly DragCommit[],
  hit: CommitHit,
  place: 'before' | 'after',
): boolean {
  const current = [...ordered, hit].sort((a, b) => b.index - a.index).map((commit) => commit.hash);
  const moving = new Set(ordered.map((commit) => commit.hash));
  const rest = current.filter((hash) => !moving.has(hash));
  const anchorAt = rest.indexOf(hit.hash);
  const insertAt = place === 'before' ? anchorAt : anchorAt + 1;
  const desired = [...rest.slice(0, insertAt), ...ordered.map((commit) => commit.hash), ...rest.slice(insertAt)];
  return desired.join('\0') === current.join('\0');
}

export function resolveGitDrop(
  source: DragSource,
  hit: DropHit | null,
  operation: HistoryOperation,
): DropIntent | null {
  if (source.kind === 'commits') {
    if (hit?.kind === 'commit') return resolveRebaseDrop(source, hit, operation);
    return resolveCherryPick(source, hit, operation);
  }
  const branchHit = hit && hit.kind !== 'commit' ? hit : null;
  return resolveBranchDrop(source, branchHit, operation) ?? resolvePushDrop(source, branchHit, operation);
}

export function rebaseSeedMessageKey(seed: RebaseSeed):
  | 'drag.git.rebaseSeedNewer'
  | 'drag.git.rebaseSeedOlder'
  | 'drag.git.rebaseSeedSquash' {
  if (seed.mode === 'squash') return 'drag.git.rebaseSeedSquash';
  return seed.place === 'before' ? 'drag.git.rebaseSeedOlder' : 'drag.git.rebaseSeedNewer';
}

export function sourceLabel(source: DragSource): string {
  if (source.kind !== 'commits') return source.label;
  return source.commits.length === 1 ? source.commits[0].short : String(source.commits.length);
}

/** `Repo::push_branch` for a normal push: `git push --progress [--set-upstream] -- <remote> <refspec>`. */
export function pushGitArgs(intent: PushIntent, setUpstream: boolean): string[] {
  const args = ['push', '--progress'];
  if (setUpstream) args.push('--set-upstream');
  args.push('--', intent.remote, `refs/heads/${intent.branch}:refs/heads/${intent.remoteBranch}`);
  return args;
}

export function dragGhost(intent: DropIntent): { source: string; target: string } {
  switch (intent.kind) {
    case 'branch':
      return { source: intent.draggedLabel, target: intent.droppedLabel };
    case 'push':
      return { source: intent.branch, target: intent.remote };
    case 'cherry-pick':
      return { source: intent.label, target: intent.branch };
    case 'rebase':
      return { source: intent.seed.moveLabel, target: intent.seed.anchorLabel };
    default: {
      const unreachable: never = intent;
      return unreachable;
    }
  }
}

export function dragMergeArgs(intent: BranchIntent): string[] {
  return [...MENU_MERGE_PREFIX, intent.mergeRef];
}

export function dragRebaseArgs(intent: BranchIntent): string[] {
  return [...MENU_REBASE_PREFIX, intent.rebaseOnto];
}

export function beginDrag(source: DragSource, x: number, y: number): DragSession {
  return { status: 'armed', x, y, source };
}

export function moveDrag(
  session: DragSession,
  move: { x: number; y: number; intent: DropIntent | null },
): DragSession {
  if (session.status === 'armed') {
    if (Math.hypot(move.x - session.x, move.y - session.y) < DRAG_THRESHOLD_PX) return session;
    return { status: 'dragging', source: session.source, intent: move.intent };
  }
  if (session.status === 'dragging') return { status: 'dragging', source: session.source, intent: move.intent };
  return session;
}

/**
 * `commit` is false for Escape and for any cancel. A release before the
 * movement threshold, or over a rejected target, also yields null — no Git op.
 */
export function finishDrag(session: DragSession, commit: boolean): DropIntent | null {
  if (!commit || session.status !== 'dragging') return null;
  return session.intent;
}

export function dragCursor(intent: DropIntent | null): 'copy' | 'no-drop' {
  return intent ? 'copy' : 'no-drop';
}
