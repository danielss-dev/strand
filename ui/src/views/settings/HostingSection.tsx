import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { pickPemCertificate } from '../../lib/dialog';
import { createAzdoServerProfile, resolveAzdoServerCollectionUrl } from '../../lib/azdoProfile';
import { errMessage, isTauri, tauri } from '../../lib/tauri';
import type {
  AzdoAuthMode,
  AzdoHelperStatus,
  AzdoServerProfile,
  HostingConnectionStatus,
  ProviderConnectionStatus,
} from '../../lib/types';
import { useRepo } from '../../stores/repo';

const emptyStatus: AzdoHelperStatus = {
  enabled: false,
  installed: false,
  version: null,
  protocol_version: null,
  profiles: [],
  authentication: [],
  error: null,
};

const unavailableConnection: ProviderConnectionStatus = {
  installed: false,
  connected: false,
  account: null,
  detail: 'Available in the Strand desktop app',
};

const emptyConnections: HostingConnectionStatus = {
  github: unavailableConnection,
  azure_dev_ops: unavailableConnection,
};

type ProviderKey = 'github' | 'azure' | 'server';

export function HostingSection() {
  const desktop = isTauri();
  const remotes = useRepo((state) => state.refs.remotes);
  const suggestedCollectionUrl = useMemo(
    () => resolveAzdoServerCollectionUrl('', remotes),
    [remotes],
  );
  const [status, setStatus] = useState(emptyStatus);
  const [connections, setConnections] = useState(emptyConnections);
  const [connectionsLoading, setConnectionsLoading] = useState(desktop);
  const [openProvider, setOpenProvider] = useState<ProviderKey | null>('server');
  const [editing, setEditing] = useState<AzdoServerProfile | null>(null);
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (desktop) void refresh();
    else setMessage('Hosting connection status is available in the Strand desktop app.');
  }, []);

  async function refresh() {
    setConnectionsLoading(true);
    const [helper, cloud] = await Promise.allSettled([
      tauri.azdoHelperStatus(),
      tauri.hostingConnectionStatus(),
    ]);
    if (helper.status === 'fulfilled') setStatus(helper.value);
    else setMessage(errMessage(helper.reason));
    if (cloud.status === 'fulfilled') setConnections(cloud.value);
    else setMessage(errMessage(cloud.reason));
    setConnectionsLoading(false);
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
    setInstalling(true);
    try {
      await perform(async () => {
        setStatus(await tauri.azdoHelperEnable());
        setMessage('Azure DevOps Server support is enabled.');
      });
    } finally {
      setInstalling(false);
    }
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

  function resolvedProfile(profile: AzdoServerProfile): AzdoServerProfile {
    const collectionUrl = resolveAzdoServerCollectionUrl(profile.collection_url, remotes);
    if (!collectionUrl) {
      throw new Error('Enter a collection URL because the active repository has no standard Azure DevOps Server remote.');
    }
    return {
      ...profile,
      name: profile.name.trim(),
      collection_url: collectionUrl,
      remote_prefixes: profile.remote_prefixes.map((value) => value.trim()).filter(Boolean),
    };
  }

  async function saveProfile() {
    if (!editing) return;
    await perform(async () => {
      const saved = await tauri.azdoProfileUpsert(resolvedProfile(editing));
      if (editing.auth_mode === 'pat' && pat) {
        await tauri.azdoProfileSetPat(saved.id, pat);
        setPat('');
      }
      setStatus(await tauri.azdoHelperStatus());
      setEditing(saved);
      setMessage(`Saved ${saved.name} using ${saved.collection_url}.`);
    });
  }

  async function importCa() {
    if (!editing) return;
    const path = await pickPemCertificate();
    if (!path) return;
    await perform(async () => {
      const profile = await tauri.azdoProfileUpsert(resolvedProfile(editing));
      const saved = await tauri.azdoProfileImportCa(profile.id, path);
      setEditing(saved);
      setStatus(await tauri.azdoHelperStatus());
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
      setStatus(await tauri.azdoHelperStatus());
      if (editing?.id === profile.id) setEditing(null);
      setMessage('Profile removed.');
    });
  }

  const authenticatedProfiles = status.authentication.filter((item) => item.configured).length;
  const serverReady = status.installed && authenticatedProfiles > 0;
  const helperLabel = installing
    ? 'Downloading and verifying strand-azdo…'
    : status.installed
      ? `Installed ${status.version ?? ''} · protocol ${status.protocol_version ?? 'unknown'}`
      : 'Not installed';
  const serverSummary = installing
    ? 'Installing and verifying strand-azdo…'
    : serverReady
      ? `${authenticatedProfiles} authenticated ${authenticatedProfiles === 1 ? 'profile' : 'profiles'} via strand-azdo`
      : status.installed
        ? 'Helper installed · add an authenticated profile'
        : 'Install strand-azdo to connect on-premises servers';

  return (
    <section className="settings-section hosting-settings" aria-label="Hosting">
      <div className="hosting-heading">
        <div>
          <span className="settings-section-label">Hosting connections</span>
          <p className="settings-hint">Strand uses each provider’s existing CLI authentication.</p>
        </div>
        <button type="button" className="icon-btn" aria-label="Refresh hosting connections" disabled={!desktop || connectionsLoading} onClick={() => void refresh()}>
          <Icon name="refresh" className={connectionsLoading ? 'spin' : ''} />
        </button>
      </div>

      <div className="hosting-providers">
        <ProviderAccordion
          id="github"
          name="GitHub"
          cli="gh"
          connected={connections.github.connected}
          loading={connectionsLoading}
          summary={connectionSummary(connections.github, 'gh', connectionsLoading)}
          open={openProvider === 'github'}
          onToggle={() => setOpenProvider(openProvider === 'github' ? null : 'github')}
        >
          <ConnectionDetails status={connections.github} cli="gh" loading={connectionsLoading} />
        </ProviderAccordion>

        <ProviderAccordion
          id="azure"
          name="Azure DevOps"
          cli="az"
          connected={connections.azure_dev_ops.connected}
          loading={connectionsLoading}
          summary={connectionSummary(connections.azure_dev_ops, 'az', connectionsLoading)}
          open={openProvider === 'azure'}
          onToggle={() => setOpenProvider(openProvider === 'azure' ? null : 'azure')}
        >
          <ConnectionDetails status={connections.azure_dev_ops} cli="az" loading={connectionsLoading} />
        </ProviderAccordion>

        <ProviderAccordion
          id="server"
          name="Azure DevOps Server"
          cli="strand-azdo"
          connected={serverReady}
          loading={installing}
          summary={serverSummary}
          open={openProvider === 'server'}
          onToggle={() => setOpenProvider(openProvider === 'server' ? null : 'server')}
        >
          <div className="hosting-provider-body">
            <div className="settings-rows">
              <div className="settings-frow">
                <div className="settings-frow-text">
                  <span className="settings-field-label">On-premises pull requests</span>
                  <span className="settings-frow-hint" role="status" aria-live="polite">{helperLabel}</span>
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
            {status.error && !installing && <p className="settings-hint">{status.error}</p>}
            <div className="settings-row">
              <button type="button" className="btn" disabled={busy || !desktop} onClick={() => void enable()}>
                {installing && <span className="spinner" aria-hidden="true" />}
                {installing ? 'Downloading helper…' : status.installed ? 'Retry installation' : 'Install helper'}
              </button>
              <button type="button" className="btn danger" disabled={busy || (!status.installed && status.profiles.length === 0)} onClick={() => void removeEverything()}>
                Remove helper and credentials
              </button>
            </div>
            {installing && <progress className="settings-progress" aria-label="Downloading strand-azdo helper" />}

            {status.installed && (
              <div className="settings-field hosting-server-profiles">
                <div className="settings-row settings-row-between">
                  <span className="settings-section-label">Server profiles</span>
                  <button type="button" className="btn" disabled={busy} onClick={() => { setPat(''); setEditing(createAzdoServerProfile()); }}>
                    Add profile
                  </button>
                </div>
                {status.profiles.length === 0 && <p className="settings-hint">Add a Server 2020+ profile. Strand can derive its collection URL from the active repository.</p>}
                <div className="azdo-profile-list" role="list">
                  {status.profiles.map((profile) => {
                    const authenticated = status.authentication.some((item) => item.profile_id === profile.id && item.configured);
                    return (
                      <div className="azdo-profile-row" role="listitem" key={profile.id}>
                        <span className={`hosting-profile-status${authenticated ? ' ready' : ''}`} aria-label={authenticated ? 'Authentication configured' : 'Authentication required'}>
                          <Icon name={authenticated ? 'check' : 'circle'} size={12} />
                        </span>
                        <button type="button" className="azdo-profile-main" onClick={() => { setPat(''); setEditing(profile); }}>
                          <strong>{profile.name}</strong>
                          <span>{profile.collection_url}</span>
                        </button>
                        <button type="button" className="btn" disabled={busy} onClick={() => void testProfile(profile)}>Test</button>
                        <button type="button" className="btn danger" disabled={busy} onClick={() => void removeProfile(profile)}>Remove</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {editing && (
              <ProfileEditor
                profile={editing}
                pat={pat}
                busy={busy}
                suggestedCollectionUrl={suggestedCollectionUrl}
                onProfile={setEditing}
                onPat={setPat}
                onSave={() => void saveProfile()}
                onImportCa={() => void importCa()}
                onClearPat={() => void perform(async () => {
                  await tauri.azdoProfileClearPat(editing.id);
                  setStatus(await tauri.azdoHelperStatus());
                  setPat('');
                  setMessage('Stored PAT cleared.');
                })}
                onCancel={() => { setEditing(null); setPat(''); }}
              />
            )}
          </div>
        </ProviderAccordion>
      </div>

      {message && <p className="settings-hint hosting-message" role="status">{message}</p>}
    </section>
  );
}

function ProviderAccordion({
  id,
  name,
  cli,
  connected,
  loading,
  summary,
  open,
  onToggle,
  children,
}: {
  id: ProviderKey;
  name: string;
  cli: string;
  connected: boolean;
  loading: boolean;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`hosting-provider${open ? ' open' : ''}`}>
      <button type="button" className="hosting-provider-summary" aria-expanded={open} aria-controls={`hosting-${id}-panel`} onClick={onToggle}>
        <span className={`hosting-provider-status${connected ? ' ready' : ''}${loading ? ' loading' : ''}`} aria-hidden="true">
          <Icon name={connected ? 'check' : loading ? 'refresh' : 'circle'} size={13} />
        </span>
        <span className="hosting-provider-copy">
          <strong>{name}</strong>
          <span>{summary}</span>
        </span>
        <code className="hosting-cli-badge">{cli}</code>
        <Icon className="hosting-provider-chevron" name="chev-right" size={13} />
      </button>
      {open && <div className="hosting-provider-panel" id={`hosting-${id}-panel`}>{children}</div>}
    </div>
  );
}

function ConnectionDetails({ status, cli, loading }: {
  status: ProviderConnectionStatus;
  cli: string;
  loading: boolean;
}) {
  return (
    <div className="hosting-provider-body hosting-cloud-details">
      <div className="hosting-detail-row">
        <span>CLI</span>
        <code>{cli}</code>
      </div>
      <div className="hosting-detail-row">
        <span>Account</span>
        <strong>{loading ? 'Checking…' : status.account ?? 'Not connected'}</strong>
      </div>
      <p className="settings-hint">
        {loading ? `Checking ${cli} authentication…` : status.detail}
      </p>
    </div>
  );
}

function connectionSummary(status: ProviderConnectionStatus, cli: string, loading: boolean): string {
  if (loading) return `Checking ${cli} authentication…`;
  if (status.connected && status.account) return `Connected as ${status.account} via ${cli}`;
  return status.detail;
}

function ProfileEditor({
  profile,
  pat,
  busy,
  suggestedCollectionUrl,
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
  suggestedCollectionUrl: string;
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
        <span>HTTPS collection URL <small>Optional</small></span>
        <input className="clone-input" placeholder={suggestedCollectionUrl || 'https://server/tfs/DefaultCollection'} value={profile.collection_url} onChange={(event) => set('collection_url', event.target.value)} />
      </label>
      <p className="settings-hint hosting-inference-hint">
        {suggestedCollectionUrl
          ? <>Leave blank to use <code>{suggestedCollectionUrl}</code> from the active repository.</>
          : 'Strand will use the active repository remote when it has a standard Azure DevOps Server URL.'}
      </p>
      <label>
        <span>Authentication</span>
        <Select
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
        </Select>
      </label>
      <label>
        <span>Additional server aliases <small>Optional · one per line</small></span>
        <textarea className="clone-input azdo-prefixes" value={prefixes} onChange={(event) => set('remote_prefixes', event.target.value.split('\n'))} />
      </label>
      <p className="settings-hint">HTTPS and SSH repositories under the collection URL are matched automatically. Add prefixes only when the same server is reached through another hostname or path.</p>
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
