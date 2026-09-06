import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Dialog } from '../components/Dialog';
import { Select } from '../components/Select';
import { errMessage, tauri } from '../lib/tauri';
import type { FlowAction, FlowConfig, FlowKind, FlowPlan, FlowState, FlowTool } from '../lib/gitflow';
import { useRepo } from '../stores/repo';

export function GitflowDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const [state, setState] = useState<FlowState | null>(null);
  const [tool, setTool] = useState<FlowTool | null>(null);
  const [draft, setDraft] = useState<FlowConfig | null>(null);
  const [configToken, setConfigToken] = useState('');
  const [settings, setSettings] = useState(false);
  const [kind, setKind] = useState<FlowKind>('feature');
  const [name, setName] = useState('');
  const [plan, setPlan] = useState<FlowPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [output, setOutput] = useState('');
  const [result, setResult] = useState('');
  const first = useRef<HTMLButtonElement>(null);
  const reviewPanel = useRef<HTMLElement>(null);
  const focusReview = useRef(false);
  const mounted = useRef(true);
  const reads = useRef(0);
  const seeded = useRef(false);
  function loadDraft(next: FlowState) { setDraft(next.config); setConfigToken(next.token); }
  const refresh = useCallback(async () => {
    const seq = ++reads.current;
    try {
      const next = await tauri.repoGitflowState(path);
      if (!mounted.current || seq !== reads.current) return;
      setState(next);
      if (!seeded.current) { seeded.current = true; loadDraft(next); }
    } catch (e) { if (mounted.current && seq === reads.current) { setError(errMessage(e)); setState(null); } }
  }, [path]);
  useEffect(() => {
    mounted.current = true; void refresh();
    const changed = () => { void refresh(); };
    const unlisten = listen<string>('repo://changed', changed);
    window.addEventListener('focus', changed);
    const focus = requestAnimationFrame(() => first.current?.focus());
    return () => { mounted.current = false; reads.current++; cancelAnimationFrame(focus); window.removeEventListener('focus', changed); void unlisten.then((fn) => fn()); };
  }, [refresh]);
  async function run(work: () => Promise<void>, mutation = false) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); } catch (e) { if (mounted.current) setError(errMessage(e)); }
    finally {
      await refresh();
      if (mutation) { const repo = useRepo.getState(); if (repo.activePath === path) await Promise.all([repo.refreshLocalChanges(), repo.refreshLog()]); }
      if (mounted.current) { setBusy(false); requestAnimationFrame(() => { if (focusReview.current && reviewPanel.current) reviewPanel.current.focus(); else first.current?.focus(); focusReview.current = false; }); }
    }
  }
  function review(action: FlowAction) { void run(async () => { setPlan(await tauri.repoGitflowPlan(path, kind, action, name)); focusReview.current = true; setResult(''); }); }
  const actionLabel: Record<FlowAction, string> = { start: 'Start reviewed workflow', finish: 'Finish reviewed workflow', continue_merge: 'Continue reviewed merge', abort_merge: 'Abort reviewed merge' };
  return <Dialog title="Git-flow workflows" size="lg" busy={busy} initialFocusRef={first} onClose={onClose}
    footer={<><span role="status">{busy ? 'Git-flow is working…' : result}</span><button className="btn" disabled={busy} onClick={() => void refresh()}>Refresh Git-flow state</button><button className="btn" disabled={busy} onClick={onClose}>Close</button></>}>
    <div className="clone-body git-tool-body">
      <p className="stash-blurb">Repository: <code>{path}</code>. Git-flow is optional and uses the installed Git-flow AVH extension.</p>
      <button ref={first} className="btn" disabled={busy} onClick={() => void run(async () => { setTool(await tauri.repoGitflowDetect()); })}>Detect Git-flow AVH</button>
      {tool && <p role="status">{tool.available ? 'Available: ' : 'Git-flow AVH is unavailable or unsupported: '}{tool.version}</p>}
      {state && <>
        <p>Checkout: <code>{state.current || 'detached HEAD'}</code> · <code>{state.head}</code><br />{state.clean ? 'Working tree is clean.' : 'Working tree has changes.'} {state.operation && `Active Git operation: ${state.operation}.`}</p>
        <p>{state.enabled ? `Enabled · production ${state.config.production} · develop ${state.config.develop}` : 'Git-flow is disabled in Strand for this repository.'}</p>
        {state.enabled && <button className="btn" disabled={busy} onClick={() => { setSettings(!settings); if (!settings) loadDraft(state); }}>Configure Git-flow…</button>}
        {(!state.enabled || settings) && draft && <section className="git-tool-review" aria-label="Git-flow configuration">
          <p>Save sets these shared repository settings. Select existing base branches; create missing branches with Strand’s branch command first.</p>
          <datalist id="gitflow-base-branches">{Object.keys(state.branches).map((branch) => <option key={branch} value={branch} />)}</datalist>
          {([['production', 'Production branch'], ['develop', 'Develop branch'], ['feature', 'Feature prefix'], ['release', 'Release prefix'], ['hotfix', 'Hotfix prefix'], ['version_tag', 'Version tag prefix']] as const).map(([key, label]) => <label className="clone-field" key={key}><span className="lbl">{label}</span><input className="clone-input" list={key === 'production' || key === 'develop' ? 'gitflow-base-branches' : undefined} disabled={busy} value={draft[key]} onChange={(e) => { setDraft({ ...draft, [key]: e.target.value }); setPlan(null); }} /></label>)}
          {configToken !== state.token && <p className="stash-note">Repository state changed since this configuration was loaded. Reload it before saving.</p>}
          <div className="git-tool-actions"><button className="btn" disabled={busy} onClick={() => loadDraft(state)}>Reload configuration</button><button className="btn primary" disabled={busy || !tool?.available || configToken !== state.token} onClick={() => void run(async () => { const next = await tauri.repoGitflowConfigure(path, draft, true, configToken); loadDraft(next); setState(next); setSettings(false); setResult('Git-flow enabled with the reviewed configuration.'); }, true)}>Enable / save Git-flow</button>
            {state.enabled && <button className="btn" disabled={busy} onClick={() => void run(async () => { const next = await tauri.repoGitflowConfigure(path, state.config, false, state.token); loadDraft(next); setState(next); setPlan(null); }, true)}>Disable in Strand</button>}</div>
        </section>}
        {state.enabled && <>
          <label className="clone-field"><span className="lbl">Workflow kind</span><Select className="clone-input" value={kind} disabled={busy} onChange={(e) => { setKind(e.target.value as FlowKind); setName(''); setPlan(null); }}><option value="feature">Feature</option><option value="release">Release</option><option value="hotfix">Hotfix</option></Select></label>
          <label className="clone-field"><span className="lbl">Workflow name (without prefix)</span><input className="clone-input" value={name} list="gitflow-existing-branches" disabled={busy} onChange={(e) => { setName(e.target.value); setPlan(null); }} /><datalist id="gitflow-existing-branches">{Object.keys(state.branches).filter((b) => b.startsWith(state.config[kind])).map((b) => <option key={b} value={b.slice(state.config[kind].length)} />)}</datalist></label>
          <p className="stash-note">Start and finish require a clean checkout. Finish retains workflow branches and performs no fetch or push. Existing sessions started in a terminal can be resumed by selecting their exact branch name.</p>
          <div className="git-tool-actions"><button className="btn" disabled={busy || !name || !state.clean || !!state.operation} onClick={() => review('start')}>Review start</button><button className="btn" disabled={busy || !name || !state.clean || !!state.operation} onClick={() => review('finish')}>Review finish / resume</button></div>
          {state.operation === 'merge' && <section className="git-tool-review" aria-label="Git-flow merge recovery"><p>Resolve files in Local Changes and stage them, then continue this merge. Afterwards, review Finish again to run the remaining stages. A completed merge or tag survives aborting a later merge.</p><div className="git-tool-actions"><button className="btn" disabled={busy || state.conflicts} onClick={() => review('continue_merge')}>Review continue merge</button><button className="btn danger" disabled={busy} onClick={() => review('abort_merge')}>Review abort merge</button><button className="btn" disabled={busy} onClick={() => { const repo = useRepo.getState(); if (repo.activePath === path) repo.setView('local'); onClose(); }}>Open Local Changes</button></div></section>}
          {Object.keys(state.options).length > 0 && <details><summary>Current Git-flow configuration</summary><pre className="git-tool-output">{Object.entries(state.options).map(([k, v]) => `${k} = ${v}`).join('\n')}</pre></details>}
        </>}
        {plan && <section ref={reviewPanel} tabIndex={-1} className="git-tool-review" aria-label="Git-flow operation review"><ol>{plan.steps.map((step, i) => <li key={i}>{step}</li>)}</ol><p>Git arguments (each quoted item is one argument):</p><pre className="git-tool-output">git {plan.args.map((arg) => JSON.stringify(arg)).join(' ')}</pre>
          {plan.token !== state.token && <p className="clone-error">Git state changed after review. Review the operation again.</p>}
          <button className={`btn ${plan.action === 'abort_merge' ? 'danger' : 'primary'}`} disabled={busy || plan.token !== state.token} onClick={() => void run(async () => { setOutput(''); setResult(''); const outcome = await tauri.repoGitflowRun(path, plan, (text) => { if (mounted.current) setOutput(text); }); reads.current++; setState(outcome.state); setOutput(outcome.output); setPlan(null); setResult(outcome.success ? 'Git-flow step completed.' : 'Git-flow paused or failed. Review its output and current Git state.'); }, true)}>{actionLabel[plan.action]}</button>
        </section>}
      </>}
      {error && <div className="clone-error" role="alert">{error}</div>}
      {output && <section aria-label="Git-flow output"><p>Latest Git output (up to 64 KiB)</p><pre className="git-tool-output" tabIndex={0}>{output}</pre></section>}
    </div>
  </Dialog>;
}
