import { describe, expect, it } from 'vitest';

import { pierreThemeOptions } from './pierreTheme';

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
});
