import { Icon } from './Icon';
import { t } from '../lib/i18n';
import { formatBinding } from '../lib/keys';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';

export function StatusBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const meta = useRepo((s) => s.meta);
  const status = useRepo((s) => s.status);
  const selectedFile = useRepo((s) => s.selectedFile);
  const platform = useSettings((s) => s.platform);

  const syncLabel = !meta
    ? t('status.noRepository')
    : status.some((entry) => entry.kind === 'CONFLICTED')
      ? t('status.conflicts')
      : meta.ahead > 0 && meta.behind > 0
        ? t('status.diverged')
        : meta.ahead > 0
          ? t('status.ahead', { count: meta.ahead })
          : meta.behind > 0
            ? t('status.behind', { count: meta.behind })
            : t('status.upToDate');

  const settingsShortcut = formatBinding('Mod+,', platform);
  const hasDrift = !!meta && (meta.ahead > 0 || meta.behind > 0);

  return (
    <div className="statusbar">
      <div className="sb-item" title={meta?.branch ?? undefined}>
        <Icon name="branch" size={11} />
        <span className="branch">{meta?.branch ?? '—'}</span>
      </div>
      {hasDrift && (
        <>
          <div className="sb-item" title={`${meta.ahead} ahead, ${meta.behind} behind`}>
            {meta.ahead > 0 && <span className="sb-ahead">{meta.ahead}↑</span>}
            {meta.behind > 0 && <span className="sb-behind">{meta.behind}↓</span>}
          </div>
          <span className="sep">·</span>
        </>
      )}
      <div className="sb-item">
        <Icon name="sync" size={11} />
        <span>{syncLabel}</span>
      </div>

      <div className="right">
        {selectedFile && (
          <>
            <div className="sb-item">UTF-8 · LF</div>
            <span className="sep">·</span>
          </>
        )}
        <button
          type="button"
          className="sb-item sb-gear"
          onClick={onOpenSettings}
          title={`${t('settings.title')} (${settingsShortcut})`}
          aria-label={t('settings.title')}
        >
          <Icon name="settings" size={12} />
        </button>
      </div>
    </div>
  );
}
