import { expect, test, vi } from 'vitest';

test('persists startup settings and seeds the configured initial space', async () => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  vi.stubGlobal('navigator', { userAgent: '' });
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
  storage.setItem('strand.settings', JSON.stringify({
    state: { startupSpace: 'custom', keybindings: { 'view-custom': 'Mod+9' } },
    version: 0,
  }));

  const { useSettings } = await import('./settings');
  expect(useSettings.getState().startupSpace).toBe('work');
  expect(useSettings.getState().keybindings).toEqual({ 'customize-workbench': 'Mod+9' });
  useSettings.getState().set('aiConnectionStatus', {
    openai: { installed: true, loggedIn: true, checkedAt: 123 },
    anthropic: null,
  });
  useSettings.getState().set('startupSpace', 'work');
  useSettings.getState().set('diffSyntaxTheme', 'protanopia-deuteranopia');

  const persisted = JSON.parse(storage.getItem('strand.settings') ?? '{}');
  expect(persisted.state.startupSpace).toBe('work');
  expect(persisted.state.diffSyntaxTheme).toBe('protanopia-deuteranopia');
  expect(persisted.state.aiConnectionStatus).toEqual({
    openai: { installed: true, loggedIn: true, checkedAt: 123 },
    anthropic: null,
  });
  expect(JSON.stringify(persisted.state.aiConnectionStatus)).not.toContain('account');

  const { useRepo } = await import('./repo');
  expect(useRepo.getState().view).toBe('work');
});
