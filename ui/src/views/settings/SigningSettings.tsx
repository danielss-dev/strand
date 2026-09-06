import { useEffect, useState } from 'react';
import { errMessage, tauri } from '../../lib/tauri';
import type { ScopedValue, SigningScope, SigningSettings as Settings } from '../../lib/types';
import { ConfigSource } from './RepositoryIdentity';

const fields = [
  { key: 'commit.gpgsign', label: 'Sign commits by default', options: ['true', 'false'] },
  { key: 'tag.gpgsign', label: 'Sign tags by default', options: ['true', 'false'] },
  { key: 'tag.forcesignannotated', label: 'Sign annotated tags', options: ['true', 'false'] },
  { key: 'gpg.format', label: 'Signing format', options: ['openpgp', 'ssh', 'x509'] },
  { key: 'user.signingkey', label: 'Signing key ID or path' },
  { key: 'gpg.ssh.allowedsignersfile', label: 'SSH allowed signers file' },
];

function SettingRow({ field, current, effective, busy, save }: {
  field: typeof fields[number]; current?: ScopedValue; effective?: ScopedValue;
  busy: boolean; save: (key: string, value: string | null) => void;
}) {
  const [value, setValue] = useState(current?.value ?? '');
  useEffect(() => { setValue(current?.value ?? ''); }, [current?.value]);
  return <div className="settings-field">
    <label className="clone-field"><span className="lbl">{field.label}</span>
      {field.options ? <select className="clone-input" aria-label={field.label} value={value}
        disabled={busy} onChange={(e) => setValue(e.target.value)}>
        <option value="">Inherit</option>
        {value && !field.options.includes(value) && <option value={value}>{value} (current)</option>}
        {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select> : <input className="clone-input" aria-label={field.label} value={value}
        placeholder="Inherited" disabled={busy} onChange={(e) => setValue(e.target.value)} />}
    </label>
    <p className="settings-hint">Effective: {effective?.value ?? (field.key === 'gpg.format' ? 'openpgp' : 'Git default')}
      {effective && <> · <ConfigSource value={effective} /></>}</p>
    <div className="settings-row">
      <button type="button" className="btn" disabled={busy || value === (current?.value ?? '')}
        onClick={() => save(field.key, value.trim() || null)}>Save {field.label.toLowerCase()}</button>
      <button type="button" className="btn" disabled={busy || !current}
        onClick={() => save(field.key, null)}>Remove override</button>
    </div>
  </div>;
}

export function SigningSettings({ path }: { path: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [scope, setScope] = useState<SigningScope>('local');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void tauri.repoSigningSettings(path).then((result) => { if (active) setSettings(result); })
      .catch((e) => { if (active) setError(errMessage(e)); });
    return () => { active = false; };
  }, [path]);
  async function save(key: string, value: string | null) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await tauri.repoSetSigningConfig(path, scope, key, value);
      setSettings(await tauri.repoSigningSettings(path));
      window.dispatchEvent(new Event('strand:git-config-changed'));
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }
  return <div className="settings-field">
    <span className="settings-field-label">Repository signing</span>
    <p className="settings-hint">Git uses your existing GPG/SSH agents and configured signing program.
      Strand stores key references, never private keys or passphrases. SSH verification
      uses Git’s allowed signers file. Removing an override restores inherited config.</p>
    <label className="clone-field"><span className="lbl">Write scope</span>
      <select className="clone-input" aria-label="Signing scope" value={scope} disabled={busy}
        onChange={(e) => setScope(e.target.value as SigningScope)}>
        <option value="local">Repository (shared by linked worktrees)</option>
        <option value="worktree" disabled={!settings?.worktree_enabled}>This worktree</option>
      </select>
    </label>
    {settings && !settings.worktree_enabled && <p className="settings-hint">
      Worktree scope is available when Git’s extensions.worktreeConfig is enabled.</p>}
    {settings ? fields.map((field) => <SettingRow key={`${scope}:${field.key}`} field={field}
      current={settings[scope][field.key]} effective={settings.effective[field.key]} busy={busy}
      save={(key, value) => void save(key, value)} />) : <p className="settings-hint">Loading signing settings…</p>}
    {error && <p className="clone-error" role="alert">{error}</p>}
  </div>;
}
