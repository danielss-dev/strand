import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { errMessage, tauri } from '../lib/tauri';
import type { SparseCheckout } from '../lib/types';
import { useRepo } from '../stores/repo';

export function SparseCheckoutDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const [state, setState] = useState<SparseCheckout | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [sparseIndex, setSparseIndex] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const search = useRef<HTMLInputElement>(null);
  function accept(value: SparseCheckout) {
    setState(value); setSelected(value.directories); setSparseIndex(value.sparse_index);
  }
  useEffect(() => {
    let current = true;
    void tauri.repoSparseCheckout(path).then((value) => { if (current) accept(value); })
      .catch((e) => { if (current) setError(errMessage(e)); });
    return () => { current = false; };
  }, [path]);
  useEffect(() => {
    if (!state || busy) return;
    const frame = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [state, busy]);
  const directories = useMemo(() => [...new Set([...(state?.available ?? []), ...selected])].sort(), [state?.available, selected]);
  const matches = useMemo(() => directories.filter((dir) => dir.toLowerCase().includes(query.toLowerCase())), [directories, query]);
  const editable = Boolean(state && (!state.enabled || state.cone));
  async function apply(disable: boolean) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const output = disable ? await tauri.repoDisableSparseCheckout(path) : await tauri.repoSetSparseCheckout(path, selected, sparseIndex);
      accept(await tauri.repoSparseCheckout(path));
      setMessage(output || (disable ? 'Sparse checkout disabled. All tracked files restored.' : 'Sparse directories updated.'));
    } catch (e) { setError(errMessage(e)); }
    finally {
      try {
        if (useRepo.getState().activePath === path) {
          useRepo.getState().markFilesTreeChanged(path, { kind: 'refresh' });
          await useRepo.getState().refreshLocalChanges();
        }
      } catch (e) { setError(errMessage(e)); }
      finally { setBusy(false); }
    }
  }
  return <Dialog title="Sparse checkout" icon="folder" className="clone-options-dialog" busy={busy} onClose={onClose} footer={<>
    <button className="btn" type="button" disabled={busy} onClick={onClose}>Close</button>
    {state?.enabled && <button className="btn" type="button" disabled={busy} onClick={() => void apply(true)}>Disable sparse checkout</button>}
    <button className="btn primary" type="button" disabled={busy || !editable} onClick={() => void apply(false)}>{busy ? 'Updating…' : state?.enabled ? 'Apply selection' : 'Enable sparse checkout'}</button>
  </>}>
    <div className="clone-body">
      {error && <p className="clone-error" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {!state ? <p>Reading tracked directories…</p> : <>
        <p>{state.enabled ? `Enabled · ${state.cone ? 'cone mode' : 'non-cone patterns'} · ${state.sparse_index ? 'sparse index' : 'full index'}` : 'Disabled — all tracked directories are included.'}</p>
        <p className="stash-blurb">Select whole directories to keep locally. Root files and files beside selected directories and their ancestors stay included. Excluded paths remain tracked in Git; they are absent locally and are not deletions.</p>
        {!editable ? <><p>These external non-cone patterns can be inspected or disabled. Disable them before choosing cone directories.</p><pre className="sparse-patterns">{state.patterns}</pre></> : <>
          <label className="clone-field"><span className="lbl">Find tracked directory</span>
            <input ref={search} className="clone-input" value={query} disabled={busy} onChange={(e) => setQuery(e.target.value)} placeholder="Filter directories…" />
          </label>
          <span className="lbl">Selection to apply</span>
          <div className="sparse-directory-list" role="group" aria-label="Selection to apply">
            {matches.slice(0, 100).map((dir) => {
              const inherited = selected.some((parent) => dir.startsWith(`${parent}/`));
              const partial = selected.some((child) => child.startsWith(`${dir}/`));
              return <label key={dir}><input type="checkbox" checked={selected.includes(dir)} disabled={busy} onChange={(e) => setSelected((old) => e.target.checked ? [...old, dir] : old.filter((item) => item !== dir))} />
                <span>{dir}</span><small>{selected.includes(dir) || inherited ? 'Included' : partial ? 'Partly included' : 'Excluded subtree'}</small>
              </label>;
            })}
            {!matches.length && <p>No matching directories.</p>}
          </div>
          {matches.length > 100 && <p className="stash-blurb">Showing 100 of {matches.length}. Narrow the filter to find another directory.</p>}
          <p className="stash-blurb">{selected.length} selected. An empty selection keeps root files only. This reduces populated files, not downloaded history.</p>
          <label><input type="checkbox" checked={sparseIndex} disabled={busy} onChange={(e) => setSparseIndex(e.target.checked)} /> Use sparse index</label>
          <p className="stash-blurb">A sparse index can speed up system Git in large repositories; older external tools may not support it. Strand reads it without changing its on-disk format.</p>
        </>}
        <p className="stash-blurb">Commit or stash edits and move untracked files before changing this checkout. Strand refuses a selection that could remove ignored files. Restoring files in a partial clone may require a network connection.</p>
      </>}
    </div>
  </Dialog>;
}
