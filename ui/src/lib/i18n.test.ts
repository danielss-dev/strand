import { describe, expect, it } from 'vitest';

import { formatDateTime, formatNumber, formatPercent, plural, t } from './i18n';

describe('i18n', () => {
  it('resolves and interpolates catalog messages', () => {
    expect(t('updates.available', { version: '1.0.0' })).toBe('Version 1.0.0 is available.');
    expect(() => t('updates.available')).toThrow('Missing localization value: version');
  });

  it('selects the English plural form', () => {
    const forms = { one: 'common.fileCount.one', other: 'common.fileCount.other' } as const;
    expect(plural(1, forms, {}, 'en-US')).toBe('1 file');
    expect(plural(2, forms, {}, 'en-US')).toBe('2 files');
  });

  it('formats numbers, percentages, and dates for an explicit locale', () => {
    expect(formatNumber(1234.5, undefined, 'en-US')).toBe('1,234.5');
    expect(formatPercent(0.42, undefined, 'en-US')).toBe('42%');
    expect(formatDateTime(new Date('2026-07-18T12:00:00Z'), { timeZone: 'UTC', dateStyle: 'medium' }, 'en-US'))
      .toBe('Jul 18, 2026');
  });
});
