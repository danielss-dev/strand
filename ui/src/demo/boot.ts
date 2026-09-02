/**
 * Web-demo bootstrap. Installs Tauri's official IPC mock so the unmodified
 * app talks to the in-browser demo backend: `strand-tauri` commands go to
 * `dispatch.ts`, the SQLite settings store becomes an in-memory table, and
 * desktop-only plugins (shell, dialog, updater, menu, …) get harmless stubs.
 *
 * Imported by `main.tsx` only when `VITE_DEMO` is set; the module is never
 * part of a desktop build.
 */

import { mockConvertFileSrc, mockIPC, mockWindows } from '@tauri-apps/api/mocks';

import { useRepo, type View } from '../stores/repo';
import { MAIN_PATH } from './fixtures';
import { dispatch } from './dispatch';

type Args = Record<string, unknown>;

// ---- deep links from the landing page ---------------------------------------

const LINKABLE_VIEWS: ReadonlySet<View> = new Set<View>([
  'work', 'local', 'commits', 'reflog', 'review', 'worktrees', 'pull-requests',
]);

function showView(raw: unknown): void {
  if (typeof raw === 'string' && LINKABLE_VIEWS.has(raw as View)) useRepo.getState().setView(raw as View);
}

/** `?view=review` on first load; `postMessage({ type: 'strand-demo:view', view })`
 * from the embedding page afterwards, so "See it in the demo" links switch
 * surfaces without reloading the app. */
function installDeepLinks(): void {
  showView(new URLSearchParams(window.location.search).get('view') ?? 'review');
  window.addEventListener('message', (event: MessageEvent<{ type?: string; view?: string }>) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'strand-demo:view') showView(event.data.view);
  });
}

// ---- plugin:sql — the six statements `lib/db.ts` issues -------------------

const settingsTable = new Map<string, string>();
const recentRepos = new Map<string, { name: string; last_opened: number }>();

function seedSettings(): void {
  const put = (key: string, value: unknown) => settingsTable.set(key, JSON.stringify(value));
  put('session.tabs', { tabs: [MAIN_PATH], activeTabPath: MAIN_PATH });
  recentRepos.set(MAIN_PATH, { name: 'acme-api', last_opened: Math.floor(Date.now() / 1000) - 3600 });
}

function sqlSelect(query: string, values: unknown[]): unknown[] {
  if (/FROM settings WHERE key/i.test(query)) {
    const value = settingsTable.get(String(values[0]));
    return value == null ? [] : [{ value }];
  }
  if (/FROM recent_repos/i.test(query)) {
    return [...recentRepos.entries()]
      .map(([path, r]) => ({ path, name: r.name, last_opened: r.last_opened }))
      .sort((a, b) => b.last_opened - a.last_opened)
      .slice(0, Number(values[0] ?? 20));
  }
  return [];
}

function sqlExecute(query: string, values: unknown[]): [number, number] {
  if (/INSERT INTO settings/i.test(query)) { settingsTable.set(String(values[0]), String(values[1])); return [1, 0]; }
  if (/DELETE FROM settings/i.test(query)) { settingsTable.delete(String(values[0])); return [1, 0]; }
  if (/INSERT INTO recent_repos/i.test(query)) {
    recentRepos.set(String(values[0]), { name: String(values[1]), last_opened: Number(values[2]) });
    return [1, 0];
  }
  if (/DELETE FROM recent_repos/i.test(query)) { recentRepos.delete(String(values[0])); return [1, 0]; }
  return [0, 0];
}

// ---- other plugins ---------------------------------------------------------

const unknownCommands = new Set<string>();

function pluginCommand(cmd: string, args: Args): unknown {
  const [plugin, action] = cmd.slice('plugin:'.length).split('|');
  switch (plugin) {
    case 'sql':
      if (action === 'load') return 'sqlite:demo.db';
      if (action === 'select') return sqlSelect(String(args.query), (args.values as unknown[]) ?? []);
      if (action === 'execute') return sqlExecute(String(args.query), (args.values as unknown[]) ?? []);
      return true;
    case 'app':
      if (action === 'version') return '1.5.1';
      if (action === 'name') return 'Strand';
      if (action === 'tauri_version') return '2.9.0';
      return null;
    case 'shell':
      if (action === 'open') { window.open(String(args.path), '_blank', 'noopener'); return null; }
      throw { message: 'Spawning processes is not available in the web demo.' };
    case 'dialog':
      if (action === 'ask' || action === 'confirm') return window.confirm(String(args.message));
      if (action === 'message') return null;
      // open/save: behave like a cancelled picker.
      return null;
    case 'notification':
      // Report "granted" so the PR monitor doesn't park a permissions banner
      // over the PR tabs; `notify` itself is a no-op in a browser tab.
      if (action === 'is_permission_granted') return true;
      if (action === 'request_permission') return 'granted';
      return null;
    case 'updater':
      return null;
    case 'process':
      if (action === 'restart') window.location.reload();
      return null;
    case 'menu':
      // No native menu bar in a browser tab. Rejecting keeps the app's keydown
      // shortcut path active (`nativeMenuPreemptsKeydown` stays false).
      throw { message: 'no native menu in the web demo' };
    case 'window':
      if (action === 'is_maximized' || action === 'is_fullscreen' || action === 'is_minimized') return false;
      if (action === 'is_focused' || action === 'is_visible' || action === 'is_decorated' || action === 'is_resizable') return true;
      if (action === 'scale_factor') return window.devicePixelRatio;
      if (action === 'inner_size' || action === 'outer_size') return { width: window.innerWidth, height: window.innerHeight };
      if (action === 'inner_position' || action === 'outer_position') return { x: 0, y: 0 };
      if (action === 'theme') return document.documentElement.dataset.theme ?? 'dark';
      return null;
    case 'webview':
    case 'resources':
    case 'path':
    case 'os':
      return null;
    default:
      if (!unknownCommands.has(cmd)) {
        unknownCommands.add(cmd);
        console.info(`[demo] unhandled plugin command ${cmd}`);
      }
      return null;
  }
}

export function installDemoBackend(): void {
  mockWindows('main');
  mockConvertFileSrc('macos');
  seedSettings();
  mockIPC(async (cmd, payload) => {
    const args = (payload ?? {}) as Args;
    if (cmd.startsWith('plugin:')) return pluginCommand(cmd, args);
    return dispatch(cmd, args);
  }, { shouldMockEvents: true });
  installDeepLinks();
  document.documentElement.dataset.demo = '';
  document.title = 'Strand — live demo';
}
