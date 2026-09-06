import { useEffect, useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
import { errMessage, tauri } from '../lib/tauri';
import type { PublishAccount, PublishRequest, PublishState } from '../lib/types';
import { useRepo } from '../stores/repo';

const DEFAULT_HOST = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' };

export function PublishRepoDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const [provider, setProvider] = useState<PublishRequest['provider']>('github');
  const [host, setHost] = useState('github.com');
  const [account, setAccount] = useState<PublishAccount | null>(null);
  const [destination, setDestination] = useState('');
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [remote, setRemote] = useState('origin');
  const [state, setState] = useState<PublishState | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmPush, setConfirmPush] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const alive = useRef(true);
  const providerRef = useRef<HTMLSelectElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);

  useEffect(() => {
    if (!busy && !focused.current) {
      focused.current = true;
      (providerRef.current ?? closeRef.current)?.focus();
    }
  }, [busy]);

  useEffect(() => {
    alive.current = true;
    void tauri.hostedPublishState(path).then((value) => { if (alive.current) setState(value); })
      .catch((e) => { if (alive.current) setError(errMessage(e)); })
      .finally(() => { if (alive.current) setBusy(false); });
    return () => { alive.current = false; };
  }, [path]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); }
    catch (e) { if (alive.current) setError(errMessage(e)); }
    finally { if (alive.current) setBusy(false); }
  }

  async function loadAccount() {
    const next = await tauri.hostedPublishAccounts(path, provider, host.trim());
    if (alive.current) { setAccount(next); setDestination(next.destinations[0]?.id ?? ''); }
  }
  async function preview() {
    if (!account) return;
    const next = await tauri.hostedPublishPreview(path, { provider, host: host.trim(), account_id: account.account_id, destination, name: name.trim(), visibility, remote: remote.trim() });
    if (alive.current) setState(next);
  }
  async function advance(action: string) {
    if (!state) return;
    const next = await tauri.hostedPublishAdvance(path, state.id, action);
    if (alive.current) { setState(next); setError(next.error); setConfirmPush(false); }
    if ((action === 'attach' || action === 'push') && useRepo.getState().activePath === path) await useRepo.getState().refreshRefs();
  }
  async function forget() {
    await tauri.hostedPublishForget(path);
    if (alive.current) { setState(null); setConfirmForget(false); setAccount(null); setError(null); }
  }

  const nextAction = state?.stage === 'review' ? 'create' : state?.stage === 'uncertain' ? 'check' : state?.stage === 'created' ? 'attach' : state?.stage === 'remote_ready' ? 'push' : null;
  const nextLabel = { create: 'Create repository', check: 'Check destination', attach: 'Add remote', push: 'Push reviewed commit' };

  return <Dialog title="Publish repository" icon="remote" busy={busy} onClose={onClose} footer={<>
    <button ref={closeRef} type="button" className="btn" disabled={busy} onClick={onClose}>{state ? 'Close · resume later' : 'Cancel'}</button>
    {!state && <button type="button" className="btn primary" disabled={busy || !account || !destination || !name.trim()} onClick={() => void run(preview)}>Review destination</button>}
    {nextAction && <button type="button" className="btn primary" disabled={busy || (nextAction === 'push' && (!confirmPush || !state?.head))} onClick={() => void run(() => advance(nextAction))}>{busy ? 'Working…' : nextLabel[nextAction]}</button>}
  </>}>
    <div className="clone-body">
      <p className="stash-blurb">Create an empty hosted repository for <code>{path}</code>, add its remote, then choose whether to push.</p>
      {!state ? <>
        <label className="clone-field"><span className="lbl">Provider</span>
          <select ref={providerRef} className="clone-input" value={provider} disabled={busy} onChange={(e) => { const value = e.target.value as PublishRequest['provider']; setProvider(value); setHost(DEFAULT_HOST[value]); setAccount(null); }}>
            <option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="bitbucket">Bitbucket Cloud</option>
          </select>
        </label>
        <label className="clone-field"><span className="lbl">Host</span><input className="clone-input" value={host} disabled={busy || provider === 'bitbucket'} onChange={(e) => { setHost(e.target.value); setAccount(null); }} /></label>
        <p className="stash-blurb">{provider === 'github' ? 'Uses the active gh account for this host. Switch accounts with gh auth switch --hostname HOST. Enterprise API routing follows gh configuration.' : provider === 'gitlab' ? 'Uses glab authentication for this host. Sign in or switch the active account with glab.' : 'Uses the API credential for api.bitbucket.org in your Git credential helper: Atlassian email and a scoped API token.'}</p>
        <button type="button" className="btn" disabled={busy || !host.trim()} onClick={() => void run(loadAccount)}>Load account and destinations</button>
        {account && <>
          <label className="clone-field"><span className="lbl">Authenticated account</span><select className="clone-input" value={account.account_id} disabled><option value={account.account_id}>{account.account}</option></select></label>
          <label className="clone-field"><span className="lbl">Account / organization / namespace</span><select className="clone-input" value={destination} disabled={busy} onChange={(e) => setDestination(e.target.value)}>{account.destinations.map((d) => <option key={d.id} value={d.id}>{d.label} · {d.kind}</option>)}</select></label>
          {account.destinations.length === 0 && <p role="status">No destinations are available to this account.</p>}
        </>}
        <label className="clone-field"><span className="lbl">Repository name</span><input className="clone-input" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></label>
        <label className="clone-field"><span className="lbl">Visibility</span><select className="clone-input" value={visibility} disabled={busy} onChange={(e) => setVisibility(e.target.value as 'private' | 'public')}><option value="private">Private</option><option value="public">Public · visible to everyone</option></select></label>
        <label className="clone-field"><span className="lbl">New remote name</span><input className="clone-input" value={remote} disabled={busy} onChange={(e) => setRemote(e.target.value)} /></label>
      </> : <>
        <dl className="publish-review">
          <dt>Destination</dt><dd><a href={state.url} target="_blank" rel="noreferrer">{state.url}</a></dd>
          <dt>Account</dt><dd>{state.account}</dd><dt>Visibility</dt><dd>{state.request.visibility}</dd>
          <dt>Remote</dt><dd><code>{state.request.remote} → {state.clone_url}</code></dd>
          <dt>Initial push</dt><dd><code>{state.head || 'No commit'} → refs/heads/{state.branch}</code></dd>
        </dl>
        <p role="status">{state.stage === 'review' ? 'Review this destination before creating the empty repository. Creation does not push any files.' : state.stage === 'uncertain' ? 'Creation was attempted. Check the destination before deciding whether to attach it; it may already exist. No remote or push has been performed by this flow.' : state.stage === 'created' ? 'The destination exists. Add its remote to continue, or close and resume later.' : state.stage === 'remote_ready' ? 'Remote configured. Initial push is optional and sends only the reviewed commit and its history.' : 'The reviewed commit was pushed successfully.'}</p>
        {state.stage === 'remote_ready' && <label className="stash-check"><input type="checkbox" checked={confirmPush} disabled={busy || !state.head} onChange={(e) => setConfirmPush(e.target.checked)} /><span>Push the reviewed commit and its history to this destination</span></label>}
        {state.stage === 'remote_ready' && !state.head && <p>Create your first commit, then use Strand’s ordinary Push action.</p>}
        {state.stage === 'review' ? <button type="button" className="btn" disabled={busy} onClick={() => void run(forget)}>Edit destination</button> : <>
          <label className="stash-check"><input type="checkbox" checked={confirmForget} disabled={busy} onChange={(e) => setConfirmForget(e.target.checked)} /><span>Dismiss this recovery record; keep the hosted repository and remote</span></label>
          {confirmForget && <button type="button" className="btn" disabled={busy} onClick={() => void run(forget)}>Dismiss recovery record</button>}
        </>}
      </>}
      {(error || state?.error) && <div className="clone-error" role="alert">{error || state?.error}</div>}
    </div>
  </Dialog>;
}
