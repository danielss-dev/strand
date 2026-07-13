import { useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage, tauri } from '../lib/tauri';
import type { PullRequest, PullRequestMergeStrategy, PullRequestProvider } from '../lib/types';

const STRATEGIES: { value: PullRequestMergeStrategy; label: string; hint: string }[] = [
  {
    value: 'merge_commit',
    label: 'Create a merge commit',
    hint: 'Preserve every commit and join the branches with a merge commit.',
  },
  {
    value: 'squash',
    label: 'Squash and merge',
    hint: 'Combine the pull request into one commit on the target branch.',
  },
  {
    value: 'rebase',
    label: 'Rebase and merge',
    hint: 'Replay the pull request commits onto the target branch without a merge commit.',
  },
];

const providerName = (provider: PullRequestProvider) =>
  provider === 'git_hub' ? 'GitHub' : 'Azure DevOps';

export function PullRequestMergeDialog({
  path,
  provider,
  pr,
  onClose,
  onMerged,
  onToast,
}: {
  path: string;
  provider: PullRequestProvider;
  pr: PullRequest;
  onClose: () => void;
  onMerged: (next: PullRequest) => void;
  onToast: (message: string, kind?: 'success' | 'error') => void;
}) {
  const [strategy, setStrategy] = useState<PullRequestMergeStrategy>('merge_commit');
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const trapFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await tauri.repoPullRequestMerge(path, pr.id, strategy, pr.source_commit);
      let next: PullRequest;
      try {
        next = await tauri.repoPullRequest(path, pr.id);
      } catch (refreshError) {
        onToast(
          `Merge was requested, but PR #${pr.id} could not refresh: ${errMessage(refreshError)}`,
          'error',
        );
        onClose();
        return;
      }
      onMerged(next);
      const merged = next.state === 'merged' || next.state === 'completed';
      onToast(
        merged
          ? `Merged PR #${pr.id}`
          : `Merge requested for PR #${pr.id}; provider policies may still be running.`,
      );
      onClose();
    } catch (caught) {
      if (mountedRef.current) setError(errMessage(caught));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <div
      className="palette-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="clone-dialog stash-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Merge pull request ${pr.id}`}
        ref={dialogRef}
        onKeyDown={trapFocus}
      >
        <div className="clone-head">
          <Icon name="check" size={15} />
          <span className="title">Merge pull request</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>×</button>
        </div>

        <div className="clone-body">
          <p className="stash-blurb">
            Merge <strong>#{pr.id}</strong> from <code>{pr.source_branch}</code> into{' '}
            <code>{pr.target_branch}</code> on {providerName(provider)}.
          </p>
          <p className="pr-merge-warning">
            Required checks and branch policies remain enforced. Strand will stop if the source changed since this view loaded.
          </p>

          <div className="merge-modes" role="radiogroup" aria-label="Pull request merge strategy">
            {STRATEGIES.map((item, index) => (
              <label key={item.value} className={`merge-mode${strategy === item.value ? ' on' : ''}`}>
                <input
                  type="radio"
                  name="pr-merge-strategy"
                  value={item.value}
                  checked={strategy === item.value}
                  disabled={busy}
                  autoFocus={index === 0}
                  onChange={() => setStrategy(item.value)}
                />
                <span className="mm-text">
                  <span className="mm-label">{item.label}</span>
                  <span className="mm-hint">{item.hint}</span>
                </span>
              </label>
            ))}
          </div>

          {error ? <div className="clone-error" role="alert">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Merging…' : `Merge PR #${pr.id}`}
          </button>
        </div>
      </div>
    </div>
  );
}
