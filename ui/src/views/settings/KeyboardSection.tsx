import { useEffect, useMemo, useState } from 'react';

import { Icon } from '../../components/Icon';
import {
  CATEGORY_ORDER,
  COMMANDS,
  conflictingCommands,
  eventToBinding,
  formatBinding,
  resolveBindings,
  type CommandCategory,
  type CommandId,
} from '../../lib/keys';
import { useSettings } from '../../stores/settings';

/**
 * Keyboard — view and rebind every global app shortcut. Bindings are resolved
 * from `lib/keys.ts` (defaults) overlaid with the user's overrides
 * (`settings.keybindings`); changes apply live (the window keydown handler and
 * the native menu both read the same resolved map).
 *
 * Each row: the command, its current binding chip, a "record" toggle (press a
 * combo to capture it), and — when overridden — a reset-to-default control.
 * A binding shared by two commands is flagged so it's clear which one wins.
 *
 * The lower "Context shortcuts" card documents the surface-local keys (commit,
 * in-diff search, review queue, palette navigation) that live with their
 * focused views and aren't rebindable here.
 */

const CATEGORY_HINT: Partial<Record<CommandCategory, string>> = {
  Git: 'Push, pull, fetch and sync only act on the open repository.',
};

/** Surface-local shortcuts, documented for discoverability (not rebindable). */
const CONTEXT_SHORTCUTS: { keys: string; plain?: boolean; label: string }[] = [
  { keys: 'Mod+Enter', label: 'Commit (from the message box)' },
  { keys: 'Mod+F', label: 'Search within the current file or diff' },
  { keys: '/', plain: true, label: 'Search commits (All Commits view)' },
  { keys: 'j / k', plain: true, label: 'Next / previous file (Review queue · Local Changes)' },
  { keys: 'n / p', plain: true, label: 'Next / previous change block in the diff' },
  { keys: 'Shift+J / Shift+K', plain: true, label: 'Scroll the diff pane down / up' },
  { keys: '↑ ↓ · ↵ · ⇥ · Esc', plain: true, label: 'Palette: navigate · run · change scope · close' },
  { keys: 'Ctrl/⌘ +  −  0', plain: true, label: 'Zoom UI in · out · reset to 100%' },
];

export function KeyboardSection() {
  const keybindings = useSettings((s) => s.keybindings);
  const platform = useSettings((s) => s.platform);
  const setKeybinding = useSettings((s) => s.setKeybinding);
  const resetKeybindings = useSettings((s) => s.resetKeybindings);

  const [recording, setRecording] = useState<CommandId | null>(null);

  const resolved = useMemo(() => resolveBindings(keybindings), [keybindings]);
  const conflicts = useMemo(() => conflictingCommands(resolved.byCommand), [resolved]);

  // While recording, grab the next keystroke (capture phase, so it lands before
  // the app's own keydown handler) and store it as this command's binding.
  // Escape cancels; a lone modifier press is ignored until a real key arrives.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setRecording(null); return; }
      const binding = eventToBinding(e);
      if (!binding) return; // waiting for a non-modifier key
      setKeybinding(recording, binding);
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, setKeybinding]);

  const overridden = (id: CommandId) =>
    Object.prototype.hasOwnProperty.call(keybindings, id);
  const anyOverride = Object.keys(keybindings).length > 0;

  return (
    <section className="settings-section" aria-label="Keyboard">
      <div className="settings-field">
        <div className="kb-head">
          <span className="settings-field-label">Shortcuts</span>
          <button
            type="button"
            className="btn ghost kb-reset-all"
            disabled={!anyOverride}
            onClick={resetKeybindings}
          >
            Restore defaults
          </button>
        </div>
        <p className="settings-hint">
          Click a shortcut, then press the keys you want. Use <kbd className="kbd">Esc</kbd> to
          cancel.
        </p>
      </div>

      {CATEGORY_ORDER.map((cat) => {
        const cmds = COMMANDS.filter((c) => c.category === cat);
        if (cmds.length === 0) return null;
        return (
          <div className="settings-field" key={cat}>
            <span className="settings-field-label">{cat}</span>
            {CATEGORY_HINT[cat] && <p className="settings-hint">{CATEGORY_HINT[cat]}</p>}
            <div className="settings-rows kb-rows">
              {cmds.map((c) => {
                const binding = resolved.byCommand.get(c.id) ?? null;
                const isRec = recording === c.id;
                const clash = conflicts.has(c.id);
                return (
                  <div className="settings-frow kb-row" key={c.id}>
                    <span className="settings-frow-text">
                      <span className="settings-field-label">{c.label}</span>
                      {clash && (
                        <span className="settings-frow-hint kb-warn">
                          Shared with another command
                        </span>
                      )}
                    </span>
                    <div className="kb-controls">
                      <button
                        type="button"
                        className={'kb-chip' + (isRec ? ' recording' : '') + (clash ? ' clash' : '')}
                        aria-label={
                          isRec
                            ? `Recording shortcut for ${c.label} — press a key combination`
                            : `Change shortcut for ${c.label}` +
                              (binding ? `, currently ${formatBinding(binding, platform)}` : ', unassigned')
                        }
                        onClick={() => setRecording(isRec ? null : c.id)}
                      >
                        {isRec ? 'Press keys…' : binding ? formatBinding(binding, platform) : 'Unassigned'}
                      </button>
                      <button
                        type="button"
                        className="kb-icon-btn"
                        title="Unassign"
                        aria-label={`Unassign shortcut for ${c.label}`}
                        disabled={binding === null}
                        onClick={() => setKeybinding(c.id, null)}
                      >
                        <Icon name="x" size={12} />
                      </button>
                      <button
                        type="button"
                        className="kb-icon-btn"
                        title="Reset to default"
                        aria-label={`Reset shortcut for ${c.label} to default`}
                        disabled={!overridden(c.id)}
                        onClick={() => setKeybinding(c.id, undefined)}
                      >
                        <Icon name="history" size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="settings-field">
        <span className="settings-field-label">Context shortcuts</span>
        <p className="settings-hint">
          These act on the focused surface and aren't rebindable.
        </p>
        <div className="settings-rows kb-rows">
          {CONTEXT_SHORTCUTS.map((s) => (
            <div className="settings-frow kb-row" key={s.label}>
              <span className="settings-frow-text">
                <span className="settings-field-label">{s.label}</span>
              </span>
              <span className="kb-chip static">
                {s.plain ? s.keys : formatBinding(s.keys, platform)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
