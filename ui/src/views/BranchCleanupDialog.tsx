import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { mergedBranchCleanupPlan } from '../lib/branchCleanup';
import { errMessage, tauri } from '../lib/tauri';
import { useRepo } from '../stores/repo';

function ScopeCheckbox({
  checked,
  partial,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  partial: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial;
  }, [partial]);

  return (
    <label className="branch-cleanup-scope">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function BranchCleanupDialog({
  onClose,
  onToast,
}: {
  onClose: () => void;
  onToast: (message: string, kind?: 'success' | 'error') => void;
}) {
  const activePath = useRepo((state) => state.activePath);
  const refs = useRepo((state) => state.refs);
  const worktrees = useRepo((state) => state.worktrees);
  const refreshRefs = useRepo((state) => state.refreshRefs);
  const refreshLog = useRepo((state) => state.refreshLog);

  // Freeze the plan while the dialog is open. A remote push updates the local
  // tracking ref, and watcher refreshes must not make rows disappear mid-run.
  const [plan] = useState(() => mergedBranchCleanupPlan(refs, worktrees));
  const [localSelection, setLocalSelection] = useState(
    () => new Set(plan.candidates.map((candidate) => candidate.local.name)),
  );
  // Remote deletion is deliberately opt-in: it changes the shared repository.
  const [remoteSelection, setRemoteSelection] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(0);

  const dialogRef = useRef<HTMLFormElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  if (openerRef.current === null && typeof document !== 'undefined') {
    openerRef.current = document.activeElement as HTMLElement | null;
  }

  const remoteByRef = useMemo(() => {
    const remotes = new Map<string, NonNullable<(typeof plan.candidates)[number]['remote']>>();
    for (const candidate of plan.candidates) {
      if (candidate.remote) remotes.set(candidate.remote.full_name, candidate.remote);
    }
    return remotes;
  }, [plan.candidates]);
  const remoteKeys = useMemo(() => [...remoteByRef.keys()], [remoteByRef]);

  const localCount = localSelection.size;
  const remoteCount = remoteSelection.size;
  const total = localCount + remoteCount;
  const allLocals = plan.candidates.length > 0 && localCount === plan.candidates.length;
  const allRemotes = remoteKeys.length > 0 && remoteCount === remoteKeys.length;
  const summary = total === 0
    ? 'Nothing selected'
    : [
        localCount ? `${localCount} local` : '',
        remoteCount ? `${remoteCount} remote` : '',
      ].filter(Boolean).join(' + ');

  useEffect(() => {
    // The palette restores focus as it unmounts. Re-claim it one frame later
    // so keyboard users land inside the dialog they just opened.
    const frame = requestAnimationFrame(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>(
        '.branch-cleanup-grid input:not([disabled])',
      ) ?? dialogRef.current?.querySelector<HTMLElement>('button:not([disabled])');
      target?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      openerRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  function trapFocus(event: React.KeyboardEvent<HTMLFormElement>) {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function toggleLocal(name: string, checked: boolean) {
    setLocalSelection((current) => {
      const next = new Set(current);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  function toggleRemote(fullName: string, checked: boolean) {
    setRemoteSelection((current) => {
      const next = new Set(current);
      if (checked) next.add(fullName);
      else next.delete(fullName);
      return next;
    });
  }

  async function clearSelected() {
    if (!activePath || busy || total === 0) return;
    setBusy(true);
    setCompleted(0);

    let localCleared = 0;
    let remoteCleared = 0;
    const errors: string[] = [];
    const failedRemoteRefs = new Set<string>();
    const selectedRemotes = [...remoteSelection]
      .map((fullName) => remoteByRef.get(fullName))
      .filter((remote): remote is NonNullable<typeof remote> => !!remote);
    const selectedLocals = plan.candidates.filter(
      (candidate) => localSelection.has(candidate.local.name),
    );

    // Remote refs go first. If the network rejects a deletion, the local ref
    // remains available as the recovery anchor until its own explicit step.
    for (const remote of selectedRemotes) {
      try {
        await tauri.repoBranchDeleteRemote(activePath, remote.remote, remote.branch);
        remoteCleared += 1;
      } catch (error) {
        failedRemoteRefs.add(remote.full_name);
        errors.push(`${remote.name}: ${errMessage(error)}`);
      }
      setCompleted((count) => count + 1);
    }
    for (const candidate of selectedLocals) {
      if (
        candidate.remote
        && remoteSelection.has(candidate.remote.full_name)
        && failedRemoteRefs.has(candidate.remote.full_name)
      ) {
        // Keep the local recovery anchor when its paired remote deletion was
        // refused. The remote error above is the one actionable failure.
        setCompleted((count) => count + 1);
        continue;
      }
      try {
        await tauri.repoBranchDelete(activePath, candidate.local.name, false);
        localCleared += 1;
      } catch (error) {
        errors.push(`${candidate.local.name}: ${errMessage(error)}`);
      }
      setCompleted((count) => count + 1);
    }

    await Promise.allSettled([refreshRefs(), refreshLog()]);
    const cleared = localCleared + remoteCleared;
    const clearedSummary = [
      localCleared ? `${localCleared} local` : '',
      remoteCleared ? `${remoteCleared} remote` : '',
    ].filter(Boolean).join(' + ');
    if (errors.length > 0) {
      onToast(
        `Cleared ${clearedSummary || '0 refs'}, but ${errors.length} failed: ${errors[0]}`,
        'error',
      );
    } else {
      onToast(`Cleared ${clearedSummary} merged branch ref${cleared === 1 ? '' : 's'}`);
    }
    setBusy(false);
    onClose();
  }

  return (
    <div
      className="palette-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="clone-dialog branch-cleanup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="branch-cleanup-title"
        aria-describedby="branch-cleanup-description"
        onKeyDown={trapFocus}
        onSubmit={(event) => {
          event.preventDefault();
          void clearSelected();
        }}
      >
        <div className="clone-head">
          <Icon name="branch" size={15} />
          <span id="branch-cleanup-title" className="title">Clear merged branches</span>
          <button
            type="button"
            className="cd-close"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="clone-body">
          <p id="branch-cleanup-description" className="stash-blurb">
            These branch tips are contained by{' '}
            <code>{refs.primary_branch ?? 'the primary branch'}</code>. Choose the local refs to
            remove and any matching remote refs that still exist.
          </p>

          {plan.candidates.length > 0 ? (
            <div className="branch-cleanup-grid" role="group" aria-label="Merged branch selections">
              <div className="branch-cleanup-grid-head">
                <span>Branch</span>
                <ScopeCheckbox
                  checked={allLocals}
                  partial={localCount > 0 && !allLocals}
                  disabled={busy}
                  label={`Local (${plan.candidates.length})`}
                  onChange={(checked) => setLocalSelection(
                    checked
                      ? new Set(plan.candidates.map((candidate) => candidate.local.name))
                      : new Set(),
                  )}
                />
                <ScopeCheckbox
                  checked={allRemotes}
                  partial={remoteCount > 0 && !allRemotes}
                  disabled={busy || remoteKeys.length === 0}
                  label={`Remote (${remoteKeys.length})`}
                  onChange={(checked) => setRemoteSelection(checked ? new Set(remoteKeys) : new Set())}
                />
              </div>
              <div className="branch-cleanup-rows">
                {plan.candidates.map((candidate) => (
                  <div className="branch-cleanup-row" key={candidate.local.full_name}>
                    <span className="branch-cleanup-name" title={candidate.local.name}>
                      <Icon name="check" size={12} />
                      <code>{candidate.local.name}</code>
                    </span>
                    <label className="branch-cleanup-option">
                      <input
                        type="checkbox"
                        checked={localSelection.has(candidate.local.name)}
                        disabled={busy}
                        aria-label={`Delete local branch ${candidate.local.name}`}
                        onChange={(event) => toggleLocal(candidate.local.name, event.target.checked)}
                      />
                      <span>Delete local</span>
                    </label>
                    {candidate.remote ? (
                      <label className="branch-cleanup-option remote">
                        <input
                          type="checkbox"
                          checked={remoteSelection.has(candidate.remote.full_name)}
                          disabled={busy}
                          aria-label={`Delete remote branch ${candidate.remote.name}`}
                          onChange={(event) => toggleRemote(
                            candidate.remote!.full_name,
                            event.target.checked,
                          )}
                        />
                        <code title={candidate.remote.name}>{candidate.remote.name}</code>
                      </label>
                    ) : (
                      <span className="branch-cleanup-missing">No matching ref</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="branch-cleanup-empty">
              <Icon name="check" size={15} />
              <span>No removable merged branches were found.</span>
            </div>
          )}

          {plan.checkedOut.length > 0 ? (
            <div className="branch-cleanup-note">
              <Icon name="worktree" size={13} />
              <span>
                {plan.checkedOut.length} merged branch{plan.checkedOut.length === 1 ? ' is' : 'es are'}
                {' '}checked out in a worktree and excluded: <code>{plan.checkedOut.join(', ')}</code>
              </span>
            </div>
          ) : null}

          {remoteCount > 0 ? (
            <div className="clone-error">
              Remote deletion runs <code>git push --delete</code>. Strand cannot restore a remote
              ref after the server accepts it.
            </div>
          ) : null}
        </div>

        <div className="clone-foot">
          <span className="branch-cleanup-summary" aria-live="polite">
            {busy ? `Clearing ${completed} of ${total}…` : summary}
          </span>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {plan.candidates.length === 0 ? 'Close' : 'Cancel'}
          </button>
          {plan.candidates.length > 0 ? (
            <button type="submit" className="btn danger" disabled={busy || total === 0}>
              {busy ? 'Clearing…' : 'Clear selected'}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
