import { t } from '../lib/i18n';

/** Checkbox for git's `--update-refs`. Disabled, with a tooltip, on git older than 2.38. */
export function UpdateRefsToggle({
  supported,
  enabled,
  busy,
  onChange,
}: {
  supported: boolean;
  enabled: boolean;
  busy: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label
      className="rebase-preserve"
      title={supported ? t('rebase.updateRefs') : t('rebase.updateRefsUnsupported')}
    >
      <input
        type="checkbox"
        checked={supported && enabled}
        disabled={busy || !supported}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{t('rebase.updateRefs')}</span>
    </label>
  );
}
