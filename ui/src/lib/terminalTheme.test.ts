import { describe, expect, it } from 'vitest';

import { terminalTheme } from './terminalTheme';

function styles(tokens: Record<string, string>): CSSStyleDeclaration {
  return {
    getPropertyValue: (name: string) => tokens[name] ?? '',
  } as CSSStyleDeclaration;
}

describe('terminalTheme', () => {
  it('uses dark foreground tokens for ANSI black and every bright color in light mode', () => {
    const theme = terminalTheme(styles({
      '--bg-os': 'cream',
      '--text': 'ink',
      '--text-muted': 'muted-ink',
      '--del': 'red',
      '--add': 'green',
      '--warn': 'yellow',
      '--b-2': 'blue',
      '--b-4': 'magenta',
      '--b-7': 'cyan',
    }), 'light');

    expect(theme.black).toBe('ink');
    expect(theme.black).not.toBe('cream');
    expect(theme.brightBlack).toBe('muted-ink');
    expect(theme.brightRed).toBe('red');
    expect(theme.brightGreen).toBe('green');
    expect(theme.brightYellow).toBe('yellow');
    expect(theme.brightBlue).toBe('blue');
    expect(theme.brightMagenta).toBe('magenta');
    expect(theme.brightCyan).toBe('cyan');
    expect(theme.brightWhite).toBe('ink');
  });

  it('keeps ANSI black anchored to the dark terminal background in dark mode', () => {
    expect(terminalTheme(styles({ '--bg-os': 'charcoal', '--text': 'white' }), 'dark').black)
      .toBe('charcoal');
  });
});
