import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
  type MenuItemOptions,
} from '@tauri-apps/api/menu';

/**
 * Native macOS menubar, wired to the same callbacks the in-app UI uses.
 * macOS only — Windows/Linux get an in-window menubar later (PRD §7,
 * tracked in TASKS).
 *
 * On macOS, menu accelerators are NSMenuItem key equivalents: AppKit
 * dispatches them through the menu *before* the webview sees the keydown,
 * so the menu action — not App's global key handler — runs. App's handler
 * additionally skips menu-owned combos while `appMenuInstalled()` is true,
 * so behavior is single-fire regardless of dispatch order.
 *
 * Repo-scoped items (views, sync, editor/terminal) are disabled with no
 * repo open; App reinstalls the menu when that flips.
 */

export type MenuViewId = 'local' | 'commits' | 'reflog' | 'review' | 'worktrees';

export interface MenuHandlers {
  openRepo(): void;
  cloneRepo(): void;
  openSettings(): void;
  checkUpdates(): void;
  openPalette(): void;
  showView(view: MenuViewId): void;
  cycleTheme(): void;
  sync(): void;
  pull(): void;
  push(): void;
  openInEditor(): void;
  openInTerminal(): void;
}

let installed = false;

/** True once the native menu owns its accelerators (App's keydown handler
 * uses this to skip menu-owned combos). */
export function appMenuInstalled(): boolean {
  return installed;
}

export async function installAppMenu(
  handlers: () => MenuHandlers,
  hasRepo: boolean,
): Promise<void> {
  const sep = () => PredefinedMenuItem.new({ item: 'Separator' });
  const item = (opts: MenuItemOptions) => MenuItem.new(opts);

  const appMenu = await Submenu.new({
    text: 'Strand',
    items: [
      await PredefinedMenuItem.new({ item: { About: { name: 'Strand' } }, text: 'About Strand' }),
      await sep(),
      await item({
        id: 'settings',
        text: 'Settings…',
        accelerator: 'Cmd+Comma',
        action: () => handlers().openSettings(),
      }),
      await item({
        id: 'check-updates',
        text: 'Check for Updates…',
        action: () => handlers().checkUpdates(),
      }),
      await sep(),
      await PredefinedMenuItem.new({ item: 'Services' }),
      await sep(),
      await PredefinedMenuItem.new({ item: 'Hide', text: 'Hide Strand' }),
      await PredefinedMenuItem.new({ item: 'HideOthers' }),
      await PredefinedMenuItem.new({ item: 'ShowAll' }),
      await sep(),
      await PredefinedMenuItem.new({ item: 'Quit', text: 'Quit Strand' }),
    ],
  });

  const fileMenu = await Submenu.new({
    text: 'File',
    items: [
      await item({
        id: 'open-repo',
        text: 'Open Repository…',
        accelerator: 'Cmd+O',
        action: () => handlers().openRepo(),
      }),
      await item({
        id: 'clone-repo',
        text: 'Clone Repository…',
        action: () => handlers().cloneRepo(),
      }),
      await sep(),
      await PredefinedMenuItem.new({ item: 'CloseWindow' }),
    ],
  });

  // Standard clipboard items so ⌘C/⌘V/etc. behave natively in text fields.
  const editMenu = await Submenu.new({
    text: 'Edit',
    items: [
      await PredefinedMenuItem.new({ item: 'Undo' }),
      await PredefinedMenuItem.new({ item: 'Redo' }),
      await sep(),
      await PredefinedMenuItem.new({ item: 'Cut' }),
      await PredefinedMenuItem.new({ item: 'Copy' }),
      await PredefinedMenuItem.new({ item: 'Paste' }),
      await PredefinedMenuItem.new({ item: 'SelectAll' }),
    ],
  });

  const views: { id: MenuViewId; text: string; key: string }[] = [
    { id: 'local', text: 'Local Changes', key: 'Cmd+1' },
    { id: 'commits', text: 'All Commits', key: 'Cmd+2' },
    { id: 'reflog', text: 'Reflog', key: 'Cmd+3' },
    { id: 'review', text: 'Review', key: 'Cmd+4' },
    { id: 'worktrees', text: 'Worktrees', key: 'Cmd+5' },
  ];
  const viewMenu = await Submenu.new({
    text: 'View',
    items: [
      await item({
        id: 'palette',
        text: 'Command Palette…',
        accelerator: 'Cmd+K',
        action: () => handlers().openPalette(),
      }),
      await sep(),
      ...(await Promise.all(
        views.map((v) =>
          item({
            id: `view-${v.id}`,
            text: v.text,
            accelerator: v.key,
            enabled: hasRepo,
            action: () => handlers().showView(v.id),
          }),
        ),
      )),
      await sep(),
      await item({
        id: 'cycle-theme',
        text: 'Toggle Light/Dark Theme',
        accelerator: 'Cmd+Shift+T',
        action: () => handlers().cycleTheme(),
      }),
    ],
  });

  const repoMenu = await Submenu.new({
    text: 'Repository',
    items: [
      await item({
        id: 'sync',
        text: 'Sync (Fetch + Pull + Push)',
        accelerator: 'Cmd+Shift+S',
        enabled: hasRepo,
        action: () => handlers().sync(),
      }),
      await item({ id: 'pull', text: 'Pull', enabled: hasRepo, action: () => handlers().pull() }),
      await item({ id: 'push', text: 'Push', enabled: hasRepo, action: () => handlers().push() }),
      await sep(),
      await item({
        id: 'open-editor',
        text: 'Open in Editor',
        enabled: hasRepo,
        action: () => handlers().openInEditor(),
      }),
      await item({
        id: 'open-terminal',
        text: 'Open in Terminal',
        enabled: hasRepo,
        action: () => handlers().openInTerminal(),
      }),
    ],
  });

  const windowMenu = await Submenu.new({
    text: 'Window',
    items: [
      await PredefinedMenuItem.new({ item: 'Minimize' }),
      await PredefinedMenuItem.new({ item: 'Maximize', text: 'Zoom' }),
      await sep(),
      await PredefinedMenuItem.new({ item: 'Fullscreen' }),
    ],
  });

  const menu = await Menu.new({
    items: [appMenu, fileMenu, editMenu, viewMenu, repoMenu, windowMenu],
  });
  await menu.setAsAppMenu();
  installed = true;
}
