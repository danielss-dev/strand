import { useEffect, useState } from 'react';
import { errMessage, tauri } from '../lib/tauri';
import type { SigningMode, SigningSettings } from '../lib/types';

export function SigningChoice({ path, kind, annotated = false, settingsLink = true, value, disabled, onChange }: {
  path: string; kind: 'commit' | 'tag'; annotated?: boolean; settingsLink?: boolean;
  value: SigningMode; disabled: boolean; onChange: (value: SigningMode) => void;
}) {
  const [settings, setSettings] = useState<SigningSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    const load = () => {
      const request = ++sequence;
      void tauri.repoSigningSettings(path).then((result) => {
        if (active && request === sequence) { setSettings(result); setError(null); }
      }).catch((e) => { if (active && request === sequence) setError(errMessage(e)); });
    };
    load();
    window.addEventListener('strand:git-config-changed', load);
    window.addEventListener('focus', load);
    return () => { active = false; window.removeEventListener('strand:git-config-changed', load); window.removeEventListener('focus', load); };
  }, [path]);
  const inherited = settings && (kind === 'commit' ? settings.commit_sign
    : settings.tag_sign || (annotated && settings.tag_force_annotated));
  return <div className="signing-choice">
    <label>Signature{' '}
      <select className="clone-input" aria-label={`${kind === 'commit' ? 'Commit' : 'Tag'} signing`}
        value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as SigningMode)}>
        <option value="inherit">Inherit Git config{settings ? ` (${inherited ? 'sign' : 'unsigned'})` : ''}</option>
        <option value="sign">Sign this {kind}</option>
        <option value="unsigned">Do not sign this {kind}</option>
      </select>
    </label>
    {settingsLink && <button type="button" className="h-link" disabled={disabled}
      onClick={() => window.dispatchEvent(new Event('strand:open-git-settings'))}>Signing settings…</button>}
    {error && <span className="clone-error" role="alert">{error}</span>}
  </div>;
}
