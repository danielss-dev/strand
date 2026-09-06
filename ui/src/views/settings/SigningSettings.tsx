import { Select } from '../../components/Select';
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

const optionLabel = (value: string) => ({ true: 'Enabled', false: 'Disabled', openpgp: 'OpenPGP', ssh: 'SSH', x509: 'X.509' }[value] ?? value);

function SettingRow({ field, current, effective, busy, save }: {
  field: typeof fields[number]; current?: ScopedValue; effective?: ScopedValue;
  busy: boolean; save: (key: string, value: string | null) => void;
}) {
  const [value, setValue] = useState(current?.value ?? '');
  useEffect(() => { setValue(current?.value ?? ''); }, [current?.value]);
  return <div className="settings-field">
    <label className="clone-field"><span className="lbl">{field.label}</span>
      {field.options ? <Select className="clone-input" aria-label={field.label} value={value}
        disabled={busy} onChange={(e) => setValue(e.target.value)}>
        <option value="">Use existing Git setting</option>
        {value && !field.options.includes(value) && <option value={value}>{value} (current)</option>}
        {field.options.map((option) => <option key={option} value={option}>{optionLabel(option)}</option>)}
      </Select> : <input className="clone-input" aria-label={field.label} value={value}
        placeholder="Inherited" disabled={busy} onChange={(e) => setValue(e.target.value)} />}
    </label>
    <details className="settings-disclosure"><summary>Current Git setting</summary>
      <p className="settings-hint">{optionLabel(effective?.value ?? (field.key === 'gpg.format' ? 'openpgp' : 'Git default'))}
        {effective && <> · <ConfigSource value={effective} /></>}</p>
    </details>
    <div className="settings-row">
      <button type="button" className="btn" disabled={busy || value === (current?.value ?? '')}
        aria-label={`Save ${field.label.toLowerCase()}`} onClick={() => save(field.key, value.trim() || null)}>Save</button>
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
    <p className="settings-hint">Choose when Git signs commits and tags. Removing an override restores your existing Git settings.</p>
    <label className="clone-field"><span className="lbl">Apply settings to</span>
      <Select className="clone-input" aria-label="Signing scope" value={scope} disabled={busy}
        onChange={(e) => setScope(e.target.value as SigningScope)}>
        <option value="local">Repository (shared by linked worktrees)</option>
        <option value="worktree" disabled={!settings?.worktree_enabled}>This worktree</option>
      </Select>
    </label>
    {settings && !settings.worktree_enabled && <p className="settings-hint">
      Separate worktree settings need to be enabled in Git first.</p>}
    {settings ? <>
      {fields.slice(0, 3).map((field) => <SettingRow key={`${scope}:${field.key}`} field={field}
        current={settings[scope][field.key]} effective={settings.effective[field.key]} busy={busy} save={(key, value) => void save(key, value)} />)}
      <details className="settings-disclosure"><summary>Signing key and verification</summary>
        <p className="settings-hint">Git uses your existing signing program and GPG or SSH agent. Strand stores key references, never private keys or passphrases.</p>
        {fields.slice(3).map((field) => <SettingRow key={`${scope}:${field.key}`} field={field}
          current={settings[scope][field.key]} effective={settings.effective[field.key]} busy={busy} save={(key, value) => void save(key, value)} />)}
      </details>
    </> : <p className="settings-hint">Loading signing settings…</p>}
    {error && <p className="clone-error" role="alert">{error}</p>}
  </div>;
}
