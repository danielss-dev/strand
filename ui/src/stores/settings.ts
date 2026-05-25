import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';
export type Platform = 'mac' | 'win11';
export type Density = 'compact' | 'default' | 'relaxed';
export type DiffMode = 'stacked' | 'split';
export type GraphStyle = 'classic' | 'bold' | 'mono';

export type UiFont = 'geist' | 'inter' | 'iaq' | 'system';
export type MonoFont = 'jetbrains' | 'geist' | 'plex' | 'commit' | 'sfmono';

export interface SettingsState {
  theme: Theme;
  platform: Platform;
  density: Density;
  diffMode: DiffMode;
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
      theme: 'dark',
      platform: 'mac',
      density: 'default',
      diffMode: 'stacked',
      graphStyle: 'classic',
      uiFont: 'geist',
      monoFont: 'jetbrains',
      set: (key, value) => set({ [key]: value } as Partial<SettingsState>),
    }),
    { name: 'strand.settings' },
  ),
);
