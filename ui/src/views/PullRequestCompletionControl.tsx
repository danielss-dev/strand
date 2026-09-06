import { useCallback, useEffect, useRef, useState } from 'react';
import { Select } from '../components/Select';
import { completionAction, completionLabel } from '../lib/pullRequestCompletion';
import { errMessage, tauri } from '../lib/tauri';
import type { PullRequest, PullRequestMergeStrategy } from '../lib/types';

export function PullRequestCompletionControl({ path, pr, onUpdated }: {
  path: string; pr: PullRequest; onUpdated: (pr: PullRequest) => void;
}) {
  const state = pr.completion;
  const [strategy, setStrategy] = useState<PullRequestMergeStrategy>('squash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const selected = state?.strategies.includes(strategy) ? strategy : state?.strategies[0];
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setError(null); }, [pr.source_commit]);
  const submit = useCallback(async (enable: boolean) => {
    if (!state || busy || (enable ? !state.can_enable : !state.can_cancel)) return;
    setBusy(true); setError(null);
    try {
      await tauri.repoPullRequestCompletion(path, pr.id, enable, selected ?? 'merge_commit', pr.source_commit);
      const next = await tauri.repoPullRequest(path, pr.id);
      if (mounted.current) onUpdated(next);
    } catch (caught) {
      if (mounted.current) setError(errMessage(caught));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, onUpdated, path, pr.id, pr.source_commit, selected, state]);
  useEffect(() => {
    const focus = () => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('button:not(:disabled), select, [tabindex]')?.focus());
    window.addEventListener('strand:pull-request-completion', focus);
    return () => window.removeEventListener('strand:pull-request-completion', focus);
  }, []);
  if (!state) return null;
  return <div className="pr-data-status" ref={root} aria-label="Deferred pull request completion">
    <strong tabIndex={-1}>{completionLabel(state)}</strong>
    {state.can_enable && state.kind !== 'github_queue' && <Select aria-label="Automatic merge strategy" disabled={busy} value={selected} onChange={e => setStrategy(e.target.value as PullRequestMergeStrategy)}>
      {state.strategies.map(s => <option value={s} key={s}>{s === 'merge_commit' ? 'Merge commit' : s === 'squash' ? 'Squash' : 'Rebase'}</option>)}
    </Select>}
    {state.can_enable && <button type="button" className="h-link" disabled={busy || (state.kind !== 'github_queue' && !selected)} onClick={() => void submit(true)}>{completionAction(state, true)}</button>}
    {state.can_cancel && <button type="button" className="h-link" disabled={busy} onClick={() => void submit(false)}>{completionAction(state, false)}</button>}
    {busy && <span role="status">Updating completion…</span>}
    {state.status !== 'merged' && state.status !== 'closed' && <span>
      {state.kind === 'github_queue' ? 'GitHub controls queue order and required checks.' : 'The provider completes automatically when policies pass, including later source pushes.'}
    </span>}
    {state.blockers.length > 0 && <span>{state.blockers.join(' · ')}</span>}
    {error && <span role="alert">{error} · Refresh to check the current provider state.</span>}
  </div>;
}
