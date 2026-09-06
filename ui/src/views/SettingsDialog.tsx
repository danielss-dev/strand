import { useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
import { Icon, type IconName } from '../components/Icon';
import { t, type MessageKey } from '../lib/i18n';
import { AiSection } from './settings/AiSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { DiffSection } from './settings/DiffSection';
import { GitSection } from './settings/GitSection';
import { HostingSection } from './settings/HostingSection';
import { IntegrationsSection } from './settings/IntegrationsSection';
import { KeyboardSection } from './settings/KeyboardSection';
import { PluginsSection } from './settings/PluginsSection';
import { PrivacySection } from './settings/PrivacySection';
import { TerminalSection } from './settings/TerminalSection';
import { UpdatesSection } from './settings/UpdatesSection';
import { UserActionsEditor } from './settings/UserActionsEditor';

/**
 * Settings modal — a sidebar of sections (Appearance / Diff / Git /
 * Integrations / Updates) with the active section's controls on the right.
 * Reuses the `.clone-dialog` shell like the other dialogs; section content
 * lives in `./settings/*Section.tsx`.
 *
 * Keyboard model: the sidebar is a vertical tablist with a roving tabindex —
 * ↑/↓ move *and* select (select-on-focus, same as the radiogroups inside),
 * Home/End jump, Tab moves between the close button, the tablist, the active
 * panel's controls, and Done. Escape closes.
 *
 * Reachable from the status-bar gear, ⌘, and the command palette.
 */

export type SettingsSectionId =
  | 'appearance' | 'terminal' | 'diff' | 'keyboard' | 'git' | 'hosting' | 'integrations' | 'user-actions' | 'ai' | 'plugins' | 'updates' | 'privacy';

const SECTIONS: { id: SettingsSectionId; label: MessageKey; icon: IconName }[] = [
  { id: 'appearance', label: 'settings.appearance', icon: 'eye' },
  { id: 'terminal', label: 'settings.terminal', icon: 'terminal' },
  { id: 'diff', label: 'settings.diff', icon: 'compare' },
  { id: 'keyboard', label: 'settings.keyboard', icon: 'command' },
  { id: 'git', label: 'settings.git', icon: 'branch' },
  { id: 'hosting', label: 'settings.hosting', icon: 'remote' },
  { id: 'integrations', label: 'settings.integrations', icon: 'external' },
  { id: 'user-actions', label: 'settings.userActions', icon: 'terminal' },
  { id: 'ai', label: 'settings.ai', icon: 'sparkle' },
  { id: 'plugins', label: 'settings.plugins', icon: 'workspace' },
  { id: 'updates', label: 'settings.updates', icon: 'sync' },
  { id: 'privacy', label: 'settings.privacy', icon: 'lock' },
];

export function SettingsDialog({
  onClose,
  initialSection = 'appearance',
}: {
  onClose: () => void;
  initialSection?: SettingsSectionId;
}) {
  const [section, setSection] = useState<SettingsSectionId>(initialSection);

  const navRef = useRef<HTMLDivElement>(null);

  // Sidebar roving nav: ↑/↓ move + select, Home/End jump.
  function onNavKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const i = SECTIONS.findIndex((s) => s.id === section);
    let next: SettingsSectionId | null = null;
    if (e.key === 'ArrowDown') next = SECTIONS[(i + 1) % SECTIONS.length].id;
    else if (e.key === 'ArrowUp') next = SECTIONS[(i + SECTIONS.length - 1) % SECTIONS.length].id;
    else if (e.key === 'Home') next = SECTIONS[0].id;
    else if (e.key === 'End') next = SECTIONS[SECTIONS.length - 1].id;
    if (!next) return;
    e.preventDefault();
    setSection(next);
    const id = next;
    requestAnimationFrame(() => {
      navRef.current?.querySelector<HTMLElement>(`[data-opt-id="${id}"]`)?.focus();
    });
  }

  return (
    <Dialog
      title={t('settings.title')}
      icon="settings"
      size="xl"
      className="settings-dialog-lg"
      blockEscapeWhileBusy={false}
      onClose={onClose}
      footer={
        <button type="button" className="btn primary" onClick={onClose}>
          {t('settings.done')}
        </button>
      }
    >
        <div className="settings-layout">
          <div
            className="settings-nav"
            role="tablist"
            aria-orientation="vertical"
            aria-label={t('settings.sections')}
            ref={navRef}
            onKeyDown={onNavKeyDown}
          >
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={`settings-tab-${s.id}`}
                aria-selected={section === s.id}
                aria-controls="settings-pane"
                data-opt-id={s.id}
                tabIndex={s.id === section ? 0 : -1}
                className={'settings-nav-item' + (section === s.id ? ' on' : '')}
                onClick={() => setSection(s.id)}
              >
                <Icon name={s.icon} size={13} />
                {t(s.label)}
              </button>
            ))}
          </div>

          <div
            className="settings-pane"
            id="settings-pane"
            role="tabpanel"
            aria-labelledby={`settings-tab-${section}`}
          >
            {section === 'appearance' && <AppearanceSection />}
            {section === 'terminal' && <TerminalSection />}
            {section === 'diff' && <DiffSection />}
            {section === 'keyboard' && <KeyboardSection />}
            {section === 'git' && <GitSection />}
            {section === 'hosting' && <HostingSection />}
            {section === 'integrations' && <IntegrationsSection />}
            {section === 'user-actions' && <UserActionsEditor />}
            {section === 'ai' && <AiSection />}
            {section === 'plugins' && <PluginsSection />}
            {section === 'updates' && <UpdatesSection />}
            {section === 'privacy' && <PrivacySection />}
          </div>
        </div>
    </Dialog>
  );
}
