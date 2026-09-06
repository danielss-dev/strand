import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { Select } from '../components/Select';
import { positiveDepth } from '../lib/cloneOptions';
import { errMessage, isCancelled, tauri } from '../lib/tauri';
import type { CloneScope, HistoryExpansion } from '../lib/types';

export function CloneScopeDialog({ path, busy, progress, onExpand, onCancel, onClose }: {
  path: string;
  busy: boolean;
  progress: string | null;
  onCancel: () => void;
  onExpand: (path: string, remote: string, expansion: HistoryExpansion) => Promise<void>;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<CloneScope | null>(null);
  const [remote, setRemote] = useState('');
  const [depth, setDepth] = useState('100');
  const [error, setError] = useState('');
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    let current = true;
    void tauri.repoCloneScope(path).then((value) => {
      if (!current) return;
      setScope(value);
      setRemote(value.remotes.find((r) => r.name === 'origin')?.name ?? value.remotes[0]?.name ?? '');
    }).catch((e) => { if (current) setError(errMessage(e)); });
    return () => { current = false; };
  }, [path]);
  useEffect(() => {
    if (!scope || busy) return;
    const frame = requestAnimationFrame(() => first.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [scope, busy]);
  async function expand(expansion: HistoryExpansion) {
    setError('');
    try {
      await onExpand(path, remote, expansion);
      setScope(await tauri.repoCloneScope(path));
    } catch (e) { setError(isCancelled(e) ? 'History download cancelled.' : errMessage(e)); }
  }
  const selected = scope?.remotes.find((r) => r.name === remote);
  return <Dialog title="Repository history and downloads" icon="remote" className="clone-options-dialog" busy={busy} onClose={onClose} footer={
    busy ? <button className="btn danger" type="button" onClick={onCancel}>Cancel download</button>
      : <button className="btn" type="button" onClick={onClose}>Close</button>
  }>
    <div className="clone-body">
      {error && <p role="alert" className="clone-error">{error}</p>}
      {busy && <p role="status">{progress || 'Downloading history…'}</p>}
      {!scope ? <p>Reading repository configuration…</p> : <>
        <p>{scope.shallow ? 'Only recent history is downloaded. Older commits may be unavailable.' : 'All available commit history is downloaded.'}</p>
        <label className="clone-field"><span className="lbl">Remote</span>
          <Select ref={first} className="clone-input" value={remote} disabled={busy || !scope.remotes.length} onChange={(e) => setRemote(e.target.value)}>
            {scope.remotes.map((r) => <option key={r.name}>{r.name}</option>)}
          </Select>
        </label>
        {!scope.remotes.length && <p>No remotes configured. Add a remote before downloading history.</p>}
        {selected && <>
          <p className="stash-blurb">{selected.filter ? `Partial clone filter: ${selected.filter}. Missing file contents may need a network connection.` : 'No partial-clone filter configured for this remote.'}</p>
          <details className="settings-disclosure"><summary>Branch download rules</summary><div className="stash-blurb">Fetched branches: {selected.fetch_refspecs.length ? selected.fetch_refspecs.map((ref) => <div key={ref}><code>{ref}</code></div>) : 'No fetch refspec configured'}</div></details>
        </>}
        {scope.shallow && <>
          <label className="clone-field"><span className="lbl">Additional commits</span>
            <input className="clone-input" type="number" min="1" max="4294967295" step="1" value={depth} disabled={busy} onChange={(e) => setDepth(e.target.value)} />
          </label>
          <div className="clone-scope-actions">
            <button className="btn primary" type="button" disabled={busy || !remote || positiveDepth(depth) === null} onClick={() => void expand({ kind: 'deepen', commits: positiveDepth(depth)! })}>Download more history</button>
            <button className="btn" type="button" disabled={busy || !remote} onClick={() => void expand({ kind: 'unshallow' })}>Download full history</button>
          </div>
          <p className="stash-blurb">Downloads use more bandwidth and disk and preserve your current branch and local edits. Full history may remain shallow if the source is shallow. These actions keep the existing branch refspecs and partial-clone filter.</p>
        </>}
      </>}
    </div>
  </Dialog>;
}
