import type { DiffsThemeNames, ThemesType } from '@pierre/diffs';

import type { DiffSyntaxTheme, Theme } from '../stores/settings';

export const DIFF_SYNTAX_THEME_OPTIONS: readonly { id: DiffSyntaxTheme; label: string }[] = [
  { id: 'standard', label: 'Standard' },
  { id: 'soft', label: 'Soft' },
  { id: 'vibrant', label: 'Vibrant' },
  { id: 'protanopia-deuteranopia', label: 'Red–green accessible' },
  { id: 'tritanopia', label: 'Blue–yellow accessible' },
];

export function pierreThemePair(family: DiffSyntaxTheme): ThemesType {
  const suffix = family === 'standard' ? '' : `-${family}`;
  return {
    light: `pierre-light${suffix}` as DiffsThemeNames,
    dark: `pierre-dark${suffix}` as DiffsThemeNames,
  };
}

/**
 * Pierre's worker pool renders both palettes into one cached AST. `themeType`
 * selects which palette the mounted instance displays; `theme` remains the
 * single-theme fallback when the worker pool is unavailable.
 */
export function pierreThemeOptions(theme: Theme, family: DiffSyntaxTheme = 'standard') {
  const pair = pierreThemePair(family);
  return {
    theme: pair[theme],
    themeType: theme,
  } as const;
}
