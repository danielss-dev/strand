/**
 * A tiny in-memory git for the browser demo: enough of the object model
 * (commits with full trees, branches, remotes, tags, worktrees, an index and
 * a working directory per worktree, stashes) that the real Strand UI can run
 * unmodified against it. Nothing here touches disk.
 */

import type {
  BlameLine,
  Branch,
  Commit,
  FileDiff,
  FileHistoryEntry,
  FileStatus,
  RebaseEntry,
  RebaseStep,
  ReflogEntry,
  Refs,
  Remote,
  RemoteBranch,
  RepoMeta,
  Snapshot,
  Stash,
  Tag,
  WorkTreeEntry,
  Worktree,
  WorktreeArchive,
  WorktreeHealth,
  WorktreeStats,
} from '../lib/types';
import { applyPatch, countChanges, diffLines, splitLines, unifiedPatch } from './textdiff';

export type Tree = Map<string, string>;
/** `null` = the path is deleted by this change. */
export type Overlay = Map<string, string | null>;

export interface DemoCommit {
  hash: string;
  parents: string[];
  tree: Tree;
  author_name: string;
  author_email: string;
  time_unix: number;
  subject: string;
  body: string;
  signed: boolean;
}

export interface DemoWorktree {
  path: string;
  /** `null` when detached — HEAD then lives in `detachedHead`. */
  branch: string | null;
  detachedHead: string | null;
  index: Tree;
  workdir: Tree;
  /** Git-ignored paths present on disk (directories end with `/`). */
  ignored: Map<string, string>;
  isMain: boolean;
  lockReason: string | null;
  locked: boolean;
  lastActivityUnix: number;
  diskBytes: number;
}

interface StashEntry {
  oid: string;
  message: string;
  branch: string | null;
  base: string;
  time_unix: number;
  index: Tree;
  workdir: Tree;
}

interface ArchiveEntry extends WorktreeArchive {
  branch: string | null;
  path: string;
  tree: Tree;
}

export interface Author { name: string; email: string }

export class GitError extends Error {}

function fnv(seed: string, salt: number): number {
  let h = (0x811c9dc5 ^ salt) >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function fakeOid(seed: string): string {
  let out = '';
  for (let round = 0; round < 5; round += 1) out += fnv(seed, round * 7919).toString(16).padStart(8, '0');
  return out;
}

export function normalizePath(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

function cloneTree(tree: Tree): Tree {
  return new Map(tree);
}

function treeDigest(tree: Tree): string {
  return [...tree.keys()].sort().map((k) => `${k}:${fnv(tree.get(k)!, 1).toString(16)}`).join('|');
}

/** Path → content|null changes that turn `from` into `to`. */
export function overlayBetween(from: Tree, to: Tree): Overlay {
  const out: Overlay = new Map();
  for (const [path, text] of to) if (from.get(path) !== text) out.set(path, text);
  for (const path of from.keys()) if (!to.has(path)) out.set(path, null);
  return out;
}

export function applyOverlay(tree: Tree, overlay: Overlay): Tree {
  const out = cloneTree(tree);
  for (const [path, text] of overlay) {
    if (text == null) out.delete(path);
    else out.set(path, text);
  }
  return out;
}

export class DemoRepo {
  readonly commits = new Map<string, DemoCommit>();
  readonly branches = new Map<string, string>();
  readonly upstreams = new Map<string, string>();
  readonly remoteBranches = new Map<string, string>();
  readonly remotes: Remote[] = [];
  readonly tags: Tag[] = [];
  readonly worktrees = new Map<string, DemoWorktree>();
  readonly stashes: StashEntry[] = [];
  readonly archives: ArchiveEntry[] = [];
  primary = 'main';
  identity: Author = { name: 'Dana Whitfield', email: 'dana@acme.dev' };

  constructor(readonly name: string, readonly commonDir: string) {}

  // ---- objects -----------------------------------------------------------

  createCommit(
    parents: string[],
    tree: Tree,
    subject: string,
    body: string,
    author: Author,
    time_unix: number,
    signed = false,
  ): DemoCommit {
    let hash = fakeOid(`${parents.join(',')}|${treeDigest(tree)}|${subject}|${body}|${author.email}|${time_unix}`);
    while (this.commits.has(hash)) hash = fakeOid(`${hash}+`);
    const commit: DemoCommit = {
      hash, parents, tree: cloneTree(tree), subject, body, signed,
      author_name: author.name, author_email: author.email, time_unix,
    };
    this.commits.set(hash, commit);
    return commit;
  }

  commit(hash: string): DemoCommit {
    const c = this.commits.get(hash);
    if (!c) throw new GitError(`unknown object ${hash.slice(0, 7)}`);
    return c;
  }

  parentTree(commit: DemoCommit): Tree {
    return commit.parents[0] ? this.commit(commit.parents[0]).tree : new Map();
  }

  changesOf(commit: DemoCommit): Overlay {
    return overlayBetween(this.parentTree(commit), commit.tree);
  }

  /** Resolve a rev the way the UI spells them: HEAD, branch, tag, remote, hash. */
  resolve(rev: string, wt?: DemoWorktree): string {
    if (rev === 'HEAD' && wt) return this.headOf(wt);
    const branch = this.branches.get(rev.replace(/^refs\/heads\//, ''));
    if (branch) return branch;
    const remote = this.remoteBranches.get(rev.replace(/^refs\/remotes\//, ''));
    if (remote) return remote;
    const tag = this.tags.find((t) => t.name === rev || t.full_name === rev);
    if (tag) return tag.target;
    const stash = this.stashes.find((s) => s.oid === rev || s.oid.startsWith(rev));
    if (stash) return stash.base;
    if (/^[0-9a-f]{4,40}$/.test(rev)) {
      const hits = [...this.commits.keys()].filter((h) => h.startsWith(rev));
      if (hits.length === 1) return hits[0];
    }
    const tilde = rev.match(/^(.+?)(?:~(\d+)|\^)$/);
    if (tilde) {
      let hash = this.resolve(tilde[1], wt);
      const steps = tilde[2] ? Number(tilde[2]) : 1;
      for (let i = 0; i < steps; i += 1) hash = this.commit(hash).parents[0] ?? hash;
      return hash;
    }
    throw new GitError(`revspec '${rev}' not found`);
  }

  ancestors(hash: string): Set<string> {
    const seen = new Set<string>();
    const stack = [hash];
    while (stack.length) {
      const h = stack.pop()!;
      if (seen.has(h)) continue;
      seen.add(h);
      stack.push(...this.commit(h).parents);
    }
    return seen;
  }

  /** Commits reachable from `a` but not from `b`. */
  aheadCount(a: string, b: string): number {
    const exclude = this.ancestors(b);
    let n = 0;
    for (const h of this.ancestors(a)) if (!exclude.has(h)) n += 1;
    return n;
  }

  mergeBase(a: string, b: string): string | null {
    const bs = this.ancestors(b);
    let best: DemoCommit | null = null;
    for (const h of this.ancestors(a)) {
      if (!bs.has(h)) continue;
      const c = this.commit(h);
      if (!best || c.time_unix > best.time_unix) best = c;
    }
    return best?.hash ?? null;
  }

  // ---- worktrees ---------------------------------------------------------

  addWorktree(wt: Omit<DemoWorktree, 'index' | 'workdir' | 'ignored' | 'locked' | 'lockReason' | 'diskBytes'> & Partial<DemoWorktree>): DemoWorktree {
    const head = wt.branch ? this.branches.get(wt.branch) : wt.detachedHead;
    if (!head) throw new GitError(`worktree ${wt.path} has no HEAD`);
    const tree = this.commit(head).tree;
    const full: DemoWorktree = {
      index: cloneTree(tree),
      workdir: cloneTree(tree),
      ignored: new Map(),
      locked: false,
      lockReason: null,
      diskBytes: 0,
      ...wt,
      path: normalizePath(wt.path),
    };
    this.worktrees.set(full.path, full);
    return full;
  }

  worktree(path: string): DemoWorktree {
    const wt = this.worktrees.get(normalizePath(path));
    if (!wt) throw new GitError(`could not find repository at '${path}'`);
    return wt;
  }

  headOf(wt: DemoWorktree): string {
    if (wt.branch) {
      const h = this.branches.get(wt.branch);
      if (!h) throw new GitError(`branch ${wt.branch} vanished`);
      return h;
    }
    if (!wt.detachedHead) throw new GitError('unborn HEAD');
    return wt.detachedHead;
  }

  headTree(wt: DemoWorktree): Tree {
    return this.commit(this.headOf(wt)).tree;
  }

  private moveHead(wt: DemoWorktree, hash: string): void {
    if (wt.branch) this.branches.set(wt.branch, hash);
    else wt.detachedHead = hash;
  }

  meta(wt: DemoWorktree): RepoMeta {
    const head = this.headOf(wt);
    const upstream = wt.branch ? this.upstreams.get(wt.branch) : undefined;
    const remoteTip = upstream ? this.remoteBranches.get(upstream) : undefined;
    return {
      name: wt.isMain ? this.name : wt.path.split('/').pop() ?? this.name,
      path: wt.path,
      branch: wt.branch ?? head.slice(0, 7),
      head_oid: head,
      ahead: remoteTip ? this.aheadCount(head, remoteTip) : 0,
      behind: remoteTip ? this.aheadCount(remoteTip, head) : 0,
      detached: wt.branch == null,
      operation: null,
      common_dir: this.commonDir,
      is_linked_worktree: !wt.isMain,
    };
  }

  snapshot(wt: DemoWorktree): Snapshot {
    return {
      meta: this.meta(wt),
      status: this.status(wt),
      work_tree: this.workTree(wt, false),
      refs: this.refs(wt),
      submodules: [],
    };
  }

  // ---- status / trees ----------------------------------------------------

  status(wt: DemoWorktree): FileStatus[] {
    const head = this.headTree(wt);
    const out: FileStatus[] = [];
    for (const [path, text] of overlayBetween(head, wt.index)) {
      out.push({ path, staged: true, kind: text == null ? 'DELETED' : head.has(path) ? 'MODIFIED' : 'ADDED' });
    }
    for (const [path, text] of overlayBetween(wt.index, wt.workdir)) {
      if (!wt.index.has(path)) out.push({ path, staged: false, kind: 'UNTRACKED' });
      else out.push({ path, staged: false, kind: text == null ? 'DELETED' : 'MODIFIED' });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  workTree(wt: DemoWorktree, includeIgnored: boolean): WorkTreeEntry[] {
    const status = new Map(this.status(wt).map((s) => [s.path, s.kind]));
    const paths = new Set([...wt.index.keys(), ...wt.workdir.keys()]);
    const out: WorkTreeEntry[] = [];
    for (const path of paths) {
      if (!wt.workdir.has(path) && !status.has(path)) continue;
      out.push({ path, status: status.get(path) ?? null, ignored: false });
    }
    if (includeIgnored) {
      for (const path of wt.ignored.keys()) {
        if (!path.includes('/') || path.endsWith('/')) out.push({ path, status: null, ignored: true });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  ignoredChildren(wt: DemoWorktree, directory: string): WorkTreeEntry[] {
    const prefix = `${directory.replace(/\/$/, '')}/`;
    const seen = new Set<string>();
    const out: WorkTreeEntry[] = [];
    for (const path of wt.ignored.keys()) {
      if (!path.startsWith(prefix) || path === prefix) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      const child = slash === -1 ? prefix + rest : `${prefix}${rest.slice(0, slash)}/`;
      if (seen.has(child)) continue;
      seen.add(child);
      out.push({ path: child, status: null, ignored: true });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  treeAt(rev: string, wt: DemoWorktree): WorkTreeEntry[] {
    return [...this.commit(this.resolve(rev, wt)).tree.keys()].sort()
      .map((path) => ({ path, status: null, ignored: false }));
  }

  fileText(wt: DemoWorktree, file: string, rev: string | null, index = false): string | null {
    if (index) return wt.index.get(file) ?? null;
    if (rev == null) return wt.workdir.get(file) ?? null;
    return this.commit(this.resolve(rev, wt)).tree.get(file) ?? null;
  }

  // ---- diffs -------------------------------------------------------------

  diffTrees(from: Tree, to: Tree, context = 3, only?: string): FileDiff[] {
    const out: FileDiff[] = [];
    for (const [path, text] of overlayBetween(from, to)) {
      if (only && path !== only) continue;
      const oldText = from.get(path) ?? '';
      const newText = text ?? '';
      const ops = diffLines(oldText, newText);
      const { adds, dels } = countChanges(ops);
      out.push({
        path,
        old_path: null,
        status: text == null ? 'deleted' : from.has(path) ? 'modified' : 'added',
        adds,
        dels,
        binary: false,
        patch: unifiedPatch(oldText, newText, {
          oldPath: from.has(path) ? path : null,
          newPath: text == null ? null : path,
          context,
        }),
      });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  diffUnstaged(wt: DemoWorktree, full = false): FileDiff[] {
    return this.diffTrees(wt.index, wt.workdir, full ? Infinity : 3);
  }

  diffStaged(wt: DemoWorktree): FileDiff[] {
    return this.diffTrees(this.headTree(wt), wt.index);
  }

  diffSince(wt: DemoWorktree, baseline: string, full = false): FileDiff[] {
    return this.diffTrees(this.commit(this.resolve(baseline, wt)).tree, wt.workdir, full ? Infinity : 3);
  }

  diffCommit(wt: DemoWorktree, oid: string, file?: string): FileDiff[] {
    const c = this.commit(this.resolve(oid, wt));
    return this.diffTrees(this.parentTree(c), c.tree, 3, file);
  }

  diffBetween(wt: DemoWorktree, from: string, to: string): FileDiff[] {
    return this.diffTrees(this.commit(this.resolve(from, wt)).tree, this.commit(this.resolve(to, wt)).tree);
  }

  /** Combined patch of `branch` against its base — what a PR page shows. */
  branchPatch(branch: string, base: string): string {
    const tip = this.resolve(branch);
    const mb = this.mergeBase(tip, this.resolve(base)) ?? this.resolve(base);
    return this.diffTrees(this.commit(mb).tree, this.commit(tip).tree).map((d) => d.patch).join('');
  }

  // ---- index / workdir writes -------------------------------------------

  stage(wt: DemoWorktree, file: string): void {
    const text = wt.workdir.get(file);
    if (text == null) wt.index.delete(file);
    else wt.index.set(file, text);
  }

  unstage(wt: DemoWorktree, file: string): void {
    const text = this.headTree(wt).get(file);
    if (text == null) wt.index.delete(file);
    else wt.index.set(file, text);
  }

  discard(wt: DemoWorktree, file: string): void {
    const text = wt.index.get(file);
    if (text == null) wt.workdir.delete(file);
    else wt.workdir.set(file, text);
    wt.lastActivityUnix = now();
  }

  writeFile(wt: DemoWorktree, file: string, text: string): void {
    wt.workdir.set(file, text);
    wt.lastActivityUnix = now();
  }

  deleteFiles(wt: DemoWorktree, files: string[]): void {
    for (const f of files) {
      for (const path of [...wt.workdir.keys()]) {
        if (path === f || path.startsWith(`${f}/`)) wt.workdir.delete(path);
      }
    }
  }

  movePath(wt: DemoWorktree, from: string, to: string): void {
    for (const tree of [wt.workdir, wt.index]) {
      for (const path of [...tree.keys()]) {
        if (path === from || path.startsWith(`${from}/`)) {
          const text = tree.get(path)!;
          tree.delete(path);
          tree.set(to + path.slice(from.length), text);
        }
      }
    }
  }

  applyPatchTo(wt: DemoWorktree, patch: string, target: 'index' | 'index_reverse' | 'workdir_reverse' | 'workdir'): void {
    const files = patch.split(/^(?=diff --git )/m).filter((p) => p.trim());
    for (const filePatch of files) {
      const m = filePatch.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      if (!m) throw new GitError('malformed patch');
      const path = m[2];
      const tree = target.startsWith('index') ? wt.index : wt.workdir;
      const reverse = target.endsWith('_reverse');
      const isNew = /^--- \/dev\/null$/m.test(filePatch);
      const isDeleted = /^\+\+\+ \/dev\/null$/m.test(filePatch);
      if ((isNew && !reverse) || (isDeleted && reverse)) {
        tree.set(path, applyPatch('', filePatch, reverse));
        continue;
      }
      if ((isDeleted && !reverse) || (isNew && reverse)) {
        tree.delete(path);
        continue;
      }
      const current = tree.get(path) ?? '';
      tree.set(path, applyPatch(current, filePatch, reverse));
    }
    if (!target.startsWith('index')) wt.lastActivityUnix = now();
  }

  commitIndex(wt: DemoWorktree, subject: string, body: string | null, amend: boolean): DemoCommit {
    const head = this.commit(this.headOf(wt));
    if (!amend && overlayBetween(head.tree, wt.index).size === 0) {
      throw new GitError('nothing to commit (no staged changes)');
    }
    const parents = amend ? head.parents : [head.hash];
    const c = this.createCommit(parents, wt.index, subject, body ?? '', this.identity, now());
    this.moveHead(wt, c.hash);
    wt.lastActivityUnix = c.time_unix;
    return c;
  }

  // ---- history -----------------------------------------------------------

  toCommit(c: DemoCommit): Commit {
    return {
      hash: c.hash, short_hash: c.hash.slice(0, 7), subject: c.subject, body: c.body,
      author_name: c.author_name, author_email: c.author_email, time_unix: c.time_unix, parents: c.parents,
    };
  }

  log(wt: DemoWorktree, limit = 500, headOnly = false): Commit[] {
    const roots = headOnly
      ? [this.headOf(wt)]
      : [this.headOf(wt), ...this.branches.values(), ...this.remoteBranches.values(), ...this.tags.map((t) => t.target)];
    const seen = new Set<string>();
    for (const r of roots) for (const h of this.ancestors(r)) seen.add(h);
    return [...seen].map((h) => this.commit(h))
      .sort((a, b) => b.time_unix - a.time_unix || a.hash.localeCompare(b.hash))
      .slice(0, limit)
      .map((c) => this.toCommit(c));
  }

  searchLog(wt: DemoWorktree, query: string, mode: 'message' | 'author' | 'content', limit = 500): Commit[] {
    const q = query.toLowerCase();
    return this.log(wt, Infinity).filter((c) => {
      if (mode === 'message') return `${c.subject}\n${c.body}`.toLowerCase().includes(q);
      if (mode === 'author') return `${c.author_name} ${c.author_email}`.toLowerCase().includes(q);
      const dc = this.commit(c.hash);
      const parent = this.parentTree(dc);
      for (const [path, text] of overlayBetween(parent, dc.tree)) {
        for (const op of diffLines(parent.get(path) ?? '', text ?? '')) {
          if (op.kind !== 'eq' && op.text.toLowerCase().includes(q)) return true;
        }
      }
      return false;
    }).slice(0, limit);
  }

  fileHistory(wt: DemoWorktree, file: string, limit = 200): FileHistoryEntry[] {
    const out: FileHistoryEntry[] = [];
    for (const c of this.log(wt, Infinity, true)) {
      const dc = this.commit(c.hash);
      const before = this.parentTree(dc).get(file);
      const after = dc.tree.get(file);
      if (before === after) continue;
      const { adds, dels } = countChanges(diffLines(before ?? '', after ?? ''));
      out.push({
        hash: c.hash, short_hash: c.short_hash, author_name: c.author_name, author_email: c.author_email,
        time_unix: c.time_unix, subject: c.subject, adds, dels,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  blame(wt: DemoWorktree, file: string): BlameLine[] {
    // Oldest → newest along first parents; common lines inherit their blame.
    const chain: DemoCommit[] = [];
    let cursor: string | undefined = this.headOf(wt);
    while (cursor) {
      const c: DemoCommit = this.commit(cursor);
      chain.push(c);
      cursor = c.parents[0];
    }
    chain.reverse();
    let lines: string[] = [];
    let owners: DemoCommit[] = [];
    for (const c of chain) {
      const text = c.tree.get(file);
      if (text == null) { lines = []; owners = []; continue; }
      const next = splitLines(text);
      if (next.join('\n') === lines.join('\n')) continue;
      const nextOwners: DemoCommit[] = [];
      let oldIdx = 0;
      for (const op of diffLines(lines.join('\n') + (lines.length ? '\n' : ''), text)) {
        if (op.kind === 'eq') nextOwners.push(owners[oldIdx++]);
        else if (op.kind === 'del') oldIdx += 1;
        else nextOwners.push(c);
      }
      lines = next;
      owners = nextOwners;
    }
    return lines.map((content, i) => {
      const c = owners[i] ?? chain[chain.length - 1];
      return {
        line_no: i + 1, content, commit: c.hash, short: c.hash.slice(0, 7),
        author: c.author_name, author_email: c.author_email, time_unix: c.time_unix, summary: c.subject,
      };
    });
  }

  reflog(wt: DemoWorktree, limit = 100): ReflogEntry[] {
    const out: ReflogEntry[] = [];
    let prev: string | null = null;
    const chain: DemoCommit[] = [];
    let cursor: string | undefined = this.headOf(wt);
    while (cursor && chain.length < limit) {
      const c: DemoCommit = this.commit(cursor);
      chain.push(c);
      cursor = c.parents[0];
    }
    chain.reverse().forEach((c) => {
      out.push({
        index: 0, new_oid: c.hash, new_short: c.hash.slice(0, 7),
        old_oid: prev ?? '0'.repeat(40), committer_name: c.author_name, committer_email: c.author_email,
        time_unix: c.time_unix, message: prev ? `commit: ${c.subject}` : `commit (initial): ${c.subject}`,
      });
      prev = c.hash;
    });
    return out.reverse().map((e, i) => ({ ...e, index: i }));
  }

  // ---- refs --------------------------------------------------------------

  refs(wt: DemoWorktree): Refs {
    const primaryTip = this.branches.get(this.primary);
    const primaryAncestors = primaryTip ? this.ancestors(primaryTip) : new Set<string>();
    const branches: Branch[] = [...this.branches.entries()].map(([name, target]) => {
      const up = this.upstreams.get(name) ?? null;
      const remoteTip = up ? this.remoteBranches.get(up) : undefined;
      return {
        name, full_name: `refs/heads/${name}`, target,
        is_head: wt.branch === name,
        merged: name !== this.primary && wt.branch !== name && primaryAncestors.has(target),
        upstream: up ? { name: up, remote: up.split('/')[0] } : null,
        ahead: remoteTip ? this.aheadCount(target, remoteTip) : 0,
        behind: remoteTip ? this.aheadCount(remoteTip, target) : 0,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const remote_branches: RemoteBranch[] = [...this.remoteBranches.entries()].map(([name, target]) => {
      const [remote, ...rest] = name.split('/');
      return {
        name, remote, branch: rest.join('/'), full_name: `refs/remotes/${name}`, target,
        merged: rest.join('/') !== this.primary && primaryAncestors.has(target),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return {
      branches,
      primary_branch: this.primary,
      remotes: this.remotes,
      remote_branches,
      tags: [...this.tags].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  createBranch(wt: DemoWorktree, name: string, startPoint: string | null, checkout: boolean): void {
    if (this.branches.has(name)) throw new GitError(`a branch named '${name}' already exists`);
    if (!/^[\w./-]+$/.test(name) || name.endsWith('/') || name.includes('..')) {
      throw new GitError(`'${name}' is not a valid branch name`);
    }
    this.branches.set(name, this.resolve(startPoint ?? 'HEAD', wt));
    if (checkout) this.checkout(wt, name);
  }

  deleteBranch(wt: DemoWorktree, name: string, force: boolean): void {
    if (!this.branches.has(name)) throw new GitError(`branch '${name}' not found`);
    for (const other of this.worktrees.values()) {
      if (other.branch === name) {
        throw new GitError(`cannot delete branch '${name}' checked out at '${other.path}'`);
      }
    }
    const primaryTip = this.branches.get(this.primary);
    if (!force && primaryTip && !this.ancestors(primaryTip).has(this.branches.get(name)!) && name !== wt.branch) {
      throw new GitError(`the branch '${name}' is not fully merged. Use force to delete it anyway.`);
    }
    this.branches.delete(name);
    this.upstreams.delete(name);
  }

  renameBranch(oldName: string, newName: string): void {
    const target = this.branches.get(oldName);
    if (!target) throw new GitError(`branch '${oldName}' not found`);
    if (this.branches.has(newName)) throw new GitError(`a branch named '${newName}' already exists`);
    this.branches.delete(oldName);
    this.branches.set(newName, target);
    const up = this.upstreams.get(oldName);
    this.upstreams.delete(oldName);
    if (up) this.upstreams.set(newName, up);
    for (const wt of this.worktrees.values()) if (wt.branch === oldName) wt.branch = newName;
  }

  checkout(wt: DemoWorktree, rev: string): void {
    const isBranch = this.branches.has(rev);
    for (const other of this.worktrees.values()) {
      if (other !== wt && isBranch && other.branch === rev) {
        throw new GitError(`'${rev}' is already checked out at '${other.path}'`);
      }
    }
    const target = this.resolve(rev, wt);
    const oldHead = this.headTree(wt);
    const staged = overlayBetween(oldHead, wt.index);
    const unstaged = overlayBetween(wt.index, wt.workdir);
    const newTree = this.commit(target).tree;
    if (isBranch) { wt.branch = rev; wt.detachedHead = null; }
    else { wt.branch = null; wt.detachedHead = target; }
    wt.index = applyOverlay(newTree, staged);
    wt.workdir = applyOverlay(wt.index, unstaged);
  }

  reset(wt: DemoWorktree, target: string, mode: 'soft' | 'mixed' | 'hard'): string | null {
    const hash = this.resolve(target, wt);
    let snapshot: string | null = null;
    if (mode === 'hard' && this.status(wt).length > 0) {
      snapshot = this.stashSave(wt, `Strand safety snapshot before reset --hard`, true, false, true);
    }
    this.moveHead(wt, hash);
    if (mode !== 'soft') wt.index = cloneTree(this.commit(hash).tree);
    if (mode === 'hard') wt.workdir = cloneTree(this.commit(hash).tree);
    return snapshot;
  }

  // ---- stash -------------------------------------------------------------

  stashSave(wt: DemoWorktree, message: string | null, includeUntracked: boolean, keepIndex: boolean, snapshot = false, paths?: string[]): string | null {
    const head = this.commit(this.headOf(wt));
    const dirty = this.status(wt).filter((s) => includeUntracked || s.kind !== 'UNTRACKED')
      .filter((s) => !paths || paths.includes(s.path));
    if (dirty.length === 0) return null;
    const scope = new Set(dirty.map((s) => s.path));
    const pick = (tree: Tree): Tree => {
      const out = cloneTree(head.tree);
      for (const p of scope) {
        const t = tree.get(p);
        if (t == null) out.delete(p);
        else out.set(p, t);
      }
      return out;
    };
    const entry: StashEntry = {
      oid: fakeOid(`stash|${head.hash}|${now()}|${this.stashes.length}|${message ?? ''}`),
      message: message ? `On ${wt.branch ?? 'HEAD'}: ${message}` : `WIP on ${wt.branch ?? 'HEAD'}: ${head.hash.slice(0, 7)} ${head.subject}`,
      branch: wt.branch,
      base: head.hash,
      time_unix: now(),
      index: pick(wt.index),
      workdir: pick(wt.workdir),
    };
    this.stashes.unshift(entry);
    if (!snapshot) {
      for (const p of scope) {
        const base = keepIndex ? wt.index.get(p) : head.tree.get(p);
        if (base == null) { wt.workdir.delete(p); if (!keepIndex) wt.index.delete(p); }
        else { wt.workdir.set(p, base); if (!keepIndex) wt.index.set(p, base); }
      }
    }
    return entry.oid;
  }

  stashList(): Stash[] {
    return this.stashes.map((s, index) => ({
      index, oid: s.oid, message: s.message, branch: s.branch, base: s.base, time_unix: s.time_unix,
    }));
  }

  stashApply(wt: DemoWorktree, index: number, drop: boolean): void {
    const entry = this.stashes[index];
    if (!entry) throw new GitError(`stash@{${index}} does not exist`);
    const base = this.commit(entry.base).tree;
    wt.index = applyOverlay(wt.index, overlayBetween(base, entry.index));
    wt.workdir = applyOverlay(wt.workdir, overlayBetween(base, entry.workdir));
    if (drop) this.stashes.splice(index, 1);
  }

  stashDrop(index: number): void {
    if (!this.stashes[index]) throw new GitError(`stash@{${index}} does not exist`);
    this.stashes.splice(index, 1);
  }

  stashBranch(wt: DemoWorktree, index: number, branch: string): void {
    const entry = this.stashes[index];
    if (!entry) throw new GitError(`stash@{${index}} does not exist`);
    this.branches.set(branch, entry.base);
    this.checkout(wt, branch);
    this.stashApply(wt, index, true);
  }

  // ---- history rewriting -------------------------------------------------

  private applyCommitsOnto(base: string, commits: DemoCommit[], reword?: Map<string, string>): string {
    let head = base;
    let tree = this.commit(base).tree;
    for (const c of commits) {
      tree = applyOverlay(tree, this.changesOf(c));
      const msg = reword?.get(c.hash);
      const [subject, ...rest] = (msg ?? `${c.subject}\n${c.body}`).split('\n');
      head = this.createCommit([head], tree, subject, rest.join('\n').trim(), { name: c.author_name, email: c.author_email }, now(), c.signed).hash;
    }
    return head;
  }

  cherryPick(wt: DemoWorktree, oids: string[]): void {
    const commits = oids.map((o) => this.commit(this.resolve(o, wt)));
    const head = this.applyCommitsOnto(this.headOf(wt), commits);
    this.moveHeadKeepingWork(wt, head);
  }

  revert(wt: DemoWorktree, oids: string[]): void {
    let head = this.headOf(wt);
    for (const o of oids) {
      const c = this.commit(this.resolve(o, wt));
      const tree = applyOverlay(this.commit(head).tree, overlayBetween(c.tree, this.parentTree(c)));
      head = this.createCommit([head], tree, `Revert "${c.subject}"`, `This reverts commit ${c.hash}.`, this.identity, now()).hash;
    }
    this.moveHeadKeepingWork(wt, head);
  }

  merge(wt: DemoWorktree, refname: string, mode: 'auto' | 'no_ff' | 'squash'): string {
    const head = this.headOf(wt);
    const other = this.resolve(refname, wt);
    const otherC = this.commit(other);
    if (this.ancestors(head).has(other)) return 'Already up to date.';
    const base = this.mergeBase(head, other) ?? head;
    const tree = applyOverlay(this.commit(head).tree, overlayBetween(this.commit(base).tree, otherC.tree));
    if (mode === 'squash') {
      wt.index = tree;
      wt.workdir = applyOverlay(wt.workdir, overlayBetween(this.commit(head).tree, tree));
      return `Squash commit -- not updating HEAD\nChanges staged from ${refname}.`;
    }
    if (mode === 'auto' && this.ancestors(other).has(head)) {
      this.moveHeadKeepingWork(wt, other);
      return `Updating ${head.slice(0, 7)}..${other.slice(0, 7)}\nFast-forward`;
    }
    const c = this.createCommit([head, other], tree, `Merge branch '${refname}' into ${wt.branch ?? 'HEAD'}`, '', this.identity, now());
    this.moveHeadKeepingWork(wt, c.hash);
    return `Merge made by the 'ort' strategy.`;
  }

  rebase(wt: DemoWorktree, onto: string): void {
    const head = this.headOf(wt);
    const target = this.resolve(onto, wt);
    const base = this.mergeBase(head, target);
    if (base === target) return;
    const chain = this.firstParentChain(head, base);
    const newHead = this.applyCommitsOnto(target, chain);
    this.moveHeadKeepingWork(wt, newHead);
  }

  rebaseTodo(wt: DemoWorktree, base: string | null): RebaseEntry[] {
    const stop = base ? this.resolve(base, wt) : null;
    return this.firstParentChain(this.headOf(wt), stop).map((c) => ({
      oid: c.hash, short: c.hash.slice(0, 7), subject: c.subject, author: c.author_name, is_merge: c.parents.length > 1,
    }));
  }

  interactiveRebase(wt: DemoWorktree, base: string | null, steps: RebaseStep[]): void {
    const start = base ? this.resolve(base, wt) : null;
    const chain = this.firstParentChain(this.headOf(wt), start);
    let head: string | null = start ?? chain[0]?.parents[0] ?? null;
    let tree: Tree = head ? this.commit(head).tree : new Map();
    let pending: { subject: string; body: string; author: Author } | null = null;
    const flush = () => {
      if (!pending) return;
      head = this.createCommit(head ? [head] : [], tree, pending.subject, pending.body, pending.author, now()).hash;
      pending = null;
    };
    for (const step of steps) {
      if (step.action === 'drop') continue;
      const c = this.commit(step.oid);
      const author = { name: c.author_name, email: c.author_email };
      if ((step.action === 'squash' || step.action === 'fixup') && pending) {
        tree = applyOverlay(tree, this.changesOf(c));
        if (step.action === 'squash') pending.body = `${pending.body}\n\n${c.subject}\n${c.body}`.trim();
        continue;
      }
      flush();
      tree = applyOverlay(tree, this.changesOf(c));
      const message = step.action === 'reword' && step.message ? step.message : `${c.subject}\n${c.body}`;
      const [subject, ...rest] = message.split('\n');
      pending = { subject, body: rest.join('\n').trim(), author };
    }
    flush();
    if (!head) throw new GitError('rebase would leave no commits');
    this.moveHeadKeepingWork(wt, head);
  }

  private firstParentChain(from: string, stop: string | null): DemoCommit[] {
    const out: DemoCommit[] = [];
    let cursor: string | undefined = from;
    while (cursor && cursor !== stop) {
      const c: DemoCommit = this.commit(cursor);
      out.push(c);
      cursor = c.parents[0];
    }
    return out.reverse();
  }

  /** Move HEAD and carry uncommitted work along (like a clean rebase does). */
  private moveHeadKeepingWork(wt: DemoWorktree, hash: string): void {
    const staged = overlayBetween(this.headTree(wt), wt.index);
    const unstaged = overlayBetween(wt.index, wt.workdir);
    this.moveHead(wt, hash);
    wt.index = applyOverlay(this.commit(hash).tree, staged);
    wt.workdir = applyOverlay(wt.index, unstaged);
  }

  // ---- tags / remotes ----------------------------------------------------

  tagCreate(wt: DemoWorktree, name: string, target: string | null, message: string | null, force: boolean): void {
    const existing = this.tags.findIndex((t) => t.name === name);
    if (existing !== -1 && !force) throw new GitError(`tag '${name}' already exists`);
    if (existing !== -1) this.tags.splice(existing, 1);
    this.tags.push({ name, full_name: `refs/tags/${name}`, target: this.resolve(target ?? 'HEAD', wt), annotated: message != null, message });
  }

  tagDelete(name: string): void {
    const idx = this.tags.findIndex((t) => t.name === name);
    if (idx === -1) throw new GitError(`tag '${name}' not found`);
    this.tags.splice(idx, 1);
  }

  push(wt: DemoWorktree, branch = wt.branch): string {
    if (!branch) throw new GitError('cannot push a detached HEAD');
    const upstream = this.upstreams.get(branch) ?? `origin/${branch}`;
    const tip = this.branches.get(branch)!;
    const before = this.remoteBranches.get(upstream);
    if (before === tip) return 'Everything up-to-date';
    this.remoteBranches.set(upstream, tip);
    this.upstreams.set(branch, upstream);
    return before
      ? `To github.com:acme/acme-api.git\n   ${before.slice(0, 7)}..${tip.slice(0, 7)}  ${branch} -> ${upstream.split('/').slice(1).join('/')}`
      : `To github.com:acme/acme-api.git\n * [new branch]      ${branch} -> ${branch}\nbranch '${branch}' set up to track '${upstream}'.`;
  }

  pull(wt: DemoWorktree): string {
    if (!wt.branch) throw new GitError('cannot pull onto a detached HEAD');
    const upstream = this.upstreams.get(wt.branch);
    if (!upstream) throw new GitError(`there is no tracking information for the current branch '${wt.branch}'`);
    const remoteTip = this.remoteBranches.get(upstream);
    const head = this.headOf(wt);
    if (!remoteTip || this.ancestors(head).has(remoteTip)) return 'Already up to date.';
    if (this.ancestors(remoteTip).has(head)) {
      this.moveHeadKeepingWork(wt, remoteTip);
      return `Updating ${head.slice(0, 7)}..${remoteTip.slice(0, 7)}\nFast-forward`;
    }
    return this.merge(wt, upstream, 'auto');
  }

  // ---- worktree registry -------------------------------------------------

  listWorktrees(current: DemoWorktree): Worktree[] {
    return [...this.worktrees.values()]
      .sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.path.localeCompare(b.path))
      .map((wt) => ({
        path: wt.path,
        branch: wt.branch,
        head: this.headOf(wt),
        is_bare: false,
        is_detached: wt.branch == null,
        is_locked: wt.locked,
        lock_reason: wt.lockReason,
        is_prunable: false,
        prune_reason: null,
        is_main: wt.isMain,
        is_current: wt === current,
      }));
  }

  worktreeStats(wt: DemoWorktree): WorktreeStats {
    let insertions = 0;
    let deletions = 0;
    for (const d of this.diffTrees(this.headTree(wt), wt.workdir)) {
      if (!wt.index.has(d.path) && !this.headTree(wt).has(d.path)) continue;
      insertions += d.adds;
      deletions += d.dels;
    }
    let bytes = wt.diskBytes;
    if (bytes === 0) for (const text of wt.workdir.values()) bytes += text.length;
    return { disk_bytes: bytes, last_activity_unix: wt.lastActivityUnix, insertions, deletions };
  }

  detectBaseBranch(target: string): { name: string; merge_base: string } | null {
    const tip = this.resolve(target);
    let best: { name: string; merge_base: string; time: number } | null = null;
    for (const [name, other] of this.branches) {
      if (name === target || other === tip) continue;
      const mb = this.mergeBase(tip, other);
      if (!mb) continue;
      const t = this.commit(mb).time_unix;
      const preferPrimary = name === this.primary ? 1 : 0;
      if (!best || t > best.time || (t === best.time && preferPrimary)) best = { name, merge_base: mb, time: t };
    }
    return best ? { name: best.name, merge_base: best.merge_base } : null;
  }

  worktreeHealth(target: string): WorktreeHealth {
    const tip = this.resolve(target);
    const base = this.detectBaseBranch(target);
    let merged_into: string | null = null;
    for (const [name, other] of this.branches) {
      if (name !== target && this.ancestors(other).has(tip)) { merged_into = name; break; }
    }
    const baseTip = base ? this.branches.get(base.name)! : null;
    const upstream = this.upstreams.get(target);
    const remoteTip = upstream ? this.remoteBranches.get(upstream) : undefined;
    return {
      base_branch: base?.name ?? null,
      merged: merged_into != null,
      merged_into,
      ahead_of_base: baseTip ? this.aheadCount(tip, baseTip) : 0,
      can_fast_forward: baseTip != null && base != null && base.merge_base === baseTip,
      has_upstream: upstream != null,
      unpushed: remoteTip ? this.aheadCount(tip, remoteTip) : 0,
    };
  }

  integrate(branch: string, base: string, mode: string): string {
    const baseWt = [...this.worktrees.values()].find((w) => w.branch === base);
    const tip = this.branches.get(branch);
    const baseTip = this.branches.get(base);
    if (!tip || !baseTip) throw new GitError('unknown branch');
    const advance = (hash: string) => {
      if (baseWt) this.moveHeadKeepingWork(baseWt, hash);
      else this.branches.set(base, hash);
    };
    if (mode === 'ff') {
      if (!this.ancestors(tip).has(baseTip)) throw new GitError(`${base} cannot be fast-forwarded to ${branch}`);
      advance(tip);
      return tip;
    }
    const mb = this.mergeBase(tip, baseTip) ?? baseTip;
    const tree = applyOverlay(this.commit(baseTip).tree, overlayBetween(this.commit(mb).tree, this.commit(tip).tree));
    const c = mode === 'squash'
      ? this.createCommit([baseTip], tree, `${branch} (squashed)`, this.firstParentChain(tip, mb).map((x) => `* ${x.subject}`).join('\n'), this.identity, now())
      : this.createCommit([baseTip, tip], tree, `Merge branch '${branch}' into ${base}`, '', this.identity, now());
    advance(c.hash);
    return c.hash;
  }

  removeWorktree(path: string, force: boolean): void {
    const wt = this.worktree(path);
    if (wt.isMain) throw new GitError('cannot remove the main working tree');
    if (wt.locked && !force) throw new GitError(`cannot remove a locked working tree (${wt.lockReason ?? 'locked'})`);
    if (!force && this.status(wt).length > 0) {
      throw new GitError(`'${path}' contains modified or untracked files, use force to delete it`);
    }
    this.worktrees.delete(wt.path);
  }

  addLinkedWorktree(dest: string, branch: string, newBranch: boolean, startPoint: string | null, wt: DemoWorktree): void {
    const path = normalizePath(dest);
    if (this.worktrees.has(path)) throw new GitError(`'${dest}' already exists`);
    if (newBranch) this.createBranch(wt, branch, startPoint, false);
    else if (!this.branches.has(branch)) throw new GitError(`invalid reference: ${branch}`);
    for (const other of this.worktrees.values()) {
      if (other.branch === branch) throw new GitError(`'${branch}' is already checked out at '${other.path}'`);
    }
    this.addWorktree({ path, branch, detachedHead: null, isMain: false, lastActivityUnix: now() });
  }

  archiveWorktree(path: string): string {
    const wt = this.worktree(path);
    const slug = (wt.branch ?? 'detached').replace(/\//g, '-');
    const t = now();
    const c = this.createCommit([this.headOf(wt)], wt.workdir, `Strand archive of ${wt.branch ?? 'detached HEAD'}`, `Snapshot of ${wt.path}`, this.identity, t);
    const ref_name = `refs/strand/archive/${slug}/${t}`;
    this.archives.unshift({ ref_name, name: slug, oid: c.hash, time_unix: t, subject: c.subject, branch: wt.branch, path: wt.path, tree: wt.workdir });
    return ref_name;
  }

  restoreArchive(refName: string, dest: string): { path: string; branch: string | null } {
    const idx = this.archives.findIndex((a) => a.ref_name === refName);
    if (idx === -1) throw new GitError(`archive ${refName} not found`);
    const a = this.archives[idx];
    const path = this.worktrees.has(a.path) ? normalizePath(dest) : a.path;
    const branchFree = a.branch != null && this.branches.has(a.branch)
      && ![...this.worktrees.values()].some((w) => w.branch === a.branch);
    const wt = this.addWorktree({
      path, branch: branchFree ? a.branch : null,
      detachedHead: branchFree ? null : this.commit(a.oid).parents[0] ?? a.oid,
      isMain: false, lastActivityUnix: now(),
    });
    wt.workdir = cloneTree(a.tree);
    this.archives.splice(idx, 1);
    return { path, branch: wt.branch };
  }

  deleteArchive(refName: string): void {
    const idx = this.archives.findIndex((a) => a.ref_name === refName);
    if (idx === -1) throw new GitError(`archive ${refName} not found`);
    this.archives.splice(idx, 1);
  }
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
