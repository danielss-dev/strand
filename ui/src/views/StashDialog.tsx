import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { computeStashPreselection } from '../lib/stashPreselection';
import { errMessage } from '../lib/tauri';
import { useRepo } from '../stores/repo';

export interface StashDialogOptions {
  /** Open in snapshot mode (keep changes in working directory). */
  snapshot: boolean;
  /** Stash unstaged only, leave staged in the index (`--keep-index`). */
  keepIndex?: boolean;
}

interface StashFileRow {
  path: string;
  hasStaged: boolean;
  hasUnstaged: boolean;
  untracked: boolean;
}

/**
 * Modal for creating a stash from the working tree. Shows a checklist of
 * changed files so the user can include or exclude paths before stashing.
 * Pre-selection mirrors Local Changes: Pierre multi-select, then the active
 * row / folder / show-all selection; otherwise every stashable path starts
 * checked.
 */
export function StashDialog({
  snapshot: initialSnapshot,
  keepIndex = false,
  onClose,
}: StashDialogOptions & { onClose: () => void }) {
  const unstaged = useRepo((s) => s.unstagedDiffs);
  const staged = useRepo((s) => s.stagedDiffs);
  const status = useRepo((s) => s.status);
  const localSelection = useRepo((s) => s.localSelection);
  const localTreeSelection = useRepo((s) => s.localTreeSelection);
  const stashPushPaths = useRepo((s) => s.stashPushPaths);

  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [keep, setKeep] = useState(initialSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const conflictSet = useMemo(() => {
    const set = new Set<string>();
    for (const s of status) if (s.kind === 'CONFLICTED') set.add(s.path);
    return set;
  }, [status]);

  const untrackedSet = useMemo(() => {
    const set = new Set<string>();
    for (const s of status) if (s.kind === 'UNTRACKED') set.add(s.path);
    return set;
  }, [status]);

  const unstagedView = useMemo(
    () => unstaged.filter((d) => !conflictSet.has(d.path)),
    [unstaged, conflictSet],
  );
  const stagedView = useMemo(
    () => staged.filter((d) => !conflictSet.has(d.path)),
    [staged, conflictSet],
  );

  const fileRows = useMemo((): StashFileRow[] => {
    const stagedPaths = new Set(stagedView.map((d) => d.path));
    const unstagedPaths = new Set(unstagedView.map((d) => d.path));
    const paths = new Set([...stagedPaths, ...unstagedPaths]);
    return [...paths]
      .map((path) => ({
        path,
        hasStaged: stagedPaths.has(path),
        hasUnstaged: unstagedPaths.has(path),
        untracked: untrackedSet.has(path),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [unstagedView, stagedView, untrackedSet]);

  const visibleRows = useMemo(
    () => (includeUntracked ? fileRows : fileRows.filter((r) => !r.untracked)),
    [fileRows, includeUntracked],
  );

  const visiblePaths = useMemo(() => visibleRows.map((r) => r.path), [visibleRows]);

  const initialChecked = useMemo(
    () =>
      computeStashPreselection(
        localSelection,
        unstagedView.map((d) => d.path),
        stagedView.map((d) => d.path),
        localTreeSelection,
        visiblePaths,
      ),
    // Seed once on open — don't chase live Local Changes selection while editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [checked, setChecked] = useState<Set<string>>(() => new Set(initialChecked));

  // Drop untracked paths from the selection when the user toggles them off.
  useEffect(() => {
    const visible = new Set(visiblePaths);
    setChecked((prev) => {
      const next = new Set([...prev].filter((p) => visible.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [visiblePaths]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);

  function onTrapKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

  const selectedPaths = useMemo(
    () => visiblePaths.filter((p) => checked.has(p)),
    [visiblePaths, checked],
  );

  const allChecked = visiblePaths.length > 0 && selectedPaths.length === visiblePaths.length;
  const someChecked = selectedPaths.length > 0 && !allChecked;

  function toggleAll(next: boolean) {
    setChecked(next ? new Set(visiblePaths) : new Set());
  }

  function togglePath(path: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function submit() {
    if (busy || selectedPaths.length === 0) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const msg = message.trim() || null;
      const outcome = await stashPushPaths(
        selectedPaths,
        msg,
        includeUntracked,
        keepIndex,
        keep,
      );
      if (outcome.oid === null) {
        if (mountedRef.current) setNote('Nothing to stash — no changes matched the selection.');
        return;
      }
      onClose();
    } catch (e) {
      if (mountedRef.current) setError(errMessage(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const title = keep ? 'Save snapshot' : 'Stash changes';
  const cta = keep ? 'Save Snapshot' : 'Stash';

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="clone-dialog stash-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="stash" size={15} />
          <span className="title">{title}</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body stash-body">
          <p className="stash-blurb">
            {keep
              ? 'Save your local changes to a new stash, but keep them in the working directory.'
              : 'Save your local changes to a new stash and clear them from the working directory.'}
          </p>

          <label className="clone-field">
            <span className="lbl">Message</span>
            <input
              autoFocus
              className="clone-input"
              placeholder="Stash message (optional)"
              value={message}
              disabled={busy}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && selectedPaths.length > 0) void submit();
              }}
            />
          </label>

          <div className="stash-files">
            <div className="stash-files-head">
              <label className="stash-file-all">
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = someChecked;
                  }}
                  disabled={busy || visibleRows.length === 0}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
                <span>
                  Files to stash
                  <span className="hint">
                    {selectedPaths.length} of {visibleRows.length} selected
                  </span>
                </span>
              </label>
            </div>
            <div className="stash-files-list" role="list">
              {visibleRows.length === 0 ? (
                <div className="stash-files-empty">No changes to stash.</div>
              ) : (
                visibleRows.map((row) => (
                  <label key={row.path} className="stash-file-row" role="listitem">
                    <input
                      type="checkbox"
                      checked={checked.has(row.path)}
                      disabled={busy}
                      onChange={() => togglePath(row.path)}
                    />
                    <span className="stash-file-path" title={row.path}>
                      {row.path}
                    </span>
                    <span className="stash-file-badges">
                      {row.hasStaged ? <span className="stash-badge staged">staged</span> : null}
                      {row.hasUnstaged ? <span className="stash-badge unstaged">unstaged</span> : null}
                      {row.untracked ? <span className="stash-badge untracked">untracked</span> : null}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>

          <label className="stash-check">
            <input
              type="checkbox"
              checked={includeUntracked}
              disabled={busy}
              onChange={(e) => setIncludeUntracked(e.target.checked)}
            />
            <span>
              Include untracked files
              <span className="hint">New files are left behind unless included.</span>
            </span>
          </label>

          {!keepIndex ? (
            <label className="stash-check">
              <input
                type="checkbox"
                checked={keep}
                disabled={busy}
                onChange={(e) => setKeep(e.target.checked)}
              />
              <span>
                Keep changes in working directory
                <span className="hint">Snapshot — the stash is a backup, your changes stay put.</span>
              </span>
            </label>
          ) : (
            <p className="stash-note">Staged changes stay in the index; only unstaged changes are cleared.</p>
          )}

          {note ? <div className="stash-note">{note}</div> : null}
          {error ? <div className="clone-error">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || selectedPaths.length === 0}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : cta}
          </button>
        </div>
      </div>
    </div>
  );
}
