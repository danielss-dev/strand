import { useEffect, useMemo, useState } from 'react';

import { pickPemCertificate } from '../../lib/dialog';
import { errMessage, isTauri, tauri } from '../../lib/tauri';
import type { AzdoAuthMode, AzdoHelperStatus, AzdoServerProfile } from '../../lib/types';
import { useRepo } from '../../stores/repo';

const emptyStatus: AzdoHelperStatus = {
  enabled: false,
  installed: false,
  version: null,
  protocol_version: null,
  profiles: [],
  error: null,
};

function newProfile(remote: string | null): AzdoServerProfile {
  return {
    id: crypto.randomUUID(),
    name: '',
    collection_url: '',
    auth_mode: 'pat',
    remote_prefixes: remote ? [remote] : [''],
    ca_certificate: null,
  };
}

export function HostingSection() {
  const desktop = isTauri();
  const remotes = useRepo((state) => state.refs.remotes);
  const preferredRemote = useMemo(
    () => remotes.find((remote) => remote.name === 'origin')?.url ?? remotes[0]?.url ?? null,
    [remotes],
  );
  const [status, setStatus] = useState(emptyStatus);
  const [editing, setEditing] = useState<AzdoServerProfile | null>(null);
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (desktop) void refresh();
    else setMessage('Azure DevOps Server setup is available in the Strand desktop app.');
  }, []);

  async function refresh() {
    try {
      setStatus(await tauri.azdoHelperStatus());
    } catch (error) {
      setMessage(errMessage(error));
    }
  }

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(errMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function enable() {
    await perform(async () => {
      setStatus(await tauri.azdoHelperEnable());
      setMessage('Azure DevOps Server support is enabled.');
    });
  }

  async function disable() {
    await perform(async () => {
      setStatus(await tauri.azdoHelperDisable());
      setMessage('Disabled. Profiles and credentials were retained.');
    });
  }

  async function removeEverything() {
    if (!window.confirm('Remove the helper, all Azure DevOps Server profiles, imported certificates, and stored PATs?')) return;
    await perform(async () => {
      await tauri.azdoHelperRemove();
      setStatus(emptyStatus);
      setEditing(null);
      setPat('');
      setMessage('Helper, profiles, certificates, and credentials were removed.');
    });
  }

  async function saveProfile() {
    if (!editing) return;
    await perform(async () => {
      let saved = await tauri.azdoProfileUpsert({
        ...editing,
        name: editing.name.trim(),
        collection_url: editing.collection_url.trim(),
        remote_prefixes: editing.remote_prefixes.map((value) => value.trim()).filter(Boolean),
      });
      if (editing.auth_mode === 'pat' && pat) {
        await tauri.azdoProfileSetPat(saved.id, pat);
        setPat('');
      }
      setStatus((current) => ({
        ...current,
        profiles: [...current.profiles.filter((profile) => profile.id !== saved.id), saved],
      }));
      setEditing(saved);
      setMessage('Profile saved.');
    });
  }

  async function importCa() {
    if (!editing) return;
    const path = await pickPemCertificate();
    if (!path) return;
    await perform(async () => {
      const profile = await tauri.azdoProfileUpsert({
        ...editing,
        name: editing.name.trim(),
        collection_url: editing.collection_url.trim(),
        remote_prefixes: editing.remote_prefixes.map((value) => value.trim()).filter(Boolean),
      });
      const saved = await tauri.azdoProfileImportCa(profile.id, path);
      setEditing(saved);
      setStatus((current) => ({
        ...current,
        profiles: [...current.profiles.filter((profile) => profile.id !== saved.id), saved],
      }));
      setMessage('CA certificate copied into Strand configuration.');
    });
  }

  async function testProfile(profile: AzdoServerProfile) {
    await perform(async () => {
      await tauri.azdoProfileTest(profile.id);
      setMessage(`Connected to ${profile.name}.`);
    });
  }

  async function removeProfile(profile: AzdoServerProfile) {
    if (!window.confirm(`Remove the “${profile.name}” profile and its stored credential?`)) return;
    await perform(async () => {
      await tauri.azdoProfileRemove(profile.id);
      setStatus((current) => ({
        ...current,
        profiles: current.profiles.filter((item) => item.id !== profile.id),
      }));
      if (editing?.id === profile.id) setEditing(null);
      setMessage('Profile removed.');
    });
  }

  const helperLabel = status.installed
    ? `Installed ${status.version ?? ''} · protocol ${status.protocol_version ?? 'unknown'}`
    : 'Not installed';

  return (
    <section className="settings-section" aria-label="Hosting">
      <div className="settings-field">
        <span className="settings-section-label">Azure DevOps Server</span>
        <div className="settings-rows">
          <div className="settings-frow">
            <div className="settings-frow-text">
              <span className="settings-field-label">On-premises pull requests</span>
              <span className="settings-frow-hint">{helperLabel}</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="Enable Azure DevOps Server"
              aria-checked={status.enabled}
              className={`settings-switch${status.enabled ? ' on' : ''}`}
              disabled={busy || !desktop}
              onClick={() => void (status.enabled ? disable() : enable())}
            >
              <span />
            </button>
          </div>
        </div>
        {status.error && <p className="settings-hint">{status.error}</p>}
        <div className="settings-row">
          <button type="button" className="btn" disabled={busy || !desktop} onClick={() => void enable()}>
            {status.installed ? 'Retry installation' : 'Install helper'}
          </button>
          <button type="button" className="btn danger" disabled={busy || (!status.installed && status.profiles.length === 0)} onClick={() => void removeEverything()}>
            Remove helper and credentials
          </button>
        </div>
      </div>

      {status.installed && (
        <div className="settings-field">
          <div className="settings-row settings-row-between">
            <span className="settings-section-label">Server profiles</span>
            <button type="button" className="btn" disabled={busy} onClick={() => { setPat(''); setEditing(newProfile(preferredRemote)); }}>
              Add profile
            </button>
          </div>
          {status.profiles.length === 0 && <p className="settings-hint">Add a Server 2020+ collection profile to match repository remotes.</p>}
          <div className="azdo-profile-list" role="list">
            {status.profiles.map((profile) => (
              <div className="azdo-profile-row" role="listitem" key={profile.id}>
                <button type="button" className="azdo-profile-main" onClick={() => { setPat(''); setEditing(profile); }}>
                  <strong>{profile.name}</strong>
                  <span>{profile.collection_url}</span>
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void testProfile(profile)}>Test</button>
                <button type="button" className="btn danger" disabled={busy} onClick={() => void removeProfile(profile)}>Remove</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <ProfileEditor
          profile={editing}
          pat={pat}
          busy={busy}
          onProfile={setEditing}
          onPat={setPat}
          onSave={() => void saveProfile()}
          onImportCa={() => void importCa()}
          onClearPat={() => void perform(async () => {
            await tauri.azdoProfileClearPat(editing.id);
            setPat('');
            setMessage('Stored PAT cleared.');
          })}
          onCancel={() => { setEditing(null); setPat(''); }}
        />
      )}

      {message && <p className="settings-hint" role="status">{message}</p>}
    </section>
  );
}

function ProfileEditor({
  profile,
  pat,
  busy,
  onProfile,
  onPat,
  onSave,
  onImportCa,
  onClearPat,
  onCancel,
}: {
  profile: AzdoServerProfile;
  pat: string;
  busy: boolean;
  onProfile: (profile: AzdoServerProfile) => void;
  onPat: (pat: string) => void;
  onSave: () => void;
  onImportCa: () => void;
  onClearPat: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof AzdoServerProfile>(key: K, value: AzdoServerProfile[K]) =>
    onProfile({ ...profile, [key]: value });
  const prefixes = profile.remote_prefixes.join('\n');
  const windowsAvailable = navigator.userAgent.includes('Windows');

  return (
    <fieldset className="azdo-profile-editor" disabled={busy}>
      <legend>{profile.name || 'New server profile'}</legend>
      <label>
        <span>Name</span>
        <input className="clone-input" value={profile.name} onChange={(event) => set('name', event.target.value)} />
      </label>
      <label>
        <span>HTTPS collection URL</span>
        <input className="clone-input" placeholder="https://server/tfs/DefaultCollection" value={profile.collection_url} onChange={(event) => set('collection_url', event.target.value)} />
      </label>
      <label>
        <span>Authentication</span>
        <select
          className="settings-select"
          value={profile.auth_mode}
          onChange={(event) => {
            const authMode = event.target.value as AzdoAuthMode;
            onProfile({
              ...profile,
              auth_mode: authMode,
              ca_certificate: authMode === 'windows' ? null : profile.ca_certificate,
            });
          }}
        >
          <option value="pat">Personal access token</option>
          <option value="windows" disabled={!windowsAvailable}>Windows identity (Negotiate / NTLM)</option>
        </select>
      </label>
      <label>
        <span>Remote prefixes (one per line)</span>
        <textarea className="clone-input azdo-prefixes" value={prefixes} onChange={(event) => set('remote_prefixes', event.target.value.split('\n'))} />
      </label>
      {profile.auth_mode === 'pat' && (
        <>
          <label>
            <span>Personal access token</span>
            <input type="password" autoComplete="off" className="clone-input" placeholder="Stored in the system credential vault" value={pat} onChange={(event) => onPat(event.target.value)} />
          </label>
          <p className="settings-hint">Requires Azure DevOps “Code: Read &amp; write”. The token is never stored in Strand configuration.</p>
          <div className="settings-row">
            <button type="button" className="btn" onClick={onImportCa}>Import CA…</button>
            <button type="button" className="btn" onClick={onClearPat}>Clear stored PAT</button>
          </div>
          {profile.ca_certificate && <p className="settings-hint">Custom CA: {profile.ca_certificate}</p>}
        </>
      )}
      <div className="settings-row">
        <button type="button" className="btn primary" onClick={onSave}>Save profile</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </fieldset>
  );
}
