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
  if (!state) return null;
  return <div className="pr-completion-options" aria-label="Automatic merging">
    <strong tabIndex={-1}>{completionLabel(state)}</strong>
    {state.can_enable && state.kind !== 'github_queue' && <Select aria-label="Automatic merge strategy" disabled={busy} value={selected} onChange={e => setStrategy(e.target.value as PullRequestMergeStrategy)}>
      {state.strategies.map(s => <option value={s} key={s}>{s === 'merge_commit' ? 'Merge commit' : s === 'squash' ? 'Squash' : 'Rebase'}</option>)}
    </Select>}
    {state.can_enable && <button type="button" className="h-link" disabled={busy || (state.kind !== 'github_queue' && !selected)} onClick={() => void submit(true)}>{completionAction(state, true)}</button>}
    {state.can_cancel && <button type="button" className="h-link" disabled={busy} onClick={() => void submit(false)}>{completionAction(state, false)}</button>}
    {busy && <span role="status">Updating completion…</span>}
    {state.status !== 'merged' && state.status !== 'closed' && <span>
      {state.kind === 'github_queue' ? 'GitHub manages the queue and required checks.' : 'Merges when the required checks pass. New commits pushed to this branch are included.'}
    </span>}
    {state.blockers.length > 0 && <span>{state.blockers.join(' · ')}</span>}
    {error && <span role="alert">{error} · Refresh to check the current provider state.</span>}
  </div>;
}
