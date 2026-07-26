import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import '@xterm/xterm/css/xterm.css';

import { Icon } from '../components/Icon';
import { TreeFileIcon, TreeIconSprite } from '../components/TreeFileIcon';
import { repoEmbeddedShell } from '../lib/db';
import { embeddedShellOptions } from '../lib/embeddedShell';
import { t } from '../lib/i18n';
import { repoFamilyName } from '../lib/repoIdentity';
import { errMessage, tauri } from '../lib/tauri';
import type { EmbeddedShellChoice, TerminalEvent } from '../lib/types';
import {
  adjacentWorkTabId,
  findWorkPane,
  workPanes,
  type WorkFileTab,
  type WorkFileMode,
  type WorkPane,
  type WorkPaneLayout,
  type RepoWorkTabs,
  type WorkTab,
  type WorkTerminalTab,
} from '../lib/workTabs';
import { useOutsideClose } from '../lib/useOutsideClose';
import { useRepo } from '../stores/repo';
import { TERMINAL_FONTS, useSettings, type TerminalFont } from '../stores/settings';
import { useWork } from '../stores/work';
import { FileDocument } from './FileView';

export function Work({ visible }: { visible: boolean }) {
  const repoPath = useRepo((state) => state.activePath);
  const meta = useRepo((state) => state.meta);
  const openRepos = useRepo((state) => state.tabs);
  const repos = useWork((state) => state.repos);
  const activate = useWork((state) => state.activate);
  const activatePane = useWork((state) => state.activatePane);
  const close = useWork((state) => state.close);
  const addTerminal = useWork((state) => state.addTerminal);
  const openFile = useWork((state) => state.openFile);
  const setFileMode = useWork((state) => state.setFileMode);
  const splitPane = useWork((state) => state.splitPane);
  const restore = useWork((state) => state.restore);
  const setView = useRepo((state) => state.setView);
  const selectCommit = useRepo((state) => state.selectCommit);
  const repo = repoPath ? repos[repoPath] : undefined;
  const platform = useSettings((state) => state.platform);
  const rootRef = useRef<HTMLDivElement>(null);
  const paneHosts = useRef(new Map<string, HTMLDivElement>());
  const [paneHostVersion, setPaneHostVersion] = useState(0);
  const [paneRects, setPaneRects] = useState<Record<string, PaneRect>>({});
  const [focusTabsTick, setFocusTabsTick] = useState(0);
  const terminals = useMemo(
    () => Object.values(repos).flatMap((state) =>
      state.tabs.filter((tab): tab is WorkTerminalTab => tab.kind === 'terminal')),
    [repos],
  );
  const activePane = repo ? findWorkPane(repo.layout, repo.activePaneId) : null;
  const activePaneTabs = useMemo(
    () => activePane?.tabIds.flatMap((id) => repo?.tabs.find((tab) => tab.id === id) ?? []) ?? [],
    [activePane, repo?.tabs],
  );

  const registerPaneHost = useCallback((paneId: string, node: HTMLDivElement | null) => {
    if (node) paneHosts.current.set(paneId, node);
    else paneHosts.current.delete(paneId);
    setPaneHostVersion((value) => value + 1);
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const rootRect = root.getBoundingClientRect();
      const next: Record<string, PaneRect> = {};
      for (const [id, node] of paneHosts.current) {
        const rect = node.getBoundingClientRect();
        next[id] = {
          left: rect.left - rootRect.left,
          top: rect.top - rootRect.top,
          width: rect.width,
          height: rect.height,
        };
      }
      setPaneRects(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const node of paneHosts.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [paneHostVersion, repo?.layout, visible]);

  useEffect(() => {
    for (const tab of openRepos) void restore(tab.path);
  }, [openRepos, restore]);

  // Fast peer navigation follows editor/browser convention without competing
  // with repository switching on Mod+Tab. Capture first so a focused xterm
  // never forwards the shortcut to the shell before Work handles it.
  useEffect(() => {
    if (!visible || !repoPath || !repo || activePaneTabs.length === 0) return;
    const cycle = (event: globalThis.KeyboardEvent) => {
      const primary = platform === 'mac' ? event.metaKey : event.ctrlKey;
      if (!primary || event.altKey || event.shiftKey) return;
      const delta = event.key === 'PageUp' ? -1 : event.key === 'PageDown' ? 1 : 0;
      if (!delta) return;
      const id = adjacentWorkTabId(activePaneTabs, activePane?.activeTabId ?? null, delta);
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      activate(repoPath, id);
    };
    window.addEventListener('keydown', cycle, true);
    return () => window.removeEventListener('keydown', cycle, true);
  }, [activate, activePane?.activeTabId, activePaneTabs, platform, repo, repoPath, visible]);

  useEffect(() => {
    if (!visible) return;
    const focusTabs = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'F6' || activePaneTabs.length === 0) return;
      event.preventDefault();
      setFocusTabsTick((value) => value + 1);
    };
    window.addEventListener('keydown', focusTabs);
    return () => window.removeEventListener('keydown', focusTabs);
  }, [activePaneTabs.length, visible]);

  const jump = useCallback((tab: WorkFileTab, hash: string) => {
    useWork.getState().activate(tab.repoPath, tab.id);
    useRepo.getState().setWorkFileReturn({ repoPath: tab.repoPath, tabId: tab.id, path: tab.path });
    setView('commits');
    void selectCommit(hash);
  }, [selectCommit, setView]);

  return (
    <div
      ref={rootRef}
      className={'work-root' + (visible ? '' : ' work-hidden')}
      aria-hidden={!visible}
    >
      <TreeIconSprite />
      {repoPath && repo && (
        <WorkLayout
          node={repo.layout}
          repo={repo}
          repoPath={repoPath}
          repoName={repoFamilyName(meta)}
          visible={visible}
          activePaneId={repo.activePaneId}
          focusTabsTick={focusTabsTick}
          onActivate={(id) => activate(repoPath, id)}
          onActivatePane={(paneId) => activatePane(repoPath, paneId)}
          onClose={(id) => void close(repoPath, id)}
          onNewTerminal={(paneId, shell, label) => addTerminal(repoPath, shell, label, paneId)}
          onOpenFile={(paneId, path, revision, isDirectory, mode) =>
            openFile(repoPath, path, revision, isDirectory, 'pinned', mode, paneId)}
          onSetFileMode={(id, mode) => setFileMode(repoPath, id, mode)}
          onSplit={(paneId, direction) => splitPane(repoPath, paneId, direction)}
          onJump={jump}
          registerPaneHost={registerPaneHost}
        />
      )}

      {/* Terminal renderers stay under one stable parent while their measured
          pane rectangle changes. Splitting and resizing therefore preserve
          xterm scrollback, selection, and the live PTY process. */}
      <div className="terminal-runtime-layer">
        {terminals.map((tab) => {
          const terminalRepo = repos[tab.repoPath];
          const pane = terminalRepo
            ? workPanes(terminalRepo.layout).find((candidate) => candidate.tabIds.includes(tab.id))
            : null;
          const isVisible = Boolean(
            visible
            && repoPath === tab.repoPath
            && pane?.activeTabId === tab.id
            && paneRects[pane.id],
          );
          return (
            <TerminalPane
              key={tab.id}
              tab={tab}
              visible={isVisible}
              rect={pane ? paneRects[pane.id] : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface WorkPaneProps {
  repo: RepoWorkTabs;
  repoPath: string;
  repoName: string;
  visible: boolean;
  activePaneId: string;
  focusTabsTick: number;
  onActivate(id: string): void;
  onActivatePane(paneId: string): void;
  onClose(id: string): void;
  onNewTerminal(paneId: string, shell?: EmbeddedShellChoice | null, label?: string): void;
  onOpenFile(
    paneId: string,
    path: string,
    revision: string | null,
    isDirectory: boolean,
    mode?: WorkFileMode,
  ): void;
  onSetFileMode(id: string, mode: WorkFileMode): void;
  onSplit(paneId: string, direction: 'horizontal' | 'vertical'): void;
  onJump(tab: WorkFileTab, hash: string): void;
  registerPaneHost(paneId: string, node: HTMLDivElement | null): void;
}

function WorkLayout({
  node,
  layoutPath = 'root',
  ...props
}: WorkPaneProps & {
  node: WorkPaneLayout;
  layoutPath?: string;
}) {
  if (node.kind === 'pane') return <WorkPaneView pane={node} {...props} />;
  return (
    <PanelGroup
      direction={node.direction}
      autoSaveId={`strand:work:${layoutPath}:${node.direction}`}
      className="work-layout"
    >
      <Panel minSize={20}>
        <WorkLayout node={node.children[0]} layoutPath={`${layoutPath}.0`} {...props} />
      </Panel>
      <PanelResizeHandle className={`rs-handle ${node.direction === 'horizontal' ? 'vert' : 'horiz'}`} />
      <Panel minSize={20}>
        <WorkLayout node={node.children[1]} layoutPath={`${layoutPath}.1`} {...props} />
      </Panel>
    </PanelGroup>
  );
}

function WorkPaneView({
  pane,
  repo,
  repoPath,
  repoName,
  visible,
  activePaneId,
  focusTabsTick,
  onActivate,
  onActivatePane,
  onClose,
  onNewTerminal,
  onOpenFile,
  onSetFileMode,
  onSplit,
  onJump,
  registerPaneHost,
}: WorkPaneProps & {
  pane: WorkPane;
}) {
  const tabs = pane.tabIds.flatMap((id) => repo.tabs.find((tab) => tab.id === id) ?? []);
  const active = tabs.find((tab) => tab.id === pane.activeTabId) ?? null;
  const isActive = pane.id === activePaneId;
  const hostRef = useCallback(
    (node: HTMLDivElement | null) => registerPaneHost(pane.id, node),
    [pane.id, registerPaneHost],
  );

  return (
    <section
      className={'work-pane' + (isActive ? ' active' : '')}
      aria-label={t('work.paneLabel')}
      onPointerDownCapture={() => onActivatePane(pane.id)}
      onFocusCapture={() => onActivatePane(pane.id)}
    >
      <WorkTabs
        tabs={tabs}
        activeId={pane.activeTabId}
        focusRequested={isActive ? focusTabsTick : 0}
        onActivate={onActivate}
        onClose={onClose}
        onNewTerminal={(shell, label) => onNewTerminal(pane.id, shell, label)}
        onSplit={(direction) => onSplit(pane.id, direction)}
      />
      <div
        ref={hostRef}
        className="work-content"
      >
        {visible && active?.kind === 'file' && (
          active.missing ? (
            <div className="work-empty" role="status">
              <Icon name="file" size={24} />
              <strong>{t('work.fileMissingTitle')}</strong>
              <span>{t('work.fileMissingBody', { path: active.path })}</span>
            </div>
          ) : (
            <FileDocument
              key={active.id}
              path={active.path}
              repoPath={repoPath}
              revision={active.revision}
              isDirectory={active.isDirectory}
              mode={active.mode}
              repoName={repoName}
              onModeChange={(mode) => onSetFileMode(active.id, mode)}
              onJump={(hash) => onJump(active, hash)}
              onOpenPath={(path, isDirectory, mode) =>
                onOpenFile(pane.id, path, active.revision, isDirectory, mode)}
              embedded
            />
          )
        )}
        {visible && !active && (
          <div className="work-empty">
            <Icon name="terminal" size={24} />
            <strong>{t('work.emptyPaneTitle')}</strong>
            <span>{t('work.emptyBody')}</span>
            <button type="button" className="btn primary" onClick={() => onNewTerminal(pane.id)}>
              <Icon name="terminal" size={13} />
              {t('work.newTerminal')}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function WorkTabs({
  tabs,
  activeId,
  focusRequested,
  onActivate,
  onClose,
  onNewTerminal,
  onSplit,
}: {
  tabs: WorkTab[];
  activeId: string | null;
  focusRequested: number;
  onActivate(id: string): void;
  onClose(id: string): void;
  onNewTerminal(shell?: EmbeddedShellChoice | null, label?: string): void;
  onSplit(direction: 'horizontal' | 'vertical'): void;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const moveFocus = (current: string, key: string) => {
    const index = tabs.findIndex((tab) => tab.id === current);
    if (index < 0 || tabs.length === 0) return;
    const next = key === 'Home' ? 0
      : key === 'End' ? tabs.length - 1
        : key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
          : (index + 1) % tabs.length;
    const tab = tabs[next];
    onActivate(tab.id);
    requestAnimationFrame(() => buttons.current.get(tab.id)?.focus());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      moveFocus(id, event.key);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onClose(id);
    }
  };

  useEffect(() => {
    if (!focusRequested || tabs.length === 0) return;
    buttons.current.get(activeId ?? tabs[0].id)?.focus();
  }, [activeId, focusRequested, tabs]);

  useLayoutEffect(() => {
    const lane = scrollRef.current;
    if (!lane) return;
    const measure = () => setOverflowing(lane.scrollWidth > lane.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(lane);
    return () => observer.disconnect();
  }, [tabs]);

  useEffect(() => {
    if (!activeId) return;
    buttons.current.get(activeId)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeId, tabs]);

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const lane = scrollRef.current;
    if (!lane || lane.scrollWidth <= lane.clientWidth) return;
    if (event.deltaX === 0 && event.deltaY !== 0) lane.scrollLeft += event.deltaY;
  };

  return (
    <div className="work-tabbar">
      <div
        className="work-tabs"
        ref={scrollRef}
        role="tablist"
        aria-label={t('work.tabsLabel')}
        onWheel={onWheel}
      >
        {tabs.map((tab) => (
          <div
            className={'work-tab-wrap' + (activeId === tab.id ? ' active' : '')}
            key={tab.id}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              onClose(tab.id);
            }}
          >
            <button
              ref={(node) => {
                if (node) buttons.current.set(tab.id, node);
                else buttons.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              aria-selected={activeId === tab.id}
              tabIndex={activeId === tab.id || (!activeId && tab === tabs[0]) ? 0 : -1}
              className={'work-tab' + (tab.kind === 'file' && tab.preview ? ' preview' : '')}
              title={tab.kind === 'file' ? tab.path : tab.label}
              onClick={() => onActivate(tab.id)}
              onKeyDown={(event) => onKeyDown(event, tab.id)}
            >
              {tab.kind === 'file' ? (
                tab.isDirectory ? <Icon name="folder" size={14} /> : <TreeFileIcon path={tab.path} />
              ) : (
                <Icon name="terminal" size={14} />
              )}
              <span>{tab.kind === 'file' ? leaf(tab.path) : tab.label}</span>
              {tab.kind === 'terminal' && (
                <span className={`work-terminal-state ${tab.lifecycle}`} aria-label={terminalStatus(tab)} />
              )}
            </button>
            <button
              type="button"
              className="work-tab-close"
              aria-label={t('work.closeTab', { label: tab.kind === 'file' ? leaf(tab.path) : tab.label })}
              onClick={() => onClose(tab.id)}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
      </div>
      {overflowing && (
        <WorkTabSelector tabs={tabs} activeId={activeId} onPick={onActivate} />
      )}
      <div className="work-pane-actions">
        <button
          type="button"
          className="work-pane-action"
          title={t('work.splitRight')}
          aria-label={t('work.splitRight')}
          disabled={!activeId}
          onClick={() => onSplit('horizontal')}
        >
          <Icon name="split" size={13} />
        </button>
        <button
          type="button"
          className="work-pane-action"
          title={t('work.splitDown')}
          aria-label={t('work.splitDown')}
          disabled={!activeId}
          onClick={() => onSplit('vertical')}
        >
          <Icon name="unified" size={13} />
        </button>
      </div>
      <NewTerminalButton onNewTerminal={onNewTerminal} />
    </div>
  );
}

function NewTerminalButton({
  onNewTerminal,
}: {
  onNewTerminal(shell?: EmbeddedShellChoice | null, label?: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [wslDistributions, setWslDistributions] = useState<string[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const options = embeddedShellOptions(wslDistributions);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void tauri.terminalWslDistributions()
      .then((items) => { if (!cancelled) setWslDistributions(items); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [open]);

  useOutsideClose([wrapRef, menuRef], open, () => setOpen(false));

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      toggleRef.current?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (items.length === 0) return;
    event.preventDefault();
    items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  };

  const choose = (shell: EmbeddedShellChoice | null, label?: string) => {
    setOpen(false);
    onNewTerminal(shell, label);
  };

  return (
    <div ref={wrapRef} className="work-new-terminal-group">
      <button
        type="button"
        className="work-new-terminal"
        onClick={() => onNewTerminal()}
        title={t('work.newTerminalDefault')}
        aria-label={t('work.newTerminalDefault')}
      >
        <Icon name="plus" size={12} />
        <Icon name="terminal" size={13} />
      </button>
      <button
        ref={toggleRef}
        type="button"
        className="work-new-terminal-toggle"
        title={t('work.chooseTerminalShell')}
        aria-label={t('work.chooseTerminalShell')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="chev-down" size={10} />
      </button>
      {open && position && createPortal(
        <div
          ref={menuRef}
          className="repo-menu work-new-terminal-menu"
          role="menu"
          style={{ position: 'fixed', top: position.top, right: position.right, left: 'auto' }}
          onKeyDown={onMenuKeyDown}
        >
          <button type="button" className="repo-menu-item" role="menuitem" onClick={() => choose(null)}>
            <span className="ico"><Icon name="terminal" size={13} /></span>
            <span className="label">{t('work.configuredDefaultShell')}</span>
          </button>
          <div className="repo-menu-sect">{t('work.openWithShell')}</div>
          {options.map((option) => (
            <button
              type="button"
              className="repo-menu-item"
              role="menuitem"
              key={option.value}
              onClick={() => choose(option.choice, option.label)}
            >
              <span className="ico"><Icon name="terminal" size={13} /></span>
              <span className="label">{option.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function WorkTabSelector({
  tabs,
  activeId,
  onPick,
}: {
  tabs: WorkTab[];
  activeId: string | null;
  onPick(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }, [open]);

  useOutsideClose([wrapRef, menuRef], open, () => setOpen(false));

  return (
    <div ref={wrapRef} className="work-tab-selector-wrap">
      <button
        type="button"
        className="work-tab-selector"
        title={t('work.allTabs')}
        aria-label={t('work.allTabs')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="chev-down" size={12} />
      </button>
      {open && position && createPortal(
        <div
          ref={menuRef}
          className="repo-menu work-tab-menu"
          role="menu"
          style={{ position: 'fixed', top: position.top, right: position.right, left: 'auto' }}
        >
          <div className="repo-menu-sect">{t('work.openTabs')}</div>
          {tabs.map((tab) => {
            const active = tab.id === activeId;
            const label = tab.kind === 'file' ? leaf(tab.path) : tab.label;
            return (
              <button
                type="button"
                key={tab.id}
                className="repo-menu-item"
                role="menuitemradio"
                aria-checked={active}
                title={tab.kind === 'file' ? tab.path : tab.label}
                onClick={() => {
                  setOpen(false);
                  onPick(tab.id);
                }}
              >
                <span className="ico">
                  {tab.kind === 'file' ? (
                    tab.isDirectory ? <Icon name="folder" size={14} /> : <TreeFileIcon path={tab.path} />
                  ) : (
                    <Icon name="terminal" size={14} />
                  )}
                </span>
                <span className="label">{label}</span>
                {tab.kind === 'terminal' && (
                  <span className={`work-terminal-state ${tab.lifecycle}`} aria-label={terminalStatus(tab)} />
                )}
                {active && <span className="meta"><Icon name="check" size={12} stroke={2.2} /></span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

function TerminalPane({
  tab,
  visible,
  rect,
}: {
  tab: WorkTerminalTab;
  visible: boolean;
  rect?: PaneRect;
}) {
  const resolvedTheme = useSettings((state) => state.resolvedTheme);
  const terminalFont = useSettings((state) => state.terminalFont);
  const terminalFontSize = useSettings((state) => state.terminalFontSize);
  const fontFamily = TERMINAL_FONTS[terminalFont];
  const fontSpec = terminalFontSpec(terminalFont, terminalFontSize);
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const runtimeId = useRef<string | null>(tab.runtimeId);
  const pendingInput = useRef('');
  const starting = useRef(false);
  const [initializeRenderer, setInitializeRenderer] = useState(
    () => visible || tab.lifecycle !== 'dormant',
  );
  runtimeId.current = tab.runtimeId;

  useEffect(() => {
    if (visible) setInitializeRenderer(true);
  }, [visible]);

  const fitAndResize = useCallback((id: string | null = runtimeId.current) => {
    const instance = terminal.current;
    const addon = fit.current;
    if (!instance || !addon) return fitDimensions(instance);
    addon.fit();
    instance.refresh(0, instance.rows - 1);
    const dimensions = fitDimensions(instance);
    if (id) void tauri.terminalResize(id, dimensions.cols, dimensions.rows).catch(() => undefined);
    return dimensions;
  }, []);

  const start = useCallback(async () => {
    if (starting.current) return;
    const live = useWork.getState().repos[tab.repoPath]?.tabs.find((item) => item.id === tab.id);
    if (!live || live.kind !== 'terminal' || live.lifecycle !== 'dormant') return;
    starting.current = true;
    useWork.getState().setTerminalState(tab.repoPath, tab.id, 'starting');
    // Fit before process creation so full-screen TUIs receive the actual host
    // grid in their first WINCH/layout pass instead of xterm's 80x24 default.
    const dimensions = fitAndResize(null);
    try {
      const repoMeta = useRepo.getState().tabs.find((item) => item.path === tab.repoPath)?.meta;
      const override = repoMeta ? await repoEmbeddedShell.get(repoMeta.common_dir) : null;
      const shell = tab.shell ?? override ?? useSettings.getState().embeddedShell;
      const handle = await tauri.repoTerminalCreate(
        tab.repoPath,
        shell,
        dimensions.cols,
        dimensions.rows,
        (event) => onTerminalEvent(tab, terminal.current, event),
      );
      const stillOpen = useWork.getState().repos[tab.repoPath]?.tabs.some((item) => item.id === tab.id);
      if (!stillOpen) {
        await tauri.terminalClose(handle.id);
        return;
      }
      useWork.getState().setTerminalRuntime(tab.repoPath, tab.id, handle.id);
      runtimeId.current = handle.id;
      if (pendingInput.current) {
        const input = pendingInput.current;
        pendingInput.current = '';
        await tauri.terminalWrite(handle.id, input);
      }
      // The ResizeObserver may have fired while the PTY id was unavailable.
      // Synchronize once more after creation so the native grid cannot remain
      // stale when a full-screen app takes over the alternate screen.
      requestAnimationFrame(() => fitAndResize(handle.id));
    } catch (error) {
      useWork.getState().setTerminalState(tab.repoPath, tab.id, 'error', { error: errMessage(error) });
    } finally {
      starting.current = false;
    }
  }, [fitAndResize, tab]);

  useEffect(() => {
    if (!initializeRenderer || !container.current || terminal.current) return;
    let cancelled = false;
    const createRenderer = () => {
      if (cancelled || !container.current || terminal.current) return;
      const current = useSettings.getState();
      const styles = getComputedStyle(document.documentElement);
      const instance = new Terminal({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        customGlyphs: true,
        fontFamily: TERMINAL_FONTS[current.terminalFont],
        fontSize: current.terminalFontSize,
        fontWeight: 400,
        fontWeightBold: 600,
        letterSpacing: 0,
        lineHeight: 1.2,
        scrollback: 5_000,
        theme: terminalTheme(styles),
      });
      const addon = new FitAddon();
      instance.loadAddon(addon);
      instance.open(container.current);
      terminal.current = instance;
      fit.current = addon;
      instance.onData((value) => {
        const id = runtimeId.current;
        if (id) {
          void tauri.terminalWrite(id, value).catch(() => undefined);
        } else if (starting.current) {
          pendingInput.current = (pendingInput.current + value).slice(-64 * 1024);
        }
      });
      if (visible && tab.lifecycle === 'dormant') void start();
    };
    if (document.fonts) void document.fonts.load(fontSpec).finally(createRenderer);
    else createRenderer();
    return () => { cancelled = true; };
  }, [fontSpec, initializeRenderer, start, tab.lifecycle, visible]);

  useEffect(() => () => {
    terminal.current?.dispose();
    terminal.current = null;
    fit.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const applyFont = () => {
      const instance = terminal.current;
      if (cancelled || !instance) return;
      instance.options.fontFamily = fontFamily;
      instance.options.fontSize = terminalFontSize;
      if (visible) requestAnimationFrame(() => fitAndResize());
    };
    if (document.fonts) void document.fonts.load(fontSpec).finally(applyFont);
    else applyFont();
    return () => { cancelled = true; };
  }, [fitAndResize, fontFamily, fontSpec, terminalFontSize, visible]);

  useEffect(() => {
    const instance = terminal.current;
    if (!instance) return;
    const styles = getComputedStyle(document.documentElement);
    instance.options.theme = terminalTheme(styles);
  }, [resolvedTheme]);

  useEffect(() => {
    if (visible && tab.lifecycle === 'dormant' && terminal.current) void start();
  }, [start, tab.lifecycle, visible]);

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    let timer: number | undefined;
    const resize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!visible) return;
        fitAndResize();
      }, 80);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [fitAndResize, visible]);

  const relaunch = () => {
    terminal.current?.write(`\r\n\x1b[2m${t('work.terminalRelaunchDivider')}\x1b[0m\r\n`);
    useWork.getState().setTerminalState(tab.repoPath, tab.id, 'dormant', { exitCode: null, error: null });
  };

  return (
    <div
      className={'work-terminal-pane' + (visible ? ' visible' : '')}
      style={rect as CSSProperties | undefined}
    >
      <div ref={container} className="work-terminal-host" />
      {visible && (tab.lifecycle === 'exited' || tab.lifecycle === 'error') && (
        <div className="work-terminal-exit" role="status">
          <span>{tab.lifecycle === 'exited'
            ? t('work.terminalExited', { code: tab.exitCode ?? 0 })
            : t('work.terminalError', { reason: tab.error ?? t('work.terminalUnknownError') })}</span>
          <button type="button" className="btn" onClick={relaunch}>{t('work.relaunch')}</button>
        </div>
      )}
    </div>
  );
}

function onTerminalEvent(tab: WorkTerminalTab, terminal: Terminal | null, event: TerminalEvent): void {
  if (event.type === 'output') {
    const binary = atob(event.data);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    terminal?.write(bytes);
  } else if (event.type === 'exit') {
    useWork.getState().clearTerminalRuntime(tab.repoPath, tab.id);
    useWork.getState().setTerminalState(tab.repoPath, tab.id, 'exited', { exitCode: event.code });
  } else {
    useWork.getState().clearTerminalRuntime(tab.repoPath, tab.id);
    useWork.getState().setTerminalState(tab.repoPath, tab.id, 'error', { error: event.message });
  }
}

function fitDimensions(terminal: Terminal | null): { cols: number; rows: number } {
  return { cols: Math.max(2, terminal?.cols ?? 80), rows: Math.max(1, terminal?.rows ?? 24) };
}

const TERMINAL_FONT_FACE: Record<TerminalFont, string> = {
  jetbrains: 'JetBrains Mono Terminal',
  geist: 'Geist Mono',
  plex: 'IBM Plex Mono',
  commit: 'Commit Mono',
  system: 'monospace',
};

function terminalFontSpec(font: TerminalFont, size: number): string {
  const face = TERMINAL_FONT_FACE[font];
  return `400 ${size}px ${font === 'system' ? face : `"${face}"`}`;
}

function terminalTheme(styles: CSSStyleDeclaration) {
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--bg-base', '#111111'),
    foreground: token('--text', '#e5e5e5'),
    cursor: token('--accent', '#d6a657'),
    selectionBackground: token('--bg-sel', '#343434'),
    black: token('--bg-os', '#111111'),
    red: token('--del', '#e06c75'),
    green: token('--add', '#98c379'),
    yellow: token('--warn', '#e5c07b'),
    blue: token('--accent', '#61afef'),
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: token('--text', '#e5e5e5'),
  };
}

function leaf(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

function terminalStatus(tab: WorkTerminalTab): string {
  if (tab.lifecycle === 'running') return t('work.terminalRunning');
  if (tab.lifecycle === 'starting') return t('work.terminalStarting');
  if (tab.lifecycle === 'exited') return t('work.terminalExited', { code: tab.exitCode ?? 0 });
  if (tab.lifecycle === 'error') return t('work.terminalErrorShort');
  return t('work.terminalDormant');
}
