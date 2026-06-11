import { useRef } from 'react';

import { Icon } from '../../components/Icon';
import {
  accentSwatch,
  ACCENT_OPTIONS,
  systemTheme,
  THEME_OPTIONS,
  type AccentOption,
  type ThemeOption,
} from '../../lib/theme';
import {
  DENSITY_OPTIONS,
  MONO_FONT_OPTIONS,
  UI_FONT_OPTIONS,
  useSettings,
  type AccentId,
  type FileOpenTab,
  type ThemePref,
} from '../../stores/settings';
import { moveSelection, SegRow, SelectRow } from './shared';

const FILE_OPEN_OPTIONS: { id: FileOpenTab; label: string }[] = [
  { id: 'preview', label: 'Preview' },
  { id: 'content', label: 'Source' },
];

/** Appearance — theme, accent, density, the two app fonts, and the file
 * view's initial tab. Selecting applies live (token-driven CSS), so there's
 * no Save step. */
export function AppearanceSection() {
  const pref = useSettings((s) => s.theme);
  const resolved = useSettings((s) => s.resolvedTheme);
  const accent = useSettings((s) => s.accent);
  const density = useSettings((s) => s.density);
  const uiFont = useSettings((s) => s.uiFont);
  const monoFont = useSettings((s) => s.monoFont);
  const fileOpenTab = useSettings((s) => s.fileOpenTab);
  const set = useSettings((s) => s.set);
  const setPref = (next: ThemePref) => set('theme', next);
  const setAccent = (next: AccentId) => set('accent', next);

  const themesRef = useRef<HTMLDivElement>(null);
  const accentsRef = useRef<HTMLDivElement>(null);

  // The single Tab-reachable item per group (roving tabindex), with a fallback
  // to the first if the stored value isn't a registered option.
  const themeTab = THEME_OPTIONS.some((o) => o.id === pref) ? pref : THEME_OPTIONS[0].id;
  const accentTab = ACCENT_OPTIONS.some((o) => o.id === accent) ? accent : ACCENT_OPTIONS[0].id;

  return (
    <section className="settings-section" aria-label="Appearance">
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
        <p className="settings-hint">
          {pref === 'system'
            ? `Following the system — currently ${resolved}.`
            : `Using the ${pref} theme.`}
          {' '}Change anytime with <kbd className="kbd">⌘⇧T</kbd>.
        </p>
      </div>

      <div className="settings-rows">
        <SegRow
          label="Density"
          options={DENSITY_OPTIONS}
          value={density}
          onChange={(id) => set('density', id)}
        />
        <SelectRow
          label="UI font"
          options={UI_FONT_OPTIONS}
          value={uiFont}
          onChange={(id) => set('uiFont', id)}
        />
        <SelectRow
          label="Mono font"
          options={MONO_FONT_OPTIONS}
          value={monoFont}
          onChange={(id) => set('monoFont', id)}
        />
        <SegRow
          label="Open files on"
          hint="Renderable files (SVG, Markdown) start on the rendered preview or the raw source."
          options={FILE_OPEN_OPTIONS}
          value={fileOpenTab}
          onChange={(id) => set('fileOpenTab', id)}
        />
      </div>
    </section>
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
