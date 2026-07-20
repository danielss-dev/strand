import { useEffect, useRef, useState } from 'react';

import { Icon, type IconName } from '../components/Icon';
import { t, type MessageKey } from '../lib/i18n';
import { AiSection } from './settings/AiSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { DiffSection } from './settings/DiffSection';
import { GitSection } from './settings/GitSection';
import { HostingSection } from './settings/HostingSection';
import { IntegrationsSection } from './settings/IntegrationsSection';
import { KeyboardSection } from './settings/KeyboardSection';
import { PrivacySection } from './settings/PrivacySection';
import { TerminalSection } from './settings/TerminalSection';
import { UpdatesSection } from './settings/UpdatesSection';

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
  | 'appearance' | 'terminal' | 'diff' | 'keyboard' | 'git' | 'hosting' | 'integrations' | 'ai' | 'updates' | 'privacy';

const SECTIONS: { id: SettingsSectionId; label: MessageKey; icon: IconName }[] = [
  { id: 'appearance', label: 'settings.appearance', icon: 'eye' },
  { id: 'terminal', label: 'settings.terminal', icon: 'terminal' },
  { id: 'diff', label: 'settings.diff', icon: 'compare' },
  { id: 'keyboard', label: 'settings.keyboard', icon: 'command' },
  { id: 'git', label: 'settings.git', icon: 'branch' },
  { id: 'hosting', label: 'settings.hosting', icon: 'remote' },
  { id: 'integrations', label: 'settings.integrations', icon: 'external' },
  { id: 'ai', label: 'settings.ai', icon: 'sparkle' },
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

  const dialogRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);

  // Restore focus to whatever opened the dialog when it closes, so keyboard
  // flow returns to the status bar / palette instead of falling to <body>.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);

  // Focus trap — same aria-modal contract as TagDialog / StashDialog.
  function onTrapKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="clone-dialog settings-dialog settings-dialog-lg"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="settings" size={15} />
          <span className="title">{t('settings.title')}</span>
          <button type="button" className="cd-close" aria-label={t('common.close')} onClick={onClose}>
            ×
          </button>
        </div>

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
            {section === 'ai' && <AiSection />}
            {section === 'updates' && <UpdatesSection />}
            {section === 'privacy' && <PrivacySection />}
          </div>
        </div>

        <div className="clone-foot">
          <button type="button" className="btn primary" onClick={onClose}>
            {t('settings.done')}
          </button>
        </div>
      </div>
    </div>
  );
}
