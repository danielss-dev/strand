import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { Select } from '../components/Select';
import { LFS_ACTIONS } from '../lib/lfs';
import { errMessage, isCancelled, tauri } from '../lib/tauri';
import type { LfsAction } from '../lib/types';
import { useRepo } from '../stores/repo';

export function LfsDialog({ path, initialAction = 'environment', onClose }: {
  path: string; initialAction?: LfsAction['action']; onClose: () => void;
}) {
  const [action, setAction] = useState<LfsAction['action']>(initialAction);
  const [value, setValue] = useState('');
  const [remote, setRemote] = useState('origin');
  const [running, setRunning] = useState<string | null>(null);
  const busy = useRef(false);
  const [output, setOutput] = useState('Choose an action and run it to inspect or manage Git LFS.');
  const [error, setError] = useState(false);
  const [progress, setProgress] = useState('');
  const focus = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => focus.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const transfer = action === 'fetch' || action === 'pull' || action === 'push';
  const parameter = action === 'track' || action === 'untrack' ? 'Pattern' : action === 'lock' ? 'Repository-relative file path' : action === 'unlock' ? 'Lock ID' : action === 'locks' ? 'Filter by exact path (optional)' : null;

  async function run() {
    if (busy.current) return;
    busy.current = true;
    const opId = crypto.randomUUID();
    setRunning(opId); setError(false); setProgress('Starting…');
    const request: LfsAction = action === 'track' || action === 'untrack' ? { action, pattern: value }
      : action === 'fetch' || action === 'pull' || action === 'push' ? { action, remote }
      : action === 'lock' ? { action, path: value }
      : action === 'unlock' ? { action, id: value }
      : action === 'locks' ? { action, path: value } : { action };
    try {
      const result = await tauri.repoLfsAction(path, request, opId, (p) => setProgress(p.raw));
      setOutput(result.output || 'Completed. Git LFS produced no output.');
    } catch (e) {
      setError(true);
      setOutput(isCancelled(e) ? 'Cancelled. Completed objects are retained. Inspect status, then retry when ready.' : errMessage(e));
    } finally {
      setRunning(null); busy.current = false; setProgress('');
      if (['install', 'track', 'untrack', 'pull', 'lock', 'unlock'].includes(action) && useRepo.getState().activePath === path) {
        await useRepo.getState().refreshLocalChanges().catch((e) => { setError(true); setOutput(`Refresh failed: ${errMessage(e)}`); });
      }
    }
  }

  return <Dialog title="Git LFS" icon="sync" className="maintenance-dialog" busy={!!running} initialFocusRef={focus} onClose={onClose}
    footer={<>{running ? <button className="btn danger" onClick={() => void tauri.repoCancelOp(running).catch((e) => setOutput(errMessage(e)))}>Cancel operation</button>
      : <><button className="btn" onClick={onClose}>Close</button><button className="btn primary" onClick={() => void run()} disabled={!!parameter && action !== 'locks' && !value.trim() || transfer && !remote.trim()}>Run action</button></>}</>}>
    <div className="clone-body maintenance-body">
      <p className="stash-blurb">Setup configures this repository and installs its pre-push hook. Tracking edits .gitattributes; review and stage it with the files you want to track. Existing history is never converted.</p>
      <label className="clone-field"><span className="lbl">Action</span><Select className="clone-input" ref={focus} value={action} disabled={!!running} onChange={(e) => { setAction(e.target.value as LfsAction['action']); setValue(''); }}>{LFS_ACTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select></label>
      {parameter && <label className="clone-field"><span className="lbl">{parameter}</span><input className="clone-input" value={value} disabled={!!running} onChange={(e) => setValue(e.target.value)} placeholder={action === 'track' ? '*.psd' : ''} /></label>}
      {transfer && <label className="clone-field"><span className="lbl">Remote</span><input className="clone-input" value={remote} disabled={!!running} onChange={(e) => setRemote(e.target.value)} /></label>}
      {action === 'locks' && <p className="stash-blurb">Shows at most 100 locks. Narrow by exact file path for larger repositories. Locking requires support from the remote server.</p>}
      {action === 'objects' && <p className="stash-blurb">An asterisk marks full content in the working tree; a dash marks a pointer. Large listings show a bounded tail.</p>}
      <div role="status" aria-live="polite">{progress}</div>
      <div className={`maintenance-entry${error ? ' failed' : ''}`}><pre tabIndex={0} aria-label="Git LFS result">{output}</pre></div>
    </div>
  </Dialog>;
}
