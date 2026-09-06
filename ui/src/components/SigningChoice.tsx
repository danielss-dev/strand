import { Select } from './Select';
import { openRepositoryTool } from '../lib/repositoryTools';
import { useEffect, useState } from 'react';
import { errMessage, tauri } from '../lib/tauri';
import type { SigningMode, SigningSettings } from '../lib/types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon } from './Icon';

export function SigningChoice({ path, kind, annotated = false, settingsLink = true, compact = false, extraItems = [], value, disabled, onChange }: {
  path: string; kind: 'commit' | 'tag'; annotated?: boolean; settingsLink?: boolean;
  compact?: boolean; extraItems?: MenuItem[];
  value: SigningMode; disabled: boolean; onChange: (value: SigningMode) => void;
}) {
  const [settings, setSettings] = useState<SigningSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const loadSettings = !compact || menu !== null;
  useEffect(() => {
    if (!loadSettings) return;
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
  }, [path, loadSettings]);
  const inherited = settings && (kind === 'commit' ? settings.commit_sign
    : settings.tag_sign || (annotated && settings.tag_force_annotated));
  if (compact) return <>
    <button type="button" className="btn cb-options" disabled={disabled} aria-label="Commit options" title="Commit options"
      aria-haspopup="menu" aria-expanded={menu !== null} onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom + 4 });
      }}>
      {value !== 'inherit' && <span>{value === 'sign' ? 'Signed' : 'Unsigned'}</span>}
      <Icon name="chev-down" size={12} />
    </button>
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
      { label: `Use Git setting${settings ? ` (${inherited ? 'signed' : 'unsigned'})` : ''}`, icon: value === 'inherit' ? 'check' : undefined, onSelect: () => onChange('inherit') },
      { label: 'Sign this commit', icon: value === 'sign' ? 'check' : undefined, onSelect: () => onChange('sign') },
      { label: 'Do not sign this commit', icon: value === 'unsigned' ? 'check' : undefined, onSelect: () => onChange('unsigned') },
      { label: 'Repository signing settings…', onSelect: () => openRepositoryTool({ path, tool: 'signing' }) },
      ...extraItems,
      ...(error ? [{ label: error, disabled: true }] : []),
    ]} />}
  </>;
  return <div className="signing-choice">
    <label>Signature{' '}
      <Select className="clone-input" aria-label={`${kind === 'commit' ? 'Commit' : 'Tag'} signing`}
        value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as SigningMode)}>
        <option value="inherit">Use Git setting{settings ? ` (${inherited ? 'signed' : 'unsigned'})` : ''}</option>
        <option value="sign">Sign this {kind}</option>
        <option value="unsigned">Do not sign this {kind}</option>
      </Select>
    </label>
    {settingsLink && <button type="button" className="h-link" disabled={disabled}
      onClick={() => openRepositoryTool({ path, tool: 'signing' })}>Signing settings…</button>}
    {error && <span className="clone-error" role="alert">{error}</span>}
  </div>;
}
