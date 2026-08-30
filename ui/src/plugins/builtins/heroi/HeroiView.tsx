import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';

import { Icon } from '../../../components/Icon';
import { pickRepoDirectories } from '../../../lib/dialog';
import { errMessage } from '../../../lib/tauri';
import { plural, t } from '../../../lib/i18n';
import type { SurfaceRenderRequest } from '../../../workbench/SurfaceHost';
import { useRepo } from '../../../stores/repo';
import { useWork } from '../../../stores/work';
import { useWorkspaces } from '../../../stores/workspaces';
import { MARKETPLACE_CATALOG } from '../../marketplace';
import type { PluginCapabilityBroker } from '../../capabilities';
import { pluginStateKey, usePlugins } from '../../../stores/plugins';
import { HeroiLogo } from './HeroiLogo';
import { HEROI_NEW_CONVERSATION_EVENT, STRAND_OPEN_SETTINGS_EVENT } from './events';

export type HeroiProvider = 'claude' | 'codex' | 'cursor';
type AgentMode = 'plan' | 'build';
type PermissionMode = 'read' | 'build' | 'full';
type ThinkingLevel = 'default' | 'low' | 'medium' | 'high';
type Overlay = 'none' | 'marketplace';
type ChipMenu = 'provider' | 'model' | 'thinking' | 'mode' | 'permission' | null;

interface HeroiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
}

interface HeroiConversation {
  id: string;
  projectPath: string;
  title: string;
  provider: HeroiProvider;
  model: string;
  thinking: ThinkingLevel;
  agentMode: AgentMode;
  permissionMode: PermissionMode;
  messages: HeroiMessage[];
  createdAt: number;
}

interface HeroiDraft {
  projectPath: string;
  provider: HeroiProvider;
  model: string;
  thinking: ThinkingLevel;
  agentMode: AgentMode;
  permissionMode: PermissionMode;
}

interface KanbanColumn {
  id: string;
  name: string;
}

interface KanbanCard {
  id: string;
  title: string;
  columnId: string;
}

interface KanbanBoard {
  columns: KanbanColumn[];
  cards: KanbanCard[];
}

interface PersistedHeroiState {
  conversations?: HeroiConversation[];
  activeConversationId?: string | null;
  draft?: HeroiDraft | null;
  expanded?: string[];
  kanbanProjectPath?: string | null;
  kanbanByProject?: Record<string, KanbanBoard>;
  overlay?: Overlay;
  diffVisible?: boolean;
  terminalVisible?: boolean;
}

const PROVIDERS: readonly { id: HeroiProvider; label: string; command: string }[] = [
  { id: 'claude', label: 'Claude', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'cursor', label: 'Cursor', command: 'cursor' },
];

const MODELS: Record<HeroiProvider, readonly string[]> = {
  claude: ['default', 'opus', 'sonnet'],
  codex: ['default', 'gpt-5'],
  cursor: ['default', 'composer'],
};

const THINKING: readonly ThinkingLevel[] = ['default', 'low', 'medium', 'high'];
const MODES: readonly AgentMode[] = ['plan', 'build'];
const PERMISSIONS: readonly PermissionMode[] = ['read', 'build', 'full'];
const COLLAPSED_CHAT_LIMIT = 5;

const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: 'backlog', name: 'Backlog' },
  { id: 'progress', name: 'In Progress' },
  { id: 'done', name: 'Done' },
];

function modLabel(): string {
  try {
    const platform = (typeof navigator !== 'undefined' && navigator.platform) || '';
    if (platform.toLowerCase().includes('mac')) return '⌘';
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    return /macintosh|mac os x/i.test(ua) ? '⌘' : 'Ctrl';
  } catch {
    return 'Ctrl';
  }
}

function pathLeaf(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function mintId(prefix: string): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}-${crypto.randomUUID()}`;
    }
  } catch {
    // fall through
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function providerMeta(id: HeroiProvider) {
  return PROVIDERS.find((entry) => entry.id === id) ?? PROVIDERS[0];
}

function titleFromText(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.slice(0, 48) || t('plugins.heroi.untitled');
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function emptyBoard(): KanbanBoard {
  return { columns: DEFAULT_COLUMNS.map((column) => ({ ...column })), cards: [] };
}

export function HeroiView({
  request,
  broker,
}: {
  request: SurfaceRenderRequest;
  broker: PluginCapabilityBroker;
}) {
  const meta = useRepo((state) => state.meta);
  const tabs = useRepo((state) => state.tabs);
  const activeTabPath = useRepo((state) => state.activeTabPath);
  const setActiveTab = useRepo((state) => state.setActiveTab);
  const unstagedDiffs = useRepo((state) => state.unstagedDiffs);
  const stagedDiffs = useRepo((state) => state.stagedDiffs);
  const selectFile = useRepo((state) => state.selectFile);
  const addTerminal = useWork((state) => state.addTerminal);
  const loadPluginState = usePlugins((state) => state.loadState);
  const savePluginState = usePlugins((state) => state.saveState);
  const installedIds = usePlugins((state) => state.installedIds);
  const installPlugin = usePlugins((state) => state.install);
  const uninstallPlugin = usePlugins((state) => state.uninstall);
  const pluginsReady = usePlugins((state) => state.ready);

  const [conversations, setConversations] = useState<HeroiConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState<HeroiDraft | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [kanbanProjectPath, setKanbanProjectPath] = useState<string | null>(null);
  const [kanbanByProject, setKanbanByProject] = useState<Record<string, KanbanBoard>>({});
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [diffVisible, setDiffVisible] = useState(true);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [chipMenu, setChipMenu] = useState<ChipMenu>(null);
  const [composerText, setComposerText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [newCardColumn, setNewCardColumn] = useState<string | null>(null);
  const [newCardTitle, setNewCardTitle] = useState('');

  const rootRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stateKey = pluginStateKey('daniels.heroi', request.instanceId);
  const activePath = activeTabPath ?? meta?.path ?? tabs[0]?.path ?? '';
  const hasProjects = tabs.length > 0;
  const activeConversation = conversations.find((row) => row.id === activeConversationId) ?? null;
  const settings = draft ?? activeConversation;

  const changedFiles = useMemo(() => {
    const seen = new Set<string>();
    const rows: { path: string; kind: 'staged' | 'unstaged'; adds: number; dels: number }[] = [];
    for (const diff of stagedDiffs) {
      if (seen.has(diff.path)) continue;
      seen.add(diff.path);
      rows.push({ path: diff.path, kind: 'staged', adds: diff.adds, dels: diff.dels });
    }
    for (const diff of unstagedDiffs) {
      if (seen.has(diff.path)) continue;
      seen.add(diff.path);
      rows.push({ path: diff.path, kind: 'unstaged', adds: diff.adds, dels: diff.dels });
    }
    return rows;
  }, [stagedDiffs, unstagedDiffs]);

  useEffect(() => {
    let current = true;
    void loadPluginState<PersistedHeroiState>(stateKey).then((stored) => {
      if (!current) return;
      if (stored?.conversations) setConversations(stored.conversations);
      if (stored?.activeConversationId !== undefined) setActiveConversationId(stored.activeConversationId);
      if (stored?.draft) setDraft(stored.draft);
      if (stored?.expanded?.length) setExpanded(new Set(stored.expanded));
      else if (activePath) setExpanded(new Set([activePath]));
      if (stored?.kanbanProjectPath) setKanbanProjectPath(stored.kanbanProjectPath);
      if (stored?.kanbanByProject) setKanbanByProject(stored.kanbanByProject);
      if (stored?.overlay) setOverlay(stored.overlay);
      if (typeof stored?.diffVisible === 'boolean') setDiffVisible(stored.diffVisible);
      if (typeof stored?.terminalVisible === 'boolean') setTerminalVisible(stored.terminalVisible);
      setRestored(true);
    });
    return () => { current = false; };
  }, [activePath, loadPluginState, stateKey]);

  useEffect(() => {
    if (!restored) return;
    void savePluginState(stateKey, {
      conversations,
      activeConversationId,
      draft,
      expanded: [...expanded],
      kanbanProjectPath,
      kanbanByProject,
      overlay,
      diffVisible,
      terminalVisible,
    } satisfies PersistedHeroiState);
  }, [
    activeConversationId,
    conversations,
    diffVisible,
    draft,
    expanded,
    kanbanByProject,
    kanbanProjectPath,
    overlay,
    restored,
    savePluginState,
    stateKey,
    terminalVisible,
  ]);

  useEffect(() => {
    if (!chipMenu) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.plugin-heroi-chip-wrap')) setChipMenu(null);
    };
    window.addEventListener('mousedown', onPointer);
    return () => window.removeEventListener('mousedown', onPointer);
  }, [chipMenu]);

  const startDraft = useCallback((projectPath: string) => {
    if (!projectPath) {
      setError(t('plugins.heroi.noRepository'));
      return;
    }
    setDraft({
      projectPath,
      provider: 'claude',
      model: 'default',
      thinking: 'default',
      agentMode: 'build',
      permissionMode: 'build',
    });
    setComposerText('');
    setActiveConversationId(null);
    setKanbanProjectPath(null);
    setExpanded((current) => new Set(current).add(projectPath));
    setOverlay('none');
    setError(null);
    setStatusNote(null);
    queueMicrotask(() => composerRef.current?.focus());
  }, []);

  useEffect(() => {
    const onNew = () => startDraft(activePath || tabs[0]?.path || '');
    window.addEventListener(HEROI_NEW_CONVERSATION_EVENT, onNew);
    return () => window.removeEventListener(HEROI_NEW_CONVERSATION_EVENT, onNew);
  }, [activePath, startDraft, tabs]);

  useEffect(() => {
    if (!request.lifecycle.focused) return;
    rootRef.current?.focus({ preventScroll: true });
    if (draft || activeConversation) composerRef.current?.focus();
  }, [activeConversation, draft, request.lifecycle.focused]);

  const patchSettings = useCallback((patch: Partial<HeroiDraft>) => {
    if (draft) {
      setDraft({ ...draft, ...patch });
      return;
    }
    if (!activeConversationId) return;
    setConversations((current) => current.map((row) => (
      row.id === activeConversationId ? { ...row, ...patch } : row
    )));
  }, [activeConversationId, draft]);

  const addProject = useCallback(async () => {
    try {
      const paths = await pickRepoDirectories();
      for (const path of paths) {
        await useWorkspaces.getState().openRepoInActive(path);
        setExpanded((current) => new Set(current).add(path));
      }
      if (paths.length === 0) setError(t('plugins.heroi.addProjectHint'));
      else setError(null);
    } catch (caught) {
      setError(errMessage(caught));
    }
  }, []);

  const runInWork = useCallback((projectPath: string, provider: HeroiProvider) => {
    if (!projectPath) {
      setError(t('plugins.heroi.noRepository'));
      return;
    }
    const agent = providerMeta(provider);
    void broker.readRepository(
      projectPath,
      meta?.branch ?? null,
      meta?.head_oid ?? null,
      unstagedDiffs.length + stagedDiffs.length > 0,
    ).catch(() => undefined);
    addTerminal(projectPath, null, agent.label);
    setStatusNote(t('plugins.heroi.launchedWithCommand', { agent: agent.label, command: agent.command }));
    setError(null);
  }, [addTerminal, broker, meta?.branch, meta?.head_oid, stagedDiffs.length, unstagedDiffs.length]);

  const sendMessage = useCallback(() => {
    const text = composerText.trim();
    if (!text) return;
    const projectPath = draft?.projectPath ?? activeConversation?.projectPath ?? activePath;
    if (!projectPath) {
      setError(t('plugins.heroi.noRepository'));
      return;
    }
    const provider = draft?.provider ?? activeConversation?.provider ?? 'claude';
    const agent = providerMeta(provider);
    const now = Date.now();
    const userMessage: HeroiMessage = { id: mintId('m'), role: 'user', text, createdAt: now };
    const assistantMessage: HeroiMessage = {
      id: mintId('m'),
      role: 'assistant',
      text: t('plugins.heroi.hostReply', { agent: agent.label, command: agent.command, path: projectPath }),
      createdAt: now + 1,
    };

    if (draft || !activeConversation) {
      const conversation: HeroiConversation = {
        id: mintId('c'),
        projectPath,
        title: titleFromText(text),
        provider,
        model: draft?.model ?? 'default',
        thinking: draft?.thinking ?? 'default',
        agentMode: draft?.agentMode ?? 'build',
        permissionMode: draft?.permissionMode ?? 'build',
        messages: [userMessage, assistantMessage],
        createdAt: now,
      };
      setConversations((current) => [conversation, ...current]);
      setActiveConversationId(conversation.id);
      setDraft(null);
    } else {
      setConversations((current) => current.map((row) => (
        row.id === activeConversation.id
          ? { ...row, messages: [...row.messages, userMessage, assistantMessage] }
          : row
      )));
    }
    setComposerText('');
    runInWork(projectPath, provider);
  }, [activeConversation, activePath, composerText, draft, runInWork]);

  const deleteConversation = useCallback((conversation: HeroiConversation) => {
    if (!window.confirm(t('plugins.heroi.deleteConfirm', { title: conversation.title }))) return;
    setConversations((current) => current.filter((row) => row.id !== conversation.id));
    if (activeConversationId === conversation.id) setActiveConversationId(null);
  }, [activeConversationId]);

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const openKanban = useCallback((path: string) => {
    setKanbanProjectPath(path);
    setActiveConversationId(null);
    setDraft(null);
    setKanbanByProject((current) => current[path] ? current : { ...current, [path]: emptyBoard() });
    void setActiveTab(path);
  }, [setActiveTab]);

  const addKanbanCard = useCallback((columnId: string, title: string) => {
    if (!kanbanProjectPath) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    setKanbanByProject((current) => {
      const board = current[kanbanProjectPath] ?? emptyBoard();
      return {
        ...current,
        [kanbanProjectPath]: {
          ...board,
          cards: [...board.cards, { id: mintId('k'), title: trimmed, columnId }],
        },
      };
    });
    setNewCardColumn(null);
    setNewCardTitle('');
  }, [kanbanProjectPath]);

  const moveKanbanCard = useCallback((cardId: string, columnId: string) => {
    if (!kanbanProjectPath) return;
    setKanbanByProject((current) => {
      const board = current[kanbanProjectPath];
      if (!board) return current;
      return {
        ...current,
        [kanbanProjectPath]: {
          ...board,
          cards: board.cards.map((card) => card.id === cardId ? { ...card, columnId } : card),
        },
      };
    });
  }, [kanbanProjectPath]);

  const onSurfaceKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === '`' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      setTerminalVisible((value) => !value);
      return;
    }
    if (event.key === 'Escape') {
      if (chipMenu) { setChipMenu(null); event.preventDefault(); return; }
      if (overlay !== 'none') { setOverlay('none'); event.preventDefault(); return; }
      if (draft) { setDraft(null); event.preventDefault(); }
    }
  }, [chipMenu, draft, overlay]);

  const kanbanBoard = kanbanProjectPath ? (kanbanByProject[kanbanProjectPath] ?? emptyBoard()) : null;
  const ping = hasProjects ? t('plugins.heroi.connected') : t('plugins.heroi.waiting');
  const shortcut = modLabel();

  return (
    <div
      ref={rootRef}
      className="plugin-surface plugin-heroi"
      data-surface-id={request.contribution.id}
      data-focused={request.lifecycle.focused || undefined}
      tabIndex={-1}
      onKeyDown={onSurfaceKeyDown}
    >
      <header className="plugin-heroi-titlebar">
        <div className="plugin-heroi-title-brand">
          <HeroiLogo size={14} className="plugin-heroi-logo" />
          <span>heroi</span>
          <span className="plugin-heroi-dot">·</span>
          <span>{ping}</span>
        </div>
        {hasProjects && kanbanProjectPath === null && (
          <div className="plugin-heroi-title-actions">
            <button
              type="button"
              className={'plugin-heroi-icon-btn' + (diffVisible ? ' active' : '')}
              aria-pressed={diffVisible}
              aria-label={t('plugins.heroi.toggleDiff')}
              onClick={() => setDiffVisible((value) => !value)}
            >
              <Icon name="compare" size={12} />
            </button>
            <button
              type="button"
              className={'plugin-heroi-icon-btn' + (terminalVisible ? ' active' : '')}
              aria-pressed={terminalVisible}
              aria-label={t('plugins.heroi.toggleTerminal')}
              onClick={() => setTerminalVisible((value) => !value)}
            >
              <Icon name="terminal" size={12} />
            </button>
          </div>
        )}
      </header>

      <div className="plugin-heroi-body">
        {overlay === 'marketplace' ? (
          <MarketplaceOverlay
            ready={pluginsReady}
            installed={installedIds}
            onInstall={(id) => void installPlugin(id)}
            onUninstall={(id) => void uninstallPlugin(id)}
            onClose={() => setOverlay('none')}
          />
        ) : (
          <>
            <aside className="plugin-heroi-left" aria-label={t('plugins.heroi.sidebar')}>
              <header className="plugin-heroi-workspaces-head">
                <span>{t('plugins.heroi.workspaces')}</span>
                <button
                  type="button"
                  className="plugin-heroi-icon-btn"
                  aria-label={t('plugins.heroi.addProject')}
                  onClick={() => void addProject()}
                >
                  <Icon name="folder-plus" size={14} />
                </button>
              </header>

              <div className="plugin-heroi-workspace-list">
                {!hasProjects ? (
                  <div className="plugin-heroi-empty">
                    <p>{t('plugins.heroi.emptyRepos')}</p>
                    <p>{t('plugins.heroi.emptyReposHint')}</p>
                  </div>
                ) : tabs.map((tab) => {
                  const path = tab.path;
                  const isExpanded = expanded.has(path);
                  const projectChats = conversations.filter((row) => row.projectPath === path);
                  const visibleChats = showAll.has(path) ? projectChats : projectChats.slice(0, COLLAPSED_CHAT_LIMIT);
                  const hiddenCount = projectChats.length - visibleChats.length;
                  const kanbanFocused = kanbanProjectPath === path;
                  return (
                    <div key={path} className="plugin-heroi-project">
                      <div className="plugin-heroi-project-row">
                        <button
                          type="button"
                          className="plugin-heroi-project-toggle"
                          aria-expanded={isExpanded}
                          onClick={() => {
                            toggleExpanded(path);
                            void setActiveTab(path);
                          }}
                        >
                          <Icon name={isExpanded ? 'chev-down' : 'chev-right'} size={12} />
                          <Icon name="folder" size={12} />
                          <span className="plugin-heroi-project-name">{tab.meta?.name ?? pathLeaf(path)}</span>
                          <span className="plugin-heroi-project-count">{projectChats.length}</span>
                        </button>
                        <button
                          type="button"
                          className={'plugin-heroi-icon-btn' + (kanbanFocused ? ' active' : '')}
                          aria-label={t('plugins.heroi.openKanban')}
                          onClick={() => openKanban(path)}
                        >
                          <Icon name="workspace" size={12} />
                        </button>
                        <button
                          type="button"
                          className="plugin-heroi-icon-btn"
                          aria-label={t('plugins.heroi.newConversation')}
                          onClick={() => {
                            void setActiveTab(path);
                            startDraft(path);
                          }}
                        >
                          <Icon name="plus" size={12} />
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="plugin-heroi-chats">
                          {projectChats.length === 0 && (
                            <div className="plugin-heroi-chats-empty">{t('plugins.heroi.noConversations')}</div>
                          )}
                          {visibleChats.map((chat) => {
                            const active = chat.id === activeConversationId && !draft;
                            return (
                              <button
                                key={chat.id}
                                type="button"
                                className={'plugin-heroi-chat' + (active ? ' active' : '')}
                                onClick={() => {
                                  setActiveConversationId(chat.id);
                                  setDraft(null);
                                  setKanbanProjectPath(null);
                                  setComposerText('');
                                  void setActiveTab(path);
                                }}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  deleteConversation(chat);
                                }}
                              >
                                <span className="plugin-heroi-chat-dot" aria-hidden />
                                <span className="plugin-heroi-chat-title">{capitalize(chat.title)}</span>
                                {tab.meta?.branch && (
                                  <span className="plugin-heroi-branch">
                                    <Icon name="branch" size={8} />
                                    {tab.meta.branch}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                          {(hiddenCount > 0 || showAll.has(path)) && (
                            <button
                              type="button"
                              className="plugin-heroi-show-more"
                              onClick={() => setShowAll((current) => {
                                const next = new Set(current);
                                if (next.has(path)) next.delete(path);
                                else next.add(path);
                                return next;
                              })}
                            >
                              {showAll.has(path) ? t('plugins.heroi.showLess') : t('plugins.heroi.showMore', { count: hiddenCount })}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <footer className="plugin-heroi-left-foot">
                <button type="button" className="plugin-heroi-foot-btn" onClick={() => setOverlay('marketplace')}>
                  <Icon name="sparkle" size={14} />
                  {t('plugins.heroi.marketplace')}
                </button>
                <button
                  type="button"
                  className="plugin-heroi-foot-btn"
                  onClick={() => window.dispatchEvent(new CustomEvent(STRAND_OPEN_SETTINGS_EVENT, { detail: { section: 'plugins' } }))}
                >
                  <Icon name="settings" size={14} />
                  {t('plugins.heroi.settings')}
                </button>
              </footer>
            </aside>

            <main className="plugin-heroi-center">
              {!hasProjects ? (
                <Welcome ping={ping} />
              ) : kanbanBoard && kanbanProjectPath ? (
                <KanbanView
                  name={pathLeaf(kanbanProjectPath)}
                  board={kanbanBoard}
                  newCardColumn={newCardColumn}
                  newCardTitle={newCardTitle}
                  onNewTask={() => {
                    setNewCardColumn('backlog');
                    setNewCardTitle('');
                  }}
                  onNewCardColumn={setNewCardColumn}
                  onNewCardTitle={setNewCardTitle}
                  onAddCard={addKanbanCard}
                  onMoveCard={moveKanbanCard}
                />
              ) : draft || activeConversation ? (
                <ConversationView
                  title={draft ? t('plugins.heroi.newConversationTitle') : capitalize(activeConversation?.title ?? t('plugins.heroi.untitled'))}
                  cwd={draft?.projectPath ?? activeConversation?.projectPath ?? ''}
                  branch={meta?.branch ?? null}
                  messages={activeConversation && !draft ? activeConversation.messages : []}
                  composerText={composerText}
                  onComposerChange={setComposerText}
                  composerRef={composerRef}
                  shortcut={shortcut}
                  settings={settings}
                  chipMenu={chipMenu}
                  onChipMenu={setChipMenu}
                  onPatch={patchSettings}
                  onSend={sendMessage}
                  onRun={() => runInWork(
                    draft?.projectPath ?? activeConversation?.projectPath ?? '',
                    draft?.provider ?? activeConversation?.provider ?? 'claude',
                  )}
                  visible={request.lifecycle.visible}
                />
              ) : (
                <div className="plugin-heroi-select">{t('plugins.heroi.selectConversation')}</div>
              )}
              {hasProjects && kanbanProjectPath === null && terminalVisible && (
                <div className="plugin-heroi-terminal-strip">
                  <span>{t('plugins.heroi.terminalHintCommand', {
                    command: providerMeta(settings?.provider ?? 'claude').command,
                  })}</span>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!activePath || !request.lifecycle.visible}
                    onClick={() => runInWork(activePath, settings?.provider ?? 'claude')}
                  >
                    <Icon name="terminal" size={12} />
                    {t('plugins.heroi.runInWork')}
                  </button>
                </div>
              )}
              {statusNote && <p className="plugin-heroi-status-note">{statusNote}</p>}
              {error && <p className="plugin-heroi-error" role="alert">{error}</p>}
            </main>

            {kanbanProjectPath === null && diffVisible && (
              <aside className="plugin-heroi-right" aria-label={t('plugins.heroi.diff')}>
                <header className="plugin-heroi-right-head">
                  <Icon name="compare" size={13} />
                  <span>{t('plugins.heroi.diff')}</span>
                </header>
                {!activePath ? (
                  <p className="plugin-heroi-empty-inline">{t('plugins.heroi.gitEmpty')}</p>
                ) : changedFiles.length === 0 ? (
                  <p className="plugin-heroi-empty-inline">{t('plugins.heroi.gitClean')}</p>
                ) : (
                  <ul className="plugin-heroi-file-list">
                    {changedFiles.map((file) => (
                      <li key={`${file.kind}:${file.path}`}>
                        <button type="button" onClick={() => selectFile(file.path)}>
                          <span className={'plugin-heroi-file-kind ' + file.kind}>{file.kind}</span>
                          <span className="plugin-heroi-file-path">{file.path}</span>
                          <span className="plugin-heroi-file-stats">+{file.adds} −{file.dels}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </aside>
            )}
          </>
        )}
      </div>

      <footer className="plugin-heroi-status">
        <span>{plural(tabs.length, {
          one: 'plugins.heroi.projectCount.one',
          other: 'plugins.heroi.projectCount.other',
        })}</span>
        <span>{t('plugins.heroi.bridgeOk')}</span>
      </footer>
    </div>
  );
}

function Welcome({ ping }: { ping: string }) {
  return (
    <div className="plugin-heroi-welcome">
      <div className="plugin-heroi-welcome-card">
        <HeroiLogo size={56} className="plugin-heroi-logo" title="heroi" />
        <h1>{t('plugins.heroi.welcomeTitle')}</h1>
        <p>{t('plugins.heroi.welcomeBody')}</p>
        <div className="plugin-heroi-welcome-ping">
          {t('plugins.heroi.welcomePing')} <span>{ping}</span>
        </div>
        <p className="plugin-heroi-welcome-hint">{t('plugins.heroi.welcomeHint')}</p>
      </div>
    </div>
  );
}

function ConversationView({
  title,
  cwd,
  branch,
  messages,
  composerText,
  onComposerChange,
  composerRef,
  shortcut,
  settings,
  chipMenu,
  onChipMenu,
  onPatch,
  onSend,
  onRun,
  visible,
}: {
  title: string;
  cwd: string;
  branch: string | null;
  messages: HeroiMessage[];
  composerText: string;
  onComposerChange: (value: string) => void;
  composerRef: Ref<HTMLTextAreaElement>;
  shortcut: string;
  settings: Pick<HeroiDraft, 'provider' | 'model' | 'thinking' | 'agentMode' | 'permissionMode'> | null;
  chipMenu: ChipMenu;
  onChipMenu: (menu: ChipMenu) => void;
  onPatch: (patch: Partial<HeroiDraft>) => void;
  onSend: () => void;
  onRun: () => void;
  visible: boolean;
}) {
  const empty = messages.length === 0;
  const provider = settings?.provider ?? 'claude';
  const mode = settings?.agentMode ?? 'build';
  return (
    <div className="plugin-heroi-conversation">
      <header className="plugin-heroi-conversation-head">
        <span className="plugin-heroi-conversation-title">{title}</span>
        <span className="plugin-heroi-dot">·</span>
        <span className="plugin-heroi-path" title={cwd}>{cwd}</span>
        {branch && (
          <>
            <span className="plugin-heroi-dot">·</span>
            <span>{branch}</span>
          </>
        )}
        <div className="plugin-heroi-topbar-spacer" />
        <button type="button" className="plugin-heroi-icon-btn" aria-label={t('plugins.heroi.runInWork')} disabled={!cwd || !visible} onClick={onRun}>
          <Icon name="terminal" size={12} />
        </button>
      </header>

      {empty ? (
        <div className="plugin-heroi-draft-copy">
          {t('plugins.heroi.draftHint')}
          <code>{cwd}</code>
        </div>
      ) : (
        <div className="plugin-heroi-messages">
          {messages.map((message) => (
            <div key={message.id} className={'plugin-heroi-message ' + message.role}>
              <div className="plugin-heroi-message-body">{message.text}</div>
            </div>
          ))}
        </div>
      )}

      <div className={'plugin-heroi-composer-wrap' + (empty ? ' centered' : '')}>
        <div className="plugin-heroi-composer">
          <div className="plugin-heroi-composer-row">
            <textarea
              ref={composerRef}
              value={composerText}
              rows={2}
              placeholder={t('plugins.heroi.composerPlaceholder', { mode: capitalize(mode), shortcut })}
              onChange={(event) => onComposerChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Tab' && event.shiftKey) {
                  event.preventDefault();
                  onPatch({ agentMode: mode === 'plan' ? 'build' : 'plan' });
                }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  onSend();
                }
              }}
            />
            <button
              type="button"
              className="btn primary plugin-heroi-send"
              aria-label={t('plugins.heroi.send')}
              disabled={!composerText.trim() || !visible}
              onClick={onSend}
            >
              <Icon name="arrow-up" size={12} />
            </button>
          </div>
          <div className="plugin-heroi-config">
            <Chip
              open={chipMenu === 'provider'}
              label={providerMeta(provider).label}
              ariaLabel={t('plugins.heroi.provider')}
              onToggle={() => onChipMenu(chipMenu === 'provider' ? null : 'provider')}
            >
              {PROVIDERS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={entry.id === provider}
                  onClick={() => {
                    onPatch({ provider: entry.id, model: MODELS[entry.id][0] });
                    onChipMenu(null);
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </Chip>
            <span className="plugin-heroi-sep">·</span>
            <Chip
              open={chipMenu === 'model'}
              label={capitalize(settings?.model ?? 'default')}
              ariaLabel={t('plugins.heroi.model')}
              onToggle={() => onChipMenu(chipMenu === 'model' ? null : 'model')}
            >
              {MODELS[provider].map((model) => (
                <button
                  key={model}
                  type="button"
                  role="menuitemradio"
                  aria-checked={model === (settings?.model ?? 'default')}
                  onClick={() => { onPatch({ model }); onChipMenu(null); }}
                >
                  {capitalize(model)}
                </button>
              ))}
            </Chip>
            <span className="plugin-heroi-sep">·</span>
            <Chip
              open={chipMenu === 'thinking'}
              label={capitalize(settings?.thinking ?? 'default')}
              ariaLabel={t('plugins.heroi.thinking')}
              onToggle={() => onChipMenu(chipMenu === 'thinking' ? null : 'thinking')}
            >
              {THINKING.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="menuitemradio"
                  aria-checked={level === (settings?.thinking ?? 'default')}
                  onClick={() => { onPatch({ thinking: level }); onChipMenu(null); }}
                >
                  {capitalize(level)}
                </button>
              ))}
            </Chip>
            <span className="plugin-heroi-sep">·</span>
            <Chip
              open={chipMenu === 'mode'}
              label={capitalize(mode)}
              ariaLabel={t('plugins.heroi.mode')}
              onToggle={() => onChipMenu(chipMenu === 'mode' ? null : 'mode')}
            >
              {MODES.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === mode}
                  onClick={() => { onPatch({ agentMode: value }); onChipMenu(null); }}
                >
                  {capitalize(value)}
                </button>
              ))}
            </Chip>
            <span className="plugin-heroi-sep">·</span>
            <Chip
              open={chipMenu === 'permission'}
              label={settings?.permissionMode === 'read' ? t('plugins.heroi.permissionRead') : capitalize(settings?.permissionMode ?? 'build')}
              ariaLabel={t('plugins.heroi.permission')}
              onToggle={() => onChipMenu(chipMenu === 'permission' ? null : 'permission')}
            >
              {PERMISSIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === (settings?.permissionMode ?? 'build')}
                  onClick={() => { onPatch({ permissionMode: value }); onChipMenu(null); }}
                >
                  {value === 'read' ? t('plugins.heroi.permissionRead') : capitalize(value)}
                </button>
              ))}
            </Chip>
          </div>
        </div>
      </div>
    </div>
  );
}

function Chip({
  open,
  label,
  ariaLabel,
  onToggle,
  children,
}: {
  open: boolean;
  label: string;
  ariaLabel: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="plugin-heroi-chip-wrap">
      <button type="button" className="plugin-heroi-chip-btn" aria-label={ariaLabel} aria-expanded={open} onClick={onToggle}>
        {label}
        <Icon name="chev-down" size={10} />
      </button>
      {open && <div className="plugin-heroi-chip-menu" role="menu">{children}</div>}
    </div>
  );
}

function KanbanView({
  name,
  board,
  newCardColumn,
  newCardTitle,
  onNewTask,
  onNewCardColumn,
  onNewCardTitle,
  onAddCard,
  onMoveCard,
}: {
  name: string;
  board: KanbanBoard;
  newCardColumn: string | null;
  newCardTitle: string;
  onNewTask: () => void;
  onNewCardColumn: (id: string | null) => void;
  onNewCardTitle: (value: string) => void;
  onAddCard: (columnId: string, title: string) => void;
  onMoveCard: (cardId: string, columnId: string) => void;
}) {
  return (
    <div className="plugin-heroi-kanban">
      <header className="plugin-heroi-conversation-head">
        <Icon name="workspace" size={12} />
        <span className="plugin-heroi-conversation-title">{name} · Kanban</span>
        <span className="plugin-heroi-dot">·</span>
        <span>{t('plugins.heroi.kanbanCounts', { columns: board.columns.length, cards: board.cards.length })}</span>
        <div className="plugin-heroi-topbar-spacer" />
        <button type="button" className="btn primary plugin-heroi-new-task" onClick={onNewTask}>
          <Icon name="plus" size={11} />
          {t('plugins.heroi.newTask')}
        </button>
      </header>
      <div className="plugin-heroi-kanban-board">
        {board.columns.map((column) => {
          const cards = board.cards.filter((card) => card.columnId === column.id);
          return (
            <section key={column.id} className="plugin-heroi-kanban-col">
              <header>
                <span>{column.name}</span>
                <span>{cards.length}</span>
              </header>
              {cards.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className="plugin-heroi-kanban-card"
                  onClick={() => {
                    const index = board.columns.findIndex((entry) => entry.id === column.id);
                    const next = board.columns[(index + 1) % board.columns.length];
                    if (next) onMoveCard(card.id, next.id);
                  }}
                >
                  {card.title}
                </button>
              ))}
              {newCardColumn === column.id ? (
                <form
                  className="plugin-heroi-kanban-new"
                  onSubmit={(event) => {
                    event.preventDefault();
                    onAddCard(column.id, newCardTitle);
                  }}
                >
                  <input
                    value={newCardTitle}
                    autoFocus
                    placeholder={t('plugins.heroi.cardTitle')}
                    onChange={(event) => onNewCardTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') onNewCardColumn(null);
                    }}
                  />
                </form>
              ) : (
                <button type="button" className="plugin-heroi-add-card" onClick={() => { onNewCardColumn(column.id); onNewCardTitle(''); }}>
                  <Icon name="plus" size={10} />
                  {t('plugins.heroi.addCard')}
                </button>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function MarketplaceOverlay({
  ready,
  installed,
  onInstall,
  onUninstall,
  onClose,
}: {
  ready: boolean;
  installed: readonly string[];
  onInstall: (id: string) => void;
  onUninstall: (id: string) => void;
  onClose: () => void;
}) {
  const installedSet = new Set(installed);
  return (
    <div className="plugin-heroi-overlay">
      <header className="plugin-heroi-conversation-head">
        <span className="plugin-heroi-conversation-title">{t('plugins.heroi.marketplace')}</span>
        <div className="plugin-heroi-topbar-spacer" />
        <button type="button" className="plugin-heroi-icon-btn" aria-label={t('common.close')} onClick={onClose}>
          <Icon name="x" size={12} />
        </button>
      </header>
      <div className="plugin-heroi-market-list">
        {MARKETPLACE_CATALOG.map(({ manifest, builtin, tags }) => {
          const isInstalled = installedSet.has(manifest.id);
          return (
            <article key={manifest.id} className="plugin-heroi-market-card">
              <div>
                <strong>{manifest.name}</strong>
                <span>{manifest.id} · v{manifest.version}</span>
                <p>{manifest.description}</p>
                <div className="plugin-heroi-market-tags">
                  {builtin && <span>{t('plugins.builtin')}</span>}
                  {tags.map((tag) => <span key={tag}>{tag}</span>)}
                </div>
              </div>
              {isInstalled ? (
                <button type="button" className="btn" disabled={!ready} onClick={() => onUninstall(manifest.id)}>
                  {t('plugins.uninstall')}
                </button>
              ) : (
                <button type="button" className="btn primary" disabled={!ready} onClick={() => onInstall(manifest.id)}>
                  {t('plugins.install')}
                </button>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
