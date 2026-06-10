import { getVersion } from '@tauri-apps/api/app';
import { useEffect, useState } from 'react';

import { isTauri } from '../../lib/tauri';
import { useSettings } from '../../stores/settings';
import { useUpdates } from '../../stores/updates';
import { CheckRow } from './shared';

/** Updates — current version, manual check / download / restart, and the
 * auto-check / auto-install preferences (read by App's launch effect). */
export function UpdatesSection() {
  const autoCheck = useSettings((s) => s.updateAutoCheck);
  const autoInstall = useSettings((s) => s.updateAutoInstall);
  const set = useSettings((s) => s.set);

  const status = useUpdates((s) => s.status);
  const version = useUpdates((s) => s.version);
  const notes = useUpdates((s) => s.notes);
  const error = useUpdates((s) => s.error);
  const received = useUpdates((s) => s.received);
  const total = useUpdates((s) => s.total);
  const checkNow = useUpdates((s) => s.check);
  const downloadAndInstall = useUpdates((s) => s.downloadAndInstall);
  const restart = useUpdates((s) => s.restart);

  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (isTauri()) void getVersion().then(setCurrent).catch(() => {});
  }, []);

  const inTauri = isTauri();
  const statusLine =
    status === 'checking' ? 'Checking…'
    : status === 'upToDate' ? 'You’re on the latest version.'
    : status === 'available' ? `Version ${version} is available.`
    : status === 'downloading'
      ? `Downloading… ${total ? `${Math.round((received / total) * 100)}%` : `${Math.round(received / 1024 / 1024)} MB`}`
    : status === 'ready' ? 'Update installed — restart to finish.'
    : status === 'error' ? `Couldn’t reach the update server${error ? ` (${error})` : ''}.`
    : null;

  return (
    <section className="settings-section" aria-label="Updates">
      <div className="settings-field">
        <span className="settings-field-label">Version</span>
        <div className="settings-row">
          <span className="settings-path">
            {inTauri ? `Strand ${current ?? '…'}` : 'Strand (browser preview)'}
          </span>
          {status === 'available' ? (
            <button type="button" className="btn primary" onClick={() => void downloadAndInstall()}>
              Download &amp; install
            </button>
          ) : status === 'ready' ? (
            <button type="button" className="btn primary" onClick={() => void restart()}>
              Restart now
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={!inTauri || status === 'checking' || status === 'downloading'}
              onClick={() => void checkNow()}
            >
              Check for updates
            </button>
          )}
        </div>
        {status === 'downloading' && (
          <progress
            className="settings-progress"
            value={total ? received : undefined}
            max={total ?? undefined}
            aria-label="Download progress"
          />
        )}
        {statusLine && (
          <p className="settings-hint" role="status">
            {statusLine}
          </p>
        )}
        {status === 'available' && notes && <p className="settings-hint">{notes}</p>}
      </div>

      <div className="settings-field">
        <span className="settings-field-label">Automatic updates</span>
        <div className="settings-rows">
          <CheckRow
            label="Check for updates on launch"
            checked={autoCheck}
            onChange={(v) => set('updateAutoCheck', v)}
          />
          <CheckRow
            label="Download and install automatically"
            hint="Updates apply on the next restart; Strand never restarts itself."
            checked={autoInstall}
            onChange={(v) => set('updateAutoInstall', v)}
          />
        </div>
      </div>
    </section>
  );
}
