import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Dialog } from '../components/Dialog';
import { Select } from '../components/Select';
import { errMessage, tauri } from '../lib/tauri';
import type { BundlePreview, InterchangeOutcome, MailboxState, PatchPreview, PatchTarget } from '../lib/interchange';
import { useRepo } from '../stores/repo';

export function InterchangeDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const [mode, setMode] = useState<'patch' | 'bundle' | 'export'>('patch');
  const [source, setSource] = useState('');
  const [target, setTarget] = useState<PatchTarget>('worktree');
  const [patch, setPatch] = useState<PatchPreview | null>(null);
  const [bundle, setBundle] = useState<BundlePreview | null>(null);
  const [mailbox, setMailbox] = useState<MailboxState | null>(null);
  const [sourceRef, setSourceRef] = useState('');
  const [branch, setBranch] = useState('');
  const [exportRef, setExportRef] = useState('refs/heads/main');
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'skip' | 'abort' | null>(null);
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const first = useRef<HTMLSelectElement>(null);
  const generation = useRef(0);
  const stateGeneration = useRef(0);
  const mounted = useRef(true);
  const invalidate = useCallback(() => { generation.current++; setPatch(null); setBundle(null); setConfirm(null); }, []);
  const refresh = useCallback(async () => {
    const seq = ++stateGeneration.current;
    try {
      const next = await tauri.repoMailboxState(path);
      if (mounted.current && stateGeneration.current === seq) setMailbox(next);
    } catch (e) { if (mounted.current && stateGeneration.current === seq) { setMailbox(null); setError(errMessage(e)); } }
  }, [path]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onChange = () => { invalidate(); void refresh(); };
    const unlisten = listen<string>('repo://changed', (event) => { if (event.payload === path) onChange(); });
    window.addEventListener('focus', onChange);
    const focus = requestAnimationFrame(() => first.current?.focus());
    return () => { mounted.current = false; generation.current++; stateGeneration.current++; cancelAnimationFrame(focus); window.removeEventListener('focus', onChange); void unlisten.then((fn) => fn()); };
  }, [path, refresh, invalidate]);

  async function run(work: () => Promise<void>, mutation = false) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); }
    catch (e) { if (mounted.current) setError(errMessage(e)); }
    finally {
      if (mutation) {
        invalidate();
        await refresh();
        const repo = useRepo.getState();
        if (repo.activePath === path) await Promise.all([repo.refreshLocalChanges(), repo.refreshLog()]);
      }
      if (mounted.current) { setBusy(false); requestAnimationFrame(() => first.current?.focus()); }
    }
  }
  function outcome(result: InterchangeOutcome) {
    setOutput(result.output || (result.success ? 'Completed.' : 'Git stopped without output.'));
    if (!result.success && !result.paused) setError(result.output || 'Git operation failed.');
  }
  async function preview() {
    const seq = ++generation.current;
    if (mode === 'patch') {
      const next = await tauri.repoPatchPreview(path, source, target);
      if (mounted.current && seq === generation.current) setPatch(next);
      else if (mounted.current) setError('Repository changed during validation. Preview again.');
    } else {
      const next = await tauri.repoBundlePreview(path, source);
      if (mounted.current && seq === generation.current) { setBundle(next); setSourceRef(next.refs[0]?.name ?? ''); }
      else if (mounted.current) setError('Repository changed during verification. Verify again.');
    }
  }
  async function browse() {
    const chosen = mode === 'export' ? await save({ title: 'Export Git bundle', filters: [{ name: 'Git bundle', extensions: ['bundle'] }] }) : await open({ title: 'Import patch, mailbox or bundle', multiple: false, directory: false });
    if (typeof chosen === 'string') { setSource(chosen); invalidate(); }
  }

  return <Dialog title="Patches, mailboxes & bundles" size="lg" busy={busy} onClose={onClose} initialFocusRef={first}
    footer={<><span role="status">{busy ? 'Running Git…' : ''}</span><button className="btn" disabled={busy} onClick={() => { invalidate(); void refresh(); }}>Refresh state</button><button className="btn" disabled={busy} onClick={onClose}>Close</button></>}>
    <div className="clone-body git-tool-body">
      <p className="stash-blurb">Repository: <code>{path}</code></p>
      {mailbox && <section className="git-tool-review" aria-label="Mailbox recovery">
        <strong>Mailbox paused · patch {mailbox.current} of {mailbox.total}</strong>
        <pre>{mailbox.author || 'Author metadata is not available yet.'}</pre>
        <p>Resolve and stage conflicts in Local Changes, then return here to continue. Skip discards this patch’s changes; Abort restores the checkout before this mailbox and discards its applied changes.</p>
        <div className="git-tool-actions">
          <button className="btn" disabled={busy} onClick={() => { useRepo.getState().setView('local'); onClose(); }}>Open Local Changes</button>
          <button className="btn primary" disabled={busy || mailbox.conflicts} onClick={() => void run(async () => outcome(await tauri.repoMailboxAction(path, 'continue', mailbox.token)), true)}>Continue mailbox</button>
          {(['skip', 'abort'] as const).map((action) => <button key={action} className="btn danger" disabled={busy} onClick={() => {
            if (confirm !== action) { setConfirm(action); return; }
            void run(async () => outcome(await tauri.repoMailboxAction(path, action, mailbox.token)), true);
          }}>{confirm === action ? 'Confirm ' : ''}{action === 'skip' ? 'Skip patch' : 'Abort mailbox'}</button>)}
        </div>
      </section>}
      <label className="clone-field"><span className="lbl">Workflow</span><Select ref={first} className="clone-input" value={mode} disabled={busy} onChange={(e) => { setMode(e.target.value as typeof mode); setSource(''); setOutput(''); invalidate(); }}>
        <option value="patch">Import patch or mailbox</option><option value="bundle">Verify / import bundle</option><option value="export">Export bundle</option>
      </Select></label>
      <label className="clone-field"><span className="lbl">{mode === 'export' ? 'New destination file' : 'Source file'}</span><input className="clone-input" value={source} disabled={busy} onChange={(e) => { setSource(e.target.value); invalidate(); }} /></label>
      <button className="btn" disabled={busy} onClick={() => void run(browse)}>Browse…</button>
      {mode === 'patch' && <>
        <label className="clone-field"><span className="lbl">Apply to</span><Select className="clone-input" value={target} disabled={busy} onChange={(e) => { setTarget(e.target.value as PatchTarget); invalidate(); }}>
          <option value="worktree">Working tree only (unstaged changes)</option><option value="index">Index only (staged changes; files unchanged)</option><option value="both">Index and working tree (staged changes)</option><option value="mailbox">Mailbox — create commits with original authors</option>
        </Select></label>
        <button className="btn" disabled={busy || !source || !!mailbox} onClick={() => void run(preview)}>Preview and validate</button>
        {patch && <section className="git-tool-review" aria-label="Patch preview">
          <strong>{patch.valid ? 'Validation passed' : target === 'mailbox' ? 'Direct application failed — Git will try a three-way merge' : 'Validation failed'}</strong>
          <pre>{patch.validation}</pre>
          <details open><summary>Affected paths ({patch.paths.length})</summary><pre>{patch.paths.join('\n')}</pre></details>
          {patch.messages.length > 0 && <details open><summary>Original authors and messages ({patch.messages.length})</summary><pre>{patch.messages.join('\n\n')}</pre></details>}
          <button className="btn primary" disabled={busy || (!patch.valid && target !== 'mailbox')} onClick={() => void run(async () => outcome(await tauri.repoPatchImport(path, source, target, patch.token)), true)}>{target === 'mailbox' ? 'Start mailbox import' : 'Apply reviewed patch'}</button>
        </section>}
      </>}
      {mode === 'bundle' && <>
        <button className="btn" disabled={busy || !source} onClick={() => void run(preview)}>Verify bundle</button>
        {bundle && <section className="git-tool-review" aria-label="Bundle review">
          <strong>{bundle.valid ? 'Bundle verified' : 'Bundle cannot be imported here'}</strong><pre>{bundle.validation}</pre>
          <p>Prerequisites</p><pre>{bundle.prerequisites.join('\n') || 'None — self-contained bundle'}</pre>
          <label className="clone-field"><span className="lbl">Advertised ref to import</span><Select className="clone-input" value={sourceRef} disabled={busy} onChange={(e) => setSourceRef(e.target.value)}>{bundle.refs.map((r) => <option key={r.name} value={r.name}>{r.name} · {r.oid}</option>)}</Select></label>
          <label className="clone-field"><span className="lbl">New local branch</span><input className="clone-input" value={branch} disabled={busy} onChange={(e) => setBranch(e.target.value)} /></label>
          <p>Imports objects and creates this branch. The current checkout stays in place. Existing branches cannot be overwritten.</p>
          <button className="btn primary" disabled={busy || !bundle.valid || !branch || !sourceRef} onClick={() => void run(async () => outcome(await tauri.repoBundleImport(path, source, bundle.token, sourceRef, branch)), true)}>Import into new branch</button>
        </section>}
      </>}
      {mode === 'export' && <>
        <label className="clone-field"><span className="lbl">Full ref to export</span><input className="clone-input" value={exportRef} disabled={busy} onChange={(e) => setExportRef(e.target.value)} placeholder="refs/heads/main" /></label>
        <label className="clone-field"><span className="lbl">Exclude prerequisite revision (optional)</span><input className="clone-input" value={base} disabled={busy} onChange={(e) => setBase(e.target.value)} placeholder="Leave empty for complete history" /></label>
        <p className="stash-note">Recipients need the excluded history. The new file contains the selected ref and reachable history; existing files are never overwritten.</p>
        <button className="btn primary" disabled={busy || !source || !exportRef} onClick={() => void run(async () => { const result = await tauri.repoBundleExport(path, source, exportRef, base || null); setOutput(`Exported ${source}\n${result.validation}\nPrerequisites:\n${result.prerequisites.join('\n') || 'None'}`); })}>Export bundle</button>
      </>}
      {error && <div className="clone-error" role="alert">{error}</div>}
      {output && <pre className="git-tool-output" aria-live="polite">{output}</pre>}
    </div>
  </Dialog>;
}
