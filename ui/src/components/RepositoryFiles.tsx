import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { applyEmptyDirectoryMutation } from '../lib/emptyDirectories';
import { ignorePatterns } from '../lib/ignore';
import { t } from '../lib/i18n';
import { applyLocalTreeMutation, retainLoadedIgnoredChildren } from '../lib/localTreeMutation';
import { errMessage, isTauri, tauri } from '../lib/tauri';
import { workTreeGitStatus } from '../lib/workTreeGitStatus';
import { useRepo } from '../stores/repo';
import { useWork } from '../stores/work';
import { RenameFileDialog } from '../views/RenameFileDialog';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon } from './Icon';
import {
  copyToClipboard,
  PierreTree,
  type PierreTreeHandle,
  type TreeMenuContext,
  type TreeMenuItem,
} from './PierreTree';

interface RepositoryFilesProps {
  /** Keep the cache warm while the sidebar's Git tab is selected. */
  active?: boolean;
  /** In Custom, highlight the file selected by the embedded Work surface. */
  followWorkSelection?: boolean;
  onOpenFileInEditor(file: string): void;
  onCreateFileEntry(dir: string, directory: boolean): void;
  onToast(message: string, kind?: 'success' | 'error'): void;
  /** Custom can keep navigation inside its Work pane instead of leaving it. */
  onOpenWork?(): void;
}

/**
 * The live repository Files surface shared by the sidebar and Custom view.
 * Parents ensure only one active instance is rendered while Custom owns it.
 */
export function RepositoryFiles({
  active = true,
  followWorkSelection = false,
  onOpenFileInEditor,
  onCreateFileEntry,
  onToast,
  onOpenWork,
}: RepositoryFilesProps) {
  const view = useRepo((state) => state.view);
  const setView = useRepo((state) => state.setView);
  const selectFile = useRepo((state) => state.selectFile);
  const selectedFile = useRepo((state) => state.selectedFile);
  const selectedFileIsDirectory = useRepo((state) => state.selectedFileIsDirectory);
  const meta = useRepo((state) => state.meta);
  const workTree = useRepo((state) => state.workTree);
  const filesTreeRevision = useRepo((state) => state.filesTreeRevision);
  const filesTreeMutation = useRepo((state) => state.filesTreeMutation);
  const selectedCommit = useRepo((state) => state.selectedCommit);
  const refreshLocalChanges = useRepo((state) => state.refreshLocalChanges);
  const markFilesTreeChanged = useRepo((state) => state.markFilesTreeChanged);
  const gitignoreAdd = useRepo((state) => state.gitignoreAdd);
  const moveEntries = useRepo((state) => state.moveEntries);
  const openIgnoreDialog = useRepo((state) => state.openIgnoreDialog);
  const workRepos = useWork((state) => state.repos);
  const openWorkFile = useWork((state) => state.openFile);

  const [treeLoading, setTreeLoading] = useState(false);
  const [revisionTree, setRevisionTree] = useState<typeof workTree | null>(null);
  const [localTreeCache, setLocalTreeCache] = useState<{
    repoPath: string;
    entries: typeof workTree;
  } | null>(null);
  const filesTreeRef = useRef<PierreTreeHandle>(null);
  const loadedIgnoredDirectoriesRef = useRef(new Set<string>());
  const loadingIgnoredDirectoriesRef = useRef(new Map<string, number>());
  const ignoredLoadGenerationRef = useRef(0);
  const pendingIgnoredExpansionRef = useRef<string | null>(null);
  const [emptyDirectories, setEmptyDirectories] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(null);
  const fileCreateButtonRef = useRef<HTMLButtonElement>(null);
  const mutationTargetsRepo = filesTreeMutation?.repoPath === meta?.path;
  const workingTreeRevision = selectedCommit || !mutationTargetsRepo ? 0 : filesTreeRevision;

  const showWork = useCallback(() => {
    if (onOpenWork) onOpenWork();
    else setView('work');
  }, [onOpenWork, setView]);

  // `repo_snapshot` already carries the authoritative tracked/untracked
  // listing after commits, checkouts, and watcher events. Fold that cheap list
  // into the ignored-inclusive Files cache instead of paying for another walk.
  useEffect(() => {
    const repoPath = meta?.path;
    if (!repoPath) return;
    setLocalTreeCache((current) => {
      if (!current || current.repoPath !== repoPath) return current;
      const entries = new Map(
        current.entries.filter((entry) => entry.ignored).map((entry) => [entry.path, entry]),
      );
      for (const entry of workTree) entries.set(entry.path, entry);
      const next = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
      const unchanged =
        next.length === current.entries.length &&
        next.every((entry, index) => {
          const previous = current.entries[index];
          return previous?.path === entry.path
            && previous.status === entry.status
            && previous.ignored === entry.ignored;
        });
      return unchanged ? current : { ...current, entries: next };
    });
  }, [meta?.path, workTree]);

  useEffect(() => {
    setEmptyDirectories(new Set());
    loadedIgnoredDirectoriesRef.current.clear();
    loadingIgnoredDirectoriesRef.current.clear();
    pendingIgnoredExpansionRef.current = null;
    ignoredLoadGenerationRef.current += 1;
  }, [meta?.path]);

  useEffect(() => {
    if (!filesTreeMutation || !mutationTargetsRepo) return;
    loadedIgnoredDirectoriesRef.current.clear();
    loadingIgnoredDirectoriesRef.current.clear();
    pendingIgnoredExpansionRef.current = null;
    ignoredLoadGenerationRef.current += 1;
    setEmptyDirectories((current) => applyEmptyDirectoryMutation(current, filesTreeMutation));
    setLocalTreeCache((current) => {
      if (!current || current.repoPath !== filesTreeMutation.repoPath) return current;
      return {
        ...current,
        entries: applyLocalTreeMutation(
          current.entries,
          filesTreeMutation,
          useRepo.getState().workTree,
        ),
      };
    });
  }, [filesTreeMutation, mutationTargetsRepo]);

  // Browser-mode verification has no Rust tree IPC; use the already-seeded
  // snapshot list so the real Files UI remains driveable in the QA harness.
  useEffect(() => {
    if (!active || !meta?.path || isTauri()) return;
    if (selectedCommit) setRevisionTree(workTree);
    else setLocalTreeCache({ repoPath: meta.path, entries: workTree });
    setTreeError(null);
    setTreeLoading(false);
  }, [active, meta?.path, selectedCommit, workTree]);

  // Fetch only while this owner is visible. The sidebar keeps this component
  // mounted on its Git tab so toggling back to Files reuses the cached tree.
  useEffect(() => {
    if (!active || !meta?.path || !isTauri()) return;
    let cancelled = false;
    setTreeLoading(true);
    setTreeError(null);
    if (selectedCommit) setRevisionTree(null);
    const load = selectedCommit
      ? tauri.repoTreeAt(meta.path, selectedCommit).then((tree) => {
          if (!cancelled) setRevisionTree(tree);
        })
      : tauri.repoTree(meta.path, true).then((tree) => {
          if (!cancelled) {
            setLocalTreeCache((current) => ({
              repoPath: meta.path,
              entries: current?.repoPath === meta.path
                ? retainLoadedIgnoredChildren(
                    tree,
                    current.entries,
                    loadedIgnoredDirectoriesRef.current,
                  )
                : tree,
            }));
          }
        });
    void load
      .catch((error) => {
        if (!cancelled) {
          setRevisionTree(null);
          setTreeError(errMessage(error));
        }
      })
      .finally(() => {
        if (!cancelled) setTreeLoading(false);
      });
    return () => { cancelled = true; };
  }, [active, meta?.path, selectedCommit, workingTreeRevision]);

  useEffect(() => {
    if (!active) setCreateMenu(null);
  }, [active]);

  const localTree = localTreeCache && localTreeCache.repoPath === meta?.path
    ? localTreeCache.entries
    : null;
  const displayedTree = selectedCommit ? (revisionTree ?? []) : (localTree ?? []);
  const filePaths = useMemo(
    () => [
      ...displayedTree.map((entry) => entry.path),
      ...(selectedCommit ? [] : emptyDirectories),
    ],
    [displayedTree, emptyDirectories, selectedCommit],
  );
  const activeWorkTab = meta
    ? workRepos[meta.path]?.tabs.find((item) => item.id === workRepos[meta.path]?.activeTabId)
    : null;
  const workFile = activeWorkTab?.kind === 'file' ? activeWorkTab : null;
  const useWorkSelection = view === 'work' || followWorkSelection;
  const selectedTreeFile = useWorkSelection ? workFile?.path ?? null : selectedFile;
  const selectedTreeDirectory = useWorkSelection
    ? workFile?.isDirectory ?? false
    : selectedFileIsDirectory;
  const selectedTreePath = selectedTreeFile && selectedTreeDirectory
    ? `${selectedTreeFile.replace(/\/+$/, '')}/`
    : selectedTreeFile;
  const fileGitStatus = useMemo(
    () => workTreeGitStatus(displayedTree, selectedCommit ? displayedTree : workTree),
    [displayedTree, selectedCommit, workTree],
  );
  const ignoredDirectoryPaths = useMemo(
    () => new Set(
      displayedTree
        .filter((entry) => entry.ignored && entry.path.endsWith('/'))
        .map((entry) => entry.path.replace(/\/+$/, '')),
    ),
    [displayedTree],
  );

  const loadIgnoredDirectory = useCallback((directory: string) => {
    const repoPath = meta?.path;
    if (selectedCommit || !repoPath || !ignoredDirectoryPaths.has(directory)) return;
    if (loadedIgnoredDirectoriesRef.current.has(directory)) return;
    if (loadingIgnoredDirectoriesRef.current.has(directory)) return;

    const generation = ignoredLoadGenerationRef.current;
    loadingIgnoredDirectoriesRef.current.set(directory, generation);
    void tauri.repoTreeIgnoredChildren(repoPath, directory)
      .then((children) => {
        if (ignoredLoadGenerationRef.current !== generation) return;
        loadedIgnoredDirectoriesRef.current.add(directory);
        if (children.length > 0) pendingIgnoredExpansionRef.current = directory;
        setLocalTreeCache((current) => {
          if (!current || current.repoPath !== repoPath) return current;
          const entries = new Map(current.entries.map((entry) => [entry.path, entry]));
          for (const child of children) entries.set(child.path, child);
          return {
            ...current,
            entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
          };
        });
      })
      .catch((error) => {
        if (ignoredLoadGenerationRef.current === generation) {
          onToast(`Could not load ${directory}: ${errMessage(error)}`, 'error');
        }
      })
      .finally(() => {
        if (loadingIgnoredDirectoriesRef.current.get(directory) === generation) {
          loadingIgnoredDirectoriesRef.current.delete(directory);
        }
      });
  }, [ignoredDirectoryPaths, meta?.path, onToast, selectedCommit]);

  useEffect(() => {
    const directory = pendingIgnoredExpansionRef.current;
    if (!directory || !filePaths.some((path) => path.startsWith(`${directory}/`))) return;
    pendingIgnoredExpansionRef.current = null;
    const frame = requestAnimationFrame(() => filesTreeRef.current?.expandPath(directory));
    return () => cancelAnimationFrame(frame);
  }, [filePaths]);

  const moveTo = useCallback((sources: string[], dir: string) => {
    const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
    const parent = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const moves = sources
      .filter((source) => parent(source) !== dir && dir !== source && !dir.startsWith(`${source}/`))
      .map((source) => ({ from: source, to: dir ? `${dir}/${base(source)}` : base(source) }));
    if (moves.length === 0) return;
    void moveEntries(moves).then((failures) => {
      if (failures.length > 0) {
        const more = failures.length > 1 ? ` (+${failures.length - 1} more)` : '';
        onToast(`Move failed: ${failures[0]}${more}`, 'error');
      }
    });
  }, [moveEntries, onToast]);

  const fileMenu = useCallback((targets: string[], context: TreeMenuContext): TreeMenuItem[] => {
    const rowPath = context.path;
    const rowIsDirectory = context.kind === 'directory';
    const actionPaths = rowIsDirectory ? [rowPath] : targets;
    const items: TreeMenuItem[] = [
      {
        label: 'Open',
        icon: 'content',
        onSelect: () => {
          if (!meta) return;
          openWorkFile(meta.path, rowPath, selectedCommit, rowIsDirectory, 'pinned');
          showWork();
        },
      },
    ];
    if (!selectedCommit && actionPaths.length === 1) {
      items.push(
        { label: 'Open in editor', icon: 'external', onSelect: () => onOpenFileInEditor(rowPath) },
        {
          label: 'Reveal in file manager',
          icon: 'folder-open',
          onSelect: () => {
            if (!meta) return;
            void tauri.repoFileReveal(meta.path, rowPath).catch((error) =>
              onToast(`Reveal failed: ${errMessage(error)}`, 'error'));
          },
        },
      );
    }
    if (!selectedCommit && !rowIsDirectory && actionPaths.length === 1) {
      items.push(
        {
          label: 'Open file history',
          icon: 'history',
          onSelect: () => {
            if (!meta) return;
            openWorkFile(meta.path, rowPath, null, false, 'pinned', 'history');
            showWork();
          },
        },
        {
          label: 'Open blame',
          icon: 'blame',
          onSelect: () => {
            if (!meta) return;
            openWorkFile(meta.path, rowPath, null, false, 'pinned', 'blame');
            showWork();
          },
        },
      );
    }
    if (!selectedCommit && actionPaths.length === 1) {
      items.push({ label: 'Rename / move…', icon: 'file', onSelect: () => setRenameTarget(rowPath) });
      const dir = rowIsDirectory ? rowPath : parentPath(rowPath);
      items.push(
        { label: 'New file here…', icon: 'file', onSelect: () => onCreateFileEntry(dir, false) },
        { label: 'New folder here…', icon: 'folder', onSelect: () => onCreateFileEntry(dir, true) },
      );
    }
    if (
      !selectedCommit
      && !rowIsDirectory
      && actionPaths.length === 1
      && workTree.some((entry) => entry.path === rowPath && entry.status === 'UNTRACKED')
    ) {
      const ignore = (pattern: string) =>
        void gitignoreAdd(pattern).catch((error) =>
          onToast(`Ignore failed: ${errMessage(error)}`, 'error'));
      const base = leafName(rowPath);
      const { exact, extension } = ignorePatterns(rowPath);
      const submenu: MenuItem[] = [{ label: `Ignore “${base}”`, onSelect: () => ignore(exact) }];
      if (extension) submenu.push({ label: `Ignore all ${extension} files`, onSelect: () => ignore(extension) });
      submenu.push({ label: 'Custom pattern…', onSelect: () => openIgnoreDialog(rowPath) });
      items.push({ label: 'Ignore', icon: 'file', submenu });
    }
    items.push({
      label: actionPaths.length > 1 ? 'Copy relative paths' : 'Copy relative path',
      icon: 'file',
      onSelect: () => {
        copyToClipboard(actionPaths.join('\n'));
        onToast(actionPaths.length > 1 ? 'Relative paths copied' : 'Relative path copied');
      },
    });
    if (!selectedCommit && meta) {
      items.push({
        label: actionPaths.length > 1 ? 'Copy absolute paths' : 'Copy absolute path',
        icon: 'file',
        onSelect: () => {
          void tauri.repoFileAbsolutePaths(meta.path, actionPaths).then(
            (paths) => {
              copyToClipboard(paths.join('\n'));
              onToast(paths.length > 1 ? 'Absolute paths copied' : 'Absolute path copied');
            },
            (error) => onToast(`Copy failed: ${errMessage(error)}`, 'error'),
          );
        },
      });
      items.push({
        label: rowIsDirectory
          ? 'Delete folder'
          : actionPaths.length > 1
            ? `Delete ${actionPaths.length} files`
            : 'Delete file',
        icon: 'trash',
        danger: true,
        confirm: true,
        onSelect: () => {
          void tauri.repoFileDelete(meta.path, actionPaths).then(
            async () => {
              if (selectedFile && actionPaths.some((path) =>
                selectedFile === path || selectedFile.startsWith(`${path}/`))) {
                setView('local');
                selectFile(null);
              }
              await refreshLocalChanges();
              markFilesTreeChanged(meta.path, { kind: 'delete', paths: actionPaths });
              onToast(actionPaths.length > 1
                ? `Deleted ${actionPaths.length} entries`
                : `Deleted ${actionPaths[0]}`);
            },
            (error) => onToast(`Delete failed: ${errMessage(error)}`, 'error'),
          );
        },
      });
    }
    return items;
  }, [
    gitignoreAdd,
    markFilesTreeChanged,
    meta,
    onCreateFileEntry,
    onOpenFileInEditor,
    onToast,
    openIgnoreDialog,
    openWorkFile,
    refreshLocalChanges,
    selectFile,
    selectedCommit,
    selectedFile,
    setView,
    showWork,
    workTree,
  ]);

  const openFileCreateMenu = () => {
    const rect = fileCreateButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCreateMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const fileCreateToolbar = (
    <div
      className={'side-files-tools' + (filePaths.length === 0 ? ' standalone' : '')}
      role="toolbar"
      aria-label="Working-tree file actions"
    >
      <button
        ref={fileCreateButtonRef}
        type="button"
        className="side-files-create"
        title={t('files.createEntry')}
        aria-label={t('files.createEntry')}
        aria-haspopup="menu"
        aria-expanded={createMenu != null}
        onClick={openFileCreateMenu}
      >
        <Icon name="plus" size={14} stroke={2} />
      </button>
    </div>
  );

  return (
    <div className={'side-files repository-files' + (active ? '' : ' inactive')}>
      {renameTarget && (
        <RenameFileDialog
          from={renameTarget}
          onClose={() => setRenameTarget(null)}
          onToast={onToast}
        />
      )}
      {!selectedCommit && localTree && filePaths.length === 0 && fileCreateToolbar}
      {selectedCommit && (
        <div className="side-files-revision" title={`Files at commit ${selectedCommit}`}>
          Files at <code>{selectedCommit.slice(0, 7)}</code>
        </div>
      )}
      <PierreTree
        ref={filesTreeRef}
        paths={filePaths}
        gitStatus={fileGitStatus}
        onMove={selectedCommit ? undefined : moveTo}
        selectedPath={selectedTreePath}
        onSelect={(path, kind) => {
          if (!path || !meta) return;
          openWorkFile(meta.path, path, selectedCommit, kind === 'directory', 'preview');
          showWork();
        }}
        onActivate={(_paths, context) => {
          if (!meta) return;
          openWorkFile(
            meta.path,
            context.path,
            selectedCommit,
            context.kind === 'directory',
            'pinned',
          );
          showWork();
        }}
        onDirectoryExpand={loadIgnoredDirectory}
        menuItems={fileMenu}
        search
        searchAction={!selectedCommit && localTree && filePaths.length > 0 ? fileCreateToolbar : undefined}
        initialExpansion="closed"
        emptyLabel={
          treeLoading || (!selectedCommit && !localTree)
            ? selectedCommit ? 'Loading commit tree…' : 'Loading working tree…'
            : treeError ?? (selectedCommit ? 'No files at this commit.' : 'No files in the working tree.')
        }
      />
      {active && createMenu && (
        <ContextMenu
          x={createMenu.x}
          y={createMenu.y}
          items={[
            { label: t('files.newFile'), icon: 'file-plus', onSelect: () => onCreateFileEntry('', false) },
            { label: t('files.newFolder'), icon: 'folder-plus', onSelect: () => onCreateFileEntry('', true) },
          ]}
          onClose={() => setCreateMenu(null)}
        />
      )}
    </div>
  );
}

function leafName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}
