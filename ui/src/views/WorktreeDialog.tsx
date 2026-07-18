import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage, tauri } from '../lib/tauri';
import { repoFamilyName } from '../lib/repoIdentity';
import { useRepo } from '../stores/repo';

/**
 * Modal for creating a worktree. Checks out a branch into a separate directory
 * on disk; the new worktree can optionally open as its own tab.
 *
 * Two modes, toggled by "Create a new branch": a new branch cut from a chosen
 * start point (HEAD, any branch/remote branch/tag, or a commit handed in via
 * `initialStart` from the graph's context menu), or an existing local branch
 * (git refuses one already checked out in another worktree — that error
 * surfaces inline). A remote start point tracks it as upstream and offers a
 * fetch-first step so the branch isn't cut from a stale local snapshot. The
 * destination defaults to a sibling `<repo>.worktrees/<branch>` and is
 * editable; until the user edits it by hand it tracks the branch name.
 *
 * When the repo has a `.worktreeinclude` (the Claude Code convention naming
 * gitignored setup files — `.env`, local settings), the dialog offers to copy
 * the matching files into the fresh worktree so agents can actually run there.
 */
export function WorktreeDialog({
  onClose,
  onToast,
  initialStart = null,
}: {
  onClose: () => void;
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
  /** Pre-picked start point (branch/tag/commit) from "New worktree from here". */
  initialStart?: { ref: string; label: string } | null;
}) {
  const meta = useRepo((s) => s.meta);
  const refs = useRepo((s) => s.refs);
  const addWorktree = useRepo((s) => s.addWorktree);
  const openWorktree = useRepo((s) => s.openWorktree);

  const localBranches = useMemo(() => refs.branches.map((b) => b.name), [refs]);
  const headBranch = useMemo(() => refs.branches.find((b) => b.is_head)?.name ?? null, [refs]);

  const [newBranch, setNewBranch] = useState(true);
  const [branch, setBranch] = useState('');
  const [existing, setExisting] = useState(localBranches[0] ?? '');
  // Start point for the new branch; '' = HEAD.
  const [start, setStart] = useState(initialStart?.ref ?? '');
  const [fetchFirst, setFetchFirst] = useState(false);
  const [dest, setDest] = useState('');
  const [destEdited, setDestEdited] = useState(false);
  const [openInTab, setOpenInTab] = useState(true);
  // `.worktreeinclude` patterns of the source worktree; empty = no offer.
  const [includePatterns, setIncludePatterns] = useState<string[]>([]);
  const [copyInclude, setCopyInclude] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  // Re-arm on mount — StrictMode's dev remount reuses the same ref, so a
  // cleanup-only effect would leave it permanently false (frozen busy state).
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const chosenBranch = newBranch ? branch.trim() : existing;
  // A remote start point gets `--track` + the fetch-first offer.
  const remoteStart = useMemo(
    () => (newBranch && start ? refs.remote_branches.find((rb) => rb.name === start) ?? null : null),
    [refs, newBranch, start],
  );
  // A start handed in from a context menu may be a plain commit — not in any
  // ref list — so it needs its own option to stay selectable.
  const customStart = useMemo(() => {
    if (!initialStart) return null;
    const known =
      refs.branches.some((b) => b.name === initialStart.ref) ||
      refs.remote_branches.some((rb) => rb.name === initialStart.ref) ||
      refs.tags.some((t) => t.name === initialStart.ref);
    return known ? null : initialStart;
  }, [initialStart, refs]);

  // Offer the `.worktreeinclude` copy only when the file exists and names
  // something.
  useEffect(() => {
    if (!meta) return;
    let cancelled = false;
    void tauri
      .repoWorktreeIncludePatterns(meta.path)
      .then((p) => { if (!cancelled) setIncludePatterns(p); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [meta]);

  // Default destination = sibling `<repo>.worktrees/<branch-slug>`, tracking the
  // chosen branch until the user types their own path.
  useEffect(() => {
    if (destEdited || !meta) return;
    const repoPath = meta.path;
    const sep = repoPath.includes('\\') ? '\\' : '/';
    const parent = repoPath.replace(/[\\/][^\\/]*$/, '');
    const slug = chosenBranch.replace(/\//g, '-');
    setDest(slug ? `${parent}${sep}${repoFamilyName(meta)}.worktrees${sep}${slug}` : '');
  }, [chosenBranch, destEdited, meta]);

  // Restore focus to the opener on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);

  function onTrapKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const canSubmit = !busy && chosenBranch.length > 0 && dest.trim().length > 0;

  async function submit() {
    if (!canSubmit || !meta) return;
    setBusy(true);
    setError(null);
    try {
      const d = dest.trim();
      // Cut from origin's tip, not a stale local snapshot of it.
      if (newBranch && fetchFirst && remoteStart) {
        await tauri.repoFetch(meta.path, remoteStart.remote, true);
      }
      await addWorktree(
        d,
        chosenBranch,
        newBranch,
        newBranch && start ? start : null,
        !!remoteStart,
      );
      let copied = 0;
      if (copyInclude && includePatterns.length > 0) {
        try {
          copied = (await tauri.repoWorktreeCopyInclude(meta.path, d)).length;
        } catch {
          // The worktree exists; a failed setup copy shouldn't fail the flow.
        }
      }
      onToast?.(
        copied > 0
          ? `Worktree created — copied ${copied} setup file${copied === 1 ? '' : 's'}`
          : 'Worktree created',
      );
      if (openInTab) void openWorktree(d);
      onClose();
    } catch (e) {
      if (mountedRef.current) setError(errMessage(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const startLabel = start
    ? customStart?.ref === start ? customStart.label : start
    : headBranch ? `${headBranch} (HEAD)` : 'HEAD';

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="clone-dialog worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New worktree"
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="worktree" size={15} />
          <span className="title">New worktree</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body">
          <p className="stash-blurb">
            Start an isolated checkout for one agent task. Strand keeps it grouped
            with this repo, then can review the worktree against its fork point.
          </p>

          <label className="stash-check">
            <input
              type="checkbox"
              checked={newBranch}
              disabled={busy}
              onChange={(e) => setNewBranch(e.target.checked)}
            />
            <span>
              Create a new task branch
              <span className="hint">Starts from {startLabel}.</span>
            </span>
          </label>

          {newBranch ? (
            <>
              <label className="clone-field">
                <span className="lbl">Task branch</span>
                <input
                  autoFocus
                  className="clone-input"
                  placeholder="feature/my-work"
                  value={branch}
                  disabled={busy}
                  onChange={(e) => setBranch(e.target.value.replace(/\s+/g, '-'))}
                  onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
                />
              </label>
              <label className="clone-field">
                <span className="lbl">Start at</span>
                <select
                  className="clone-input"
                  value={start}
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.target.value;
                    setStart(v);
                    const rb = refs.remote_branches.find((r) => r.name === v) ?? null;
                    // Fetch-first is the sane default for a remote base…
                    setFetchFirst(!!rb);
                    // …and its short name is the obvious task-branch prefill.
                    if (rb && branch.trim().length === 0) setBranch(rb.branch);
                  }}
                >
                  <option value="">{headBranch ? `HEAD (${headBranch})` : 'HEAD'}</option>
                  {customStart && (
                    <option value={customStart.ref}>{customStart.label}</option>
                  )}
                  {localBranches.length > 0 && (
                    <optgroup label="Branches">
                      {localBranches.map((b) => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                    </optgroup>
                  )}
                  {refs.remote_branches.length > 0 && (
                    <optgroup label="Remote branches">
                      {refs.remote_branches.map((rb) => (
                        <option key={rb.full_name} value={rb.name}>{rb.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {refs.tags.length > 0 && (
                    <optgroup label="Tags">
                      {refs.tags.map((t) => (
                        <option key={t.full_name} value={t.name}>{t.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
              {remoteStart && (
                <label className="stash-check">
                  <input
                    type="checkbox"
                    checked={fetchFirst}
                    disabled={busy}
                    onChange={(e) => setFetchFirst(e.target.checked)}
                  />
                  <span>
                    Fetch {remoteStart.remote} first
                    <span className="hint">
                      Cut the branch from {remoteStart.name}'s current tip, not a stale local copy.
                    </span>
                  </span>
                </label>
              )}
            </>
          ) : (
            <label className="clone-field">
              <span className="lbl">Branch</span>
              <select
                className="clone-input"
                value={existing}
                disabled={busy || localBranches.length === 0}
                onChange={(e) => setExisting(e.target.value)}
              >
                {localBranches.length === 0 && <option value="">No local branches</option>}
                {localBranches.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </label>
          )}

          <label className="clone-field">
            <span className="lbl">Location</span>
            <input
              className="clone-input"
              placeholder="/path/to/worktree"
              value={dest}
              disabled={busy}
              onChange={(e) => { setDest(e.target.value); setDestEdited(true); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            />
          </label>

          {includePatterns.length > 0 && (
            <label className="stash-check">
              <input
                type="checkbox"
                checked={copyInclude}
                disabled={busy}
                onChange={(e) => setCopyInclude(e.target.checked)}
              />
              <span>
                Copy setup files from .worktreeinclude
                <span className="hint">
                  Gitignored files matching {includePatterns.slice(0, 3).join(', ')}
                  {includePatterns.length > 3 ? ', …' : ''} — so the tree runs out of the box.
                </span>
              </span>
            </label>
          )}

          <label className="stash-check">
            <input
              type="checkbox"
              checked={openInTab}
              disabled={busy}
              onChange={(e) => setOpenInTab(e.target.checked)}
            />
            <span>
              Open in a new tab when created
              <span className="hint">Switch straight to the isolated agent workspace.</span>
            </span>
          </label>

          {error ? <div className="clone-error">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create worktree'}
          </button>
        </div>
      </div>
    </div>
  );
}
