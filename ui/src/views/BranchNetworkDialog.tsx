import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage } from '../lib/tauri';
import { defaultRemote, useRepo } from '../stores/repo';
import type { Branch, BranchPushRequest, PushMode } from '../lib/types';

export type BranchNetworkDialogMode =
  | { kind: 'upstream'; branch: Branch }
  | { kind: 'push'; branch: Branch };

/**
 * Branch-scoped remote configuration. Upstream mode edits local tracking
 * config; push mode sends an explicit fully-qualified refspec, so the branch
 * never needs to be checked out and the destination is never guessed.
 */
export function BranchNetworkDialog({
  mode,
  onClose,
  onPush,
  onToast,
}: {
  mode: BranchNetworkDialogMode;
  onClose: () => void;
  onPush: (request: BranchPushRequest) => void;
  onToast: (message: string, kind?: 'success' | 'error') => void;
}) {
  const refs = useRepo((s) => s.refs);
  const setBranchUpstream = useRepo((s) => s.setBranchUpstream);
  const branch = mode.branch;
  const currentRemoteBranch = refs.remote_branches.find((candidate) => candidate.name === branch.upstream?.name);
  const initialRemote = branch.upstream?.remote ?? defaultRemote(refs) ?? refs.remotes[0]?.name ?? '';

  const [upstream, setUpstream] = useState(branch.upstream?.name ?? '');
  const [remote, setRemote] = useState(initialRemote);
  const [destination, setDestination] = useState(currentRemoteBranch?.branch ?? branch.name);
  const [pushMode, setPushMode] = useState<PushMode>('default');
  const [setUpstreamAfterPush, setSetUpstreamAfterPush] = useState(branch.upstream == null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  const upstreams = useMemo(
    () => [...refs.remote_branches].sort((a, b) => a.name.localeCompare(b.name)),
    [refs.remote_branches],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  function trapFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

  async function saveUpstream() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setBranchUpstream(branch.name, upstream || null);
      onToast(upstream ? `${branch.name} now tracks ${upstream}` : `Upstream removed from ${branch.name}`);
      onClose();
    } catch (caught) {
      if (mountedRef.current) setError(errMessage(caught));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  function startPush() {
    if (!remote) {
      setError('Choose a remote.');
      return;
    }
    const remoteBranch = destination.trim();
    if (!remoteBranch) {
      setError('Destination branch is required.');
      return;
    }
    onClose();
    onPush({
      branch: branch.name,
      remote,
      remoteBranch,
      mode: pushMode,
      setUpstream: setUpstreamAfterPush,
    });
  }

  const title = mode.kind === 'upstream' ? 'Manage upstream' : 'Push branch';
  const force = mode.kind === 'push' && pushMode === 'force-with-lease';
  const upstreamChanged = upstream !== (branch.upstream?.name ?? '');

  return (
    <div className="palette-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <div
        className="clone-dialog stash-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
        onKeyDown={trapFocus}
      >
        <div className="clone-head">
          <Icon name={mode.kind === 'push' ? 'arrow-up' : 'branch'} size={15} />
          <span className="title">{title}</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>×</button>
        </div>

        <div className="clone-body">
          <p className="stash-blurb">
            {mode.kind === 'upstream' ? 'Choose what ' : 'Push '}
            <code>{branch.name}</code>
            {mode.kind === 'upstream' ? ' tracks. This works even when the branch is not checked out.' : ' without checking it out.'}
          </p>

          {mode.kind === 'upstream' ? (
            <label className="clone-field">
              <span className="lbl">Upstream branch</span>
              <select
                autoFocus
                className="clone-input"
                value={upstream}
                disabled={busy}
                onChange={(event) => setUpstream(event.target.value)}
              >
                <option value="">No upstream</option>
                {upstreams.map((candidate) => (
                  <option key={candidate.full_name} value={candidate.name}>{candidate.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label className="clone-field">
                <span className="lbl">Remote</span>
                <select
                  autoFocus
                  className="clone-input"
                  value={remote}
                  onChange={(event) => setRemote(event.target.value)}
                >
                  {refs.remotes.length === 0 && <option value="">No remotes configured</option>}
                  {refs.remotes.map((candidate) => (
                    <option key={candidate.name} value={candidate.name}>{candidate.name}</option>
                  ))}
                </select>
              </label>

              <label className="clone-field">
                <span className="lbl">Destination branch</span>
                <input
                  className="clone-input"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value.replace(/\s+/g, '-'))}
                  placeholder={branch.name}
                />
              </label>

              <label className="clone-field">
                <span className="lbl">Push strategy</span>
                <select className="clone-input" value={pushMode} onChange={(event) => setPushMode(event.target.value as PushMode)}>
                  <option value="default">Standard push</option>
                  <option value="follow-tags">Push with annotated tags</option>
                  <option value="force-with-lease">Force with lease</option>
                </select>
              </label>

              <label className="stash-check">
                <input
                  type="checkbox"
                  checked={setUpstreamAfterPush}
                  onChange={(event) => setSetUpstreamAfterPush(event.target.checked)}
                />
                <span>Set <code>{remote}/{destination || branch.name}</code> as upstream</span>
              </label>

              {force && (
                <div className="clone-error">
                  This can replace commits on the remote. Strand uses <code>--force-with-lease</code>, so the push is refused if the destination changed since your last fetch.
                </div>
              )}
            </>
          )}

          {error ? <div className="clone-error">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={`btn ${force ? 'danger' : 'primary'}`}
            disabled={busy
              || (mode.kind === 'upstream' && !upstreamChanged)
              || (mode.kind === 'push' && refs.remotes.length === 0)}
            onClick={() => { if (mode.kind === 'upstream') void saveUpstream(); else startPush(); }}
          >
            {busy
              ? 'Saving…'
              : mode.kind === 'upstream'
                ? upstream
                  ? 'Save upstream'
                  : branch.upstream
                    ? 'Remove upstream'
                    : 'No upstream'
                : force
                  ? 'Force push with lease'
                  : 'Push branch'}
          </button>
        </div>
      </div>
    </div>
  );
}
