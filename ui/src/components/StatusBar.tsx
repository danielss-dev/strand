import { Icon } from './Icon';
import { t } from '../lib/i18n';
import { useRepo } from '../stores/repo';

export function StatusBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const meta = useRepo((s) => s.meta);
  const status = useRepo((s) => s.status);

  const modified = status.filter((s) => !s.staged).length;
  const staged = status.filter((s) => s.staged).length;
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

  return (
    <div className="statusbar">
      <div className="sb-item">
        <Icon name="branch" size={11} />
        <span className="branch">{meta?.branch ?? '—'}</span>
      </div>
      {meta && (
        <>
          <div className="sb-item">
            <span style={{ color: 'var(--add)' }}>{meta.ahead}↑</span>
            <span style={{ color: 'var(--del)' }}>{meta.behind}↓</span>
          </div>
          <span className="sep">·</span>
        </>
      )}
      <div className="sb-item">
        <Icon name="sync" size={11} />
        <span>{syncLabel}</span>
      </div>

      <div className="right">
        <div className="sb-item">{t('status.changes', { modified, staged })}</div>
        <span className="sep">·</span>
        <div className="sb-item">UTF-8 · LF</div>
        <button
          type="button"
          className="sb-item sb-gear"
          onClick={onOpenSettings}
          title={`${t('settings.title')} (⌘,)`}
          aria-label={t('settings.title')}
        >
          <Icon name="settings" size={12} />
        </button>
      </div>
    </div>
  );
}
