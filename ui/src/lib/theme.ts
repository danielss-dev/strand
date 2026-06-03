import { useEffect, useState } from 'react';

import { useSettings, type AccentId, type Theme, type ThemePref } from '../stores/settings';

/**
 * Theme management — resolves the stored {@link ThemePref} (dark / light /
 * system) to a concrete {@link Theme} and applies it as `data-theme` on
 * `<html>`, live, without a reload.
 *
 * The token sets live in `styles/tokens.css` keyed by `[data-theme="…"]`.
 * Adding a new theme (e.g. high-contrast, solarized) is a two-step extension:
 *   1. add a `[data-theme="<id>"]` block in tokens.css, and
 *   2. add a {@link ThemeOption} to {@link THEME_OPTIONS} below.
 * The settings picker, command palette, and ⌘⇧T cycle all read that registry,
 * so no other code needs to change.
 *
 * No-flash note: the *initial* `data-theme` is set by a tiny inline script in
 * `index.html` that reads the same persisted preference before first paint.
 * This hook owns it from React's first commit onward.
 */

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The current OS appearance, used to resolve the `system` preference. */
export function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.(DARK_QUERY).matches
    ? 'dark'
    : 'light';
}

/** Collapse a preference + the live OS theme into a concrete theme. */
export function resolveTheme(pref: ThemePref, system: Theme): Theme {
  return pref === 'system' ? system : pref;
}

/** A row in the theme picker / palette. `swatch` is the concrete theme whose
 * tokens a static preview should sample (`'auto'` ⇒ follow the OS). */
export interface ThemeOption {
  id: ThemePref;
  label: string;
  hint: string;
  swatch: Theme | 'auto';
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'system', label: 'System', hint: 'Match the OS appearance', swatch: 'auto' },
  { id: 'light', label: 'Light', hint: 'Warm cream', swatch: 'light' },
  { id: 'dark', label: 'Dark', hint: 'Warm charcoal', swatch: 'dark' },
];

/**
 * Accent colors. Each preset is just an OKLCH **hue**; tokens.css holds the
 * matching `[data-accent]` block that sets `--accent-h`, and every accent token
 * (`--accent`, `--accent-2`, `--accent-glow`, `--selection`, the selected-row
 * tint) is defined as `oklch(L C var(--accent-h))` per theme — so an accent is
 * a hue rotation that preserves each theme's lightness/chroma. Adding one is
 * add-a-hue here + a `[data-accent]` block in tokens.css.
 */
export interface AccentOption {
  id: AccentId;
  label: string;
  /** OKLCH hue, 0–360. */
  h: number;
}

export const ACCENT_OPTIONS: AccentOption[] = [
  { id: 'amber', label: 'Amber', h: 55 },
  { id: 'rose', label: 'Rose', h: 18 },
  { id: 'magenta', label: 'Magenta', h: 330 },
  { id: 'violet', label: 'Violet', h: 290 },
  { id: 'blue', label: 'Blue', h: 250 },
  { id: 'cyan', label: 'Cyan', h: 210 },
  { id: 'teal', label: 'Teal', h: 178 },
  { id: 'green', label: 'Green', h: 150 },
];

/** A stable, theme-independent swatch color for the accent dot in the picker. */
export function accentSwatch(h: number): string {
  return `oklch(0.70 0.17 ${h})`;
}

/**
 * The ⌘⇧T toggle target: light ↔ dark, skipping `system`. From `system` it
 * flips away from whatever's currently showing (`resolved`), so the shortcut
 * always lands on a concrete theme the opposite of the current appearance.
 */
export function toggleTheme(pref: ThemePref, resolved: Theme): Theme {
  const current = pref === 'system' ? resolved : pref;
  return current === 'dark' ? 'light' : 'dark';
}

/** Subscribe to the OS `prefers-color-scheme` and return the live theme. */
function useSystemTheme(): Theme {
  const [system, setSystem] = useState<Theme>(systemTheme);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => setSystem(mq.matches ? 'dark' : 'light');
    onChange(); // sync in case it changed between first render and effect
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return system;
}

export interface ThemeController {
  /** The stored preference (dark / light / system). */
  pref: ThemePref;
  /** The concrete theme currently applied to `[data-theme]`. */
  resolved: Theme;
  /** Set the preference; persists and re-themes live. */
  setPref: (pref: ThemePref) => void;
  /** Toggle light ↔ dark (skips system); returns the theme now applied. */
  cycle: () => Theme;
}

/**
 * Read the theme preference, resolve it against the OS, apply `data-theme` to
 * `<html>`, and expose setters. Call once near the app root; the returned
 * `resolved` value is also handy for mirroring onto a wrapper element so
 * portal-free subtrees pick up the tokens immediately.
 */
export function useTheme(): ThemeController {
  const pref = useSettings((s) => s.theme);
  const set = useSettings((s) => s.set);
  const system = useSystemTheme();
  const resolved = resolveTheme(pref, system);

  // Apply to <html> and publish the resolved theme to the store so other
  // components (Pierre diffs, the settings hint) can read it reactively
  // without each running its own OS subscription. Single writer by design —
  // call useTheme exactly once, near the app root.
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    set('resolvedTheme', resolved);
  }, [resolved, set]);

  return {
    pref,
    resolved,
    setPref: (next) => set('theme', next),
    cycle: () => {
      const next = toggleTheme(pref, resolved);
      set('theme', next);
      return next;
    },
  };
}
