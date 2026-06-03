import { useEffect, useRef } from 'react';

import { Icon } from '../components/Icon';
import {
  accentSwatch,
  ACCENT_OPTIONS,
  systemTheme,
  THEME_OPTIONS,
  type AccentOption,
  type ThemeOption,
} from '../lib/theme';
import { useSettings, type AccentId, type ThemePref } from '../stores/settings';

/**
 * Settings modal. Reuses the `.clone-dialog` shell like the other dialogs.
 * Today it hosts the **Appearance** controls — theme (dark / light / system)
 * and accent color; density / font sections slot in alongside later.
 * Selecting applies live (CSS variables are token-driven), so there's no Save
 * step — the picker *is* the preview.
 *
 * Reachable from the status-bar gear, ⌘, and the command palette.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  // Read preferences from the store (App's useTheme keeps `resolvedTheme`
  // current); selecting just writes the preference and re-themes live.
  const pref = useSettings((s) => s.theme);
  const resolved = useSettings((s) => s.resolvedTheme);
  const accent = useSettings((s) => s.accent);
  const set = useSettings((s) => s.set);
  const setPref = (next: ThemePref) => set('theme', next);
  const setAccent = (next: AccentId) => set('accent', next);

  const dialogRef = useRef<HTMLDivElement>(null);
  const themesRef = useRef<HTMLDivElement>(null);
  const accentsRef = useRef<HTMLDivElement>(null);

  // Focus trap — same aria-modal contract as TagDialog / StashDialog.
  function onTrapKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

  // Roving arrow-key nav within a radiogroup: ←/→/↑/↓ move + select the
  // adjacent option, wrapping. Shared by the theme + accent groups (both
  // tag their items with `data-opt-id`).
  function moveSelection<T extends { id: string }>(
    e: React.KeyboardEvent<HTMLDivElement>,
    options: T[],
    currentId: string,
    select: (id: T['id']) => void,
    container: HTMLDivElement | null,
  ) {
    const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    if (!fwd && !back) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.id === currentId);
    const base = i === -1 ? 0 : i;
    const next = options[(base + (fwd ? 1 : options.length - 1)) % options.length];
    select(next.id);
    requestAnimationFrame(() => {
      container?.querySelector<HTMLElement>(`[data-opt-id="${next.id}"]`)?.focus();
    });
  }

  // The single Tab-reachable item per group (roving tabindex), with a fallback
  // to the first if the stored value isn't a registered option.
  const themeTab = THEME_OPTIONS.some((o) => o.id === pref) ? pref : THEME_OPTIONS[0].id;
  const accentTab = ACCENT_OPTIONS.some((o) => o.id === accent) ? accent : ACCENT_OPTIONS[0].id;

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="clone-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="settings" size={15} />
          <span className="title">Settings</span>
          <button type="button" className="cd-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body settings-body">
          <section className="settings-section">
            <span className="settings-section-label">Appearance</span>

            <div className="settings-field">
              <span className="settings-field-label">Theme</span>
              <div
                className="theme-grid"
                role="radiogroup"
                aria-label="Theme"
                ref={themesRef}
                onKeyDown={(e) => moveSelection(e, THEME_OPTIONS, pref, setPref, themesRef.current)}
              >
                {THEME_OPTIONS.map((opt) => (
                  <ThemeCard
                    key={opt.id}
                    option={opt}
                    selected={pref === opt.id}
                    tabbable={opt.id === themeTab}
                    onSelect={() => setPref(opt.id)}
                  />
                ))}
              </div>
            </div>

            <div className="settings-field">
              <span className="settings-field-label">Accent</span>
              <div
                className="accent-row"
                role="radiogroup"
                aria-label="Accent color"
                ref={accentsRef}
                onKeyDown={(e) => moveSelection(e, ACCENT_OPTIONS, accent, setAccent, accentsRef.current)}
              >
                {ACCENT_OPTIONS.map((opt) => (
                  <AccentDot
                    key={opt.id}
                    option={opt}
                    selected={accent === opt.id}
                    tabbable={opt.id === accentTab}
                    onSelect={() => setAccent(opt.id)}
                  />
                ))}
              </div>
            </div>

            <p className="settings-hint">
              {pref === 'system'
                ? `Following the system — currently ${resolved}.`
                : `Using the ${pref} theme.`}
              {' '}Change anytime with <kbd className="kbd">⌘⇧T</kbd>.
            </p>
          </section>
        </div>

        <div className="clone-foot">
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function ThemeCard({
  option,
  selected,
  tabbable,
  onSelect,
}: {
  option: ThemeOption;
  selected: boolean;
  tabbable: boolean;
  onSelect: () => void;
}) {
  // 'auto' swatches preview whichever theme the OS currently resolves to.
  const swatchTheme = option.swatch === 'auto' ? systemTheme() : option.swatch;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-opt-id={option.id}
      tabIndex={tabbable ? 0 : -1}
      className={'theme-card' + (selected ? ' selected' : '')}
      onClick={onSelect}
    >
      <span className="theme-swatch" data-theme={swatchTheme} aria-hidden="true">
        <span className="ts-bar" />
        <span className="ts-body">
          <span className="ts-side" />
          <span className="ts-main">
            <span className="ts-line a" />
            <span className="ts-line b" />
          </span>
        </span>
      </span>
      <span className="theme-card-text">
        <span className="theme-card-label">
          {option.label}
          {option.id === 'system' && <Icon name="eye" size={11} />}
        </span>
        <span className="theme-card-hint">{option.hint}</span>
      </span>
      <span className={'theme-check' + (selected ? ' on' : '')} aria-hidden="true">
        {selected && <Icon name="check" size={12} stroke={2.2} />}
      </span>
    </button>
  );
}

function AccentDot({
  option,
  selected,
  tabbable,
  onSelect,
}: {
  option: AccentOption;
  selected: boolean;
  tabbable: boolean;
  onSelect: () => void;
}) {
  // The dot paints a fixed-lightness swatch of its hue (theme-independent);
  // selection is a ring in the same hue (`--dot`).
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={option.label}
      title={option.label}
      data-opt-id={option.id}
      tabIndex={tabbable ? 0 : -1}
      className={'accent-dot' + (selected ? ' selected' : '')}
      style={{ '--dot': accentSwatch(option.h) } as React.CSSProperties}
      onClick={onSelect}
    />
  );
}
