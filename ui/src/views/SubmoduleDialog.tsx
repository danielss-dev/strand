import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { Select } from '../components/Select';
import { SUBMODULE_ACTIONS, type SubmoduleDialogAction } from '../lib/submodules';
import { errMessage, isCancelled, tauri } from '../lib/tauri';
import type { SubmoduleAction, SubmodulePage } from '../lib/types';
import { useRepo } from '../stores/repo';
import { useWorkspaces } from '../stores/workspaces';

export function SubmoduleDialog({ path, initialPath = '', initialAction = 'inspect', onClose }: {
  path: string; initialPath?: string; initialAction?: SubmoduleDialogAction; onClose: () => void;
}) {
  const [parent, setParent] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<SubmodulePage>({ modules: [], next_offset: null });
  const [selected, setSelected] = useState(initialPath);
  const [action, setAction] = useState<SubmoduleDialogAction>(initialAction);
  const [newPath, setNewPath] = useState('');
  const [url, setUrl] = useState('');
  const [recursive, setRecursive] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [output, setOutput] = useState('Choose a module to inspect its files, or open its nested modules.');
  const [error, setError] = useState(false);
  const [progress, setProgress] = useState('');
  const busy = useRef(false);
  const focus = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => focus.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const owner = parent ? `${path}/${parent}` : path;
  const module = page.modules.find((item) => item.path === selected);
  const destructive = action === 'remove' || action === 'deinit';

  useEffect(() => {
    let current = true;
    setLoading(true);
    setConfirm(false); setUrl('');
    void tauri.repoSubmoduleChildren(path, parent, offset).then((result) => {
      if (!current) return;
      setPage(result);
      setSelected((old) => result.modules.some((item) => item.path === old) ? old : result.modules[0]?.path ?? '');
    }).catch((e) => { if (current) { setError(true); setOutput(errMessage(e)); } }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [path, parent, offset, reload]);

  function navigate(next: string) {
    setParent(next); setOffset(0); setSelected(''); setConfirm(false); setPage({ modules: [], next_offset: null });
  }

  async function run() {
    if (busy.current || loading) return;
    if (destructive && !confirm) { setConfirm(true); return; }
    busy.current = true; setConfirm(false); setError(false);
    const opId = crypto.randomUUID();
    setRunning(opId); setProgress('Starting…');
    try {
      const request: SubmoduleAction | null = action === 'update-all' ? null
        : action === 'add' ? { action, path: newPath, url }
        : action === 'set-url' ? { action, path: selected, url }
        : action === 'update' || action === 'sync' ? { action, path: selected, recursive }
        : { action, path: selected };
      const result = request
        ? await tauri.repoSubmoduleAction(owner, request, opId, (p) => setProgress(p.raw))
        : await tauri.repoSubmoduleUpdate(owner, [], true, recursive, (p) => setProgress(p.raw), opId);
      setOutput(result.output || 'Completed. Review the submodule and .gitmodules changes in Local Changes before committing.');
    } catch (e) {
      setError(true);
      setOutput(isCancelled(e) ? 'Cancelled. Completed clones and local Git data are retained. Refresh and inspect the module before retrying.' : errMessage(e));
    } finally {
      setReload((v) => v + 1);
      setRunning(null); busy.current = false; setProgress('');
      if (action !== 'inspect' && useRepo.getState().activePath === path) {
        await useRepo.getState().refreshLocalChanges().catch((e) => { setError(true); setOutput(`Refresh failed: ${errMessage(e)}`); });
      }
    }
  }

  return <Dialog title="Submodules" icon="submodule" className="maintenance-dialog" initialFocusRef={focus} busy={!!running} onClose={onClose}
    footer={<>{running ? <button className="btn danger" onClick={() => void tauri.repoCancelOp(running).catch((e) => setOutput(errMessage(e)))}>Cancel operation</button>
      : <><button className="btn" onClick={onClose}>Close</button><button className={`btn ${destructive ? 'danger' : 'primary'}`} disabled={loading || (action !== 'add' && action !== 'update-all' && !selected) || (action === 'add' && !newPath.trim()) || ((action === 'add' || action === 'set-url') && !url.trim())} onClick={() => void run()}>{confirm ? `Confirm ${action === 'remove' ? 'removal' : 'deinitialization'}` : SUBMODULE_ACTIONS.find(([id]) => id === action)?.[1]}</button></>}</>}>
    <div className="clone-body maintenance-body">
      <p className="stash-blurb">{parent || 'Repository root'} · Choose a submodule to inspect its changes or browse its nested repositories.</p>
      <label className="clone-field"><span className="lbl">Action</span><Select className="clone-input" ref={focus} value={action} disabled={!!running} onChange={(e) => { setAction(e.target.value as SubmoduleDialogAction); setConfirm(false); setUrl(module?.url ?? ''); }}>{SUBMODULE_ACTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select></label>
      {action !== 'add' && <>
        <label className="clone-field"><span className="lbl">Submodule</span><Select className="clone-input" value={selected} disabled={!!running || loading} onChange={(e) => { setSelected(e.target.value); setConfirm(false); setUrl(page.modules.find((item) => item.path === e.target.value)?.url ?? ''); }}>{page.modules.length === 0 && <option value="">{loading ? 'Loading…' : 'No submodules at this level'}</option>}{page.modules.map((item) => <option key={item.path} value={item.path}>{item.path} — {item.initialized ? item.head_id === item.workdir_id ? 'recorded commit' : 'different commit' : 'uninitialized'}</option>)}</Select></label>
        {module && <p className="stash-blurb">URL: {module.url ?? 'not set'}<br />Index: {module.head_id ?? 'none'}<br />Checked out: {module.workdir_id ?? 'none'}</p>}
        <div className="submodule-navigation">
          <button className="btn" disabled={!!running || !module?.initialized} onClick={() => navigate(parent ? `${parent}/${selected}` : selected)}>Inspect nested modules</button>
          <button className="btn" disabled={!!running || !module?.initialized} onClick={() => { void useWorkspaces.getState().openRepoInActive(`${owner}/${selected}`).then(onClose).catch((e) => { setError(true); setOutput(errMessage(e)); }); }}>Open repository</button>
          <button className="btn" disabled={!!running || !parent} onClick={() => navigate('')}>Repository root</button>
          <button className="btn" disabled={!!running || loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous page</button>
          <button className="btn" disabled={!!running || loading || page.next_offset == null} onClick={() => setOffset(page.next_offset!)}>Next page</button>
        </div>
      </>}
      {action === 'add' && <label className="clone-field"><span className="lbl">Folder within this repository</span><input className="clone-input" value={newPath} disabled={!!running} onChange={(e) => setNewPath(e.target.value)} placeholder="vendor/library" /></label>}
      {(action === 'add' || action === 'set-url') && <label className="clone-field"><span className="lbl">Repository URL</span><input className="clone-input" value={url} disabled={!!running} onChange={(e) => setUrl(e.target.value)} /></label>}
      {(action === 'update' || action === 'update-all' || action === 'sync') && <label><input type="checkbox" checked={recursive} disabled={!!running} onChange={(e) => setRecursive(e.target.checked)} /> Include nested submodules</label>}
      {destructive && <p className="stash-blurb">{action === 'remove' ? 'Remove the submodule’s local files and stage its removal from this repository.' : 'Remove the submodule’s local files, but keep its configuration so you can download it again.'} Strand stops if it finds local edits, ignored files or commits that would be lost, including in nested submodules. Git keeps the downloaded history.</p>}
      <div role="status" aria-live="polite">{progress}</div>
      <div className={`maintenance-entry${error ? ' failed' : ''}`}><pre tabIndex={0} aria-label="Submodule result">{output}</pre></div>
    </div>
  </Dialog>;
}
