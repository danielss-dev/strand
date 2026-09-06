/**
 * Demo implementations of the `tauri::command` handlers in
 * `crates/strand-tauri/src/commands.rs`, keyed by command name. The real
 * `ui/src/lib/tauri.ts` wrappers call these unchanged through `mockIPC`.
 */

import type { Channel } from '@tauri-apps/api/core';

import type {
  AiGenerationOutcome,
  AiInputCoverage,
  CodeReviewSuggestion,
  CommitMessageSuggestion,
  HeroiAgentEvent,
  Progress,
  PullRequest,
  PullRequestComment,
  PullRequestSuggestion,
  TerminalEvent,
} from '../lib/types';
import { buildWorld, MAIN_PATH } from './fixtures';
import { fakeOid, GitError } from './git';
import { DemoTerminal } from './terminal';

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

export class DemoUnavailable extends Error {}

const world = buildWorld();
const { repo } = world;
const terminals = new Map<string, { term: DemoTerminal; path: string }>();

const str = (v: unknown): string => String(v ?? '');
const wtOf = (args: Args) => repo.worktree(str(args.path));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unavailable = (what: string) => { throw new DemoUnavailable(`${what} isn't available in the web demo — download Strand to use it on your own repositories.`); };

async function streamProgress(channel: Channel<Progress> | undefined, phases: string[], tail: string): Promise<void> {
  for (let i = 0; i < phases.length; i += 1) {
    await sleep(140);
    channel?.onmessage({ phase: phases[i], percent: Math.round(((i + 1) / phases.length) * 100), raw: `${phases[i]}: ${Math.round(((i + 1) / phases.length) * 100)}%` });
  }
  await sleep(120);
  channel?.onmessage({ phase: '', percent: null, raw: tail });
}

function coverage(scope: AiInputCoverage['scope'], files: number): AiInputCoverage {
  return { scope, totalFiles: files, manifestFiles: files, patchFiles: files, omittedPatchFiles: 0, truncatedPatchFiles: 0, sensitiveExcludedFiles: 0 };
}

function generated<T>(scope: AiInputCoverage['scope'], files: number, suggestion: T, args: Args): AiGenerationOutcome<T> {
  return { status: 'generated', suggestion, coverage: coverage(scope, files), provider: (args.provider as 'openai' | 'anthropic') ?? 'anthropic' };
}

function pr(id: unknown): PullRequest {
  const hit = world.pullRequests.find((p) => p.id === Number(id));
  if (!hit) throw new GitError(`pull request #${String(id)} not found`);
  return hit;
}

function prComment(author: string, body: string, path: string | null, prId: number): PullRequestComment {
  const id = `c${prId}-${fakeOid(`${body}${Date.now()}`).slice(0, 6)}`;
  return { id, author, avatar_url: null, body, created_at: new Date().toISOString(), url: `https://github.com/acme/acme-api/pull/${prId}#issuecomment-${id}`, is_system: false, path };
}

export const handlers: Record<string, Handler> = {
  // ---- app / environment -------------------------------------------------
  microsoft_store_update_available: () => false,
  microsoft_store_open_product: () => unavailable('The Microsoft Store'),
  crash_report_check: () => ({ path: '', len: 0, entry: null }),
  repo_signing_settings: () => ({ effective: {}, local: {}, worktree: {}, worktree_enabled: false,
    commit_sign: false, tag_sign: false, tag_force_annotated: false }),
  repo_set_signing_config: () => unavailable('Signing configuration'),
  repo_tag_verify: () => unavailable('Tag signature verification'),
  repo_identity: () => {
    const source = (value: string) => ({ value, scope: 'demo', origin: 'Demo identity' });
    const identity = { identity: `${repo.identity.name} <${repo.identity.email}>`, error: null,
      name_source: source(repo.identity.name), email_source: source(repo.identity.email) };
    return { author: identity, committer: identity, local: { name: null, email: null } };
  },
  repo_set_identity: () => unavailable('Repository identity overrides'),
  git_global_identity: () => ({ name: repo.identity.name, email: repo.identity.email }),
  git_set_global_identity: ({ name, email }) => { repo.identity = { name: str(name), email: str(email) }; },
  workspace_file_read: () => unavailable('Reading .code-workspace files'),
  azdo_helper_status: () => ({ enabled: false, installed: false, version: null, protocol_version: null, profiles: [], authentication: [], error: null }),
  azdo_helper_enable: () => unavailable('The Azure DevOps credential helper'),
  azdo_helper_disable: () => unavailable('The Azure DevOps credential helper'),
  azdo_helper_remove: () => unavailable('The Azure DevOps credential helper'),
  azdo_profile_upsert: () => unavailable('Azure DevOps profiles'),
  azdo_profile_import_ca: () => unavailable('Azure DevOps profiles'),
  azdo_profile_remove: () => unavailable('Azure DevOps profiles'),
  azdo_profile_set_pat: () => unavailable('Azure DevOps profiles'),
  azdo_profile_clear_pat: () => unavailable('Azure DevOps profiles'),
  azdo_profile_test: () => unavailable('Azure DevOps profiles'),
  hosting_connection_status: () => ({
    github: { installed: true, connected: true, account: 'dana', detail: 'gh 2.62.0 · signed in as dana (demo)' },
    azure_dev_ops: { installed: false, connected: false, account: null, detail: 'az CLI not installed' },
  }),

  // ---- repository lifecycle ---------------------------------------------
  repo_init: () => unavailable('Creating repositories'),
  repo_clone: () => unavailable('Cloning'),
  repo_open: ({ path }) => {
    const p = str(path);
    try {
      return repo.meta(repo.worktree(p));
    } catch {
      throw new GitError(`could not find repository at '${p}' — the web demo ships one sample repository (${MAIN_PATH}) and its worktrees.`);
    }
  },
  repo_meta: (a) => repo.meta(wtOf(a)),
  repo_status: (a) => repo.status(wtOf(a)),
  repo_snapshot: (a) => repo.snapshot(wtOf(a)),
  repo_watch: () => undefined,
  repo_unwatch: () => undefined,
  repo_cancel_op: () => undefined,
  repo_refs: (a) => repo.refs(wtOf(a)),
  repo_submodules: () => [],
  repo_submodule_update: () => unavailable('Submodule updates'),
  repo_clone_scope: () => ({ shallow: false, remotes: [{ name: 'origin', filter: null, fetch_refspecs: ['+refs/heads/*:refs/remotes/origin/*'] }] }),
  repo_expand_history: () => unavailable('History downloads'),
  repo_sparse_checkout: () => unavailable('Sparse checkout'),
  repo_set_sparse_checkout: () => unavailable('Sparse checkout'),
  repo_disable_sparse_checkout: () => unavailable('Sparse checkout'),
  repo_maintenance: async ({ task }) => {
    await sleep(600);
    const command = task === 'garbage-collect' ? 'git gc' : task === 'integrity-check' ? 'git fsck --no-dangling' : 'git maintenance run';
    return { command, output: `${command}\nEnumerating objects: 128, done.\nnothing to prune (demo)`, success: true, duration_ms: 612 };
  },

  // ---- history -----------------------------------------------------------
  repo_log: (a) => repo.log(wtOf(a), a.limit == null ? 500 : Number(a.limit), Boolean(a.headOnly)),
  repo_search_log: (a) => repo.searchLog(wtOf(a), str(a.query), a.mode as 'message' | 'author' | 'content', a.limit == null ? 500 : Number(a.limit)),
  repo_commit_signature: (a) => {
    const c = repo.commit(repo.resolve(str(a.oid), wtOf(a)));
    return c.signed
      ? { kind: 'ssh', status: 'verified', signer: `${c.author_name} <${c.author_email}>`, key: 'SHA256:9kQx…demo', fingerprint: null, primary_fingerprint: null, trust: 'ultimate' }
      : { kind: null, status: 'unsigned', signer: null, key: null, fingerprint: null, primary_fingerprint: null, trust: null };
  },
  repo_commit_export_patch: () => unavailable('Exporting patches to disk'),
  repo_reflog: (a) => repo.reflog(wtOf(a), a.limit == null ? 100 : Number(a.limit)),
  repo_file_history: (a) => repo.fileHistory(wtOf(a), str(a.file), a.limit == null ? 200 : Number(a.limit)),
  repo_blame: (a) => repo.blame(wtOf(a), str(a.file)),
  repo_merge_base: (a) => {
    const wt = wtOf(a);
    const mb = repo.mergeBase(repo.resolve(str(a.a), wt), repo.resolve(str(a.b), wt));
    if (!mb) throw new GitError('no merge base');
    return mb;
  },
  repo_detect_base_branch: (a) => repo.detectBaseBranch(str(a.target)),

  // ---- diffs / files -----------------------------------------------------
  repo_diff_unstaged: (a) => repo.diffUnstaged(wtOf(a)),
  repo_diff_unstaged_paths: (a) => repo.diffUnstaged(wtOf(a)).map(({ path, old_path }) => ({ path, old_path })),
  repo_diff_unstaged_full: (a) => repo.diffUnstaged(wtOf(a), true),
  repo_diff_staged: (a) => repo.diffStaged(wtOf(a)),
  repo_diff_since: (a) => repo.diffSince(wtOf(a), str(a.baseline)),
  repo_diff_since_full: (a) => repo.diffSince(wtOf(a), str(a.baseline), true),
  repo_diff_between: (a) => repo.diffBetween(wtOf(a), str(a.from), str(a.to)),
  repo_diff_commit: (a) => repo.diffCommit(wtOf(a), str(a.oid)),
  repo_diff_commit_file: (a) => repo.diffCommit(wtOf(a), str(a.oid), str(a.file)),
  repo_diff_workdir_file: (a) => {
    const wt = wtOf(a);
    return repo.diffTrees(repo.headTree(wt), wt.workdir, 3, str(a.file));
  },
  repo_file_content: (a) => {
    const wt = wtOf(a);
    const file = str(a.file);
    const text = repo.fileText(wt, file, a.rev == null ? null : str(a.rev)) ?? wt.ignored.get(file);
    if (text == null) throw new GitError(`${file} does not exist${a.rev ? ` at ${str(a.rev)}` : ''}`);
    return { path: file, text, binary: false, truncated: false, editable: a.rev == null };
  },
  repo_file_write: (a) => {
    const wt = wtOf(a);
    const file = str(a.file);
    const current = wt.workdir.get(file) ?? '';
    if (current !== str(a.expected)) throw new GitError(`${file} changed on disk since it was opened`);
    repo.writeFile(wt, file, str(a.content));
    return { path: file, text: str(a.content), binary: false, truncated: false, editable: true };
  },
  repo_file_blob: (a) => {
    const wt = wtOf(a);
    const text = repo.fileText(wt, str(a.file), a.rev == null ? null : str(a.rev), Boolean(a.index)) ?? '';
    return { base64: btoa(unescape(encodeURIComponent(text))), size: text.length, too_large: false };
  },
  repo_file_create: (a) => {
    const wt = wtOf(a);
    const file = str(a.file);
    if (a.directory) { repo.writeFile(wt, `${file.replace(/\/$/, '')}/.gitkeep`, ''); return; }
    if (wt.workdir.has(file)) throw new GitError(`${file} already exists`);
    repo.writeFile(wt, file, '');
  },
  repo_file_delete: (a) => repo.deleteFiles(wtOf(a), a.files as string[]),
  repo_file_absolute_paths: (a) => (a.files as string[]).map((f) => `${wtOf(a).path}/${f}`),
  repo_file_reveal: () => unavailable('Revealing files in Finder/Explorer'),
  repo_move_path: (a) => repo.movePath(wtOf(a), str(a.from), str(a.to)),
  repo_tree: (a) => repo.workTree(wtOf(a), Boolean(a.includeIgnored)),
  repo_tree_ignored_children: (a) => repo.ignoredChildren(wtOf(a), str(a.directory)),
  repo_tree_at: (a) => repo.treeAt(str(a.rev), wtOf(a)),
  repo_gitignore_add: (a) => {
    const wt = wtOf(a);
    const current = wt.workdir.get('.gitignore') ?? '';
    repo.writeFile(wt, '.gitignore', `${current.replace(/\n?$/, '\n')}${str(a.pattern)}\n`);
    const pattern = str(a.pattern).replace(/\/$/, '');
    for (const path of [...wt.workdir.keys()]) {
      if (path === pattern || path.startsWith(`${pattern}/`) || path.endsWith(`/${pattern}`)) {
        if (!wt.index.has(path)) { wt.ignored.set(path, wt.workdir.get(path)!); wt.workdir.delete(path); }
      }
    }
  },
  repo_read_conflict_file: () => unavailable('Conflict resolution'),
  repo_resolve_conflict: () => unavailable('Conflict resolution'),
  repo_open_mergetool: () => unavailable('External merge tools'),
  repo_open_in_editor: () => unavailable('Opening an external editor'),
  repo_open_in_terminal: () => unavailable('Opening an external terminal'),

  // ---- index / commits ---------------------------------------------------
  repo_stage: (a) => repo.stage(wtOf(a), str(a.file)),
  repo_unstage: (a) => repo.unstage(wtOf(a), str(a.file)),
  repo_stage_many: (a) => { const wt = wtOf(a); for (const f of a.files as string[]) repo.stage(wt, f); },
  repo_unstage_many: (a) => { const wt = wtOf(a); for (const f of a.files as string[]) repo.unstage(wt, f); },
  repo_discard: (a) => repo.discard(wtOf(a), str(a.file)),
  repo_discard_many: (a) => { const wt = wtOf(a); for (const f of a.files as string[]) repo.discard(wt, f); },
  repo_apply_patch: (a) => repo.applyPatchTo(wtOf(a), str(a.patch), a.target as 'index' | 'index_reverse' | 'workdir_reverse' | 'workdir'),
  repo_commit: (a) => {
    if (a.signing === 'sign') return unavailable('Commit signing');
    const c = repo.commitIndex(wtOf(a), str(a.subject), a.body == null ? null : str(a.body), Boolean(a.amend));
    return { oid: c.hash, amended: Boolean(a.amend), output: 'Demo commit created.' };
  },

  // ---- branches / tags / remotes -----------------------------------------
  repo_checkout: (a) => { const wt = wtOf(a); repo.checkout(wt, str(a.branch)); return { branch: wt.branch ?? str(a.branch) }; },
  repo_checkout_commit: (a) => { const wt = wtOf(a); repo.checkout(wt, str(a.rev)); return { branch: repo.headOf(wt).slice(0, 7) }; },
  repo_branch_create: (a) => {
    const wt = wtOf(a);
    repo.createBranch(wt, str(a.name), a.startPoint == null ? null : str(a.startPoint), Boolean(a.checkout));
    return { branch: a.checkout ? str(a.name) : wt.branch ?? '' };
  },
  repo_branch_delete: (a) => repo.deleteBranch(wtOf(a), str(a.name), Boolean(a.force)),
  repo_branch_delete_at: (a) => {
    if (repo.branches.get(str(a.name)) !== str(a.expectedTarget)) throw new GitError(`${str(a.name)} moved since it was listed`);
    repo.deleteBranch(wtOf(a), str(a.name), true);
  },
  repo_branch_rename: (a) => repo.renameBranch(str(a.oldName), str(a.newName)),
  repo_branch_set_upstream: (a) => {
    if (a.upstream == null) repo.upstreams.delete(str(a.branch));
    else repo.upstreams.set(str(a.branch), str(a.upstream));
  },
  repo_branch_delete_remote: async (a) => {
    await streamProgress(a.onEvent as Channel<Progress>, ['Deleting'], `To github.com:acme/acme-api.git\n - [deleted]         ${str(a.branch)}`);
    repo.remoteBranches.delete(`${str(a.remote)}/${str(a.branch)}`);
    return { output: ` - [deleted]         ${str(a.branch)}` };
  },
  repo_remote_add: (a) => { repo.remotes.push({ name: str(a.name), url: str(a.url), push_url: a.pushUrl == null ? null : str(a.pushUrl), fetch_refspecs: [`+refs/heads/*:refs/remotes/${str(a.name)}/*`], push_refspecs: [], is_default: false }); },
  repo_remote_remove: (a) => {
    const idx = repo.remotes.findIndex((r) => r.name === str(a.name));
    if (idx === -1) throw new GitError(`remote '${str(a.name)}' not found`);
    repo.remotes.splice(idx, 1);
    for (const key of [...repo.remoteBranches.keys()]) if (key.startsWith(`${str(a.name)}/`)) repo.remoteBranches.delete(key);
  },
  repo_remote_rename: (a) => {
    const r = repo.remotes.find((x) => x.name === str(a.oldName));
    if (!r) throw new GitError(`remote '${str(a.oldName)}' not found`);
    r.name = str(a.newName);
    for (const [key, tip] of [...repo.remoteBranches.entries()]) {
      if (key.startsWith(`${str(a.oldName)}/`)) { repo.remoteBranches.delete(key); repo.remoteBranches.set(`${str(a.newName)}/${key.split('/').slice(1).join('/')}`, tip); }
    }
    for (const [b, up] of [...repo.upstreams.entries()]) if (up.startsWith(`${str(a.oldName)}/`)) repo.upstreams.set(b, `${str(a.newName)}/${up.split('/').slice(1).join('/')}`);
    return [];
  },
  repo_remote_set_urls: (a) => { const r = repo.remotes.find((x) => x.name === str(a.name)); if (r) { r.url = str(a.url); r.push_url = a.pushUrl == null ? null : str(a.pushUrl); } },
  repo_remote_set_default: (a) => { for (const r of repo.remotes) r.is_default = r.name === str(a.name); },
  repo_remote_tags: () => repo.tags.map((t) => t.name),
  repo_tag_create: (a) => {
    if (a.signing === 'sign') return unavailable('Tag signing');
    return repo.tagCreate(wtOf(a), str(a.name), a.target == null ? null : str(a.target), a.message == null ? null : str(a.message), Boolean(a.force));
  },
  repo_tag_delete: (a) => repo.tagDelete(str(a.name)),
  repo_tag_push: async (a) => {
    await streamProgress(a.onEvent as Channel<Progress>, ['Writing objects'], 'done');
    return { output: a.delete ? ` - [deleted]         ${str(a.tag)}` : ` * [new tag]         ${str(a.tag)} -> ${str(a.tag)}` };
  },
  repo_tag_push_all: async (a) => {
    await streamProgress(a.onEvent as Channel<Progress>, ['Writing objects'], 'done');
    return { output: 'Everything up-to-date' };
  },

  // ---- network -----------------------------------------------------------
  repo_fetch: async (a) => {
    await streamProgress(a.onEvent as Channel<Progress>, ['Receiving objects', 'Resolving deltas'], 'From github.com:acme/acme-api');
    return { output: 'From github.com:acme/acme-api\n = [up to date]      main       -> origin/main' };
  },
  repo_pull: async (a) => {
    const wt = wtOf(a);
    await streamProgress(a.onEvent as Channel<Progress>, ['Receiving objects', 'Resolving deltas'], 'Updating');
    return { output: repo.pull(wt) };
  },
  repo_push: async (a) => {
    const wt = wtOf(a);
    if (!wt.branch) throw new GitError('cannot push a detached HEAD');
    const upstream = repo.upstreams.get(wt.branch);
    const remoteTip = upstream ? repo.remoteBranches.get(upstream) : undefined;
    if (a.mode === 'default' && remoteTip && !repo.ancestors(repo.headOf(wt)).has(remoteTip)) {
      throw new GitError(`! [rejected]        ${wt.branch} -> ${wt.branch} (non-fast-forward)\nhint: Updates were rejected because the tip of your current branch is behind its remote counterpart.`);
    }
    await streamProgress(a.onEvent as Channel<Progress>, ['Counting objects', 'Compressing objects', 'Writing objects'], 'done');
    return { output: repo.push(wt) };
  },
  repo_branch_push: async (a) => {
    const request = a.request as { branch: string; remote: string; remoteBranch: string; setUpstream: boolean };
    await streamProgress(a.onEvent as Channel<Progress>, ['Counting objects', 'Writing objects'], 'done');
    const tip = repo.branches.get(request.branch);
    if (!tip) throw new GitError(`branch '${request.branch}' not found`);
    repo.remoteBranches.set(`${request.remote}/${request.remoteBranch}`, tip);
    if (request.setUpstream) repo.upstreams.set(request.branch, `${request.remote}/${request.remoteBranch}`);
    return { output: `To github.com:acme/acme-api.git\n * [new branch]      ${request.branch} -> ${request.remoteBranch}` };
  },
  repo_branch_fetch: async (a) => {
    await streamProgress(a.onEvent as Channel<Progress>, ['Receiving objects'], 'done');
    return { output: `From github.com:acme/acme-api\n = [up to date]      ${str(a.branch)} -> ${str(a.remote)}/${str(a.branch)}` };
  },
  repo_branch_pull: async (a) => {
    const wt = wtOf(a);
    await streamProgress(a.onEvent as Channel<Progress>, ['Receiving objects'], 'done');
    if (wt.branch !== str(a.branch)) return { output: 'Already up to date.' };
    return { output: repo.pull(wt) };
  },

  // ---- history rewriting -------------------------------------------------
  repo_cherry_pick: (a) => { repo.cherryPick(wtOf(a), a.commits as string[]); return false; },
  repo_revert: (a) => { repo.revert(wtOf(a), a.commits as string[]); return false; },
  repo_merge: (a) => { repo.merge(wtOf(a), str(a.refname), a.mode as 'auto' | 'no_ff' | 'squash'); return false; },
  repo_rebase: (a) => { repo.rebase(wtOf(a), str(a.onto)); return false; },
  repo_reset: (a) => {
    const wt = wtOf(a);
    const snapshot = repo.reset(wt, str(a.target), a.mode as 'soft' | 'mixed' | 'hard');
    return { target_short: repo.headOf(wt).slice(0, 7), snapshot_oid: snapshot };
  },
  repo_abort_operation: () => undefined,
  repo_continue_operation: () => false,
  repo_rebase_todo: (a) => repo.rebaseTodo(wtOf(a), a.base == null ? null : str(a.base)),
  repo_interactive_rebase: (a) => { repo.interactiveRebase(wtOf(a), a.base == null ? null : str(a.base), a.steps as never); return false; },

  // ---- stash -------------------------------------------------------------
  repo_stash_list: () => repo.stashList(),
  repo_stash_save: (a) => ({ oid: repo.stashSave(wtOf(a), a.message == null ? null : str(a.message), Boolean(a.includeUntracked), Boolean(a.keepIndex)) }),
  repo_stash_snapshot: (a) => ({ oid: repo.stashSave(wtOf(a), a.message == null ? null : str(a.message), Boolean(a.includeUntracked), false, true) }),
  repo_stash_push_paths: (a) => ({ oid: repo.stashSave(wtOf(a), a.message == null ? null : str(a.message), Boolean(a.includeUntracked), Boolean(a.keepIndex), Boolean(a.snapshot), a.paths as string[]) }),
  repo_stash_apply: (a) => repo.stashApply(wtOf(a), Number(a.index), false),
  repo_stash_pop: (a) => repo.stashApply(wtOf(a), Number(a.index), true),
  repo_stash_drop: (a) => repo.stashDrop(Number(a.index)),
  repo_stash_branch: (a) => repo.stashBranch(wtOf(a), Number(a.index), str(a.branch)),

  // ---- worktrees ---------------------------------------------------------
  repo_worktrees: (a) => repo.listWorktrees(wtOf(a)),
  repo_worktree_stats: (a) => repo.worktreeStats(wtOf(a)),
  repo_worktree_health: (a) => repo.worktreeHealth(str(a.target)),
  repo_worktree_include_patterns: (a) => (wtOf(a).workdir.get('.worktreeinclude') ?? '').split('\n').filter((l) => l && !l.startsWith('#')),
  repo_worktree_copy_include: (a) => {
    const from = wtOf(a);
    const to = repo.worktree(str(a.dest));
    const copied: string[] = [];
    for (const [path, text] of from.ignored) if (path === '.env') { to.ignored.set(path, text); copied.push(path); }
    return copied;
  },
  repo_worktree_add: (a) => repo.addLinkedWorktree(str(a.dest), str(a.branch), Boolean(a.newBranch), a.startPoint == null ? null : str(a.startPoint), wtOf(a)),
  repo_worktree_lock: (a) => { const wt = repo.worktree(str(a.dest)); wt.locked = true; wt.lockReason = a.reason == null ? null : str(a.reason); },
  repo_worktree_unlock: (a) => { const wt = repo.worktree(str(a.dest)); wt.locked = false; wt.lockReason = null; },
  repo_worktree_remove: (a) => repo.removeWorktree(str(a.dest), Boolean(a.force)),
  repo_worktree_prune: () => undefined,
  repo_worktree_move: (a) => {
    const wt = repo.worktree(str(a.dest));
    if (wt.locked && !a.force) throw new GitError(`cannot move a locked working tree (${wt.lockReason ?? 'locked'})`);
    repo.worktrees.delete(wt.path);
    wt.path = str(a.newPath).replace(/\/+$/, '');
    repo.worktrees.set(wt.path, wt);
  },
  repo_worktree_repair: () => undefined,
  repo_worktree_integrate: (a) => repo.integrate(str(a.branch), str(a.base), str(a.mode)),
  repo_worktree_archive: (a) => repo.archiveWorktree(str(a.path)),
  repo_worktree_archives: () => repo.archives.map(({ ref_name, name, oid, time_unix, subject }) => ({ ref_name, name, oid, time_unix, subject })),
  repo_worktree_archive_restore: (a) => repo.restoreArchive(str(a.refName), str(a.dest)),
  repo_worktree_archive_delete: (a) => repo.deleteArchive(str(a.refName)),

  // ---- terminal ----------------------------------------------------------
  terminal_shell_check: ({ shell }) => {
    const kind = (shell as { kind: string }).kind;
    return { available: kind === 'system', label: kind === 'system' ? 'demo shell' : kind, executable: kind === 'system' ? '/bin/zsh' : null, error: kind === 'system' ? null : 'Only the system shell is scripted in the web demo' };
  },
  terminal_wsl_distributions: () => [],
  repo_terminal_create: (a) => {
    const wt = wtOf(a);
    const id = `term-${fakeOid(`${wt.path}${Date.now()}${terminals.size}`).slice(0, 8)}`;
    const channel = a.onEvent as Channel<TerminalEvent>;
    const term = new DemoTerminal(repo, wt, (event) => channel.onmessage(event));
    terminals.set(id, { term, path: wt.path });
    return { id, label: 'zsh' };
  },
  terminal_write: (a) => terminals.get(str(a.id))?.term.input(str(a.data)),
  terminal_resize: () => undefined,
  terminal_close: (a) => { terminals.get(str(a.id))?.term.close(); terminals.delete(str(a.id)); },
  repo_terminal_close_all: (a) => {
    for (const [id, t] of [...terminals]) if (t.path === str(a.path)) { t.term.close(); terminals.delete(id); }
  },
  repo_terminal_count: (a) => [...terminals.values()].filter((t) => t.path === str(a.path)).length,

  // ---- pull requests -----------------------------------------------------
  repo_pull_requests: async () => {
    await sleep(250);
    return { repository: world.prRepository, pull_requests: world.pullRequests };
  },
  repo_pull_request: async (a) => { await sleep(120); return pr(a.id); },
  repo_pull_request_for_branch: (a) => {
    const hit = world.pullRequests.find((p) => p.source_branch === str(a.branch) && p.state === 'open');
    return hit ? { repository: world.prRepository, pull_request: hit } : null;
  },
  repo_pull_request_diff: async (a) => { await sleep(150); return world.prDiffs.get(Number(a.id))?.() ?? ''; },
  repo_pull_request_activity: (a) => {
    const p = pr(a.id);
    return {
      repository: world.prRepository, id: p.id, title: p.title, url: p.url, state: p.state,
      source_branch: p.source_branch, source_commit: p.source_commit, updated_at: p.updated_at,
      comments: p.comments.map((c) => ({ id: c.id, author: c.author, kind: 'comment', is_system: c.is_system })),
      reviews: p.reviews.map((r) => ({ id: r.id, author: r.author, state: r.state })),
      checks: p.checks.map((c, i) => ({ id: `${p.id}-check-${i}`, name: c.name, status: c.status })),
      checks_complete: true,
    };
  },
  repo_pull_request_create: (a) => {
    const id = Math.max(...world.pullRequests.map((p) => p.id)) + 1;
    const tip = repo.branches.get(str(a.sourceBranch));
    if (!tip) throw new GitError(`branch '${str(a.sourceBranch)}' not found`);
    const created = new Date().toISOString();
    world.pullRequests.unshift({
      id, title: str(a.title), state: 'open', is_draft: Boolean(a.isDraft), can_mark_ready: Boolean(a.isDraft), author: 'dana',
      source_branch: str(a.sourceBranch), source_commit: tip, target_branch: str(a.targetBranch), created_at: created, updated_at: created,
      completed_at: null, url: `https://github.com/acme/acme-api/pull/${id}`, description: str(a.description), merge_status: 'CLEAN',
      review_status: 'REVIEW_REQUIRED', comment_count: 0, commit_count: repo.aheadCount(tip, repo.resolve(str(a.targetBranch))),
      additions: null, deletions: null, changed_files: null, labels: [], reviewers: [], checks: [{ name: 'ci / test', status: 'PENDING' }],
      checks_complete: true, comments: [], review_threads: [], reviews: [], authored_by_viewer: true, commits: [],
    });
    world.prDiffs.set(id, () => repo.branchPatch(str(a.sourceBranch), str(a.targetBranch)));
    return { id, url: `https://github.com/acme/acme-api/pull/${id}` };
  },
  repo_pull_request_comment: (a) => {
    const p = pr(a.id);
    p.comments.push(prComment('dana', str(a.body), null, p.id));
    p.comment_count += 1;
    p.updated_at = new Date().toISOString();
  },
  repo_pull_request_inline_comment: (a) => {
    const p = pr(a.id);
    const comment = prComment('dana', str(a.body), str(a.filePath), p.id);
    p.review_threads.push({
      id: `t${p.id}-${comment.id}`, path: str(a.filePath), start_line: Number(a.startLine), end_line: Number(a.endLine),
      side: a.side as 'deletions' | 'additions', is_resolved: false, is_outdated: false, can_reply: true, can_resolve: true, can_unresolve: false,
      comments: [comment],
    });
    p.comment_count += 1;
  },
  repo_pull_request_submit_review: (a) => {
    const p = pr(a.id);
    const event = str(a.event);
    const state = event === 'approve' ? 'APPROVED' : event === 'request_changes' ? 'CHANGES_REQUESTED' : 'COMMENTED';
    p.reviews.push({ id: `r${p.id}-${Date.now()}`, author: 'dana', avatar_url: null, state, body: str(a.body), submitted_at: new Date().toISOString(), url: `${p.url}#pullrequestreview-demo`, can_update: true, can_dismiss: true });
    for (const c of (a.comments as Array<{ path: string; start_line: number; end_line: number; side: 'deletions' | 'additions'; body: string }>) ?? []) {
      const comment = prComment('dana', c.body, c.path, p.id);
      p.review_threads.push({ id: `t${p.id}-${comment.id}`, path: c.path, start_line: c.start_line, end_line: c.end_line, side: c.side, is_resolved: false, is_outdated: false, can_reply: true, can_resolve: true, can_unresolve: false, comments: [comment] });
      p.comment_count += 1;
    }
    if (state !== 'COMMENTED') p.review_status = state;
    p.updated_at = new Date().toISOString();
  },
  repo_pull_request_update_review: (a) => {
    const p = pr(a.id);
    const r = p.reviews.find((x) => x.id === str(a.reviewId));
    if (!r) throw new GitError('review not found');
    r.body = str(a.body);
  },
  repo_pull_request_dismiss_review: (a) => {
    const p = pr(a.id);
    const r = p.reviews.find((x) => x.id === str(a.reviewId));
    if (!r) throw new GitError('review not found');
    r.state = 'DISMISSED';
    if (p.review_status === 'CHANGES_REQUESTED' || p.review_status === 'APPROVED') p.review_status = 'REVIEW_REQUIRED';
  },
  repo_pull_request_thread_reply: (a) => {
    for (const p of world.pullRequests) {
      const t = p.review_threads.find((x) => x.id === str(a.threadId));
      if (t) { const c = prComment('dana', str(a.body), t.path, p.id); t.comments.push(c); p.comment_count += 1; return c; }
    }
    throw new GitError('thread not found');
  },
  repo_pull_request_thread_resolve: (a) => {
    for (const p of world.pullRequests) {
      const t = p.review_threads.find((x) => x.id === str(a.threadId));
      if (t) {
        t.is_resolved = Boolean(a.resolved);
        t.can_resolve = !t.is_resolved;
        t.can_unresolve = t.is_resolved;
        return { id: t.id, is_resolved: t.is_resolved, is_outdated: t.is_outdated, can_reply: true, can_resolve: t.can_resolve, can_unresolve: t.can_unresolve };
      }
    }
    throw new GitError('thread not found');
  },
  repo_pull_request_merge: async (a) => {
    const p = pr(a.id);
    if (p.source_commit !== str(a.expectedHead)) throw new GitError('the pull request head moved; refresh and try again');
    await sleep(500);
    if (repo.branches.has(p.source_branch) && repo.branches.has(p.target_branch)) {
      const mode = a.strategy === 'squash' ? 'squash' : a.strategy === 'rebase' ? 'ff' : 'merge';
      try { repo.integrate(p.source_branch, p.target_branch, mode); } catch { /* remote-only branch */ }
      const tip = repo.branches.get(p.target_branch)!;
      repo.remoteBranches.set(`origin/${p.target_branch}`, tip);
    }
    p.state = 'merged';
    p.completed_at = new Date().toISOString();
    p.updated_at = p.completed_at;
  },
  repo_pull_request_ready: (a) => { const p = pr(a.id); p.is_draft = false; p.can_mark_ready = false; },
  repo_pull_request_lifecycle: (a) => {
    const p = pr(a.id);
    p.state = a.action === 'close' ? 'closed' : 'open';
    p.completed_at = a.action === 'close' ? new Date().toISOString() : null;
    p.updated_at = new Date().toISOString();
  },
  repo_pull_request_update_branch: async (a) => {
    const p = pr(a.id);
    await sleep(400);
    if (repo.branches.has(p.source_branch)) {
      const wt = [...repo.worktrees.values()].find((w) => w.branch === p.source_branch);
      if (wt) repo.merge(wt, p.target_branch, 'no_ff');
      p.source_commit = repo.branches.get(p.source_branch)!;
    }
    p.merge_status = 'CLEAN';
  },
  repo_pull_request_prepare_checkout: (a) => {
    const p = pr(a.id);
    return { branch: p.source_branch, start_point: repo.branches.has(p.source_branch) ? p.source_branch : `origin/${p.source_branch}` };
  },

  // ---- AI ----------------------------------------------------------------
  ai_provider_status: ({ provider }) => ({ provider, installed: true, logged_in: true, account_hint: 'demo@acme.dev', error: null }),
  ai_provider_login: () => unavailable('Signing in to an AI provider'),
  ai_provider_logout: () => unavailable('Signing out of an AI provider'),
  repo_suggest_commit_message: async (a) => {
    const wt = wtOf(a);
    await sleep(900);
    const staged = repo.diffStaged(wt);
    const files = staged.map((d) => d.path);
    const subject = files.length === 0
      ? 'chore: no staged changes'
      : files.every((f) => f.startsWith('docs/')) ? 'docs: update documentation'
        : files.some((f) => f.includes('retry') || f.includes('backoff')) ? 'feat(auth): cap retry backoff and surface exhaustion'
          : files.some((f) => f.includes('errors')) ? 'feat(auth): add RetryExhaustedError'
            : `chore: update ${files[0].split('/').pop()}${files.length > 1 ? ` and ${files.length - 1} more` : ''}`;
    const suggestion: CommitMessageSuggestion = {
      subject,
      body: files.length ? `Touches ${files.length} file${files.length === 1 ? '' : 's'}:\n${files.map((f) => `- ${f}`).join('\n')}` : null,
    };
    return generated('staged', files.length, suggestion, a);
  },
  repo_suggest_pull_request: async (a) => {
    await sleep(1100);
    const wt = wtOf(a);
    const commits = repo.log(wt, 20, true).filter((c) => !repo.ancestors(repo.resolve(str(a.targetBranch))).has(c.hash));
    const suggestion: PullRequestSuggestion = {
      title: commits[commits.length - 1]?.subject ?? `Merge ${wt.branch} into ${str(a.targetBranch)}`,
      description: `## Summary\n\n${commits.map((c) => `- ${c.subject}`).join('\n')}\n\n## Test plan\n\n- [ ] \`pnpm test\`\n- [ ] Verify retry behaviour against a flaky upstream`,
    };
    return generated('committed', commits.length, suggestion, a);
  },
  repo_review_changes: async (a) => {
    const wt = wtOf(a);
    await sleep(1400);
    const diffs = a.baseline == null ? repo.diffUnstaged(wt) : repo.diffSince(wt, str(a.baseline));
    const suggestion: CodeReviewSuggestion = { findings: [] };
    if (diffs.some((d) => d.path === 'src/auth/backoff.ts')) {
      suggestion.findings.push({ path: 'src/auth/backoff.ts', line: 7, side: 'new', severity: 'medium', title: 'Full jitter can return 0 ms', body: '`Math.random() * capped` may yield a zero delay, so a burst of failures can retry with no pause at all. Consider `capped / 2 + Math.random() * capped / 2` (equal jitter) or a floor.' });
    }
    if (diffs.some((d) => d.path === 'src/auth/retry.ts')) {
      suggestion.findings.push({ path: 'src/auth/retry.ts', line: 15, side: 'new', severity: 'low', title: '429 should honour Retry-After', body: 'Rate-limited responses usually carry a `Retry-After` header; the backoff curve ignores it and may retry too early.' });
    }
    if (diffs.some((d) => d.path === 'src/api/client.ts')) {
      suggestion.findings.push({ path: 'src/api/client.ts', line: 14, side: 'new', severity: 'high', title: 'Retry wraps an aborted fetch', body: 'When the timeout fires, `controller.abort()` rejects with an AbortError that `isTransient` treats as a TypeError — the request is retried after the caller already gave up. Check `error.name === "AbortError"` before retrying.' });
    }
    if (suggestion.findings.length === 0) {
      suggestion.findings.push({ path: diffs[0]?.path ?? 'README.md', line: null, side: 'new', severity: 'low', title: 'No blocking issues found', body: 'The change reads cleanly. Consider adding a test for the new behaviour.' });
    }
    return generated(a.baseline == null ? 'unstaged' : 'review', diffs.length, suggestion, a);
  },

  // ---- Heroi (agent chat) -------------------------------------------------
  heroi_provider_models: ({ provider }) => ({
    provider,
    models: [
      { slug: 'default', name: 'Default', isDefault: true, reasoning: [{ id: 'medium', label: 'Medium', isDefault: true }, { id: 'high', label: 'High', isDefault: false }] },
    ],
  }),
  heroi_skills: () => [{ name: 'review-pr', description: 'Review a pull request against the team style guide', scope: 'project' }],
  heroi_agent_send: async (a) => {
    const channel = a.onEvent as Channel<HeroiAgentEvent>;
    const request = a.request as { prompt: string; sessionId: string | null };
    const sessionId = request.sessionId ?? `demo-${fakeOid(String(Date.now())).slice(0, 8)}`;
    const emit = (e: HeroiAgentEvent) => channel.onmessage(e);
    emit({ type: 'session', sessionId });
    emit({ type: 'status', message: 'Thinking…' });
    await sleep(500);
    emit({ type: 'activity', id: 'read-1', label: 'Read src/auth/retry.ts', detail: null, done: false });
    await sleep(600);
    emit({ type: 'activity', id: 'read-1', label: 'Read src/auth/retry.ts', detail: '38 lines', done: true });
    const reply = `This is the Strand web demo, so I can't run a real agent here — in the desktop app this panel talks to Claude Code, Codex or Cursor through their CLIs.\n\nYou asked: *${request.prompt.slice(0, 160)}*\n\nWhat you'd normally see: the agent's plan, each file it touches, and its final summary, while the Review view on the left fills in with the exact diff to approve or push back on.`;
    for (const word of reply.split(/(?<=\s)/)) {
      await sleep(18);
      emit({ type: 'text', text: word });
    }
    return { sessionId };
  },
};

/** Route one IPC command to its demo handler. Rejections mirror `CmdError`. */
export async function dispatch(cmd: string, args: Args): Promise<unknown> {
  const handler = handlers[cmd];
  if (!handler) throw { message: `${cmd} isn't available in the web demo.` };
  try {
    return await handler(args ?? {});
  } catch (e) {
    if (e instanceof GitError || e instanceof DemoUnavailable) throw { message: e.message };
    throw e;
  }
}
