import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
  type MenuItemOptions,
} from '@tauri-apps/api/menu';

import type { CommandId } from './keys';
import { t } from './i18n';

/**
 * Native desktop menu, wired to the same callbacks the in-app UI uses. Tauri
 * renders it in the global menubar on macOS and inside the window on Windows
 * and Linux.
 *
 * On macOS, menu accelerators are NSMenuItem key equivalents: AppKit
 * dispatches them through the menu *before* the webview sees the keydown,
 * so the menu action — not App's global key handler — runs. Windows and Linux
 * keep the webview keydown path; their window menus still display the resolved
 * accelerator and invoke the same action when selected.
 *
 * Repo-scoped items (views, sync, editor/terminal) are disabled with no
 * repo open; App reinstalls the menu when that flips.
 *
 * Accelerators are not hardcoded here — they come from the resolved keybinding
 * registry via the `accel` resolver, so a shortcut the user remaps in Settings
 * shows (and fires) consistently on the menu. App reinstalls the menu when the
 * keybindings change. A binding that can't be represented as a muda accelerator
 * yields `undefined`, so the menu shows none and the JS keydown handler keeps
 * owning that combo.
 */

export type MenuViewId = 'work' | 'local' | 'commits' | 'reflog' | 'review' | 'worktrees';

export interface MenuHandlers {
  openRepo(): void;
  cloneRepo(): void;
  openSettings(): void;
  checkUpdates(): void;
  openPalette(): void;
  showView(view: MenuViewId): void;
  customizeWorkbench(): void;
  cycleTheme(): void;
  toggleSidebar(): void;
  sync(): void;
  pull(): void;
  push(): void;
  openInEditor(): void;
  openInTerminal(): void;
  openInterchange(): void;
  openBisect(): void;
}

let preemptsKeydown = false;

/** True when the platform menu dispatches accelerators before webview keydown. */
export function nativeMenuPreemptsKeydown(): boolean {
  return preemptsKeydown;
}

/** Resolve a command's muda accelerator string (or `undefined`). */
export type AccelResolver = (id: CommandId) => string | undefined;
export type MenuPlatform = 'macos' | 'windows' | 'linux';

export async function installAppMenu(
  handlers: () => MenuHandlers,
  hasRepo: boolean,
  accel: AccelResolver,
  platform: MenuPlatform,
): Promise<void> {
  const sep = () => PredefinedMenuItem.new({ item: 'Separator' });
  // muda rejects `accelerator: undefined`? It accepts an omitted key, so only
  // include the field when we have a string.
  const item = (opts: MenuItemOptions & { cmd?: CommandId }) => {
    const { cmd, ...rest } = opts;
    const a = cmd ? accel(cmd) : undefined;
    return MenuItem.new(a ? { ...rest, accelerator: a } : rest);
  };

  const appItems = [
    await PredefinedMenuItem.new({ item: { About: { name: 'Strand' } }, text: 'About Strand' }),
    await sep(),
    await item({
      id: 'settings',
      text: 'Settings…',
      cmd: 'settings',
      action: () => handlers().openSettings(),
    }),
    await item({
      id: 'check-updates',
      text: 'Check for Updates…',
      action: () => handlers().checkUpdates(),
    }),
  ];
  if (platform === 'macos') {
    appItems.push(
      await sep(),
      await PredefinedMenuItem.new({ item: 'Services' }),
      await sep(),
      await PredefinedMenuItem.new({ item: 'Hide', text: 'Hide Strand' }),
      await PredefinedMenuItem.new({ item: 'HideOthers' }),
      await PredefinedMenuItem.new({ item: 'ShowAll' }),
    );
  }
  appItems.push(
    await sep(),
    await PredefinedMenuItem.new({ item: 'Quit', text: 'Quit Strand' }),
  );
  const appMenu = await Submenu.new({ text: 'Strand', items: appItems });

  const fileMenu = await Submenu.new({
    text: 'File',
    items: [
      await item({
        id: 'open-repo',
        text: 'Open Repository…',
        cmd: 'open-repo',
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

  const views: { id: MenuViewId; text: string; cmd: CommandId }[] = [
    { id: 'work', text: t('nav.workbench'), cmd: 'view-work' },
    { id: 'local', text: 'Local Changes', cmd: 'view-local' },
    { id: 'commits', text: 'All Commits', cmd: 'view-commits' },
    { id: 'reflog', text: 'Reflog', cmd: 'view-reflog' },
    { id: 'review', text: 'Review', cmd: 'view-review' },
    { id: 'worktrees', text: 'Worktrees', cmd: 'view-worktrees' },
  ];
  const viewMenu = await Submenu.new({
    text: 'View',
    items: [
      await item({
        id: 'palette',
        text: 'Command Palette…',
        cmd: 'palette',
        action: () => handlers().openPalette(),
      }),
      await sep(),
      ...(await Promise.all(
        views.map((v) =>
          item({
            id: `view-${v.id}`,
            text: v.text,
            cmd: v.cmd,
            enabled: hasRepo,
            action: () => handlers().showView(v.id),
          }),
        ),
      )),
      await item({
        id: 'customize-workbench',
        text: t('workbench.customizeEllipsis'),
        cmd: 'customize-workbench',
        enabled: hasRepo,
        action: () => handlers().customizeWorkbench(),
      }),
      await sep(),
      await item({
        id: 'cycle-theme',
        text: 'Toggle Light/Dark Theme',
        cmd: 'theme-toggle',
        action: () => handlers().cycleTheme(),
      }),
      await item({
        id: 'toggle-sidebar',
        text: 'Toggle Sidebar',
        cmd: 'toggle-sidebar',
        action: () => handlers().toggleSidebar(),
      }),
    ],
  });

  const repoMenu = await Submenu.new({
    text: 'Repository',
    items: [
      await item({ id: 'git-interchange', text: 'Patches, Mailboxes & Bundles…', enabled: hasRepo, action: () => handlers().openInterchange() }),
      await item({ id: 'git-bisect', text: 'Guided Bisect…', enabled: hasRepo, action: () => handlers().openBisect() }),
      await item({
        id: 'sync',
        text: 'Sync (Fetch + Pull + Push)',
        cmd: 'sync',
        enabled: hasRepo,
        action: () => handlers().sync(),
      }),
      await item({ id: 'pull', text: 'Pull', cmd: 'pull', enabled: hasRepo, action: () => handlers().pull() }),
      await item({ id: 'push', text: 'Push', cmd: 'push', enabled: hasRepo, action: () => handlers().push() }),
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
  preemptsKeydown = platform === 'macos';
}
