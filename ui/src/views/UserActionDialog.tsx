import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { Select } from '../components/Select';
import { errMessage, tauri } from '../lib/tauri';
import type { ActionOutcome, ActionPreview, ActionRequest, UserAction } from '../lib/userActions';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';
import { useWork } from '../stores/work';
import '../styles/user-actions.css';

function selectionStamp() {
  const state = useRepo.getState();
  return JSON.stringify([state.meta?.path, state.view, state.selectedCommit, state.selectedRef,
    state.selectedFile, state.meta && useWork.getState().repos[state.meta.path]?.activeTabId]);
}

export function UserActionDialog({ request, onClose, onManage }: {
  request: ActionRequest; onClose: () => void; onManage: () => void;
}) {
  const actions = useSettings((state) => state.userActions);
  const candidates = actions.filter((action) => action.scope === request.context.target.kind);
  const [id, setId] = useState(request.actionId ?? candidates[0]?.id ?? '');
  const action = candidates.find((candidate) => candidate.id === id);
  const [preview, setPreview] = useState<{ command: ActionPreview; action: UserAction } | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [running, setRunning] = useState(false);
  const operation = useRef<{ id: string; cancelled: boolean } | null>(null);
  const generation = useRef(0);
  const first = useRef<HTMLSelectElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const initialSelection = useRef(selectionStamp());

  function cancel() {
    const op = operation.current;
    if (op) { op.cancelled = true; void tauri.repoCancelOp(op.id).catch(() => {}); }
  }
  useEffect(() => {
    const frame = requestAnimationFrame(() => first.current?.focus());
    const changed = () => {
      if (selectionStamp() === initialSelection.current && useRepo.getState().tabs.some((tab) => tab.path === request.context.path)) return;
      generation.current += 1; setStale(true); setPreview(null); setBusy(false); cancel();
    };
    const offRepo = useRepo.subscribe(changed);
    const offWork = useWork.subscribe(changed);
    return () => { cancelAnimationFrame(frame); offRepo(); offWork(); generation.current += 1; cancel(); };
  }, []);

  async function resolve() {
    if (!action || busy || stale) return;
    const serial = ++generation.current;
    setBusy(true); setPreview(null); setOutcome(null); setError('');
    try {
      const command = await tauri.repoUserActionPreview(action, request.context);
      if (generation.current !== serial) return;
      setPreview({ command, action });
      requestAnimationFrame(() => runButton.current?.focus());
    } catch (error) { if (generation.current === serial) setError(errMessage(error)); }
    finally { if (generation.current === serial) setBusy(false); }
  }
  async function run() {
    if (!preview || operation.current || stale || JSON.stringify(preview.action) !== JSON.stringify(action)) return;
    if (selectionStamp() !== initialSelection.current) { setStale(true); setPreview(null); return; }
    const op = { id: `user-action-${crypto.randomUUID()}`, cancelled: false };
    operation.current = op;
    const serial = ++generation.current;
    setRunning(true); setError(''); setOutcome(null);
    requestAnimationFrame(() => cancelButton.current?.focus());
    try {
      const result = await tauri.repoUserActionRun(preview.action, request.context, preview.command, op.id, () => {
        if (op.cancelled) void tauri.repoCancelOp(op.id).catch(() => {});
      });
      if (generation.current === serial) setOutcome(result);
    } catch (error) { if (generation.current === serial) setError(errMessage(error)); }
    finally {
      if (operation.current === op) operation.current = null;
      setRunning(false); setPreview(null);
      requestAnimationFrame(() => first.current?.focus());
      // External actions can alter refs, files, or the index. Refresh only
      // this active repository; the watcher handles inactive open checkouts.
      if (useRepo.getState().meta?.path === request.context.path) {
        void useRepo.getState().refreshSnapshot().catch(() => {});
        void useRepo.getState().refreshRefs().catch(() => {});
        useRepo.getState().markFilesTreeChanged(request.context.path, { kind: 'refresh' });
      }
    }
  }
  const target = request.context.target;
  return (
    <Dialog className="git-tool-dialog" title="Run user action" icon="terminal" size="lg" initialFocusRef={first}
      onClose={onClose} blockEscapeWhileBusy={false}
      footer={<>
        <button className="btn" onClick={onManage} disabled={running}>Manage actions…</button>
        {running ? <button ref={cancelButton} className="btn danger" onClick={cancel}>Cancel action</button> : <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn" disabled={!action || busy || stale} onClick={() => void resolve()}>{busy ? 'Resolving…' : 'Preview command'}</button>
          <button ref={runButton} className="btn primary" disabled={!preview || stale || JSON.stringify(preview?.action) !== JSON.stringify(action)} onClick={() => void run()}>Run action</button>
        </>}
      </>}>
      <div className="clone-body user-action-body">
        <label>Action<Select className="settings-select" ref={first} value={id} disabled={running || busy} onChange={(event) => {
          generation.current += 1; setId(event.target.value); setPreview(null); setOutcome(null); setError('');
        }}>{candidates.length === 0 && <option value="">No actions for this context</option>}
          {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </Select></label>
        <dl><dt>Repository</dt><dd>{request.context.path}</dd><dt>Selected context</dt>
          <dd>{target.kind === 'repository' ? 'Repository root' : target.kind === 'file' ? target.file : `${target.reference} · ${target.oid}`}</dd></dl>
        <p className="settings-hint">Review this command before running it. Unsaved editor changes are not included. Closing this dialog stops the command, but does not undo changes it already made.</p>
        {stale && <p role="alert" className="form-error">Selection changed. Close this dialog and invoke the action again.</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
        {preview && <div className="user-action-preview">
          <dl><dt>Executable</dt><dd>{preview.command.executable}</dd><dt>Working directory</dt><dd>{preview.command.cwd}</dd></dl>
          <p>Arguments (each numbered row is one argument)</p>
          <ol start={0}>{preview.command.args.map((arg, index) => <li key={index}><code>{JSON.stringify(arg)}</code></li>)}</ol>
          {preview.command.args.length === 0 && <p>No arguments.</p>}
        </div>}
        {running && <p role="status">Running… Output appears when the command stops.</p>}
        {outcome && <section aria-label="Action result">
          <p role="status">{outcome.status} · exit {outcome.exit_code ?? '—'} · {outcome.duration_ms} ms{outcome.truncated ? ' · Output limit reached' : ''}</p>
          <h4>Standard output</h4><pre tabIndex={0}>{outcome.stdout || '(empty)'}</pre>
          <h4>Standard error</h4><pre tabIndex={0}>{outcome.stderr || '(empty)'}</pre>
        </section>}
        <p className="settings-hint">128 KiB retained per output stream. Excess output or a 10-minute timeout stops the process tree. Actions are personal settings; they are never loaded from repositories or remote plugins.</p>
      </div>
    </Dialog>
  );
}
