import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { KeyOverrides } from '../lib/keys';
import type { AiProvider, EmbeddedShellChoice } from '../lib/types';

/** A concrete theme that maps to a `[data-theme]` token set in tokens.css. */
export type Theme = 'dark' | 'light';
/** The user's stored preference: a concrete theme, or `system` to follow the
 * OS `prefers-color-scheme`. Resolved to a `Theme` by `lib/theme.ts`. */
export type ThemePref = Theme | 'system';
/** Accent color preset. Each id maps to an OKLCH hue via a `[data-accent]`
 * block in tokens.css; the registry lives in `lib/theme.ts` (`ACCENT_OPTIONS`). */
export type AccentId = 'amber' | 'rose' | 'magenta' | 'violet' | 'blue' | 'cyan' | 'teal' | 'green';
export type Platform = 'mac' | 'win11' | 'linux';
export type Density = 'compact' | 'default' | 'relaxed';
export type DiffMode = 'stacked' | 'split';
export type GraphStyle = 'classic' | 'bold' | 'mono';
/** Repository space shown after Strand launches. */
export type StartupSpace = 'work' | 'local' | 'review' | 'pull-requests' | 'commits';
/** How open repositories are presented: a vertical icon rail down the left
 * edge (default), or a horizontal tab strip in the toolbar. */
export type RepoNav = 'rail' | 'tabs';

export type UiFont = 'geist' | 'inter' | 'iaq' | 'system';
export type MonoFont = 'jetbrains' | 'geist' | 'plex' | 'commit' | 'sfmono';
export type TerminalFont = 'jetbrains' | 'geist' | 'plex' | 'commit' | 'system';
export type OpenAiModel = 'gpt-5.6-luna' | 'gpt-5.6-terra' | 'gpt-5.6-sol';
export type AnthropicModel = 'claude-haiku-4-5' | 'claude-sonnet-5' | 'claude-opus-4-8';

/** Last explicitly checked CLI connection state. Credentials remain owned by
 * the vendor CLI; this snapshot only lets Settings reflect that saved login. */
export interface AiConnectionSnapshot {
  installed: boolean;
  loggedIn: boolean;
  checkedAt: number;
}

/** Pierre's change-marker style: `classic` = +/− signs, `bars` = colored
 * edge bars (Pierre's default), `none` = background tint only. */
export type DiffIndicators = 'classic' | 'bars' | 'none';

/** Which tab the file view opens on for renderable files (SVG / markdown):
 * the rendered preview or the raw source. Non-renderable files always open
 * on Content. */
export type FileOpenTab = 'preview' | 'content';

/** An external app integration (editor / terminal): a preset from
 * `lib/integrations.ts`, a custom command template, or unconfigured. */
export type ExternalTool =
  | { kind: 'preset'; id: string }
  | { kind: 'custom'; template: string }
  | null;

/** The concrete theme already applied to `<html>` by the pre-paint inline
 * script in index.html — the exact (pref + OS) resolution, with no second
 * computation here. `useTheme` keeps it in sync from React's first commit. */
function initialResolvedTheme(): Theme {
  if (typeof document !== 'undefined') {
    const t = document.documentElement.dataset.theme;
    if (t === 'light' || t === 'dark') return t;
  }
  return 'dark';
}

function detectPlatform(): Platform {
  // Tauri OS plugin injects this global before JS runs
  const internals = (window as unknown as { __TAURI_OS_PLUGIN_INTERNALS__?: { os_type: string } })
    .__TAURI_OS_PLUGIN_INTERNALS__;
  if (internals?.os_type === 'windows') return 'win11';
  if (internals?.os_type === 'macos') return 'mac';
  if (internals?.os_type === 'linux') return 'linux';

  // Fallback for browser mode
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'win11';
  if (ua.includes('linux')) return 'linux';
  return 'mac';
}

export interface SettingsState {
  /** Theme *preference* (dark / light / system). The resolved concrete theme
   * driving `[data-theme]` is computed in `lib/theme.ts` (`useTheme`). */
  theme: ThemePref;
  /** Resolved concrete theme (`theme` collapsed against the OS). Runtime-only,
   * not persisted; written by `useTheme`, read by anything that needs the live
   * concrete theme without its own OS subscription (e.g. Pierre diff theming). */
  resolvedTheme: Theme;
  /** Accent color preset, applied via `[data-accent]` on `<html>` (a hue
   * rotation over the accent tokens). Works across light + dark. */
  accent: AccentId;
  platform: Platform;
  density: Density;
  /** Repository space shown after Strand launches. */
  startupSpace: StartupSpace;
  /** Open-repository presentation — vertical rail vs. horizontal tabs. */
  repoNav: RepoNav;
  /** Whole-UI zoom factor (1 = 100%). Driven by the Ctrl/⌘ +/− shortcuts and
   * applied as CSS `zoom` on `<html>` in App. Persisted across launches. */
  zoom: number;
  diffMode: DiffMode;
  /** Whether the Local Changes diff pane shows file diffs collapsed (headers
   * only). A session-only view toggle — not persisted across launches. */
  diffsCollapsed: boolean;
  /** Whether the All Commits graph shows the vertical activity-timeline rail
   * (a commit-density histogram + scrubber down the right edge). */
  showTimeline: boolean;
  graphStyle: GraphStyle;
  uiFont: UiFont;
  monoFont: MonoFont;
  /** Diff layout used for repos with no per-repo override (the header toggle
   * writes a per-repo row; see `repo.ts` `loadRepoDiffMode`). */
  defaultDiffLayout: DiffMode;
  /** Font for diff/code panes; `inherit` follows `monoFont`. */
  diffFont: MonoFont | 'inherit';
  diffLineNumbers: boolean;
  diffIndicators: DiffIndicators;
  /** Intra-line (word-level) change emphasis in diffs. */
  diffWordHighlight: boolean;
  /** Initial file-view tab for renderable files (see {@link FileOpenTab}). */
  fileOpenTab: FileOpenTab;
  /** Directory the clone dialog and open-repo picker start in. */
  defaultCloneDir: string | null;
  editorTool: ExternalTool;
  terminalTool: ExternalTool;
  /** Global shell used by Work terminals; a repository-family override may
   * replace it through the generic settings table. */
  embeddedShell: EmbeddedShellChoice;
  /** Font family and pixel size used only by Work terminal renderers. */
  terminalFont: TerminalFont;
  terminalFontSize: number;
  /** Default AI provider for writing suggestions. */
  aiProvider: AiProvider;
  /** Codex model used for commit-message and pull-request writing. */
  openaiModel: OpenAiModel;
  /** Claude model used for commit-message and pull-request writing. */
  anthropicModel: AnthropicModel;
  /** Last checked connection state for each vendor CLI. */
  aiConnectionStatus: Record<AiProvider, AiConnectionSnapshot | null>;
  /** Optional override path to the Codex CLI binary. */
  openaiCli: string | null;
  /** Optional override path to the Claude Code CLI binary. */
  anthropicCli: string | null;
  updateAutoCheck: boolean;
  updateAutoInstall: boolean;
  /** Opt-in (off by default): after a crash, offer to report it on the next
   * launch. Reporting opens a prefilled GitHub issue in the browser for the
   * user to review and submit — Strand never uploads anything itself. */
  crashPrompt: boolean;
  /** Byte offset into `crash.log` the user has already been prompted about
   * (report or dismiss both acknowledge). Entries past it are "new". */
  crashAck: number;
  /** Per-command keyboard-shortcut overrides. A missing key uses the command's
   * default from `lib/keys.ts`; a `null` value means the command is unbound.
   * Resolved by `resolveBindings`. */
  keybindings: KeyOverrides;
  set: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  /** Set (or, with `null`, unbind / with `undefined`, reset to default) the
   * binding for one command. */
  setKeybinding: (id: keyof KeyOverrides, binding: string | null | undefined) => void;
  /** Clear every override, restoring all commands to their defaults. */
  resetKeybindings: () => void;
}

export const FONTS = {
  ui: {
    geist:  "'Geist', -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
    inter:  "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    iaq:    "'IBM Plex Sans', sans-serif",
    system: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
  } satisfies Record<UiFont, string>,
  mono: {
    jetbrains: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
    geist:     "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace",
    plex:      "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
    commit:    "'Commit Mono', ui-monospace, 'SF Mono', Menlo, monospace",
    sfmono:    "ui-monospace, 'SF Mono', Menlo, monospace",
  } satisfies Record<MonoFont, string>,
};

export const TERMINAL_FONTS = {
  jetbrains: "'JetBrains Mono Terminal', 'JetBrains Mono', ui-monospace, monospace",
  geist: "'Geist Mono', 'JetBrains Mono Terminal', ui-monospace, monospace",
  plex: "'IBM Plex Mono', 'JetBrains Mono Terminal', ui-monospace, monospace",
  commit: "'Commit Mono', 'JetBrains Mono Terminal', ui-monospace, monospace",
  system: "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'JetBrains Mono Terminal', monospace",
} satisfies Record<TerminalFont, string>;

/** Picker registries — bundled fonts only (the app ships these families;
 * arbitrary system fonts would render fallbacks unpredictably). */
export const UI_FONT_OPTIONS: { id: UiFont; label: string }[] = [
  { id: 'geist', label: 'Geist' },
  { id: 'inter', label: 'Inter' },
  { id: 'iaq', label: 'IBM Plex Sans' },
  { id: 'system', label: 'System' },
];

export const MONO_FONT_OPTIONS: { id: MonoFont; label: string }[] = [
  { id: 'jetbrains', label: 'JetBrains Mono' },
  { id: 'geist', label: 'Geist Mono' },
  { id: 'plex', label: 'IBM Plex Mono' },
  { id: 'commit', label: 'Commit Mono' },
  { id: 'sfmono', label: 'SF Mono / system' },
];

export const TERMINAL_FONT_OPTIONS: { id: TerminalFont; label: string }[] = [
  { id: 'jetbrains', label: 'JetBrains Mono' },
  { id: 'geist', label: 'Geist Mono' },
  { id: 'plex', label: 'IBM Plex Mono' },
  { id: 'commit', label: 'Commit Mono' },
  { id: 'system', label: 'System monospace' },
];

export const DENSITY_OPTIONS: { id: Density; label: string }[] = [
  { id: 'compact', label: 'Compact' },
  { id: 'default', label: 'Default' },
  { id: 'relaxed', label: 'Relaxed' },
];

export const REPO_NAV_OPTIONS: { id: RepoNav; label: string }[] = [
  { id: 'rail', label: 'Sidebar' },
  { id: 'tabs', label: 'Tabs' },
];

export const STARTUP_SPACE_OPTIONS: { id: StartupSpace; label: string }[] = [
  { id: 'work', label: 'Work' },
  { id: 'local', label: 'Local Changes' },
  { id: 'review', label: 'Review' },
  { id: 'pull-requests', label: 'Pull Requests' },
  { id: 'commits', label: 'All Commits' },
];

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      resolvedTheme: initialResolvedTheme(),
      accent: 'amber',
      platform: detectPlatform(),
      density: 'default',
      startupSpace: 'work',
      repoNav: 'tabs',
      zoom: 1,
      diffMode: 'stacked',
      diffsCollapsed: false,
      showTimeline: true,
      graphStyle: 'classic',
      uiFont: 'geist',
      monoFont: 'jetbrains',
      defaultDiffLayout: 'stacked',
      diffFont: 'inherit',
      diffLineNumbers: true,
      diffIndicators: 'bars',
      diffWordHighlight: true,
      fileOpenTab: 'preview',
      defaultCloneDir: null,
      editorTool: null,
      terminalTool: null,
      embeddedShell: { kind: 'system' },
      terminalFont: 'jetbrains',
      terminalFontSize: 16,
      aiProvider: 'openai',
      openaiModel: 'gpt-5.6-luna',
      anthropicModel: 'claude-sonnet-5',
      aiConnectionStatus: { openai: null, anthropic: null },
      openaiCli: null,
      anthropicCli: null,
      updateAutoCheck: true,
      updateAutoInstall: false,
      crashPrompt: false,
      crashAck: 0,
      keybindings: {},
      set: (key, value) => set({ [key]: value } as Partial<SettingsState>),
      setKeybinding: (id, binding) =>
        set((s) => {
          const next = { ...s.keybindings };
          // `undefined` removes the override (back to default); anything else
          // (a binding string or `null` to unbind) is stored explicitly.
          if (binding === undefined) delete next[id];
          else next[id] = binding;
          return { keybindings: next };
        }),
      resetKeybindings: () => set({ keybindings: {} }),
    }),
    {
      name: 'strand.settings',
      partialize: (state) => {
        // `resolvedTheme` is derived at runtime; `platform` is re-detected;
        // `diffsCollapsed` is a session-only view toggle — none persist.
        const { platform, diffsCollapsed, resolvedTheme, ...rest } = state;
        return rest;
      },
      merge: (persisted, current) => {
        const next = { ...current, ...(persisted as Partial<SettingsState>) };
        const terminalFont = TERMINAL_FONT_OPTIONS.some((option) => option.id === next.terminalFont)
          ? next.terminalFont
          : current.terminalFont;
        const storedSize = Number(next.terminalFontSize);
        return {
          ...next,
          platform: detectPlatform(),
          terminalFont,
          terminalFontSize: Number.isFinite(storedSize)
            ? Math.min(32, Math.max(10, Math.round(storedSize)))
            : current.terminalFontSize,
        };
      },
    },
  ),
);
