import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { canMarkPullRequestReady, providerName } from '../lib/pullRequests';
import { errMessage, tauri } from '../lib/tauri';
import type { PullRequest, PullRequestMergeStrategy, PullRequestProvider } from '../lib/types';
import { PullRequestCompletionControl } from './PullRequestCompletionControl';

const STRATEGIES: {
  value: PullRequestMergeStrategy;
  buttonLabel: string;
  menuLabel: string;
  hint: string;
}[] = [
  {
    value: 'merge_commit',
    buttonLabel: 'Merge pull request',
    menuLabel: 'Create a merge commit',
    hint: 'Add every commit to the target branch with a merge commit.',
  },
  {
    value: 'squash',
    buttonLabel: 'Squash and merge',
    menuLabel: 'Squash and merge',
    hint: 'Combine this pull request into one commit on the target branch.',
  },
  {
    value: 'rebase',
    buttonLabel: 'Rebase and merge',
    menuLabel: 'Rebase and merge',
    hint: 'Replay every commit onto the target branch without a merge commit.',
  },
];

export function PullRequestMergeControl({
  path,
  provider,
  pr,
  disabledReason,
  onMerged,
  onToast,
}: {
  path: string;
  provider: PullRequestProvider;
  pr: PullRequest;
  disabledReason: string;
  onMerged: (next: PullRequest) => void;
  onToast: (message: string, kind?: 'success' | 'error') => void;
}) {
  const strategies = STRATEGIES.filter((item) => !pr.capabilities || pr.capabilities.merge_strategies.includes(item.value))
    .map((item) => provider === 'git_lab' && item.value === 'merge_commit'
      ? { ...item, buttonLabel: 'Merge with project settings', menuLabel: 'Use project merge method', hint: 'GitLab applies the project’s merge method and protections.' }
      : item);
  const [strategy, setStrategy] = useState<PullRequestMergeStrategy>('merge_commit');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const mountedRef = useRef(true);
  const selectedIndex = Math.max(0, strategies.findIndex((item) => item.value === strategy));
  const selected = strategies[selectedIndex] ?? strategies[0] ?? STRATEGIES[0];
  const markReady = canMarkPullRequestReady(pr);
  const deferred = pr.completion?.kind === 'github_queue' || pr.completion?.status === 'waiting_for_policies';
  const disabled = deferred || (markReady ? false : (Boolean(disabledReason) || strategies.length === 0)) || busy;
  const completionAvailable = !!pr.completion;
  const menuDisabled = busy || (disabled && !completionAvailable);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const showMenu = useCallback((focus = false) => {
    if (menuDisabled) return;
    setError(null);
    setOpen(true);
    if (focus) {
      window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('.pr-merge-menu button:not(:disabled), .pr-merge-menu select:not(:disabled)')?.focus());
    }
  }, [menuDisabled]);

  useEffect(() => {
    const onMergeRequest = () => showMenu(true);
    window.addEventListener('strand:pull-request-merge-menu', onMergeRequest);
    window.addEventListener('strand:pull-request-completion', onMergeRequest);
    return () => {
      window.removeEventListener('strand:pull-request-merge-menu', onMergeRequest);
      window.removeEventListener('strand:pull-request-completion', onMergeRequest);
    };
  }, [showMenu]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => toggleRef.current?.focus());
  };

  const selectStrategy = (next: PullRequestMergeStrategy) => {
    setStrategy(next);
    closeMenu(true);
  };

  const moveMenuFocus = (index: number) => {
    const wrapped = (index + strategies.length) % strategies.length;
    optionRefs.current[wrapped]?.focus();
  };

  const submit = async () => {
    if (disabled) return;
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      await tauri.repoPullRequestMerge(path, pr.id, selected.value, pr.source_commit);
      let next: PullRequest;
      try {
        next = await tauri.repoPullRequest(path, pr.id);
      } catch (refreshError) {
        onToast(
          `Merge was requested, but PR #${pr.id} could not refresh: ${errMessage(refreshError)}`,
          'error',
        );
        return;
      }
      onMerged(next);
      const merged = next.state === 'merged' || next.state === 'completed';
      onToast(
        merged
          ? `Merged PR #${pr.id}`
          : `Merge requested for PR #${pr.id}; provider policies may still be running.`,
      );
    } catch (caught) {
      if (mountedRef.current) setError(errMessage(caught));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const submitReady = useCallback(async () => {
    if (!markReady || busy) return;
    setBusy(true);
    setError(null);
    try {
      await tauri.repoPullRequestReady(path, pr.id);
      let next: PullRequest;
      try {
        next = await tauri.repoPullRequest(path, pr.id);
      } catch (refreshError) {
        onToast(
          `PR #${pr.id} was marked ready, but it could not refresh: ${errMessage(refreshError)}`,
          'error',
        );
        return;
      }
      onMerged(next);
      onToast(`PR #${pr.id} is ready for review`);
    } catch (caught) {
      if (mountedRef.current) setError(errMessage(caught));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, markReady, onMerged, onToast, path, pr.id]);

  useEffect(() => {
    const onReadyRequest = () => { void submitReady(); };
    window.addEventListener('strand:pull-request-ready', onReadyRequest);
    return () => window.removeEventListener('strand:pull-request-ready', onReadyRequest);
  }, [submitReady]);

  if (!markReady && strategies.length === 0 && !completionAvailable) return <span className="pr-muted">Merge on {providerName(provider)}</span>;
  if (markReady) {
    return (
      <div className="pr-merge-control">
        <button
          type="button"
          className="pr-merge-main pr-ready-main"
          disabled={busy}
          title={`Mark ready for review on ${providerName(provider)}`}
          onClick={() => void submitReady()}
        >
          {busy ? 'Marking ready…' : 'Ready for review'}
        </button>
        {error && <div className="pr-merge-error" role="alert">{error}</div>}
      </div>
    );
  }

  return (
    <div className="pr-merge-control" ref={rootRef}>
      <div className="pr-merge-split">
        <button
          type="button"
          className="pr-merge-main"
          disabled={deferred ? menuDisabled : disabled}
          title={deferred ? 'Manage automatic merging' : disabledReason || `${selected.buttonLabel} using ${providerName(provider)}`}
          onClick={() => deferred ? showMenu(true) : void submit()}
        >
          {busy ? 'Merging…' : deferred ? pr.completion?.status === 'queued' ? 'In merge queue' : pr.completion?.status === 'waiting_for_policies' ? 'Automatic merge enabled' : 'Join merge queue…' : selected.buttonLabel}
        </button>
        <button
          type="button"
          className="pr-merge-toggle"
          ref={toggleRef}
          disabled={menuDisabled}
          aria-label="Merge options"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={`pr-merge-menu-${pr.id}`}
          onClick={() => open ? closeMenu() : showMenu(true)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              showMenu(true);
            } else if (event.key === 'Escape' && open) {
              event.preventDefault();
              closeMenu(true);
            }
          }}
        >
          <Icon name={open ? 'chev-up' : 'chev-down'} size={12} />
        </button>
      </div>

        <div
          hidden={!open}
          className="pr-merge-menu"
          id={`pr-merge-menu-${pr.id}`}
          role="dialog"
          aria-label="Merge options"
          onKeyDown={(event) => {
            const current = optionRefs.current.indexOf(document.activeElement as HTMLButtonElement);
            if (current >= 0 && event.key === 'ArrowDown') { event.preventDefault(); moveMenuFocus(current + 1); }
            else if (current >= 0 && event.key === 'ArrowUp') { event.preventDefault(); moveMenuFocus(current - 1); }
            else if (current >= 0 && event.key === 'Home') { event.preventDefault(); moveMenuFocus(0); }
            else if (current >= 0 && event.key === 'End') { event.preventDefault(); moveMenuFocus(strategies.length - 1); }
            else if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
            else if (event.key === 'Tab') {
              const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)'));
              const first = controls[0], last = controls.at(-1);
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
          }}
        >
          {!deferred && <div role="menu" aria-label="Merge strategy">{strategies.map((item, index) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={strategy === item.value}
              className="pr-merge-option"
              key={item.value}
              ref={(element) => { optionRefs.current[index] = element; }}
              onClick={() => selectStrategy(item.value)}
            >
              <span className="pr-merge-option-check">
                {strategy === item.value && <Icon name="check" size={14} />}
              </span>
              <span>
                <strong>{item.menuLabel}</strong>
                <small>{item.hint}</small>
              </span>
            </button>
          ))}</div>}
          {pr.completion && <PullRequestCompletionControl path={path} pr={pr} onUpdated={onMerged} />}
          <div className="pr-merge-menu-note">
            {providerName(provider)} enforces required checks and branch policies. The source branch is kept.
          </div>
        </div>

      {error && <div className="pr-merge-error" role="alert">{error}</div>}
    </div>
  );
}
