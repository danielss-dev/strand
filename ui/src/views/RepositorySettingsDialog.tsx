import { useState } from 'react';
import { Dialog } from '../components/Dialog';
import { RepositoryIdentity } from './settings/RepositoryIdentity';
import { SigningSettings } from './settings/SigningSettings';

export function RepositorySettingsDialog({ path, initialSection = 'identity', onClose }: { path: string; initialSection?: 'identity' | 'signing'; onClose: () => void }) {
  const [section, setSection] = useState<'identity' | 'signing'>(initialSection);
  return <Dialog className="git-tool-dialog" title="Repository settings" icon="settings" size="lg" onClose={onClose}
    footer={<button className="btn primary" onClick={onClose}>Done</button>}>
    <div className="repository-settings-body">
      <p className="settings-hint settings-path">{path}</p>
      <div className="repository-settings-tabs" role="tablist" aria-label="Repository settings"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 'identity' : event.key === 'End' ? 'signing' : section === 'identity' ? 'signing' : 'identity';
          setSection(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`#repository-tab-${next}`)?.focus();
        }}>
        {(['identity', 'signing'] as const).map((id) => <button key={id} id={`repository-tab-${id}`} role="tab"
          aria-controls="repository-settings-panel" aria-selected={section === id} tabIndex={section === id ? 0 : -1}
          className={`btn${section === id ? ' primary' : ''}`} onClick={() => setSection(id)}>{id === 'identity' ? 'Identity' : 'Signing'}</button>)}
      </div>
      <div role="tabpanel" id="repository-settings-panel" aria-labelledby={`repository-tab-${section}`}>
        {section === 'identity' ? <RepositoryIdentity path={path} /> : <SigningSettings path={path} />}
      </div>
    </div>
  </Dialog>;
}
