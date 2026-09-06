import { useEffect, useState } from 'react';
import { errMessage, tauri } from '../../lib/tauri';
import type { RepositoryIdentity as Identity, ScopedValue } from '../../lib/types';

export function ConfigSource({ value }: { value: ScopedValue }) {
  return <span title={value.origin}>{value.scope} · {value.origin}</span>;
}

export function RepositoryIdentity({ path }: { path: string }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function display(value: Identity) {
    setIdentity(value);
    setName(value.local.name ?? '');
    setEmail(value.local.email ?? '');
  }
  useEffect(() => {
    let active = true;
    void tauri.repoIdentity(path).then((value) => { if (active) display(value); })
      .catch((e) => { if (active) setError(errMessage(e)); });
    return () => { active = false; };
  }, [path]);

  async function save(field: 'name' | 'email', value: string | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await tauri.repoSetIdentity(path, field, value);
      display(await tauri.repoIdentity(path));
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  return <div className="settings-field">
    <span className="settings-field-label">Repository identity</span>
    <p className="settings-hint">Choose the name and email used for new commits in this repository and its linked worktrees. Amending a commit keeps its original author.</p>
    {identity ? <>
      {(['author', 'committer'] as const).map((role) => <div className="settings-field" key={role}>
        <strong>{role === 'author' ? 'Author' : 'Committer'}: {identity[role].identity ?? 'Not configured'}</strong>
        <details className="settings-disclosure"><summary>Where this identity comes from</summary>
          <p className="settings-hint">Name: <ConfigSource value={identity[role].name_source} /><br />
            Email: <ConfigSource value={identity[role].email_source} /></p>
          <p className="settings-hint">Worktree settings, conditional Git settings or environment variables may take precedence over the values below.</p>
        </details>
        {identity[role].error && <p className="clone-error">{identity[role].error}</p>}
      </div>)}
      {(['name', 'email'] as const).map((field) => <div className="settings-row" key={field}>
        <label className="clone-field">
          <span className="lbl">Commit {field}</span>
          <input className="clone-input" aria-label={`Commit ${field}`} disabled={busy}
            value={field === 'name' ? name : email} placeholder="Use existing Git setting"
            onChange={(event) => (field === 'name' ? setName : setEmail)(event.target.value)} />
        </label>
        <button type="button" className="btn" disabled={busy || !(field === 'name' ? name : email).trim()}
          onClick={() => void save(field, (field === 'name' ? name : email).trim())}>Save {field}</button>
        <button type="button" className="btn" disabled={busy || identity.local[field] === null}
          onClick={() => void save(field, null)}>Remove {field} override</button>
      </div>)}
    </> : <p className="settings-hint">Loading repository identity…</p>}
    {error && <p className="clone-error" role="alert">{error}</p>}
  </div>;
}
