import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { recents as recentsDb } from '../lib/db';
import { pickRepoDirectories } from '../lib/dialog';
import { pathKey, pathLeaf, repoFamilyName } from '../lib/repoIdentity';
import { tauri } from '../lib/tauri';
import { useRepo } from '../stores/repo';
import { DEFAULT_WORKSPACE_ID, useWorkspaces } from '../stores/workspaces';

/**
 * Manage workspaces: pick a workspace on the left, curate its repositories on
 * the right — remove members, add from the repos you've opened before
 * (recents + currently open), or browse the filesystem for a repo folder.
 * Named workspaces can also be renamed or deleted; the reserved **Default**
 * view can only have its repos edited.
 *
 * Membership edits are durable and take effect on the next open of that
 * workspace; for the *active* one the rail/strip re-filter live (an added
 * repo opens in the background and appears, a removed one hides).
 */
export function WorkspaceManagerDialog({ onClose }: { onClose: () => void }) {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeWorkspaceId);
  const rename = useWorkspaces((s) => s.rename);
  const remove = useWorkspaces((s) => s.remove);
  const addRepo = useWorkspaces((s) => s.addRepo);
  const removeRepo = useWorkspaces((s) => s.removeRepo);
  const recents = useRepo((s) => s.recents);
  const tabs = useRepo((s) => s.tabs);
  const refreshRecents = useRepo((s) => s.refreshRecents);

  const named = workspaces.filter((w) => w.id !== DEFAULT_WORKSPACE_ID);

  const [selectedId, setSelectedId] = useState(activeId ?? DEFAULT_WORKSPACE_ID);
  // Error from the last "add from disk" attempt (e.g. a non-repo folder).
  const [addError, setAddError] = useState<string | null>(null);
  const selected =
    workspaces.find((w) => w.id === selectedId) ??
    workspaces.find((w) => w.id === DEFAULT_WORKSPACE_ID) ??
    null;
  const isDefault = selected?.id === DEFAULT_WORKSPACE_ID;

  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Every repo we know a path for — recents plus anything open — as the pool
  // to add from. Keyed by path *identity* (pathKey), not raw string, so the
  // same repo recorded under two spellings (D:/x vs D:\x) shows once.
  const known = useMemo(() => {
    const m = new Map<string, { path: string; name: string }>();
    for (const r of recents) {
      if (!m.has(pathKey(r.path))) m.set(pathKey(r.path), { path: r.path, name: r.name });
    }
    for (const t of tabs) {
      if (!t.meta.is_linked_worktree && !m.has(pathKey(t.path))) {
        m.set(pathKey(t.path), { path: t.path, name: repoFamilyName(t.meta) });
      }
    }
    return [...m.values()];
  }, [recents, tabs]);

  const nameFor = (path: string) =>
    known.find((k) => pathKey(k.path) === pathKey(path))?.name ?? pathLeaf(path);

  const memberPaths = selected?.repoPaths ?? [];
  const memberKeys = new Set(memberPaths.map(pathKey));
  const candidates = useMemo(
    () =>
      known
        .filter((k) => !memberKeys.has(pathKey(k.path)))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [known, selected],
  );

  const deleteSelected = async () => {
    if (!selected || isDefault) return;
    await remove(selected.id);
    setSelectedId(DEFAULT_WORKSPACE_ID);
  };

  // Add repos picked from the native folder dialog. Each pick is validated +
  // canonicalized through `repo_open` (membership keys on canonical paths),
  // and recorded in recents so it shows up with a proper name from now on.
  const addFromDisk = async () => {
    if (!selected) return;
    setAddError(null);
    const picked = await pickRepoDirectories();
    const failed: string[] = [];
    for (const p of picked) {
      try {
        const meta = await tauri.repoOpen(p);
        await addRepo(selected.id, meta.path);
        await recentsDb.touch(meta.path, repoFamilyName(meta));
      } catch (e) {
        console.warn(`addFromDisk: not a repository? ${p}`, e);
        failed.push(pathLeaf(p));
      }
    }
    if (picked.length > 0) void refreshRecents();
    if (failed.length > 0) setAddError(`Not a git repository: ${failed.join(', ')}`);
  };

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="clone-dialog ws-mgr" role="dialog" aria-modal="true" aria-label="Manage workspaces" ref={dialogRef}>
        <div className="clone-head">
          <Icon name="workspace" size={15} />
          <span className="title">Manage workspaces</span>
          <button type="button" className="cd-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="ws-mgr-body">
          {/* Left: workspace list */}
          <div className="ws-mgr-list" role="tablist" aria-label="Workspaces">
            <WorkspaceRow
              label="Default"
              count={workspaces.find((w) => w.id === DEFAULT_WORKSPACE_ID)?.repoPaths.length ?? 0}
              selected={selectedId === DEFAULT_WORKSPACE_ID}
              onSelect={() => setSelectedId(DEFAULT_WORKSPACE_ID)}
            />
            {named.map((w) => (
              <WorkspaceRow
                key={w.id}
                label={w.name}
                count={w.repoPaths.length}
                selected={selectedId === w.id}
                onSelect={() => setSelectedId(w.id)}
              />
            ))}
            {named.length === 0 && (
              <div className="ws-mgr-hint">Create workspaces from the switcher menu.</div>
            )}
          </div>

          {/* Right: repos of the selected workspace */}
          <div className="ws-mgr-editor">
            {!selected ? (
              <div className="ws-mgr-hint">Select a workspace.</div>
            ) : (
              <>
                <div className="ws-mgr-editor-head">
                  {isDefault ? (
                    <span className="ws-mgr-name-static">Default view {activeId == null ? '· active' : ''}</span>
                  ) : (
                    <NameField
                      key={selected.id}
                      initial={selected.name}
                      onCommit={(v) => void rename(selected.id, v)}
                    />
                  )}
                  {!isDefault && (
                    <button type="button" className="ws-mgr-delete" title="Delete workspace" onClick={() => void deleteSelected()}>
                      <Icon name="trash" size={13} />
                      <span>Delete</span>
                    </button>
                  )}
                </div>

                <div className="ws-mgr-sect">Repositories in this workspace</div>
                <div className="ws-mgr-repos">
                  {memberPaths.length === 0 ? (
                    <div className="ws-mgr-hint">No repositories yet — add some below.</div>
                  ) : (
                    memberPaths.map((path) => (
                      <div className="ws-mgr-repo" key={path} title={path}>
                        <span className="ws-mgr-repo-name">{nameFor(path)}</span>
                        <span className="ws-mgr-repo-path">{path}</span>
                        <button
                          type="button"
                          className="ws-mgr-repo-btn remove"
                          title="Remove from workspace"
                          aria-label={`Remove ${nameFor(path)}`}
                          onClick={() => void removeRepo(selected.id, path)}
                        >
                          <Icon name="minus" size={13} />
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <div className="ws-mgr-sect-row">
                  <div className="ws-mgr-sect">Add a repository</div>
                  <button
                    type="button"
                    className="ws-mgr-browse"
                    title="Add a repository folder from disk"
                    onClick={() => void addFromDisk()}
                  >
                    <Icon name="folder-open" size={12} />
                    <span>From disk…</span>
                  </button>
                </div>
                {addError && <div className="ws-mgr-error">{addError}</div>}
                <div className="ws-mgr-repos add">
                  {candidates.length === 0 ? (
                    <div className="ws-mgr-hint">Every known repository is already in this workspace.</div>
                  ) : (
                    candidates.map((k) => (
                      <div className="ws-mgr-repo" key={k.path} title={k.path}>
                        <span className="ws-mgr-repo-name">{k.name}</span>
                        <span className="ws-mgr-repo-path">{k.path}</span>
                        <button
                          type="button"
                          className="ws-mgr-repo-btn add"
                          title="Add to workspace"
                          aria-label={`Add ${k.name}`}
                          onClick={() => void addRepo(selected.id, k.path)}
                        >
                          <Icon name="plus" size={13} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="clone-foot">
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/** Rename field that commits on blur or Enter (not per keystroke, so a rename
 *  isn't a burst of SQLite writes). Reset by keying on the workspace id. */
function NameField({ initial, onCommit }: { initial: string; onCommit: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== initial) onCommit(trimmed);
    else if (!trimmed) setValue(initial);
  };
  return (
    <input
      className="clone-input ws-mgr-name"
      value={value}
      aria-label="Workspace name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

function WorkspaceRow({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={'ws-mgr-ws' + (selected ? ' active' : '')}
      onClick={onSelect}
    >
      <Icon name="workspace" size={13} />
      <span className="label">{label}</span>
      <span className="count">{count}</span>
    </button>
  );
}
