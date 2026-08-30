import { useMemo } from 'react';

import { Icon } from '../../components/Icon';
import { t } from '../../lib/i18n';
import { MARKETPLACE_CATALOG } from '../../plugins/marketplace';
import { usePlugins } from '../../stores/plugins';

export function PluginsSection() {
  const ready = usePlugins((state) => state.ready);
  const installedIds = usePlugins((state) => state.installedIds);
  const install = usePlugins((state) => state.install);
  const uninstall = usePlugins((state) => state.uninstall);
  const installed = useMemo(() => new Set(installedIds), [installedIds]);

  return (
    <section className="settings-section plugins-settings" aria-label={t('plugins.settingsTitle')}>
      <div className="plugins-settings-intro">
        <span className="settings-field-label">{t('plugins.settingsTitle')}</span>
        <p>{t('plugins.settingsIntro')}</p>
      </div>

      <div className="plugins-marketplace-list">
        {MARKETPLACE_CATALOG.map(({ manifest, builtin, tags }) => {
          const isInstalled = installed.has(manifest.id);
          return (
            <article key={manifest.id} className="plugins-marketplace-card">
              <div className="plugins-marketplace-head">
                <div className="plugins-marketplace-title">
                  <Icon name={manifest.contributes.surfaces[0]?.icon ?? 'workspace'} size={14} />
                  <div>
                    <strong>{manifest.name}</strong>
                    <span>{manifest.id} · v{manifest.version}</span>
                  </div>
                </div>
                <div className="plugins-marketplace-tags">
                  {builtin && <span className="plugins-tag">{t('plugins.builtin')}</span>}
                  {tags.map((tag) => <span key={tag} className="plugins-tag">{tag}</span>)}
                </div>
              </div>
              <p>{manifest.description}</p>
              <dl className="plugins-permissions">
                <dt>{t('plugins.permissions')}</dt>
                <dd>
                  {manifest.permissions.length === 0
                    ? t('plugins.noPermissions')
                    : manifest.permissions.join(', ')}
                </dd>
              </dl>
              <div className="plugins-marketplace-actions">
                {isInstalled ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={!ready}
                    onClick={() => void uninstall(manifest.id)}
                  >
                    {t('plugins.uninstall')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!ready}
                    onClick={() => void install(manifest.id)}
                  >
                    {t('plugins.install')}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <p className="settings-hint">{t('plugins.settingsHint')}</p>
    </section>
  );
}
