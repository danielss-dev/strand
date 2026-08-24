import type { ITheme } from '@xterm/xterm';

import type { Theme } from '../stores/settings';

/** Build a complete xterm palette from Strand's resolved theme tokens. */
export function terminalTheme(styles: CSSStyleDeclaration, theme: Theme): ITheme {
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  const text = token('--text', theme === 'light' ? '#242220' : '#f3f1ed');
  const text2 = token('--text-2', theme === 'light' ? '#57524c' : '#c9c6c0');
  const red = token('--del', theme === 'light' ? '#b42336' : '#e06c75');
  const green = token('--add', theme === 'light' ? '#216e39' : '#98c379');
  const yellow = token('--warn', theme === 'light' ? '#805d00' : '#e5c07b');
  const blue = token('--b-2', theme === 'light' ? '#0969da' : '#61afef');
  const magenta = token('--b-4', theme === 'light' ? '#8250df' : '#c678dd');
  const cyan = token('--b-7', theme === 'light' ? '#0a7d83' : '#56b6c2');

  return {
    background: token('--bg-base', theme === 'light' ? '#fdfbf8' : '#111111'),
    foreground: text,
    cursor: token('--accent', theme === 'light' ? '#9a6700' : '#d6a657'),
    selectionBackground: token('--bg-sel', theme === 'light' ? '#ead9b9' : '#343434'),
    black: theme === 'light' ? text : token('--bg-os', '#111111'),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: text2,
    brightBlack: token('--text-muted', theme === 'light' ? '#6e6a64' : '#99958f'),
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: text,
  };
}
