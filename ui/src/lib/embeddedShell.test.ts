import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', {});
vi.stubGlobal('navigator', { userAgent: 'Windows' });

import {
  embeddedShellFromValue,
  embeddedShellOptions,
  embeddedShellValue,
} from './embeddedShell';

describe('embedded shell choices', () => {
  it('round-trips WSL distribution names without treating them as commands', () => {
    const choice = { kind: 'wsl', distribution: 'Ubuntu Preview:Dev' } as const;
    expect(embeddedShellFromValue(embeddedShellValue(choice), { kind: 'system' })).toEqual(choice);
  });

  it('adds discovered WSL distributions to the Windows shell picker', () => {
    expect(embeddedShellOptions(['Ubuntu']).at(-1)).toMatchObject({
      label: 'WSL · Ubuntu',
      group: 'wsl',
      choice: { kind: 'wsl', distribution: 'Ubuntu' },
    });
  });
});
