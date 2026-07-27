import type { Theme } from '../stores/settings';

/**
 * Pierre's worker pool renders both palettes into one cached AST. `themeType`
 * selects which palette the mounted instance displays; `theme` remains the
 * single-theme fallback when the worker pool is unavailable.
 */
export function pierreThemeOptions(theme: Theme) {
  return {
    theme: theme === 'light' ? 'pierre-light' : 'pierre-dark',
    themeType: theme,
  } as const;
}
