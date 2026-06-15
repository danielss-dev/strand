import { describe, expect, it } from 'vitest';

import {
  COMMANDS,
  conflictingCommands,
  eventToBinding,
  formatBinding,
  isPlainKey,
  resolveBindings,
  toMudaAccelerator,
  type KeyLike,
} from './keys';

const ev = (over: Partial<KeyLike>): KeyLike => ({
  key: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over,
});

describe('eventToBinding', () => {
  it('folds letter case and carries Shift explicitly', () => {
    // ⌘P and ⌘⇧P (push vs pull) must stay distinct regardless of key case.
    expect(eventToBinding(ev({ key: 'p', metaKey: true }))).toBe('Mod+P');
    expect(eventToBinding(ev({ key: 'P', metaKey: true, shiftKey: true }))).toBe('Mod+Shift+P');
  });

  it('treats Ctrl and Meta as the same Mod token', () => {
    expect(eventToBinding(ev({ key: 'k', ctrlKey: true }))).toBe('Mod+K');
    expect(eventToBinding(ev({ key: 'k', metaKey: true }))).toBe('Mod+K');
  });

  it('keeps a fixed modifier order Mod+Alt+Shift+key', () => {
    expect(eventToBinding(ev({ key: 'a', metaKey: true, altKey: true, shiftKey: true })))
      .toBe('Mod+Alt+Shift+A');
  });

  it('returns null for a lone modifier press', () => {
    expect(eventToBinding(ev({ key: 'Shift', shiftKey: true }))).toBeNull();
    expect(eventToBinding(ev({ key: 'Meta', metaKey: true }))).toBeNull();
  });

  it('keeps digits and named keys verbatim', () => {
    expect(eventToBinding(ev({ key: '1', metaKey: true }))).toBe('Mod+1');
    expect(eventToBinding(ev({ key: ',', metaKey: true }))).toBe('Mod+,');
  });
});

describe('isPlainKey', () => {
  it('flags bindings with no Mod/Alt modifier', () => {
    expect(isPlainKey('/')).toBe(true);
    expect(isPlainKey('Shift+J')).toBe(true);
    expect(isPlainKey('Mod+P')).toBe(false);
    expect(isPlainKey('Alt+P')).toBe(false);
  });
});

describe('resolveBindings', () => {
  it('uses defaults with no overrides', () => {
    const { byCommand } = resolveBindings();
    expect(byCommand.get('push')).toBe('Mod+P');
    expect(byCommand.get('pull')).toBe('Mod+Shift+P');
  });

  it('applies an override and unbinds with null', () => {
    const { byCommand, byBinding } = resolveBindings({ push: 'Mod+U', pull: null });
    expect(byCommand.get('push')).toBe('Mod+U');
    expect(byCommand.get('pull')).toBeNull();
    expect(byBinding.get('Mod+U')).toBe('push');
    expect(byBinding.has('Mod+Shift+P')).toBe(false);
  });

  it('first-declared command wins a shared binding for dispatch', () => {
    // Bind push to the palette's default; palette is declared earlier.
    const { byBinding } = resolveBindings({ push: 'Mod+K' });
    expect(byBinding.get('Mod+K')).toBe('palette');
  });
});

describe('conflictingCommands', () => {
  it('flags every command sharing a binding', () => {
    const { byCommand } = resolveBindings({ push: 'Mod+K' });
    const clash = conflictingCommands(byCommand);
    expect(clash.has('push')).toBe(true);
    expect(clash.has('palette')).toBe(true);
    expect(clash.has('pull')).toBe(false);
  });

  it('reports none for the default set', () => {
    expect(conflictingCommands(resolveBindings().byCommand).size).toBe(0);
  });
});

describe('formatBinding', () => {
  it('renders mac glyphs joined tight', () => {
    expect(formatBinding('Mod+Shift+P', 'mac')).toBe('⌘⇧P');
    expect(formatBinding('Mod+,', 'mac')).toBe('⌘,');
  });

  it('renders windows words joined with +', () => {
    expect(formatBinding('Mod+Shift+P', 'win11')).toBe('Ctrl+Shift+P');
    expect(formatBinding('Mod+1', 'win11')).toBe('Ctrl+1');
  });

  it('returns empty for an unbound command', () => {
    expect(formatBinding(null, 'mac')).toBe('');
  });
});

describe('toMudaAccelerator', () => {
  it('maps modifiers and comma', () => {
    expect(toMudaAccelerator('Mod+Shift+P')).toBe('CmdOrControl+Shift+P');
    expect(toMudaAccelerator('Mod+,')).toBe('CmdOrControl+Comma');
  });

  it('returns null for an unrepresentable key', () => {
    expect(toMudaAccelerator('Mod+↑')).toBeNull();
  });

  it('returns null for unbound', () => {
    expect(toMudaAccelerator(null)).toBeNull();
  });
});

describe('COMMANDS table', () => {
  it('has unique ids and no conflicting default bindings', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(conflictingCommands(resolveBindings().byCommand).size).toBe(0);
  });
});
