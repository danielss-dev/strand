import { getVersion } from '@tauri-apps/api/app';
import { useEffect, useState } from 'react';

import { UPDATES_MANAGED_BY_STORE } from '../../lib/distribution';
import { isTauri } from '../../lib/tauri';
import { formatNumber, formatPercent, t } from '../../lib/i18n';
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
  const openMicrosoftStore = useUpdates((s) => s.openMicrosoftStore);
  const restart = useUpdates((s) => s.restart);

  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (isTauri()) void getVersion().then(setCurrent).catch(() => {});
  }, []);

  const inTauri = isTauri();
  if (UPDATES_MANAGED_BY_STORE) {
    const storeStatusLine =
      status === 'checking' ? t('updates.checking')
      : status === 'upToDate' ? t('updates.storeCurrent')
      : status === 'available' ? t('updates.storeAvailable')
      : status === 'error'
        ? error ? t('updates.storeErrorReason', { reason: error }) : t('updates.storeError')
      : null;

    return (
      <section className="settings-section" aria-label={t('updates.section')}>
        <div className="settings-field">
          <span className="settings-field-label">{t('updates.version')}</span>
          <div className="settings-row">
            <span className="settings-path">
              {inTauri ? `Strand ${current ?? '…'}` : t('updates.browserPreview')}
            </span>
            {status === 'available' ? (
              <button
                type="button"
                className="btn primary"
                onClick={() => void openMicrosoftStore()}
              >
                {t('updates.openStore')}
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={!inTauri || status === 'checking'}
                onClick={() => void checkNow()}
              >
                {t('updates.check')}
              </button>
            )}
          </div>
          <p className="settings-hint" role="status">
            {t('updates.managedByStore')}
          </p>
          {storeStatusLine && (
            <p className="settings-hint" role="status">
              {storeStatusLine}
            </p>
          )}
        </div>
      </section>
    );
  }

  const statusLine =
    status === 'checking' ? t('updates.checking')
    : status === 'upToDate' ? t('updates.current')
    : status === 'available' ? t('updates.available', { version: version ?? '' })
    : status === 'downloading'
      ? t('updates.downloading', {
          progress: total
            ? formatPercent(received / total)
            : `${formatNumber(received / 1024 / 1024, { maximumFractionDigits: 0 })} MB`,
        })
    : status === 'ready' ? t('updates.ready')
    : status === 'error' ? error ? t('updates.errorReason', { reason: error }) : t('updates.error')
    : null;

  return (
    <section className="settings-section" aria-label={t('updates.section')}>
      <div className="settings-field">
        <span className="settings-field-label">{t('updates.version')}</span>
        <div className="settings-row">
          <span className="settings-path">
            {inTauri ? `Strand ${current ?? '…'}` : t('updates.browserPreview')}
          </span>
          {status === 'available' ? (
            <button type="button" className="btn primary" onClick={() => void downloadAndInstall()}>
              {t('updates.downloadInstall')}
            </button>
          ) : status === 'ready' ? (
            <button type="button" className="btn primary" onClick={() => void restart()}>
              {t('updates.restart')}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={!inTauri || status === 'checking' || status === 'downloading'}
              onClick={() => void checkNow()}
            >
              {t('updates.check')}
            </button>
          )}
        </div>
        {status === 'downloading' && (
          <progress
            className="settings-progress"
            value={total ? received : undefined}
            max={total ?? undefined}
            aria-label={t('updates.downloadProgress')}
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
        <span className="settings-field-label">{t('updates.automatic')}</span>
        <div className="settings-rows">
          <CheckRow
            label={t('updates.checkOnLaunch')}
            checked={autoCheck}
            onChange={(v) => set('updateAutoCheck', v)}
          />
          <CheckRow
            label={t('updates.installAutomatically')}
            hint={t('updates.restartHint')}
            checked={autoInstall}
            onChange={(v) => set('updateAutoInstall', v)}
          />
        </div>
      </div>
    </section>
  );
}
