import { describe, expect, it } from 'vitest';

import { DIFF_SYNTAX_THEME_OPTIONS, pierreThemeOptions, pierreThemePair } from './pierreTheme';

describe('pierreThemeOptions', () => {
  it('selects the light palette independently of the OS theme', () => {
    expect(pierreThemeOptions('light')).toEqual({
      theme: 'pierre-light',
      themeType: 'light',
    });
  });

  it('selects the dark palette independently of the OS theme', () => {
    expect(pierreThemeOptions('dark')).toEqual({
      theme: 'pierre-dark',
      themeType: 'dark',
    });
  });

  it('selects the matching family member for each app appearance', () => {
    expect(pierreThemeOptions('light', 'soft')).toEqual({
      theme: 'pierre-light-soft',
      themeType: 'light',
    });
    expect(pierreThemeOptions('dark', 'vibrant')).toEqual({
      theme: 'pierre-dark-vibrant',
      themeType: 'dark',
    });
  });

  it('exposes every official Pierre palette as a light/dark pair', () => {
    expect(DIFF_SYNTAX_THEME_OPTIONS.map(({ id }) => pierreThemePair(id))).toEqual([
      { light: 'pierre-light', dark: 'pierre-dark' },
      { light: 'pierre-light-soft', dark: 'pierre-dark-soft' },
      { light: 'pierre-light-vibrant', dark: 'pierre-dark-vibrant' },
      {
        light: 'pierre-light-protanopia-deuteranopia',
        dark: 'pierre-dark-protanopia-deuteranopia',
      },
      { light: 'pierre-light-tritanopia', dark: 'pierre-dark-tritanopia' },
    ]);
  });
});
