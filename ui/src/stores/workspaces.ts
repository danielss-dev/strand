import { create } from 'zustand';

import {
  dirnameOf,
  parseCodeWorkspace,
  resolveWorkspaceFolder,
  workspaceNameFromFile,
} from '../lib/codeWorkspace';
import { recents as recentsDb, workspacesDb } from '../lib/db';
import { pathKey, repoFamilyName, workspaceMemberSet } from '../lib/repoIdentity';
import { DEFAULT_WORKSPACE_ID } from '../lib/workspaceIdentity';
import { tauri } from '../lib/tauri';
import { t } from '../lib/i18n';
import type { Workspace } from '../lib/types';
import { useRepo, type RepoTab } from './repo';
import { useWork } from './work';

/**
 * The implicit "Default" workspace — the view you get with no named workspace
 * open. It's a real {@link Workspace} entry (so it has its own membership and
 * behaves like any other), just reserved: not renamable, not deletable, and
 * kept out of the named-workspace list. Active-default is stored as
 * `activeWorkspaceId === null`; this id resolves it in the list.
 */
export { DEFAULT_WORKSPACE_ID } from '../lib/workspaceIdentity';

/**
 * # Model
 *
 * A workspace is a named set of main-repo paths. The open tab set stays
 * global; the active workspace only *filters* what the rail/strip show —
 * non-members stay open but hidden, so switching never destroys session
 * state. Membership changes **only through explicit actions**:
 *
 *  - {@link WorkspacesState.openRepoInActive} — a user-initiated open joins
 *    the active workspace (Default included).
 *  - {@link WorkspacesState.closeRepo} — closing a repo from the rail/strip
 *    leaves the active workspace; the tab truly closes only when no other
 *    workspace still holds the repo (otherwise it just hides).
 *  - {@link WorkspacesState.addRepo} / {@link WorkspacesState.removeRepo} —
 *    the manager dialog's curation.
 *
 * There is deliberately **no** implicit open/close tracking: the previous
 * delta-mirror (subscribe to the tab set, apply adds/removes to the active
 * workspace, suspended via a module flag around programmatic opens) corrupted
 * memberships whenever two async flows overlapped. The only subscription left
 * is a *pure focus reconciler* — it never edits membership, so suspending it
 * (`reconcileGuard`) during a switch is race-tolerant: the worst outcome is
 * one extra focus correction, never data loss.
 *
 * Repos that end up open but claimed by no workspace (deleted workspace,
 * data drift, stray open paths) are adopted into Default — every open repo
 * is always reachable from some workspace.
 */
interface WorkspacesState {
  /** Every workspace, including the reserved Default (see {@link DEFAULT_WORKSPACE_ID}). */
  workspaces: Workspace[];
  /** The named workspace currently open, or `null` for the Default view. */
  activeWorkspaceId: string | null;
  /** True once {@link WorkspacesState.load} has run (guards re-load). */
  loaded: boolean;

  /** Read the persisted list + active id once, at app startup. */
  load(): Promise<void>;
  /**
   * One-time init after session restore: adopt open repos that no workspace
   * claims into Default (this is also how a fresh Default is seeded on first
   * run), install the focus reconciler, and reconcile once. Idempotent.
   */
  initAfterRestore(): void;

  /** Create a named workspace from `repoPaths` (deduped) and return its id. */
  create(name: string, repoPaths: string[]): Promise<string>;
  /**
   * Import a VS Code `.code-workspace` file as a new named workspace: parse
   * its `folders` (JSONC-tolerant), resolve them against the file's
   * directory, validate each through `repoOpen` (which also canonicalizes —
   * the returned `meta.path` is what gets stored), and create the workspace
   * from the repos that resolve. Folders that aren't git repositories come
   * back in `skipped` rather than failing the import; it only throws when
   * the file is unreadable/unparseable or *no* folder is a repo.
   */
  importCodeWorkspace(
    filePath: string,
  ): Promise<{ id: string; name: string; added: number; skipped: string[] }>;
  /** Rename a workspace (no-op on Default). */
  rename(id: string, name: string): Promise<void>;
  /**
   * Delete a workspace (no-op on Default). Its open repos are not closed —
   * any left claimed by no other workspace move to Default.
   */
  remove(id: string): Promise<void>;
  /**
   * Add a repo path to a workspace's membership (no-op if already a member).
   * Adding to the *active* workspace also opens the repo in the background so
   * it appears in the rail immediately.
   */
  addRepo(id: string, path: string): Promise<void>;
  /**
   * Remove a repo path from a workspace's membership. Removing a repo from
   * its **last** holding workspace also closes its open tabs — an open repo
   * claimed by nothing would be unreachable from every view (and orphan
   * adoption would bounce it straight back into Default).
   */
  removeRepo(id: string, path: string): Promise<void>;

  /**
   * Focus a workspace, or `null` for the Default view. Pure filter switch —
   * persisted; does not open or close any repo. Reconciles the active tab
   * into the newly-visible set.
   */
  setActive(id: string | null): void;
  /**
   * Open a workspace: focus it, keep the current repo if it's a member (else
   * land on the workspace's last-active repo, else its first open member),
   * and open any missing members in the background — in parallel, without
   * stealing focus. Non-members stay open but hidden.
   */
  openWorkspace(id: string): Promise<void>;
  /**
   * Open a repo *into* the active workspace: open (or focus) it, then make it
   * a member. An explicit open means "I want this repo here" — membership is
   * multi, so a repo owned by another workspace joins this one too instead of
   * being filtered straight back out. Every user-initiated open (recents,
   * dialog, palette, switcher, clone) should route through this.
   */
  openRepoInActive(path: string): Promise<void>;
  /**
   * Close a repo tab, workspace-aware: the repo leaves the active workspace;
   * its tabs (main + linked worktrees) really close only when no other
   * workspace still holds it. A linked-worktree tab just closes. A named
   * workspace emptied this way falls back to the Default view.
   */
  closeRepo(tabPath: string): Promise<void>;
}

/** Workspace id: a UUID when available, else a timestamp-plus-counter string. */
let wsSeq = 0;
function wsId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ws-${Date.now()}-${++wsSeq}`;
}

async function persist(list: Workspace[]): Promise<void> {
  try {
    await workspacesDb.save(list);
  } catch (e) {
    console.warn('workspaces persist failed', e);
  }
}

/**
 * The main workdir a `.git` common dir implies, in its **original spelling**
 * (verbatim prefix stripped, separators untouched): `D:\x\repo\.git` →
 * `D:\x\repo`, `\\?\D:\x\repo\.git` → `D:\x\repo`. Unlike the normalized
 * `mainPathFromCommonDir` key this is safe to store and to hand to `repoOpen`
 * — fabricating a re-spelled path here is exactly how the same repo ended up
 * open twice on Windows.
 */
function derivedMainPath(commonDir: string): string | null {
  const dir = commonDir.replace(/^\\\\\?\\(?:UNC\\)?/, '');
  const m = dir.match(/^(.*)[\\/]\.git[\\/]?$/);
  return m ? m[1] : null;
}

/**
 * The membership key for a tab: main repos key by their own path; a linked
 * worktree keys by its main repo's workdir — the open main tab's path when
 * there is one, else the path derived from the shared `.git` common dir —
 * so membership always lands on the family's main path.
 */
function membershipPathFor(tab: RepoTab, tabs: RepoTab[]): string {
  if (!tab.meta.is_linked_worktree) return tab.path;
  const common = pathKey(tab.meta.common_dir);
  const main = tabs.find(
    (t) => !t.meta.is_linked_worktree && pathKey(t.meta.common_dir) === common,
  );
  if (main) return main.path;
  return derivedMainPath(tab.meta.common_dir) ?? tab.path;
}

/**
 * Rewrite a stored path to the native Windows spelling when it's clearly a
 * Windows drive path (forward slashes flipped, verbatim prefix stripped) —
 * heals membership entries written before path comparisons were
 * spelling-tolerant. POSIX paths pass through untouched.
 */
function toNativeSpelling(p: string): string {
  let out = p.replace(/^\\\\\?\\(?:UNC\\)?/, '').replace(/^\/\/\?\/(?:UNC\/)?/, '');
  if (/^[A-Za-z]:[\\/]/.test(out)) out = out.replace(/\//g, '\\');
  return out;
}

/** The active workspace, resolving `null` to the reserved Default entry. */
function resolveActiveWorkspace(state: WorkspacesState): Workspace | undefined {
  return state.workspaces.find((w) => w.id === (state.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID));
}

// Focus reconciler plumbing. `reconcileGuard` counts in-flight operations that
// manage focus themselves (workspace switch, explicit open) — while held, the
// reconciler stays quiet and runs once when the last operation finishes.
// Unlike the old delta-mirror's pause flag, a mistimed guard can only delay a
// focus correction; it can never corrupt membership.
let reconcilerInstalled = false;
let reconcileGuard = 0;

export const useWorkspaces = create<WorkspacesState>((set, get) => {
  const reconcile = () => {
    if (reconcileGuard > 0) return;
    ensureActiveVisible(get);
  };

  /** Adopt open main repos that no workspace claims into Default. Covers the
   *  first-run seed, deleted workspaces, and any persisted-data drift. */
  const adoptOrphans = () => {
    const claimed = new Set(get().workspaces.flatMap((w) => w.repoPaths.map(pathKey)));
    const orphans = useRepo
      .getState()
      .tabs.filter((t) => !t.meta.is_linked_worktree && !claimed.has(pathKey(t.path)))
      .map((t) => t.path);
    if (orphans.length === 0) return;
    const workspaces = get().workspaces.map((w) =>
      w.id === DEFAULT_WORKSPACE_ID ? { ...w, repoPaths: [...w.repoPaths, ...orphans] } : w,
    );
    set({ workspaces });
    void persist(workspaces);
  };

  return {
    workspaces: [],
    activeWorkspaceId: null,
    loaded: false,

    async load() {
      if (get().loaded) return;
      try {
        const [list, active] = await Promise.all([workspacesDb.list(), workspacesDb.getActive()]);
        let workspaces = list ?? [];
        if (!workspaces.some((w) => w.id === DEFAULT_WORKSPACE_ID)) {
          // Migrate in the reserved Default workspace (its membership is
          // seeded from the open set by initAfterRestore's orphan adoption).
          workspaces = [
            { id: DEFAULT_WORKSPACE_ID, name: 'Default', repoPaths: [], createdAt: 0 },
            ...workspaces,
          ];
        }
        // Heal spelling drift in persisted memberships: the same directory
        // recorded under two spellings (`D:/x` + `D:\x`) collapses to one
        // native-spelled entry, so counts, filters, and opens agree.
        const healed = workspaces.map((w) => {
          const seen = new Set<string>();
          const repoPaths: string[] = [];
          for (const p of w.repoPaths) {
            const native = toNativeSpelling(p);
            const key = pathKey(native);
            if (seen.has(key)) continue;
            seen.add(key);
            repoPaths.push(native);
          }
          return {
            ...w,
            repoPaths,
            ...(w.lastActivePath ? { lastActivePath: toNativeSpelling(w.lastActivePath) } : {}),
          };
        });
        if (JSON.stringify(healed) !== JSON.stringify(list ?? [])) void persist(healed);
        workspaces = healed;
        // Only restore an active id that resolves to a *named* workspace;
        // Default is `null`.
        const restore =
          active && active !== DEFAULT_WORKSPACE_ID && workspaces.some((w) => w.id === active)
            ? active
            : null;
        set({ workspaces, activeWorkspaceId: restore, loaded: true });
      } catch (e) {
        console.warn('workspaces load failed', e);
        set({ loaded: true });
      }
    },

    initAfterRestore() {
      if (reconcilerInstalled) return;
      reconcilerInstalled = true;

      adoptOrphans();

      useRepo.subscribe((state, prev) => {
        // Remember the last repo focused per workspace, so switching back
        // lands where the user left off. Only visible members count — a
        // pre-reconcile flick through a foreign tab must not be recorded.
        if (state.activeTabPath && state.activeTabPath !== prev.activeTabPath) {
          const ws = resolveActiveWorkspace(get());
          if (ws && ws.lastActivePath !== state.activeTabPath) {
            const members = workspaceMemberSet(state.tabs, new Set(ws.repoPaths));
            if (members.has(state.activeTabPath)) {
              const workspaces = get().workspaces.map((w) =>
                w.id === ws.id ? { ...w, lastActivePath: state.activeTabPath! } : w,
              );
              set({ workspaces });
              void persist(workspaces);
            }
          }
        }
        // Pure focus correction — covers closes and opens from any code path.
        reconcile();
      });

      // Session restore may have re-activated a repo the restored workspace
      // doesn't own — reconcile once now that restore has settled.
      reconcile();
    },

    async create(name, repoPaths) {
      const ws: Workspace = {
        id: wsId(),
        name: name.trim() || 'Workspace',
        repoPaths: [...new Set(repoPaths)],
        createdAt: Date.now(),
      };
      const workspaces = [...get().workspaces, ws];
      set({ workspaces });
      await persist(workspaces);
      return ws.id;
    },

    async importCodeWorkspace(filePath) {
      const text = await tauri.workspaceFileRead(filePath);
      const parsed = parseCodeWorkspace(text);
      const dir = dirnameOf(filePath);
      const added: string[] = [];
      const skipped: string[] = [];
      for (const folder of parsed.folders) {
        const candidate = resolveWorkspaceFolder(dir, folder);
        try {
          const meta = await tauri.repoOpen(candidate);
          if (!added.some((p) => pathKey(p) === pathKey(meta.path))) {
            added.push(meta.path);
            // Record in recents so the repo shows a proper name everywhere
            // from now on (the manager's add-from-disk does the same).
            void recentsDb.touch(meta.path, repoFamilyName(meta)).catch(() => undefined);
          }
        } catch {
          skipped.push(folder);
        }
      }
      if (added.length === 0) {
        throw new Error(
          parsed.folders.length === 0
            ? 'the file lists no folders'
            : 'none of its folders is a git repository',
        );
      }
      const name = workspaceNameFromFile(filePath);
      const id = await get().create(name, added);
      return { id, name, added: added.length, skipped };
    },

    async rename(id, name) {
      if (id === DEFAULT_WORKSPACE_ID) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      const workspaces = get().workspaces.map((w) => (w.id === id ? { ...w, name: trimmed } : w));
      set({ workspaces });
      await persist(workspaces);
    },

    async remove(id) {
      if (id === DEFAULT_WORKSPACE_ID) return;
      const workspaces = get().workspaces.filter((w) => w.id !== id);
      set({ workspaces });
      if (get().activeWorkspaceId === id) get().setActive(null);
      // Open repos only this workspace held stay open — hand them to Default
      // so they don't become unreachable zombie tabs.
      adoptOrphans();
      reconcile();
      await persist(get().workspaces);
    },

    async addRepo(id, path) {
      const key = pathKey(path);
      const workspaces = get().workspaces.map((w) =>
        w.id === id && !w.repoPaths.some((p) => pathKey(p) === key)
          ? { ...w, repoPaths: [...w.repoPaths, path] }
          : w,
      );
      set({ workspaces });
      await persist(workspaces);
      // Adding to the active workspace shows the repo right away: open its
      // tab in the background if needed; the reconciler focuses it when the
      // workspace was sitting on the empty state.
      if (id === (get().activeWorkspaceId ?? DEFAULT_WORKSPACE_ID)) {
        const repo = useRepo.getState();
        if (!repo.tabs.some((t) => pathKey(t.path) === pathKey(path))) {
          void repo.openRepoBackground(path).catch((e) => console.warn(`addRepo: failed to open ${path}`, e));
        }
        reconcile();
      }
    },

    async removeRepo(id, path) {
      const key = pathKey(path);
      const finalOwner = !get().workspaces.some(
        (workspace) => workspace.id !== id
          && workspace.repoPaths.some((repoPath) => pathKey(repoPath) === key),
      );
      if (finalOwner) {
        const repo = useRepo.getState();
        const tab = repo.tabs.find((item) => pathKey(item.path) === key);
        const family = tab
          ? repo.tabs
              .filter((item) => pathKey(item.meta.common_dir) === pathKey(tab.meta.common_dir))
              .map((item) => item.path)
          : [path];
        if (!await prepareFinalClose(family)) return;
      }
      const workspaces = get().workspaces.map((w) =>
        w.id === id ? { ...w, repoPaths: w.repoPaths.filter((p) => pathKey(p) !== key) } : w,
      );
      set({ workspaces });
      // Left its last workspace → close its open tabs (main + worktrees).
      if (!get().workspaces.some((w) => w.repoPaths.some((p) => pathKey(p) === key))) {
        const repo = useRepo.getState();
        const tab = repo.tabs.find((t) => pathKey(t.path) === key);
        if (tab) {
          const common = pathKey(tab.meta.common_dir);
          const family = repo.tabs.filter((t) => pathKey(t.meta.common_dir) === common);
          for (const t of family) useRepo.getState().closeTab(t.path);
        }
      }
      reconcile();
      await persist(get().workspaces);
    },

    setActive(id) {
      const norm = id === DEFAULT_WORKSPACE_ID ? null : id;
      set({ activeWorkspaceId: norm });
      void workspacesDb.setActive(norm).catch((e) => console.warn('active workspace persist failed', e));
      reconcile();
    },

    async openWorkspace(id) {
      const ws = get().workspaces.find((w) => w.id === id);
      if (!ws) return;
      reconcileGuard++;
      try {
        get().setActive(id);

        const repo = useRepo.getState();
        const members = workspaceMemberSet(repo.tabs, new Set(ws.repoPaths));

        // Focus, in preference order: the repo already on screen if it's a
        // member (no jump at all), the workspace's last-active repo (matched
        // by path key — its tab may be open under another spelling), the
        // first open member. All no-op paths are cheap.
        const lastKey = ws.lastActivePath ? pathKey(ws.lastActivePath) : null;
        const target =
          (repo.activeTabPath && members.has(repo.activeTabPath) && repo.activeTabPath) ||
          (lastKey
            ? repo.tabs.find((t) => members.has(t.path) && pathKey(t.path) === lastKey)?.path ?? null
            : null) ||
          (repo.tabs.find((t) => members.has(t.path))?.path ?? null);

        if (target) {
          await repo.setActiveTab(target);
        } else {
          // No member open yet — open the first one focused so the switch
          // shows content as soon as possible; the rest follow in background.
          let opened = false;
          for (const path of ws.repoPaths) {
            try {
              await useRepo.getState().openRepo(path);
              opened = true;
              break;
            } catch (e) {
              console.warn(`openWorkspace: failed to open ${path}`, e);
            }
          }
          if (!opened) useRepo.getState().deactivateTab();
        }

        // Open the remaining members in the background, in parallel — they
        // appear in the rail as they arrive, without stealing focus. Compare
        // by path key: a member stored under another spelling of an open
        // tab's path must not open a duplicate.
        const open = new Set(useRepo.getState().tabs.map((t) => pathKey(t.path)));
        const missing = ws.repoPaths.filter((p) => !open.has(pathKey(p)));
        await Promise.all(
          missing.map((p) =>
            useRepo
              .getState()
              .openRepoBackground(p)
              .catch((e) => console.warn(`openWorkspace: failed to open ${p}`, e)),
          ),
        );
      } finally {
        reconcileGuard--;
      }
      reconcile();
    },

    async openRepoInActive(path) {
      const ws = resolveActiveWorkspace(get());

      // Already open under any spelling of this path (hidden or not): join
      // first, then focus — membership lands before the reconciler could see
      // a foreign tab focused and flick away.
      const existing = useRepo.getState().tabs.find((t) => pathKey(t.path) === pathKey(path));
      if (existing) {
        if (ws) await get().addRepo(ws.id, membershipPathFor(existing, useRepo.getState().tabs));
        await useRepo.getState().setActiveTab(existing.path);
        reconcile();
        return;
      }

      // Not open (or open under a different spelling of the path — openRepo
      // canonicalizes and dedupes). Guard the reconciler until membership is
      // applied to the canonical path.
      reconcileGuard++;
      try {
        await useRepo.getState().openRepo(path);
        const repo = useRepo.getState();
        const tab = repo.tabs.find((t) => t.path === repo.activeTabPath);
        if (tab && ws) await get().addRepo(ws.id, membershipPathFor(tab, repo.tabs));
      } finally {
        reconcileGuard--;
      }
      reconcile();
    },

    async closeRepo(tabPath) {
      const repo = useRepo.getState();
      const tab = repo.tabs.find((t) => t.path === tabPath);
      if (!tab) return;

      // A linked worktree tab isn't a member — plain close; the reconciler
      // moves focus if it was active.
      if (tab.meta.is_linked_worktree) {
        if (!await prepareFinalClose([tabPath])) return;
        repo.closeTab(tabPath);
        reconcile();
        return;
      }

      const ws = resolveActiveWorkspace(get());
      if (!ws) {
        repo.closeTab(tabPath);
        return;
      }

      const mainPath = tab.path;
      // The family: this repo plus its open linked worktrees — they inherit
      // visibility from the main, so they hide or close along with it.
      const common = pathKey(tab.meta.common_dir);
      const family = new Set(
        repo.tabs.filter((t) => pathKey(t.meta.common_dir) === common).map((t) => t.path),
      );
      const heldElsewhere = get().workspaces.some(
        (workspace) => workspace.id !== ws.id
          && workspace.repoPaths.some((path) => pathKey(path) === pathKey(mainPath)),
      );
      if (!heldElsewhere && !await prepareFinalClose([...family])) return;

      // Move focus off the closing family first, onto a remaining member —
      // otherwise closeTab would pick a hidden neighbor and the view would
      // flash it before the reconciler corrects.
      if (repo.activeTabPath && family.has(repo.activeTabPath)) {
        const mainKey = pathKey(mainPath);
        const remaining = new Set(ws.repoPaths.filter((p) => pathKey(p) !== mainKey));
        const members = workspaceMemberSet(repo.tabs, remaining);
        const next = repo.tabs.find((t) => members.has(t.path) && !family.has(t.path));
        if (next) await repo.setActiveTab(next.path);
        else repo.deactivateTab();
      }

      // Leave the active workspace. removeRepo really closes the tabs when
      // this was the last workspace holding the repo; otherwise they stay
      // open and just hide (the membership removal unfilters them out).
      await get().removeRepo(ws.id, mainPath);

      // A named workspace emptied by closing its last repo falls back to the
      // Default view. Default itself can sit empty.
      const cur = resolveActiveWorkspace(get());
      if (get().activeWorkspaceId != null && cur && cur.repoPaths.length === 0) {
        get().setActive(null);
      }
      reconcile();
    },
  };
});

/**
 * Keep the active tab within the visible (filtered) set: if the active tab
 * isn't one of the active workspace's members — e.g. a close landed on a
 * hidden neighbor, or the workspace just changed — jump to the first member
 * that's open; with no member open, show the empty state. Conversely, sitting
 * on the empty state while a member is open (one just got added) focuses it.
 * Pure focus correction: never touches membership. The follow-up
 * `setActiveTab` re-enters via the subscription with a member active, so it
 * settles.
 */
function ensureActiveVisible(get: () => WorkspacesState): void {
  const ws = resolveActiveWorkspace(get());
  if (!ws) return;
  const repo = useRepo.getState();
  const members = workspaceMemberSet(repo.tabs, new Set(ws.repoPaths));
  const active = repo.activeTabPath;
  if (active && members.has(active)) return;
  const target = repo.tabs.find((t) => members.has(t.path));
  if (target) void repo.setActiveTab(target.path);
  else if (active) repo.deactivateTab();
}

async function prepareFinalClose(paths: string[]): Promise<boolean> {
  const counts = await Promise.all(
    paths.map((path) => tauri.repoTerminalCount(path).catch(() => 0)),
  );
  const count = counts.reduce((sum, value) => sum + value, 0);
  if (count > 0 && !window.confirm(t('repo.closeWithTerminals', { count }))) return false;
  await Promise.all(paths.map(async (path) => {
    await tauri.repoTerminalCloseAll(path).catch(() => undefined);
    await useWork.getState().clearRepo(path).catch(() => undefined);
  }));
  return true;
}
