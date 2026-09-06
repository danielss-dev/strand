import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Dialog } from '../components/Dialog';
import { bisectRatingBlock, type BisectAction, type BisectOutcome, type BisectState } from '../lib/bisect';
import { errMessage, tauri } from '../lib/tauri';
import { useRepo } from '../stores/repo';

export function BisectDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const [state, setState] = useState<BisectState | null>(null);
  const [good, setGood] = useState('');
  const [bad, setBad] = useState('HEAD');
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(false);
  const [error, setError] = useState('');
  const [output, setOutput] = useState('');
  const first = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const seq = ++generation.current;
    try { const next = await tauri.repoBisectState(path); if (mounted.current && seq === generation.current) { setState(next); setReset(false); } }
    catch (e) { if (mounted.current && seq === generation.current) { setState(null); setError(errMessage(e)); } }
  }, [path]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const changed = () => void refresh();
    const unlisten = listen<string>('repo://changed', (event) => { if (event.payload === path) changed(); });
    window.addEventListener('focus', changed);
    const focus = requestAnimationFrame(() => first.current?.focus());
    return () => { mounted.current = false; generation.current++; cancelAnimationFrame(focus); window.removeEventListener('focus', changed); void unlisten.then((fn) => fn()); };
  }, [path, refresh]);
  async function run(work: () => Promise<BisectOutcome>) {
    if (busy || !state) return;
    setBusy(true); setError(''); setReset(false); generation.current++;
    try {
      const result = await work();
      if (mounted.current) { setState(result.state); setOutput(result.output); if (!result.success) setError(result.output); }
    } catch (e) { if (mounted.current) setError(errMessage(e)); }
    finally {
      await refresh();
      const repo = useRepo.getState();
      if (repo.activePath === path) await Promise.all([repo.refreshLocalChanges(), repo.refreshLog()]);
      if (mounted.current) { setBusy(false); requestAnimationFrame(() => first.current?.focus()); }
    }
  }
  const blocked = state?.active ? bisectRatingBlock(state) : null;
  const rate = (action: BisectAction) => { if (state) void run(() => tauri.repoBisectAction(path, action, state.token)); };
  return <Dialog title="Guided bisect" size="lg" busy={busy} initialFocusRef={first} onClose={onClose}
    footer={<><button className="btn" ref={first} disabled={busy} onClick={() => { setError(''); void refresh(); }}>Refresh from Git</button><button className="btn" disabled={busy} onClick={onClose}>Close — keep session</button></>}>
    <div className="clone-body git-tool-body">
      <p className="stash-blurb">Find the commit that introduced a problem. Test each selected revision yourself, then mark the result. Repository: <code>{path}</code></p>
      {busy && <p role="status">Git is updating the bisect session…</p>}
      {!state && !error && <p role="status">Reading Git state…</p>}
      {state && !state.active && <>
        <p>Current checkout: <code>{state.current}</code> · {state.subject}</p>
        <label className="clone-field"><span className="lbl">Known good revision</span><input className="clone-input" value={good} disabled={busy} onChange={(e) => setGood(e.target.value)} placeholder="Commit, branch or tag before the problem" /></label>
        <label className="clone-field"><span className="lbl">Known bad revision</span><input className="clone-input" value={bad} disabled={busy} onChange={(e) => setBad(e.target.value)} /></label>
        <p className="stash-note">Git will check out test revisions with detached HEAD. Reset returns to the original branch or detached commit. Start and checkout transitions require a clean working tree and index.</p>
        {!state.clean && <p className="clone-error">Commit or stash changes before starting.</p>}
        <button className="btn primary" disabled={busy || !state.clean || !good || !bad} onClick={() => void run(() => tauri.repoBisectStart(path, good, bad, state.token))}>Start bisect</button>
      </>}
      {state?.active && <section className="git-tool-review" aria-label="Bisect progress">
        <strong>{state.culprit ? 'First bad commit found' : state.ambiguous ? 'Result is ambiguous — skipped commits remain' : 'Test this revision'}</strong>
        <code>{state.culprit || state.current}</code><p>{state.subject}</p>
        {state.range_error ? <p>Search range is not available yet: {state.range_error}</p> : <p>{state.remaining}{state.remaining_truncated ? '+' : ''} candidate commits remain{state.remaining > 1 && !state.culprit && !state.ambiguous ? ` · about ${Math.ceil(Math.log2(state.remaining))} more tests for a linear history without skips` : ''}.</p>}
        {state.no_checkout && <p>This external session uses no-checkout mode. Test <code>BISECT_HEAD</code>; the working files remain at HEAD.</p>}
        {blocked && <p className="stash-note">{blocked}</p>}
        {state.expected && state.expected !== state.current && <p>Expected revision: <code>{state.expected}</code></p>}
        <div className="git-tool-actions">
          <button className="btn primary" disabled={busy || !!blocked} onClick={() => rate('good')}>Mark good{state.good_term !== 'good' ? ` (${state.good_term})` : ''}</button>
          <button className="btn" disabled={busy || !!blocked} onClick={() => rate('bad')}>Mark bad{state.bad_term !== 'bad' ? ` (${state.bad_term})` : ''}</button>
          <button className="btn" disabled={busy || !!blocked} onClick={() => rate('skip')}>Skip — cannot test</button>
        </div>
        <p>Original checkout: <code>{state.original}</code> at <code>{state.original_tip || 'missing ref'}</code>. Reset ends this session and returns there. Test edits must be committed or stashed first.</p>
        <button className="btn danger" disabled={busy || !state.clean} onClick={() => reset ? rate('reset') : setReset(true)}>{reset ? 'Confirm reset to original checkout' : 'Reset bisect…'}</button>
        <details><summary>Git bisect log</summary><pre>{state.log}</pre></details>
      </section>}
      {error && <div className="clone-error" role="alert">{error}</div>}
      {output && <pre className="git-tool-output" aria-live="polite">{output}</pre>}
    </div>
  </Dialog>;
}
