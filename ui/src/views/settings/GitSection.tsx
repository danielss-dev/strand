import { useEffect, useState } from 'react';

import { type AutoFetchIntervalMin } from '../../lib/autoFetch';
import { repoAutoFetch } from '../../lib/db';
import { pickDirectory } from '../../lib/dialog';
import { t } from '../../lib/i18n';
import { errMessage, isTauri, tauri } from '../../lib/tauri';
import { useRepo } from '../../stores/repo';
import { useSettings } from '../../stores/settings';
import { CheckRow, SegRow } from './shared';

const AUTO_FETCH_OPTIONS: { id: `${AutoFetchIntervalMin}`; label: string }[] = [
  { id: '0', label: t('git.autoFetch.off') },
  { id: '5', label: t('git.autoFetch.minutes', { count: 5 }) },
  { id: '10', label: t('git.autoFetch.minutes', { count: 10 }) },
  { id: '30', label: t('git.autoFetch.minutes', { count: 30 }) },
];

/**
 * Git — the global identity (`user.name` / `user.email`, written to
 * `~/.gitconfig`) and the default clone/open folder. Identity edits need an
 * explicit Save: unlike the appearance toggles this writes a file git itself
 * reads, so no half-typed names should land there live.
 */
export function GitSection() {
  const defaultCloneDir = useSettings((s) => s.defaultCloneDir);
  const autoFetchIntervalMin = useSettings((s) => s.autoFetchIntervalMin);
  const set = useSettings((s) => s.set);
  const tabs = useRepo((s) => s.tabs);
  const tabKey = tabs.map((tab) => tab.path).join('\n');
  const [autoFetchOff, setAutoFetchOff] = useState<Record<string, boolean>>({});

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const paths = tabKey ? tabKey.split('\n') : [];
    void Promise.all(paths.map(async (path) => [path, (await repoAutoFetch.get(path)) === false] as const))
      .then((rows) => {
        if (!cancelled) setAutoFetchOff(Object.fromEntries(rows));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tabKey]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void tauri
      .gitGlobalIdentity()
      .then((id) => {
        if (cancelled) return;
        setName(id.name ?? '');
        setEmail(id.email ?? '');
        setLoaded(true);
      })
      .catch((e) => {
        if (!cancelled) setStatus(errMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setStatus(null);
    try {
      await tauri.gitSetGlobalIdentity(name.trim(), email.trim());
      setDirty(false);
      setStatus('Saved to global git config.');
    } catch (e) {
      setStatus(errMessage(e));
    }
  }

  async function chooseDefaultDir() {
    const dir = await pickDirectory('Default clone & open folder', defaultCloneDir ?? undefined);
    if (dir) set('defaultCloneDir', dir);
  }

  return (
    <section className="settings-section" aria-label="Git">
      <div className="settings-field">
        <span className="settings-field-label">Global identity</span>
        <p className="settings-hint">
          Written to your global git config. Repositories can override these defaults.
        </p>
        <div className="settings-row">
          <input
            type="text"
            className="clone-input"
            aria-label="Name"
            placeholder="Name"
            value={name}
            disabled={!loaded}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />
          <input
            type="email"
            className="clone-input"
            aria-label="Email"
            placeholder="Email"
            value={email}
            disabled={!loaded}
            onChange={(e) => {
              setEmail(e.target.value);
              setDirty(true);
            }}
          />
        </div>
        <div className="settings-row">
          <button
            type="button"
            className="btn primary"
            disabled={!loaded || !dirty || !name.trim() || !email.trim()}
            onClick={() => void save()}
          >
            Save identity
          </button>
          {status && <span className="settings-hint">{status}</span>}
        </div>
      </div>

      <div className="settings-field">
        <span className="settings-field-label">{t('git.autoFetch')}</span>
        <p className="settings-hint">{t('git.autoFetchHint')}</p>
        <div className="settings-rows">
          <SegRow
            label={t('git.autoFetch')}
            options={AUTO_FETCH_OPTIONS}
            value={String(autoFetchIntervalMin) as `${AutoFetchIntervalMin}`}
            onChange={(id) => {
              const minutes = Number(id);
              if (minutes === 0 || minutes === 5 || minutes === 10 || minutes === 30) {
                set('autoFetchIntervalMin', minutes);
              }
            }}
          />
        </div>
        <p className="settings-hint">{t('git.autoFetchRepoHint')}</p>
        {tabs.length === 0 ? (
          <p className="settings-hint">{t('git.autoFetchNone')}</p>
        ) : (
          <div className="settings-rows">
            {tabs.map((tab) => (
              <CheckRow
                key={tab.path}
                label={tab.meta.name}
                checked={autoFetchOff[tab.path] !== true}
                onChange={(enabled) => {
                  setAutoFetchOff((current) => ({ ...current, [tab.path]: !enabled }));
                  void repoAutoFetch.set(tab.path, enabled);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="settings-field">
        <span className="settings-field-label">Default clone &amp; open folder</span>
        <p className="settings-hint">
          Where the clone dialog and the open-repository picker start.
        </p>
        <div className="settings-row">
          <span className="settings-path" title={defaultCloneDir ?? undefined}>
            {defaultCloneDir ?? 'No folder chosen'}
          </span>
          <button type="button" className="btn" onClick={() => void chooseDefaultDir()}>
            Choose…
          </button>
          {defaultCloneDir && (
            <button type="button" className="btn" onClick={() => set('defaultCloneDir', null)}>
              Clear
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
