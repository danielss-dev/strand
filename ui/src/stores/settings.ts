import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** A concrete theme that maps to a `[data-theme]` token set in tokens.css. */
export type Theme = 'dark' | 'light';
/** The user's stored preference: a concrete theme, or `system` to follow the
 * OS `prefers-color-scheme`. Resolved to a `Theme` by `lib/theme.ts`. */
export type ThemePref = Theme | 'system';
/** Accent color preset. Each id maps to an OKLCH hue via a `[data-accent]`
 * block in tokens.css; the registry lives in `lib/theme.ts` (`ACCENT_OPTIONS`). */
export type AccentId = 'amber' | 'rose' | 'magenta' | 'violet' | 'blue' | 'cyan' | 'teal' | 'green';
export type Platform = 'mac' | 'win11';
export type Density = 'compact' | 'default' | 'relaxed';
export type DiffMode = 'stacked' | 'split';
export type GraphStyle = 'classic' | 'bold' | 'mono';

export type UiFont = 'geist' | 'inter' | 'iaq' | 'system';
export type MonoFont = 'jetbrains' | 'geist' | 'plex' | 'commit' | 'sfmono';

/** The concrete theme already applied to `<html>` by the pre-paint inline
 * script in index.html — the exact (pref + OS) resolution, with no second
 * computation here. `useTheme` keeps it in sync from React's first commit. */
function initialResolvedTheme(): Theme {
  if (typeof document !== 'undefined') {
    const t = document.documentElement.dataset.theme;
    if (t === 'light' || t === 'dark') return t;
  }
  return 'dark';
}

function detectPlatform(): Platform {
  // Tauri OS plugin injects this global before JS runs
  const internals = (window as unknown as { __TAURI_OS_PLUGIN_INTERNALS__?: { os_type: string } })
    .__TAURI_OS_PLUGIN_INTERNALS__;
  if (internals?.os_type === 'windows') return 'win11';
  if (internals?.os_type === 'macos') return 'mac';

  // Fallback for browser mode
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'win11';
  return 'mac';
}

export interface SettingsState {
  /** Theme *preference* (dark / light / system). The resolved concrete theme
   * driving `[data-theme]` is computed in `lib/theme.ts` (`useTheme`). */
  theme: ThemePref;
  /** Resolved concrete theme (`theme` collapsed against the OS). Runtime-only,
   * not persisted; written by `useTheme`, read by anything that needs the live
   * concrete theme without its own OS subscription (e.g. Pierre diff theming). */
  resolvedTheme: Theme;
  /** Accent color preset, applied via `[data-accent]` on `<html>` (a hue
   * rotation over the accent tokens). Works across light + dark. */
  accent: AccentId;
  platform: Platform;
  density: Density;
  diffMode: DiffMode;
  /** Whether the Local Changes diff pane shows file diffs collapsed (headers
   * only). A session-only view toggle — not persisted across launches. */
  diffsCollapsed: boolean;
  graphStyle: GraphStyle;
  uiFont: UiFont;
  monoFont: MonoFont;
  set: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
}

export const FONTS = {
  ui: {
    geist:  "'Geist', -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
    inter:  "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    iaq:    "'IBM Plex Sans', sans-serif",
    system: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
  } satisfies Record<UiFont, string>,
  mono: {
    jetbrains: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
    geist:     "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace",
    plex:      "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
    commit:    "'Commit Mono', ui-monospace, 'SF Mono', Menlo, monospace",
    sfmono:    "ui-monospace, 'SF Mono', Menlo, monospace",
  } satisfies Record<MonoFont, string>,
};

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      resolvedTheme: initialResolvedTheme(),
      accent: 'amber',
      platform: detectPlatform(),
      density: 'default',
      diffMode: 'stacked',
      diffsCollapsed: false,
      graphStyle: 'classic',
      uiFont: 'geist',
      monoFont: 'jetbrains',
      set: (key, value) => set({ [key]: value } as Partial<SettingsState>),
    }),
    {
      name: 'strand.settings',
      partialize: (state) => {
        // `resolvedTheme` is derived at runtime; `platform` is re-detected;
        // `diffsCollapsed` is a session-only view toggle — none persist.
        const { platform, diffsCollapsed, resolvedTheme, ...rest } = state;
        return rest;
      },
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as object),
        platform: detectPlatform(),
      }),
    },
  ),
);
