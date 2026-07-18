import { useEffect, useMemo, useState } from 'react';

import { Diff } from '../components/Diff';
import { Icon } from '../components/Icon';
import { ImageDiff } from '../components/ImageDiff';
import { isImagePath } from '../lib/image';
import { errMessage } from '../lib/tauri';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';
import type { Commit, DiffStatus, FileDiff, Stash } from '../lib/types';
import { MainlineDialog, type MainlineOperation } from './MainlineDialog';

/**
 * Right-side panel shown when a commit is selected in the All Commits
 * graph. Renders the commit's subject + body, a metadata grid, the list
 * of changed files, and a `<Diff />` for the currently focused file.
 *
 * Lifecycle: `useRepo.selectCommit(hash)` populates `selectedCommit` and
 * fetches `selectedCommitDiffs` via `repo_diff_commit`. The component
 * picks the first file by default whenever the commit changes.
 */
export function CommitDetail({
  onCreateTag,
  onInteractiveRebase,
  onToast,
}: {
  /** Open the New-tag dialog targeting this commit (revspec + label). */
  onCreateTag: (target: string, label: string) => void;
  /** Open the interactive-rebase editor over `base..HEAD` (base null = root). */
  onInteractiveRebase: (base: string | null, label: string) => void;
  /** Surface cherry-pick / revert success or git's conflict message. */
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const selectedCommit = useRepo((s) => s.selectedCommit);
  const diffs = useRepo((s) => s.selectedCommitDiffs);
  const loading = useRepo((s) => s.selectedCommitDiffsLoading);
  const commits = useRepo((s) => s.commits);
  const searchResults = useRepo((s) => s.commitSearchResults);
  const stashes = useRepo((s) => s.stashes);
  const selectCommit = useRepo((s) => s.selectCommit);
  const checkoutCommit = useRepo((s) => s.checkoutCommit);
  const cherryPick = useRepo((s) => s.cherryPick);
  const revert = useRepo((s) => s.revert);
  const stashApply = useRepo((s) => s.stashApply);
  const stashPop = useRepo((s) => s.stashPop);
  const diffMode = useSettings((s) => s.diffMode);
  const layout = diffMode === 'split' ? 'split' : 'unified';

  // A stash node selected in the graph isn't in `commits`; resolve it from the
  // stash list and render a synthetic commit (its diff is base→stash, already
  // loaded via repo_diff_commit) with stash-specific actions.
  const stash = useMemo(
    () => stashes.find((s) => s.oid === selectedCommit) ?? null,
    [stashes, selectedCommit],
  );
  // Prefer the loaded graph window; fall back to a full-history search result
  // (so a commit the search surfaced from beyond the window still renders its
  // header here — its diff loads by oid regardless), then a stash node.
  const commit = useMemo(
    () =>
      commits.find((c) => c.hash === selectedCommit) ??
      searchResults.find((c) => c.hash === selectedCommit) ??
      (stash ? stashCommit(stash) : null),
    [commits, searchResults, selectedCommit, stash],
  );

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  useEffect(() => {
    setSelectedFile(diffs[0]?.path ?? null);
  }, [diffs]);

  // Detached-HEAD checkout of this commit. Errors (e.g. a dirty working tree
  // that would be overwritten) surface inline rather than silently failing.
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  // Reset transient checkout state whenever the selected commit changes.
  useEffect(() => {
    setCheckoutError(null);
    setCheckingOut(false);
  }, [selectedCommit]);

  // Cherry-pick / revert (commit) + apply / pop (stash) in-flight guards. These
  // must sit *above* the early return below: a selected stash can leave the
  // list while the panel is mounted (pop / drop), flipping `commit` to null —
  // and hooks after a conditional return would change in count and crash React.
  const [historyBusy, setHistoryBusy] = useState(false);
  const [stashBusy, setStashBusy] = useState(false);
  const [mainlineAction, setMainlineAction] = useState<MainlineOperation | null>(null);

  if (!commit) return null;

  const hash = commit.hash;
  async function onCheckout() {
    if (checkingOut) return;
    setCheckingOut(true);
    setCheckoutError(null);
    try {
      await checkoutCommit(hash);
    } catch (e) {
      setCheckoutError(errMessage(e));
    } finally {
      setCheckingOut(false);
    }
  }

  // Cherry-pick / revert this commit onto HEAD. Both can conflict — surface
  // git's message via a toast rather than the inline (single-line) slot.
  async function onCherryPick() {
    if (historyBusy) return;
    if (commit!.parents.length > 1) {
      setMainlineAction('cherry-pick');
      return;
    }
    setHistoryBusy(true);
    try {
      const conflicted = await cherryPick([hash]);
      onToast(
        conflicted
          ? `Cherry-pick of ${commit!.short_hash} has conflicts — resolve in Local Changes`
          : `Cherry-picked ${commit!.short_hash}`,
      );
    } catch (e) {
      onToast(`Cherry-pick failed: ${errMessage(e)}`, 'error');
    } finally {
      setHistoryBusy(false);
    }
  }
  async function onRevert() {
    if (historyBusy) return;
    if (commit!.parents.length > 1) {
      setMainlineAction('revert');
      return;
    }
    setHistoryBusy(true);
    try {
      const conflicted = await revert([hash]);
      onToast(
        conflicted
          ? `Revert of ${commit!.short_hash} has conflicts — resolve in Local Changes`
          : `Reverted ${commit!.short_hash}`,
      );
    } catch (e) {
      onToast(`Revert failed: ${errMessage(e)}`, 'error');
    } finally {
      setHistoryBusy(false);
    }
  }

  // Apply / Pop the selected stash. Pop drops it on success, so the panel
  // closes itself (the oid leaves the stash list → `commit` becomes null).
  // Drop (unrecoverable) stays behind the right-click menu's confirm step.
  async function onStashApply(pop: boolean) {
    if (stashBusy || !stash) return;
    setStashBusy(true);
    try {
      if (pop) await stashPop(stash.index);
      else await stashApply(stash.index);
      onToast(`${pop ? 'Popped' : 'Applied'} stash@{${stash.index}}`);
      // Pop removes the stash, so this panel's subject no longer resolves —
      // close it rather than leaving an empty strip.
      if (pop) void selectCommit(null);
    } catch (e) {
      onToast(`${pop ? 'Pop' : 'Apply'} failed: ${errMessage(e)}`, 'error');
    } finally {
      setStashBusy(false);
    }
  }

  const focused = diffs.find((d) => d.path === selectedFile) ?? null;

  return (
    <>
      <aside className="commit-detail">
        <div className="cd-head">
        <div className="cd-head-row">
          <div className="msg-subj">{commit.subject}</div>
          <button
            type="button"
            className="cd-close"
            aria-label="Close commit detail"
            onClick={() => void selectCommit(null)}
          >
            ×
          </button>
        </div>
        {commit.body ? <pre className="msg-body">{commit.body}</pre> : null}
        <div className="cd-meta">
          {commit.author_name ? (
            <>
              <span className="k">author</span>
              <span className="v">
                {commit.author_name}
                {commit.author_email ? ` <${commit.author_email}>` : ''}
              </span>
            </>
          ) : null}
          <span className="k">date</span>
          <span className="v">{formatFullDate(commit.time_unix)}</span>
          <span className="k">commit</span>
          <span className="v" title={commit.hash}>
            {commit.hash}
          </span>
          {commit.parents.length > 0 ? (
            <>
              <span className="k">{commit.parents.length > 1 ? 'parents' : 'parent'}</span>
              <span className="v">
                {commit.parents.map((p, i) => (
                  <span key={p}>
                    {i > 0 ? ' ' : ''}
                    {p.slice(0, 7)}
                  </span>
                ))}
              </span>
            </>
          ) : null}
        </div>
        <div className="cd-actions">
          {stash ? (
            <>
              <button
                type="button"
                className="btn ghost cd-action-btn"
                disabled={stashBusy}
                onClick={() => void onStashApply(false)}
                title="Apply this stash, keeping it on the stack"
              >
                <Icon name="arrow-down" size={12} />
                Apply
              </button>
              <button
                type="button"
                className="btn ghost cd-action-btn"
                disabled={stashBusy}
                onClick={() => void onStashApply(true)}
                title="Apply this stash and drop it from the stack"
              >
                <Icon name="stash" size={12} />
                Pop
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn ghost cd-action-btn"
                disabled={checkingOut}
                onClick={() => void onCheckout()}
                title="Check out this commit (detached HEAD)"
              >
                <Icon name="branch" size={12} />
                {checkingOut ? 'Checking out…' : 'Checkout'}
              </button>
              <button
                type="button"
                className="btn ghost cd-action-btn"
                onClick={() => onCreateTag(hash, commit.short_hash)}
                title="Create a tag at this commit"
              >
                <Icon name="tag" size={12} />
                Tag…
              </button>
              <button
                type="button"
                className="btn ghost cd-action-btn"
                disabled={historyBusy}
                onClick={() => void onCherryPick()}
                title="Apply this commit's changes onto the current branch"
              >
                <Icon name="arrow-down" size={12} />
                {commit.parents.length > 1 ? 'Cherry-pick…' : 'Cherry-pick'}
              </button>
              <button
                type="button"
                className="btn ghost cd-action-btn"
                disabled={historyBusy}
                onClick={() => void onRevert()}
                title="Create a commit that undoes this commit"
              >
                <Icon name="history" size={12} />
                {commit.parents.length > 1 ? 'Revert…' : 'Revert'}
              </button>
              <button
                type="button"
                className="btn ghost cd-action-btn"
                disabled={historyBusy}
                onClick={() =>
                  onInteractiveRebase(commit.parents.length ? `${hash}^` : null, commit.short_hash)
                }
                title="Reorder, squash, reword, or drop this commit and everything newer"
              >
                <Icon name="rebase" size={12} />
                Rebase from here…
              </button>
            </>
          )}
        </div>
        {checkoutError ? <div className="cd-action-error">{checkoutError}</div> : null}
      </div>
      <div className="cd-files">
        {loading && diffs.length === 0 ? (
          <div className="cd-empty">Loading…</div>
        ) : diffs.length === 0 ? (
          <div className="cd-empty">No file changes.</div>
        ) : (
          diffs.map((d) => (
            <CdFileRow
              key={d.path}
              diff={d}
              active={d.path === selectedFile}
              onClick={() => setSelectedFile(d.path)}
            />
          ))
        )}
      </div>
      <div className="cd-diff">
        {focused ? (
          focused.binary && isImagePath(focused.path) ? (
            <div className="cd-diff-scroll">
              {/* Old side: the first parent (a root commit / added file has none).
                  New side: this commit. */}
              <ImageDiff
                path={focused.path}
                oldSrc={
                  focused.status === 'added' || commit.parents.length === 0
                    ? null
                    : { rev: `${hash}^` }
                }
                newSrc={focused.status === 'deleted' ? null : { rev: hash }}
              />
            </div>
          ) : focused.binary || focused.patch.length === 0 ? (
            <div className="cd-empty">
              {focused.binary ? 'Binary file — no textual diff.' : 'No textual diff.'}
            </div>
          ) : (
            <div className="cd-diff-scroll">
              <Diff patch={focused.patch} layout={layout} />
            </div>
          )
        ) : (
          <div className="cd-empty">Select a file to see its diff.</div>
        )}
        </div>
      </aside>
      {mainlineAction && (
        <MainlineDialog
          commit={commit}
          operation={mainlineAction}
          onClose={() => setMainlineAction(null)}
          onToast={onToast}
        />
      )}
    </>
  );
}

function CdFileRow({
  diff,
  active,
  onClick,
}: {
  diff: FileDiff;
  active: boolean;
  onClick: () => void;
}) {
  const letter = statusLetter(diff.status);
  return (
    <div className={`cd-file${active ? ' active' : ''}`} onClick={onClick}>
      <span className={`stat ${letter}`}>{letter}</span>
      <span />
      <span className="fpath" title={diff.path}>
        {diff.path}
      </span>
      <span className="delta">
        <span className="add">+{diff.adds}</span> <span className="del">−{diff.dels}</span>
      </span>
    </div>
  );
}

/** Synthetic commit for a stash node so the detail panel can render its header.
 *  Its diff (base→stash) is loaded separately via `repo_diff_commit`. */
function stashCommit(s: Stash): Commit {
  return {
    hash: s.oid,
    short_hash: s.oid.slice(0, 7),
    subject: s.message,
    body: '',
    author_name: '',
    author_email: '',
    time_unix: s.time_unix,
    parents: s.base ? [s.base] : [],
  };
}

function statusLetter(s: DiffStatus): 'A' | 'M' | 'D' | 'R' | 'C' | 'T' {
  switch (s) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'typechange':
      return 'T';
  }
}

function formatFullDate(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
