import type { ExternalTool } from '../stores/settings';

/**
 * External editor / terminal integrations (Settings → Integrations).
 *
 * A tool is either a preset from the per-platform lists below or a custom
 * command template. Templates use `{file}` / `{line}` / `{dir}` placeholders;
 * `strand-core::external` tokenizes the template *before* substituting, so
 * paths with spaces or shell metacharacters can never inject arguments.
 *
 * macOS editor presets use the editors' CLI shims (`code`, `zed`, …) because
 * `open -a` can't pass file:line. A missing shim surfaces as a friendly
 * "not found on PATH" error from the backend.
 */

export type OsType = 'macos' | 'windows' | 'linux';

/** The raw OS, distinct from the settings store's `platform` (which collapses
 * to mac/win11 purely to drive window-chrome CSS). */
export function osType(): OsType {
  const internals = (window as unknown as { __TAURI_OS_PLUGIN_INTERNALS__?: { os_type: string } })
    .__TAURI_OS_PLUGIN_INTERNALS__;
  if (internals?.os_type === 'windows') return 'windows';
  if (internals?.os_type === 'linux') return 'linux';
  if (internals?.os_type === 'macos') return 'macos';
  // Browser-mode fallback.
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return 'macos';
}

export interface AppPreset {
  id: string;
  label: string;
  template: string;
}

const EDITORS: Record<OsType, AppPreset[]> = {
  macos: [
    { id: 'vscode', label: 'Visual Studio Code', template: 'code -g {file}:{line}' },
    { id: 'cursor', label: 'Cursor', template: 'cursor -g {file}:{line}' },
    { id: 'zed', label: 'Zed', template: 'zed {file}:{line}' },
    { id: 'sublime', label: 'Sublime Text', template: 'subl {file}:{line}' },
  ],
  windows: [
    // std::process::Command doesn't apply PATHEXT, so the .cmd shims are
    // named explicitly (Rust ≥1.77 quotes .cmd args safely — BatBadBut).
    { id: 'vscode', label: 'Visual Studio Code', template: 'code.cmd -g {file}:{line}' },
    { id: 'cursor', label: 'Cursor', template: 'cursor.cmd -g {file}:{line}' },
    { id: 'sublime', label: 'Sublime Text', template: 'subl {file}:{line}' },
  ],
  linux: [
    { id: 'vscode', label: 'Visual Studio Code', template: 'code -g {file}:{line}' },
    { id: 'cursor', label: 'Cursor', template: 'cursor -g {file}:{line}' },
    { id: 'zed', label: 'Zed', template: 'zed {file}:{line}' },
    { id: 'sublime', label: 'Sublime Text', template: 'subl {file}:{line}' },
  ],
};

const TERMINALS: Record<OsType, AppPreset[]> = {
  macos: [
    { id: 'terminal', label: 'Terminal', template: 'open -a Terminal {dir}' },
    { id: 'iterm', label: 'iTerm2', template: 'open -a iTerm {dir}' },
    { id: 'warp', label: 'Warp', template: 'open -a Warp {dir}' },
    { id: 'ghostty', label: 'Ghostty', template: 'open -a Ghostty {dir}' },
  ],
  windows: [
    { id: 'wt', label: 'Windows Terminal', template: 'wt -d {dir}' },
    { id: 'cmd', label: 'Command Prompt', template: 'cmd /K cd /d {dir}' },
  ],
  linux: [
    { id: 'gnome', label: 'GNOME Terminal', template: 'gnome-terminal --working-directory={dir}' },
    { id: 'konsole', label: 'Konsole', template: 'konsole --workdir {dir}' },
    { id: 'alacritty', label: 'Alacritty', template: 'alacritty --working-directory {dir}' },
    { id: 'kitty', label: 'kitty', template: 'kitty -d {dir}' },
  ],
};

export function editorPresets(os: OsType = osType()): AppPreset[] {
  return EDITORS[os];
}

export function terminalPresets(os: OsType = osType()): AppPreset[] {
  return TERMINALS[os];
}

/** The launch template for a configured tool, or `null` when unconfigured /
 * the stored preset id no longer exists on this platform. */
export function resolveTemplate(tool: ExternalTool, presets: AppPreset[]): string | null {
  if (!tool) return null;
  if (tool.kind === 'custom') return tool.template.trim() || null;
  return presets.find((p) => p.id === tool.id)?.template ?? null;
}

export function editorTemplate(tool: ExternalTool): string | null {
  return resolveTemplate(tool, editorPresets());
}

export function terminalTemplate(tool: ExternalTool): string | null {
  return resolveTemplate(tool, terminalPresets());
}
