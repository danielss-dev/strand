import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Dialog } from '../components/Dialog';
import { Diff } from '../components/Diff';
import { errMessage, tauri } from '../lib/tauri';
import { remoteHost, type RemoteFileChunk, type RemoteHealth } from '../lib/remoteRepos';
import { useRemoteRepos } from '../stores/remoteRepos';
import '../styles/remoteRepos.css';

export function RemoteReposDialog({ onClose }: { onClose: () => void }) {
  const state = useRemoteRepos();
  const [address, setAddress] = useState(state.address || 'ssh://devbox/home/me/repo');
  const [since, setSince] = useState(state.since);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState('');
  const [chunk, setChunk] = useState<RemoteFileChunk | null>(null);
  const [fileBytes, setFileBytes] = useState<number[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const fileRequest = useRef<string | null>(null);
  const fileGeneration = useRef(0);
  const addressRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = requestAnimationFrame(() => addressRef.current?.focus());
    const health = listen<RemoteHealth>('ssh://health', (event) => useRemoteRepos.getState().healthEvent(event.payload));
    const changes = listen<{ host: string; repository: string }>('ssh://changed', (event) => {
      const current = useRemoteRepos.getState();
      if (event.payload.host === remoteHost(current.address)) void current.refresh();
    });
    return () => {
      cancelAnimationFrame(focus);
      void health.then((stop) => stop()); void changes.then((stop) => stop());
      ++fileGeneration.current;
      if (fileRequest.current) void tauri.remoteRepoCancel(fileRequest.current);
      void useRemoteRepos.getState().disconnect();
    };
  }, []);
  useEffect(() => {
    setSelected(''); setChunk(null); setFileBytes([]); setFileError(null); setFileBusy(false); ++fileGeneration.current;
  }, [state.address, state.mode, state.generation]);

  const diffs = state.result?.kind === 'diff' ? state.result.data : state.result?.kind === 'review' ? state.result.data.diffs : [];
  const paths = state.mode === 'files' ? state.snapshot?.work_tree.map((f) => f.path) ?? []
    : state.mode === 'status' ? [...new Set(state.snapshot?.status.map((f) => f.path) ?? [])] : diffs.map((f) => f.path);
  const matches = useMemo(() => paths.filter((path) => path.toLowerCase().includes(filter.toLowerCase())), [paths, filter]);
  const visible = matches.slice(0, 500);
  const diff = diffs.find((diff) => diff.path === selected);

  async function loadFile(path: string, append = false) {
    const token = ++fileGeneration.current;
    const id = crypto.randomUUID();
    fileRequest.current = id;
    setFileBusy(true); setFileError(null);
    try {
      const response = await tauri.remoteRepoRead(state.address, { kind: 'file_chunk', path, offset: append ? chunk?.next_offset ?? 0 : 0, length: 65536, version: append ? chunk?.version ?? null : null }, id);
      if (token !== fileGeneration.current) return;
      if (response.result.kind !== 'file_chunk') throw new Error('Invalid file response.');
      setChunk(response.result.data);
      const bytes = response.result.data.bytes;
      setFileBytes((old) => append ? [...old, ...bytes] : bytes);
    } catch (error) { if (token === fileGeneration.current) setFileError(errMessage(error)); }
    finally { if (fileRequest.current === id) fileRequest.current = null; if (token === fileGeneration.current) setFileBusy(false); }
  }
  function select(path: string) {
    setSelected(path); setChunk(null); setFileBytes([]); setFileError(null);
    if (state.mode === 'files') void loadFile(path);
  }
  const canRead = !!state.snapshot && !state.busy && state.health === 'connected';
  return <Dialog title="SSH repositories" icon="remote" size="wide" className="remote-repo-dialog" onClose={onClose} initialFocusRef={addressRef}>
    <div className="remote-repo-controls">
      <label className="settings-field">Repository on SSH host
        <input ref={addressRef} className="clone-input" list="ssh-recent-repositories" value={address} onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void state.connect(address); } }} />
        <datalist id="ssh-recent-repositories">{state.recents.map((address) => <option key={address} value={address} />)}</datalist>
      </label>
      <button className="btn primary" disabled={state.busy} onClick={() => void state.connect(address)}>Connect</button>
      <button className="btn" disabled={!state.address || state.busy} onClick={() => void state.connect(state.address)}>Reconnect now</button>
      <button className="btn" disabled={!state.address} onClick={() => void state.disconnect()}>{state.busy ? 'Cancel connection' : 'Disconnect'}</button>
    </div>
    <p className="settings-hint">System OpenSSH uses your host alias, known_hosts and SSH agent. Authenticate in a terminal first; install the compatible companion as ~/.strand/bin/strand on the host.</p>
    <div className="remote-repo-context" role="status">{state.address || 'No remote repository'} · <strong>{state.health}</strong> · Read only · Git and file reads execute on the SSH host</div>
    {state.error && <p className="remote-repo-error" role="alert">{state.error}</p>}
    <div className="remote-repo-controls">
      <label>View <select className="clone-input" value={state.mode} disabled={!canRead} onChange={(event) => void state.selectMode(event.target.value as typeof state.mode)}>
        <option value="status">Status</option><option value="diff">Changes since HEAD</option><option value="log">Recent history</option><option value="review">Review since…</option><option value="files">Files</option>
      </select></label>
      {state.mode === 'review' && <><input className="clone-input" aria-label="Review base revision" value={since} onChange={(event) => setSince(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void state.selectMode('review', since); } }} /><button className="btn" disabled={!canRead} onClick={() => void state.selectMode('review', since)}>Review</button></>}
      <button className="btn" disabled={!canRead} onClick={() => void state.refresh()}>Refresh</button>
      {state.snapshot && <span>{state.snapshot.meta.branch} · {state.snapshot.status.length} status entries</span>}
    </div>
    <div className="remote-repo-body" aria-busy={state.busy}>
      {state.mode === 'log' ? <div className="remote-repo-scroll">{state.result?.kind === 'log' && state.result.data.map((commit) => <p key={commit.hash}><code>{commit.short_hash}</code> {commit.subject} — {commit.author_name}</p>)}</div> :
        <PanelGroup direction="horizontal" autoSaveId="strand:ssh-inspector">
          <Panel defaultSize={30} minSize={20}>
            <div className="remote-repo-files">
              <input className="clone-input" aria-label="Filter remote files" placeholder="Filter files…" value={filter} onChange={(event) => setFilter(event.target.value)} />
              <select size={15} className="remote-repo-list" aria-label="Remote files" value={selected} onChange={(event) => select(event.target.value)} disabled={!canRead}>
                <option value="" disabled>Select a file</option>{visible.map((path) => <option key={path} value={path}>{path}</option>)}
              </select>
              <span className="settings-hint">{visible.length} of {matches.length} files{matches.length > 500 ? ' · narrow the filter' : ''}</span>
            </div>
          </Panel>
          <PanelResizeHandle className="rs-handle vert" />
          <Panel minSize={30}>
            <div className="remote-repo-scroll" tabIndex={0} aria-label="Remote inspection">
              {state.health !== 'connected' && state.snapshot && <p>Disconnected · displaying the last snapshot. Reconnect to refresh.</p>}
              {state.mode === 'status' && (selected ? state.snapshot?.status.filter((file) => file.path === selected).map((file) => <p key={`${file.path}:${file.staged}`}>{file.staged ? 'Index' : 'Working tree'} · {file.kind} · {file.path}</p>) : <p>Select a file to inspect its status.</p>)}
              {(state.mode === 'diff' || state.mode === 'review') && (diff ? diff.binary ? <p>Binary change: {diff.path}</p> : <Diff key={diff.path} patch={diff.patch} /> : <p>Select a changed file to inspect its diff.</p>)}
              {state.result?.kind === 'review' && <p className="settings-hint">Pinned base: {state.result.data.base}{state.result.data.head_before !== state.result.data.head_after ? ' · HEAD changed during the read; refresh before reviewing.' : ''}</p>}
              {state.mode === 'files' && <>
                {fileError && <p role="alert">{fileError}</p>}
                {chunk && <p>{fileBytes.length} / {chunk.total} bytes · read-only snapshot <button className="btn" disabled={fileBusy || !canRead} onClick={() => void loadFile(selected)}>Reload file</button></p>}
                {fileBytes.includes(0) ? <p>Binary file.</p> : <pre>{new TextDecoder().decode(new Uint8Array(fileBytes))}</pre>}
                {chunk && chunk.next_offset < chunk.total && fileBytes.length < 1_048_576 && <button className="btn" disabled={fileBusy || !canRead} onClick={() => void loadFile(selected, true)}>Read next 64 KiB</button>}
                {fileBytes.length >= 1_048_576 && chunk && chunk.next_offset < chunk.total && <p>Preview stopped at 1 MiB.</p>}
                {fileBusy && <p role="status">Reading file…</p>}
              </>}
            </div>
          </Panel>
        </PanelGroup>}
    </div>
  </Dialog>;
}
