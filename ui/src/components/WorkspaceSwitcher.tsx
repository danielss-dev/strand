import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icon';
import { useOutsideClose } from '../lib/useOutsideClose';
import { workspaceMemberSet } from '../lib/repoIdentity';
import { useRepo } from '../stores/repo';
import { DEFAULT_WORKSPACE_ID, useWorkspaces } from '../stores/workspaces';

/**
 * Workspace control shared by the vertical rail and the horizontal tab strip:
 * a button that drops a menu to switch between the Default view and named
 * workspaces, create/rename/delete them, and open the manage dialog.
 * `placement` only decides which edge the dropdown opens from — `rail` opens to
 * the right of the button, `tabs` opens below it.
 *
 * Creating seeds the workspace with the repos currently *visible* (the active
 * workspace's open members), so "save what I'm looking at as a group" is one
 * action. Opening a workspace filters the rail/strip to its repos; the Default
 * view is just the workspace shown when none is active.
 */
export function WorkspaceSwitcher({ placement, onManage }: { placement: 'rail' | 'tabs'; onManage: () => void }) {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeWorkspaceId);
  const openWorkspace = useWorkspaces((s) => s.openWorkspace);
  const create = useWorkspaces((s) => s.create);
  const rename = useWorkspaces((s) => s.rename);
  const remove = useWorkspaces((s) => s.remove);
  const tabs = useRepo((s) => s.tabs);

  // The active workspace, resolving Default (`null`) to its reserved entry.
  const active = workspaces.find((w) => w.id === (activeId ?? DEFAULT_WORKSPACE_ID)) ?? null;
  const defaultWs = workspaces.find((w) => w.id === DEFAULT_WORKSPACE_ID) ?? null;
  const named = workspaces.filter((w) => w.id !== DEFAULT_WORKSPACE_ID);
  // A new workspace captures the repos on screen now (the active workspace's
  // open members) rather than every open repo — hidden ones stay out.
  const seedPaths = useMemo(() => {
    const members = active ? workspaceMemberSet(tabs, new Set(active.repoPaths)) : null;
    return tabs
      .filter((t) => !t.meta.is_linked_worktree && (!members || members.has(t.path)))
      .map((t) => t.path);
  }, [tabs, active]);

  const [open, setOpen] = useState(false);
  // 'list' = the menu; 'create'/'rename' swap it for a single name field.
  const [mode, setMode] = useState<{ kind: 'list' } | { kind: 'create' } | { kind: 'rename'; id: string }>(
    { kind: 'list' },
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    if (placement === 'rail') setPos({ top: r.top, left: r.right + 6 });
    else setPos({ top: r.bottom + 6, left: r.left });
  }, [open, placement, mode]);

  useOutsideClose([wrapRef, menuRef], open, () => setOpen(false));

  const close = () => {
    setOpen(false);
    setMode({ kind: 'list' });
  };

  const submitName = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (mode.kind === 'create') {
      const id = await create(trimmed, seedPaths);
      void openWorkspace(id);
    } else if (mode.kind === 'rename') {
      await rename(mode.id, trimmed);
    }
    close();
  };

  // The button shows a named workspace's name; Default reads as the plain icon.
  const namedActive = activeId != null ? active : null;
  const title = namedActive ? `Workspace: ${namedActive.name}` : 'Workspaces';

  return (
    <div ref={wrapRef} className={'ws-switch-wrap ' + placement}>
      <button
        type="button"
        className={'ws-switch' + (namedActive ? ' active' : '')}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setMode({ kind: 'list' }); setOpen((o) => !o); }}
      >
        <Icon name="workspace" size={placement === 'rail' ? 16 : 13} />
        {placement === 'tabs' && namedActive && <span className="ws-switch-name">{namedActive.name}</span>}
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="repo-menu ws-menu"
          role="menu"
          style={{ position: 'fixed', top: pos.top, left: pos.left, minWidth: 240 }}
        >
          {mode.kind === 'list' ? (
            <>
              <div className="repo-menu-sect">Workspaces</div>

              {/* Default view — always present, not renamable/deletable. */}
              <button
                type="button"
                className="repo-menu-item"
                role="menuitemradio"
                aria-checked={activeId == null}
                title="Default view"
                onClick={() => { close(); void openWorkspace(DEFAULT_WORKSPACE_ID); }}
              >
                <span className="ico">
                  {activeId == null
                    ? <Icon name="check" size={12} stroke={2.2} />
                    : <Icon name="workspace" size={12} />}
                </span>
                <span className="label">Default</span>
                <span className="meta">{defaultWs?.repoPaths.length ?? 0}</span>
              </button>

              {named.map((w) => {
                const isActive = w.id === activeId;
                const count = w.repoPaths.length;
                return (
                  <button
                    type="button"
                    key={w.id}
                    className="repo-menu-item"
                    role="menuitemradio"
                    aria-checked={isActive}
                    title={`${w.name} · ${count} repositor${count === 1 ? 'y' : 'ies'}`}
                    onClick={() => { close(); void openWorkspace(w.id); }}
                  >
                    <span className="ico">
                      {isActive
                        ? <Icon name="check" size={12} stroke={2.2} />
                        : <Icon name="workspace" size={12} />}
                    </span>
                    <span className="label">{w.name}</span>
                    <span
                      className="x"
                      role="button"
                      title="Rename workspace"
                      onClick={(e) => { e.stopPropagation(); setMode({ kind: 'rename', id: w.id }); }}
                    >
                      <Icon name="edit" size={11} />
                    </span>
                    <span
                      className="x"
                      role="button"
                      title="Delete workspace"
                      onClick={(e) => { e.stopPropagation(); void remove(w.id); }}
                    >
                      <Icon name="trash" size={11} />
                    </span>
                    <span className="meta">{count}</span>
                  </button>
                );
              })}

              <div className="repo-menu-divider" />
              <button
                type="button"
                className="repo-menu-item"
                role="menuitem"
                onClick={() => setMode({ kind: 'create' })}
              >
                <span className="ico"><Icon name="plus" size={12} /></span>
                <span className="label">New workspace…</span>
              </button>
              <button
                type="button"
                className="repo-menu-item"
                role="menuitem"
                onClick={() => { close(); onManage(); }}
              >
                <span className="ico"><Icon name="settings" size={12} /></span>
                <span className="label">Manage workspaces…</span>
              </button>
            </>
          ) : (
            <WorkspaceNameForm
              title={mode.kind === 'create' ? 'New workspace' : 'Rename workspace'}
              initial={mode.kind === 'rename' ? (workspaces.find((w) => w.id === mode.id)?.name ?? '') : ''}
              hint={
                mode.kind === 'create' && seedPaths.length > 0
                  ? `Includes ${seedPaths.length} open repositor${seedPaths.length === 1 ? 'y' : 'ies'}`
                  : undefined
              }
              onSubmit={submitName}
              onCancel={() => setMode({ kind: 'list' })}
            />
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Single-field name form inside the dropdown (create / rename). Enter submits,
 *  Escape cancels; the input autofocuses on mount. */
function WorkspaceNameForm({
  title,
  initial,
  hint,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: string;
  hint?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="ws-name-form"
      onSubmit={(e) => { e.preventDefault(); onSubmit(value); }}
    >
      <div className="repo-menu-sect">{title}</div>
      <input
        className="ws-name-input"
        autoFocus
        value={value}
        placeholder="Workspace name"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }}
      />
      {hint && <div className="ws-name-hint">{hint}</div>}
      <div className="ws-name-actions">
        <button type="button" className="ws-name-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="ws-name-btn primary" disabled={!value.trim()}>Save</button>
      </div>
    </form>
  );
}
