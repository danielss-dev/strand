import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { Diff } from '../components/Diff';
import { Select } from '../components/Select';
import { pullRequestReview } from '../lib/db';
import { exportHostedFeedback, feedbackSuggestions, reviewBoundaries } from '../lib/hostedReview';
import { errMessage, tauri } from '../lib/tauri';
import type { PullRequest, PullRequestBoundary, PullRequestComparison, PullRequestFeedback, PullRequestSuggestionPreview, PullRequestSuggestionRequest } from '../lib/types';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';

type Mode = 'compare' | 'feedback' | 'suggestions';

export function HostedReviewTools({ path, provider, pr }: { path: string; provider: string; pr: PullRequest }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [markFocus, setMarkFocus] = useState(false);
  const [openVersion, setOpenVersion] = useState(0);
  useEffect(() => {
    const open = (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      setOpenVersion(v => v + 1);
      setMarkFocus(action === 'mark');
      setMode(action === 'feedback' || action === 'suggestions' ? action : 'compare');
    };
    window.addEventListener('strand:pull-request-review-tools', open);
    return () => window.removeEventListener('strand:pull-request-review-tools', open);
  }, []);
  return <>
    <button type="button" className="btn" onClick={() => { setMarkFocus(false); setMode('compare'); }}>Review tools…</button>
    {mode && <HostedReviewDialog key={`${path}:${pr.url}`} path={path} provider={provider} pr={pr} initialMode={mode} openVersion={openVersion} markFocus={markFocus} onClose={() => setMode(null)} />}
  </>;
}

function HostedReviewDialog({ path, provider, pr, initialMode, openVersion, markFocus, onClose }: {
  path: string; provider: string; pr: PullRequest; initialMode: Mode; openVersion: number; markFocus: boolean; onClose: () => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [saved, setSaved] = useState<{ head: string; reviewedAt: string } | null>(null);
  const [providerBoundaries, setProviderBoundaries] = useState<PullRequestBoundary[]>([]);
  const [from, setFrom] = useState('');
  const [comparison, setComparison] = useState<PullRequestComparison | null>(null);
  const [file, setFile] = useState('');
  const [feedback, setFeedback] = useState<PullRequestFeedback | null>(null);
  const [candidate, setCandidate] = useState('');
  const [preview, setPreview] = useState<{ value: PullRequestSuggestionPreview; request: PullRequestSuggestionRequest; key: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const request = useRef<string | null>(null);
  const markButton = useRef<HTMLButtonElement>(null);
  const layout = useSettings(s => s.diffMode) === 'split' ? 'split' : 'unified';
  const key = `${provider}:${pr.url}`;
  const choices = useMemo(() => reviewBoundaries(saved, providerBoundaries), [saved, providerBoundaries]);
  const selectedFrom = from || choices[0]?.head || '';
  const candidates = useMemo(() => feedback ? feedbackSuggestions(feedback) : [], [feedback]);
  const selectedCandidate = candidates.find(c => c.key === candidate) ?? candidates[0];
  const exported = useMemo(() => feedback ? exportHostedFeedback(pr, feedback) : '', [pr.id, pr.title, pr.url, feedback]);
  const staleFeedback = feedback?.source_commit !== pr.source_commit;
  const focused = comparison?.diffs.find(d => d.path === file) ?? comparison?.diffs[0];

  function cancel() {
    const id = request.current;
    request.current = null;
    if (id) void tauri.repoPullRequestCancelRead(id).catch(() => {});
    setBusy('');
  }
  useEffect(() => {
    let active = true;
    void pullRequestReview.getBoundary(key).then(value => { if (active) setSaved(value); }, caught => { if (active) setError(errMessage(caught)); });
    return () => { active = false; };
  }, [key]);
  useEffect(() => {
    // Keep the old comparison/export visible, but never reuse their coordinates.
    cancel(); setPreview(null);
    return () => { const id = request.current; request.current = null; if (id) void tauri.repoPullRequestCancelRead(id).catch(() => {}); };
  }, [pr.source_commit]);
  useEffect(() => { setMode(initialMode); if (markFocus) markButton.current?.focus(); }, [initialMode, markFocus, openVersion]);

  async function run<T>(label: string, work: (id: string) => Promise<T>, accept: (value: T) => void) {
    if (request.current) return;
    const id = crypto.randomUUID(); request.current = id;
    setBusy(label); setError(''); setMessage('');
    try { const value = await work(id); if (request.current === id) accept(value); }
    catch (caught) { if (request.current === id) setError(errMessage(caught)); }
    finally { if (request.current === id) { request.current = null; setBusy(''); } }
  }
  const loadFeedback = () => void run('Loading all unresolved discussion…', id => tauri.repoPullRequestFeedback(path, pr.id, pr.source_commit, id), value => { setFeedback(value); setPreview(null); });
  const applying = busy === 'Applying suggestion…';
  return <Dialog title={`Review tools · #${pr.id}`} icon="compare" size="wide" className="compare-refs-dialog hosted-review-dialog" busy={applying} onClose={onClose} initialFocusRef={markFocus ? markButton : undefined}>
    <div className="hosted-review-toolbar">
      <label>Review tool <Select aria-label="Review tool" value={mode} disabled={!!busy} onChange={e => setMode(e.target.value as Mode)}>
        <option value="compare">Changes since review</option><option value="feedback">Unresolved feedback</option><option value="suggestions">Suggestions</option>
      </Select></label>
      <span title={pr.source_commit}>Current head {pr.source_commit.slice(0, 8)}</span>
      <button ref={markButton} type="button" className="btn" disabled={!!busy} onClick={() => void run('Saving reviewed head…', async () => {
        const boundary = { head: pr.source_commit, reviewedAt: new Date().toISOString() };
        await pullRequestReview.setBoundary(key, boundary); return boundary;
      }, value => { setSaved(value); setFrom(value.head); setMessage(`Saved ${value.head.slice(0, 8)} as my reviewed head on this device.`); })}>Mark head reviewed</button>
    </div>
    {mode === 'compare' ? <>
      <div className="hosted-review-toolbar">
        <label>Reviewed boundary <Select aria-label="Reviewed boundary" value={selectedFrom} disabled={!!busy} onChange={e => setFrom(e.target.value)}>
          {!choices.length && <option value="">No reviewed boundary saved</option>}
          {choices.map(choice => <option key={choice.head} value={choice.head}>{choice.head.slice(0, 8)} · {choice.label}</option>)}
        </Select></label>
        <button type="button" className="btn" disabled={!!busy} onClick={() => void run('Loading provider boundaries…', id => tauri.repoPullRequestBoundaries(path, pr.id, pr.source_commit, id), value => { setProviderBoundaries(previous => reviewBoundaries(null, [...value, ...previous])); if (!value.length) setMessage('No provider review boundary is available. Mark a reviewed head to compare after future updates.'); })}>Load {provider === 'git_hub' ? 'review commits' : 'iterations'}</button>
        <button type="button" className="btn primary" disabled={!!busy || !selectedFrom} onClick={() => void run('Comparing reviewed trees…', () => tauri.repoPullRequestCompareReview(path, pr.id, selectedFrom, pr.source_commit), value => { setComparison(value); setFile(current => value.diffs.some(d => d.path === current) ? current : value.diffs[0]?.path ?? ''); })}>Compare to current head</button>
      </div>
      <div className="compare-refs-message">
        {comparison ? <span>Showing {comparison.from.slice(0, 8)} → {comparison.to.slice(0, 8)} · {comparison.diffs.length} files{comparison.to !== pr.source_commit || comparison.from !== selectedFrom ? ' · Previous comparison; compare again to update' : ''}{comparison.history_rewritten ? ' · History was rewritten. These are the exact two trees.' : ''}</span> : <span>Save the head you reviewed, or choose a provider review commit or iteration. Comparison fetches missing commits without checking out a branch.</span>}
      </div>
    </> : <div className="hosted-review-toolbar">
      <button type="button" className="btn" disabled={!!busy} onClick={loadFeedback}>{feedback ? 'Reload' : 'Load'} all unresolved feedback</button>
      {feedback && <span>{feedback.threads.length} unresolved {feedback.threads.length === 1 ? 'thread' : 'threads'} · {feedback.source_commit.slice(0, 8)}{staleFeedback ? ' · Head changed; reload before using suggestions or copying' : ''}</span>}
      {mode === 'feedback' && <button type="button" className="btn primary" disabled={!!busy || !feedback || staleFeedback} onClick={() => void run('Copying feedback…', () => navigator.clipboard.writeText(exported), () => setMessage('Unresolved feedback copied.'))}>Copy feedback</button>}
    </div>}
    <div className="hosted-review-status" aria-live="polite">
      {busy && <span>{busy} {!applying && <button type="button" className="h-link" onClick={cancel}>Cancel read</button>}</span>}
      {error && <span role="alert">{error}</span>}{message && <span>{message}</span>}
    </div>
    {mode === 'compare' ? <div className="compare-refs-body">
      <div className="compare-refs-files" role="listbox" aria-label="Review comparison files">
        {comparison?.diffs.map(diff => <button key={diff.path} type="button" role="option" aria-selected={diff.path === focused?.path} tabIndex={diff.path === focused?.path ? 0 : -1} className={`compare-refs-file${diff.path === focused?.path ? ' active' : ''}`} onClick={() => setFile(diff.path)} onKeyDown={e => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const rows = Array.from(e.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="option"]'));
          const index = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)));
          rows[index]?.focus(); rows[index]?.click();
        }}><span className="path">{diff.old_path ? `${diff.old_path} → ` : ''}{diff.path}</span><span className="counts">+{diff.adds} −{diff.dels}</span></button>)}
      </div>
      <div className="compare-refs-diff">{focused?.patch && !focused.binary ? <Diff patch={focused.patch} layout={layout} /> : <div className="compare-refs-empty">{focused ? 'No textual diff for this file.' : comparison ? 'No changed files.' : 'Choose a reviewed boundary and compare.'}</div>}</div>
    </div> : mode === 'feedback' ? <textarea className="hosted-review-export" aria-label="Unresolved feedback export" readOnly value={exported} placeholder="Load all unresolved feedback to preview the export, including replies and file context." /> : <div className="hosted-review-suggestions">
      <p>Standard suggestion blocks apply to a clean file at the exact PR head. Open the branch in a worktree first. Old-side, outdated, unknown Azure iteration, column and offset suggestions require manual review.</p>
      <label>Suggestion <Select aria-label="Suggestion" value={selectedCandidate?.key ?? ''} disabled={!!busy} onChange={e => { setCandidate(e.target.value); setPreview(null); }}>
        {!candidates.length && <option value="">{feedback ? 'No standard suggestions in unresolved feedback' : 'Load feedback first'}</option>}
        {candidates.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
      </Select></label>
      <div className="hosted-review-toolbar">
        <button type="button" className="btn" disabled={!!busy || !selectedCandidate || staleFeedback} onClick={() => { if (selectedCandidate) void run('Validating suggestion…', id => tauri.repoPullRequestSuggestionPreview(path, pr.id, selectedCandidate.request, id), value => setPreview({ value, request: selectedCandidate.request, key: selectedCandidate.key })); }}>Preview local change</button>
        <button type="button" className="btn primary" disabled={!!busy || !preview || staleFeedback || preview.key !== selectedCandidate?.key} onClick={() => { if (preview) void run('Applying suggestion…', id => tauri.repoPullRequestSuggestionApply(path, pr.id, preview.request, preview.value, id), changed => {
          setPreview(null); setMessage(`Applied to ${changed}. The local change is ready for review.`);
          if (useRepo.getState().activePath === path) void useRepo.getState().refreshStatus();
        }); }}>Apply locally</button>
      </div>
      {preview && <><span>{preview.value.path} · lines {preview.value.start_line}–{preview.value.end_line}</span><div className="hosted-review-preview"><label>Before<textarea aria-label="Suggestion before" readOnly value={preview.value.before} /></label><label>After<textarea aria-label="Suggestion after" readOnly value={preview.value.after} /></label></div></>}
    </div>}
  </Dialog>;
}
