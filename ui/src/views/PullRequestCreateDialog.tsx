import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage, tauri } from '../lib/tauri';
import type { PullRequestCreateOutcome, PullRequestProvider, Refs } from '../lib/types';

function targetBranches(refs: Refs | null, sourceBranch: string, knownTargets: string[]): string[] {
  const candidates = [
    ...knownTargets,
    ...(refs?.branches.map((branch) => branch.name) ?? []),
    ...(refs?.remote_branches.map((branch) => branch.branch) ?? []),
  ].filter((branch) => branch && branch !== sourceBranch);
  const unique = [...new Set(candidates)];
  return unique.sort((left, right) => {
    const rank = (branch: string) => branch === 'main' ? 0 : branch === 'master' ? 1 : 2;
    return rank(left) - rank(right) || left.localeCompare(right);
  });
}

export function PullRequestCreateDialog({
  path,
  provider,
  sourceBranch,
  refs,
  knownTargets,
  onCreated,
  onClose,
}: {
  path: string;
  provider: PullRequestProvider;
  sourceBranch: string;
  refs: Refs | null;
  knownTargets: string[];
  onCreated: (outcome: PullRequestCreateOutcome) => void;
  onClose: () => void;
}) {
  const targets = useMemo(
    () => targetBranches(refs, sourceBranch, knownTargets),
    [knownTargets, refs, sourceBranch],
  );
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [targetBranch, setTargetBranch] = useState(targets[0] ?? 'main');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  function trapFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function submit() {
    if (busy) return;
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    if (!targetBranch.trim()) {
      setError('Target branch is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await tauri.repoPullRequestCreate(
        path,
        sourceBranch,
        targetBranch.trim(),
        title.trim(),
        description,
        draft,
      );
      onCreated(outcome);
    } catch (caught) {
      if (mountedRef.current) setError(errMessage(caught));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const providerLabel = provider === 'git_hub' ? 'GitHub' : 'Azure DevOps';

  return (
    <div
      className="palette-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="clone-dialog stash-dialog pr-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Create pull request"
        onKeyDown={trapFocus}
      >
        <div className="clone-head">
          <Icon name="remote" size={15} />
          <span className="title">Create pull request</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>×</button>
        </div>

        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="clone-body">
            <p className="stash-blurb">
              Create on {providerLabel} from <code>{sourceBranch}</code>. Strand will not push the branch; it must already exist on the remote.
            </p>

            <label className="clone-field">
              <span className="lbl">Title</span>
              <input
                autoFocus
                className="clone-input"
                value={title}
                disabled={busy}
                maxLength={512}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>

            <label className="clone-field">
              <span className="lbl">Target branch</span>
              <input
                className="clone-input"
                value={targetBranch}
                list="pr-target-branches"
                disabled={busy}
                onChange={(event) => setTargetBranch(event.target.value)}
              />
              <datalist id="pr-target-branches">
                {targets.map((branch) => <option key={branch} value={branch} />)}
              </datalist>
            </label>

            <label className="clone-field">
              <span className="lbl">Description</span>
              <textarea
                className="clone-input pr-create-description"
                value={description}
                disabled={busy}
                maxLength={65_536}
                placeholder="What changed, and why?"
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>

            <label className="stash-check">
              <input
                type="checkbox"
                checked={draft}
                disabled={busy}
                onChange={(event) => setDraft(event.target.checked)}
              />
              <span>Create as draft</span>
            </label>

            {error ? <div className="clone-error" role="alert">{error}</div> : null}
          </div>

          <div className="clone-foot">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create pull request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
