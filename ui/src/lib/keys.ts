/**
 * Central keyboard-shortcut registry — the single source of truth for every
 * *global* app command and its binding. Pure logic only (no React, no store
 * imports) so it lives in `lib/` and is unit-testable (see the testable-logic
 * learning), and so both `App.tsx` (the window keydown handler + palette chips)
 * and `lib/menu.ts` (native-menu accelerators) resolve bindings the same way.
 *
 * ## Binding format
 *
 * A binding is a canonical `+`-joined string built in a fixed modifier order:
 * `Mod` · `Alt` · `Shift` · `<key>`, e.g. `Mod+P`, `Mod+Shift+P`, `Mod+1`.
 * `Mod` is the platform primary — ⌘ on macOS, Ctrl elsewhere — so we never
 * hardcode one family (AGENTS.md cross-platform rule). The `<key>` is a
 * single uppercased letter, a digit, a punctuation char (`,` `/`), or a named
 * key (`Enter`, `Escape`, `ArrowUp`…). `null` means "unbound".
 *
 * User overrides live in `settings.keybindings` ({@link resolveBindings}
 * overlays them on the defaults here); `formatBinding` renders a binding for
 * display and `toMudaAccelerator` converts one for the native desktop menu.
 */

/** A global command id. The owning handlers live in `App.tsx`. */
export type CommandId =
  | 'palette'
  | 'open-repo'
  | 'clone-repo'
  | 'settings'
  | 'view-work'
  | 'view-local'
  | 'view-commits'
  | 'view-reflog'
  | 'view-review'
  | 'view-workspace-review'
  | 'view-worktrees'
  | 'tab-next'
  | 'tab-prev'
  | 'switch-repo'
  | 'theme-toggle'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'sync'
  | 'open-editor'
  | 'open-terminal'
  | 'refresh'
  | 'suggest-commit';

export type CommandCategory = 'General' | 'Navigation' | 'Git' | 'Repository' | 'Appearance';

export interface CommandDef {
  id: CommandId;
  /** Human label shown in Settings and (some) menus. */
  label: string;
  category: CommandCategory;
  /** Default binding in canonical form, or `null` for "no default binding". */
  defaultBinding: string | null;
  /** True if a macOS native-menu item owns an accelerator for this command —
   * the window keydown handler defers to AppKit for these while the menu is
   * installed (see the menu-ownership learning). */
  menu?: boolean;
  /** True if the command only makes sense with a repository open (the keydown
   * handler no-ops it otherwise; the menu item is `enabled: hasRepo`). */
  needsRepo?: boolean;
}

/**
 * The command table. Order here is the order rows render in Settings, grouped
 * by `category`. `Mod` = ⌘ (macOS) / Ctrl (elsewhere).
 *
 * Push/Pull follow the user's request: push on `Mod+P`, pull on `Mod+Shift+P`.
 */
export const COMMANDS: readonly CommandDef[] = [
  { id: 'palette',      label: 'Command palette',        category: 'General',     defaultBinding: 'Mod+K',       menu: true },
  { id: 'open-repo',    label: 'Open repository…',       category: 'General',     defaultBinding: 'Mod+O',       menu: true },
  { id: 'clone-repo',   label: 'Clone repository…',      category: 'General',     defaultBinding: null },
  { id: 'settings',     label: 'Settings',               category: 'General',     defaultBinding: 'Mod+,',       menu: true },

  { id: 'view-work',      label: 'Go to Work',           category: 'Navigation',  defaultBinding: 'Mod+1', menu: true, needsRepo: true },
  { id: 'view-local',     label: 'Go to Local Changes',  category: 'Navigation',  defaultBinding: 'Mod+2', menu: true, needsRepo: true },
  { id: 'view-commits',   label: 'Go to All Commits',    category: 'Navigation',  defaultBinding: 'Mod+3', menu: true, needsRepo: true },
  { id: 'view-reflog',    label: 'Go to Reflog',         category: 'Navigation',  defaultBinding: 'Mod+4', menu: true, needsRepo: true },
  { id: 'view-review',    label: 'Go to Review',         category: 'Navigation',  defaultBinding: 'Mod+5', menu: true, needsRepo: true },
  { id: 'view-worktrees', label: 'Go to Worktrees',      category: 'Navigation',  defaultBinding: 'Mod+6', menu: true, needsRepo: true },
  // Aggregated cross-repo review of the active workspace. JS-owned — the
  // macOS View menu keeps the five core views.
  { id: 'view-workspace-review', label: 'Go to Workspace Review', category: 'Navigation', defaultBinding: 'Mod+7', needsRepo: true },
  // Cycle the active repository. Tab isn't representable as a native-menu
  // accelerator, so these stay JS-owned (no `menu: true`).
  { id: 'tab-next', label: 'Next repository',     category: 'Navigation',  defaultBinding: 'Mod+Tab',       needsRepo: true },
  { id: 'tab-prev', label: 'Previous repository', category: 'Navigation',  defaultBinding: 'Mod+Shift+Tab', needsRepo: true },
  // Repo quick-switcher overlay. Not `needsRepo` — with nothing open it still
  // lists recents, so it doubles as a fast opener.
  { id: 'switch-repo', label: 'Switch repository…', category: 'Navigation', defaultBinding: 'Mod+E' },

  { id: 'fetch',  label: 'Fetch',                        category: 'Git', defaultBinding: 'Mod+Shift+Y', needsRepo: true },
  { id: 'pull',   label: 'Pull',                         category: 'Git', defaultBinding: 'Mod+Shift+P', menu: true, needsRepo: true },
  { id: 'push',   label: 'Push',                         category: 'Git', defaultBinding: 'Mod+P',       menu: true, needsRepo: true },
  { id: 'sync',   label: 'Sync (fetch + pull + push)',   category: 'Git', defaultBinding: 'Mod+Shift+S', menu: true, needsRepo: true },
  { id: 'suggest-commit', label: 'Suggest commit message', category: 'Git', defaultBinding: 'Mod+Shift+M', needsRepo: true },

  { id: 'open-editor',   label: 'Open in editor',        category: 'Repository', defaultBinding: 'Mod+Shift+E', needsRepo: true },
  { id: 'open-terminal', label: 'Open in terminal',      category: 'Repository', defaultBinding: 'Mod+Shift+C', needsRepo: true },
  { id: 'refresh',       label: 'Refresh',               category: 'Repository', defaultBinding: 'Mod+R',       needsRepo: true },

  { id: 'theme-toggle', label: 'Toggle light/dark theme', category: 'Appearance', defaultBinding: 'Mod+Shift+T', menu: true },
] as const;

export const CATEGORY_ORDER: readonly CommandCategory[] =
  ['General', 'Navigation', 'Git', 'Repository', 'Appearance'];

const COMMAND_BY_ID = new Map<CommandId, CommandDef>(COMMANDS.map((c) => [c.id, c]));

/** Commands whose accelerator the macOS native menu owns. */
export const MENU_COMMANDS: ReadonlySet<CommandId> = new Set(
  COMMANDS.filter((c) => c.menu).map((c) => c.id),
);
/** Commands the keydown handler must gate on an open repository. */
export const REPO_COMMANDS: ReadonlySet<CommandId> = new Set(
  COMMANDS.filter((c) => c.needsRepo).map((c) => c.id),
);

/** User-override map: command id → binding (or `null` to unbind). A missing
 * key falls back to the command's default. */
export type KeyOverrides = Partial<Record<CommandId, string | null>>;

/** Minimal shape of the parts of a KeyboardEvent we read — lets tests pass a
 * plain object without constructing a real event. */
export type KeyLike = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>;

/** Keys that are modifiers themselves — pressing one alone isn't a binding. */
const LONE_MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead']);

/**
 * Normalize a keyboard event into a canonical binding string, or `null` if the
 * event isn't a usable shortcut (a lone modifier press). Letters fold to
 * uppercase (case is carried by the explicit `Shift` token, so `Mod+P` and
 * `Mod+Shift+P` stay distinct regardless of the OS-reported key case).
 */
export function eventToBinding(e: KeyLike): string | null {
  if (LONE_MODIFIERS.has(e.key)) return null;
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  // `Mod` collapses ⌘ (mac) and Ctrl (win/linux) into one token.
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** True if a binding lacks the `Mod` modifier — a key that must be suppressed
 * while a text field is focused, so typing never triggers a shortcut. Only
 * `Mod+…` combos may act there: a Shift-modified key is a capital letter and
 * an Alt-modified key composes characters on many layouts. `Mod` is always
 * the first token of a canonical binding (see {@link eventToBinding}). */
export function isPlainKey(binding: string): boolean {
  return !binding.startsWith('Mod+');
}

/** Elements that own the keystrokes they receive — a keydown originating in
 * one must never be treated as a plain-key shortcut. */
export const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [role="combobox"]';

/** Structural slice of `Element` this module touches — duck-typed (no DOM
 * globals) so the file stays unit-testable in a node environment. */
interface ElementLike {
  matches?: (selector: string) => boolean;
  closest?: (selector: string) => unknown;
}

/** Minimal shape of the parts of an Event we read. */
export type EventLike = {
  target: unknown;
  composedPath?: () => unknown[];
};

/**
 * True if the event originated in (or inside) an element matching `selector`.
 * Walks `composedPath()` rather than `e.target.closest(...)`: a keydown from
 * inside a shadow root — e.g. Pierre's in-tree file-search box — is
 * *retargeted*, so window-level listeners see the shadow host as `target` and
 * a plain `closest` check never sees the inner `<input>`, letting shortcuts
 * steal keystrokes from it. Falls back to `closest` when the event has no
 * composed path (synthetic events in tests).
 */
export function eventInside(e: EventLike, selector: string): boolean {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  if (path.length > 0) {
    return path.some((n) => !!(n as ElementLike | null)?.matches?.(selector));
  }
  return !!(e.target as ElementLike | null)?.closest?.(selector);
}

export interface ResolvedBindings {
  /** binding string → command id (for keydown dispatch). When two commands
   * share a binding the *earlier* command in {@link COMMANDS} wins, so dispatch
   * stays deterministic; the Settings UI surfaces the clash separately. */
  byBinding: Map<string, CommandId>;
  /** command id → its effective binding (or `null` if unbound). */
  byCommand: Map<CommandId, string | null>;
}

/** Overlay user overrides on the defaults and build both lookup directions. */
export function resolveBindings(overrides: KeyOverrides = {}): ResolvedBindings {
  const byBinding = new Map<string, CommandId>();
  const byCommand = new Map<CommandId, string | null>();
  for (const cmd of COMMANDS) {
    const has = Object.prototype.hasOwnProperty.call(overrides, cmd.id);
    const binding = has ? overrides[cmd.id]! ?? null : cmd.defaultBinding;
    byCommand.set(cmd.id, binding);
    if (binding && !byBinding.has(binding)) byBinding.set(binding, cmd.id);
  }
  return { byBinding, byCommand };
}

/**
 * Return the set of command ids that share a binding with another command,
 * given the resolved per-command map — drives the Settings conflict warning.
 */
export function conflictingCommands(byCommand: Map<CommandId, string | null>): Set<CommandId> {
  const seen = new Map<string, CommandId[]>();
  for (const [id, binding] of byCommand) {
    if (!binding) continue;
    const list = seen.get(binding) ?? [];
    list.push(id);
    seen.set(binding, list);
  }
  const out = new Set<CommandId>();
  for (const list of seen.values()) {
    if (list.length > 1) for (const id of list) out.add(id);
  }
  return out;
}

export function commandDef(id: CommandId): CommandDef | undefined {
  return COMMAND_BY_ID.get(id);
}

const MAC_MOD: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥' };
const WIN_MOD: Record<string, string> = { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt' };
const MAC_KEY: Record<string, string> = {
  Enter: '↵', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: '␣',
};
const WIN_KEY: Record<string, string> = {
  Enter: 'Enter', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space',
};

/**
 * Render a binding for display. macOS uses glyphs joined tight (`⌘⇧P`); other
 * platforms use words joined with `+` (`Ctrl+Shift+P`).
 */
export function formatBinding(binding: string | null, platform: 'mac' | 'win11' | 'linux'): string {
  if (!binding) return '';
  const mac = platform === 'mac';
  const mods = mac ? MAC_MOD : WIN_MOD;
  const keys = mac ? MAC_KEY : WIN_KEY;
  const parts = binding.split('+').map((p) => mods[p] ?? keys[p] ?? p);
  return parts.join(mac ? '' : '+');
}

const MUDA_MOD: Record<string, string> = { Mod: 'CmdOrControl', Shift: 'Shift', Alt: 'Alt' };
const MUDA_KEY: Record<string, string> = { ',': 'Comma', '/': 'Slash', '.': 'Period' };

/**
 * Convert a binding to a muda accelerator string for the native menu, or
 * `null` if it can't be represented (the menu item then shows no accelerator
 * and the keydown handler keeps owning the combo). Covers the keys our menu
 * commands actually use (letters, digits, comma).
 */
export function toMudaAccelerator(binding: string | null): string | null {
  if (!binding) return null;
  const out: string[] = [];
  for (const p of binding.split('+')) {
    if (MUDA_MOD[p]) out.push(MUDA_MOD[p]);
    else if (MUDA_KEY[p]) out.push(MUDA_KEY[p]);
    else if (/^[A-Z0-9]$/.test(p)) out.push(p);
    else return null; // unrepresentable key — let the JS handler own it
  }
  return out.join('+');
}
