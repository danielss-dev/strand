import { Select } from '../../components/Select';
import { useEffect, useState } from 'react';
import { errMessage, tauri } from '../../lib/tauri';

export function RemoteProviderSettings() {
  return <details className="settings-disclosure">
    <summary>GitLab, Bitbucket and GitHub Enterprise setup</summary>
    <p className="settings-hint">Strand detects public hosts automatically. For a custom host, choose its provider in Edit remote → Advanced.</p>
    <p className="settings-hint">For GitLab, sign in from your terminal with <code>glab auth login --hostname HOST</code>.</p>
    <p className="settings-hint">For GitHub Enterprise, use <code>gh auth login --hostname HOST</code>.</p>
    <p className="settings-hint">For Bitbucket Cloud, save your Atlassian email and scoped API token for <code>api.bitbucket.org</code> in your Git credential helper.</p>
  </details>;
}

export function RemoteProviderSelect({ path, remote }: { path: string; remote: string }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [provider, setProvider] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void tauri.repoHostingProviders(path).then(rows => {
      if (active) { const value = rows.find(row => row.remote === remote)?.provider ?? ''; setSaved(value); setProvider(value); }
    }).catch(error => { if (active) setError(errMessage(error)); });
    return () => { active = false; };
  }, [path, remote]);
  return <div className="settings-field">
    <label className="clone-field"><span className="lbl">Hosting provider</span>
      <Select aria-label="Hosting provider" className="clone-input" disabled={busy || saved === null} value={provider} onChange={event => setProvider(event.target.value)}>
        <option value="">Detect automatically</option><option value="github">GitHub / Enterprise</option><option value="gitlab">GitLab</option>
      </Select>
    </label>
    <p className="settings-hint">Choose a provider only if Strand cannot recognize this host. Refresh Pull Requests after changing it.</p>
    <button type="button" className="btn" disabled={busy || saved === null || provider === saved} onClick={async () => {
      setBusy(true); setError('');
      try { await tauri.repoSetHostingProvider(path, remote, provider); setSaved(provider); }
      catch (error) { setError(errMessage(error)); }
      finally { setBusy(false); }
    }}>{busy ? 'Saving…' : 'Save provider'}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
