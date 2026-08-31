import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react';

import { Icon } from '../../../components/Icon';
import { Select } from '../../../components/Select';
import { TreeFileIcon, TreeIconSprite } from '../../../components/TreeFileIcon';
import { t } from '../../../lib/i18n';
import { errMessage, tauri } from '../../../lib/tauri';
import type { HeroiAgentEvent, HeroiAgentRequest, HeroiModel, HeroiSkill } from '../../../lib/types';
import { useRepo } from '../../../stores/repo';
import { useSettings } from '../../../stores/settings';
import { pluginStateKey, usePlugins } from '../../../stores/plugins';
import type { SurfaceRenderRequest } from '../../../workbench/SurfaceHost';
import type { PluginCapabilityBroker } from '../../capabilities';
import {
  HEROI_FILES_DROPPED_EVENT,
  HEROI_FILE_DRAG_EVENT,
  HEROI_NEW_CONVERSATION_EVENT,
  HEROI_OPEN_FILE_EVENT,
  HEROI_OPEN_REVIEW_EVENT,
  type HeroiFilesDroppedDetail,
  type HeroiFileDragDetail,
} from './events';
import { HeroiLogo } from './HeroiLogo';
import { AssistantTurnBody } from './AssistantTurnBody';
import { MessageMarkdown } from './MessageMarkdown';
import {
  appendFileMentions,
  composerTrigger,
  filterSuggestions,
  replaceComposerTrigger,
  type HeroiComposerSuggestion,
} from './composer';

export type HeroiProvider = 'claude' | 'codex' | 'cursor';
type AgentMode = 'plan' | 'build';
type PermissionMode = 'read' | 'build' | 'full';
type MessageState = 'running' | 'complete' | 'stopped' | 'error';
type ActivityState = 'running' | 'done' | 'stopped' | 'error';
type ThreadFilter = 'all' | 'running';

interface HeroiActivity {
  id: string;
  label: string;
  detail?: string;
  state: ActivityState;
}

interface HeroiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  state?: MessageState;
  activities?: HeroiActivity[];
}

interface HeroiConversation {
  id: string;
  projectPath: string;
  title: string;
  provider: HeroiProvider;
  model: string;
  thinking: string;
  agentMode: AgentMode;
  permissionMode: PermissionMode;
  sessionId?: string;
  messages: HeroiMessage[];
  createdAt: number;
  updatedAt: number;
}

interface PersistedHeroiState {
  conversations?: HeroiConversation[];
  activeConversationId?: string | null;
}

interface ActiveRun {
  runId: string;
  conversationId: string;
  assistantMessageId: string;
  activity: string;
}

const PROVIDERS: readonly { id: HeroiProvider; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor Agent' },
];

const MODEL_ALIASES: Record<HeroiProvider, Record<string, string>> = {
  claude: {
    default: 'claude-sonnet-5',
    opus: 'claude-opus-5',
    sonnet: 'claude-sonnet-5',
    haiku: 'claude-haiku-4-5',
  },
  codex: {
    default: 'gpt-5.6-sol',
    'gpt-5.6-codex': 'gpt-5.6-sol',
    'gpt-5-codex': 'gpt-5.4',
  },
  cursor: {
    default: 'auto',
    composer: 'composer-2',
  },
};

function resolveCatalogModel(
  provider: HeroiProvider,
  stored: string,
  models: readonly HeroiModel[],
): string {
  const aliased = MODEL_ALIASES[provider][stored] ?? stored;
  if (models.some((model) => model.slug === aliased)) return aliased;
  return models.find((model) => model.isDefault)?.slug
    ?? models[0]?.slug
    ?? aliased;
}

function resolveReasoning(model: HeroiModel | undefined, stored: string): string {
  if (!model || model.reasoning.length === 0) return stored === 'default' ? '' : stored;
  if (stored && stored !== 'default' && model.reasoning.some((option) => option.id === stored)) {
    return stored;
  }
  return model.reasoning.find((option) => option.isDefault)?.id ?? model.reasoning[0]?.id ?? '';
}

function mintId(prefix: string): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}-${crypto.randomUUID()}`;
    }
  } catch {
    // Fall through for test/browser shims without Web Crypto.
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pathLeaf(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function titleFromText(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 52) || t('plugins.heroi.untitled');
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return t('plugins.heroi.time.now');
  if (elapsed < 3_600_000) return t('plugins.heroi.time.minutes', { count: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return t('plugins.heroi.time.hours', { count: Math.floor(elapsed / 3_600_000) });
  if (elapsed < 172_800_000) return t('plugins.heroi.time.yesterday');
  return t('plugins.heroi.time.days', { count: Math.floor(elapsed / 86_400_000) });
}

function providerLabel(provider: HeroiProvider): string {
  return PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider;
}

function cliOverride(
  provider: HeroiProvider,
  openaiCli: string | null,
  anthropicCli: string | null,
): string | null {
  if (provider === 'codex') return openaiCli;
  if (provider === 'claude') return anthropicCli;
  return null;
}

export function HeroiView({
  request,
  broker,
}: {
  request: SurfaceRenderRequest;
  broker: PluginCapabilityBroker;
}) {
  const meta = useRepo((state) => state.meta);
  const activeTabPath = useRepo((state) => state.activeTabPath);
  const openaiCli = useSettings((state) => state.openaiCli);
  const anthropicCli = useSettings((state) => state.anthropicCli);
  const loadPluginState = usePlugins((state) => state.loadState);
  const savePluginState = usePlugins((state) => state.saveState);

  const [conversations, setConversations] = useState<HeroiConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [composingNew, setComposingNew] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [draftProvider, setDraftProvider] = useState<HeroiProvider>('claude');
  const [draftModel, setDraftModel] = useState('default');
  const [draftThinking, setDraftThinking] = useState('default');
  const [draftAgentMode, setDraftAgentMode] = useState<AgentMode>('build');
  const [draftPermission, setDraftPermission] = useState<PermissionMode>('build');
  const [activeRuns, setActiveRuns] = useState<Record<string, ActiveRun>>({});
  const [threadFilter, setThreadFilter] = useState<ThreadFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [catalog, setCatalog] = useState<{ provider: HeroiProvider; models: HeroiModel[] } | null>(null);
  const [skills, setSkills] = useState<HeroiSkill[]>([]);
  const [repoFiles, setRepoFiles] = useState<string[]>([]);
  const [composerCursor, setComposerCursor] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [fileDropActive, setFileDropActive] = useState(false);
  const [expandedActivities, setExpandedActivities] = useState<Set<string>>(new Set());
  /** Explicit open/closed override per assistant message; default is open while running. */
  const [toolGroupOpen, setToolGroupOpen] = useState<Record<string, boolean>>({});

  const rootRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stateKey = pluginStateKey('daniels.heroi', request.instanceId);
  const activePath = activeTabPath ?? '';
  const repoConversations = useMemo(
    () => conversations
      .filter((conversation) => conversation.projectPath === activePath)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [activePath, conversations],
  );
  const visibleConversations = threadFilter === 'running'
    ? repoConversations.filter(({ id }) => Boolean(activeRuns[id]))
    : repoConversations;
  const activeConversation = composingNew
    ? null
    : repoConversations.find((conversation) => conversation.id === activeConversationId) ?? null;

  const provider = activeConversation?.provider ?? draftProvider;
  const model = activeConversation?.model ?? draftModel;
  const thinking = activeConversation?.thinking ?? draftThinking;
  const agentMode = activeConversation?.agentMode ?? draftAgentMode;
  const permissionMode = activeConversation?.permissionMode ?? draftPermission;
  const models = catalog?.provider === provider ? catalog.models : [];
  const selectedModel = resolveCatalogModel(provider, model, models);
  const selectedCatalogModel = models.find((entry) => entry.slug === selectedModel);
  const selectedThinking = resolveReasoning(selectedCatalogModel, thinking);
  const modelOptions = useMemo(() => {
    if (models.length === 0) {
      return selectedModel
        ? [{ slug: selectedModel, name: selectedModel, isDefault: true, reasoning: [] }]
        : [];
    }
    if (models.some((entry) => entry.slug === selectedModel)) return models;
    return [{ slug: selectedModel, name: selectedModel, isDefault: false, reasoning: [] }, ...models];
  }, [models, selectedModel]);
  const thinkingOptions = selectedCatalogModel?.reasoning ?? [];
  const trigger = composerTrigger(composerText, composerCursor);
  const suggestions = trigger
    ? filterSuggestions(
        trigger.marker === '@'
          ? repoFiles.map((path) => ({ kind: 'file' as const, value: path, detail: path }))
          : skills.map((skill) => ({
              kind: 'skill' as const,
              value: skill.name,
              detail: skill.description ?? `${skill.scope} skill`,
            })),
        trigger.query,
      )
    : [];
  const activeRun = activeConversation ? activeRuns[activeConversation.id] ?? null : null;

  useEffect(() => {
    let current = true;
    void loadPluginState<PersistedHeroiState>(stateKey).then((stored) => {
      if (!current) return;
      const restoredConversations = (stored?.conversations ?? []).map((conversation) => ({
        ...conversation,
        updatedAt: conversation.updatedAt ?? conversation.createdAt,
        messages: conversation.messages.map((message) => ({
          ...message,
          state: message.state === 'running' ? 'stopped' as const : message.state,
          activities: message.activities?.map((activity) => (
            activity.state === 'running' ? { ...activity, state: 'stopped' as const } : activity
          )),
        })),
      }));
      setConversations(restoredConversations);
      setActiveConversationId(stored?.activeConversationId ?? null);
      setRestored(true);
    });
    return () => { current = false; };
  }, [loadPluginState, stateKey]);

  useEffect(() => {
    if (!restored) return;
    void savePluginState(stateKey, { conversations, activeConversationId } satisfies PersistedHeroiState);
  }, [activeConversationId, conversations, restored, savePluginState, stateKey]);

  useEffect(() => {
    if (!restored) return;
    if (composingNew) return;
    if (activeConversationId && repoConversations.some(({ id }) => id === activeConversationId)) return;
    setActiveConversationId(repoConversations[0]?.id ?? null);
  }, [activeConversationId, composingNew, repoConversations, restored]);

  useEffect(() => {
    setComposingNew(false);
  }, [activePath]);

  useEffect(() => {
    if (!request.lifecycle.focused) return;
    rootRef.current?.focus({ preventScroll: true });
    composerRef.current?.focus({ preventScroll: true });
  }, [request.lifecycle.focused]);

  useEffect(() => {
    const onNew = () => {
      setComposingNew(true);
      setActiveConversationId(null);
      setComposerText('');
      setError(null);
      queueMicrotask(() => composerRef.current?.focus());
    };
    window.addEventListener(HEROI_NEW_CONVERSATION_EVENT, onNew);
    return () => window.removeEventListener(HEROI_NEW_CONVERSATION_EVENT, onNew);
  }, []);

  useEffect(() => {
    const element = messagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [activeConversation?.messages, activeRun?.activity]);

  useEffect(() => {
    if (!activePath) {
      setRepoFiles([]);
      setSkills([]);
      return;
    }
    let current = true;
    void Promise.all([
      tauri.repoTree(activePath),
      tauri.heroiSkills(activePath, provider),
    ]).then(([tree, discoveredSkills]) => {
      if (!current) return;
      setRepoFiles(tree.filter((entry) => !entry.path.endsWith('/')).map((entry) => entry.path));
      setSkills(discoveredSkills);
    }).catch(() => {
      if (!current) return;
      setRepoFiles(useRepo.getState().workTree.map((entry) => entry.path));
      setSkills([]);
    });
    return () => { current = false; };
  }, [activePath, provider]);

  useEffect(() => {
    const onFilesDropped = (event: Event) => {
      const detail = (event as CustomEvent<HeroiFilesDroppedDetail>).detail;
      if (detail.projectPath !== activePath) return;
      setComposerText((current) => {
        const next = appendFileMentions(current, detail.paths);
        setComposerCursor(next.length);
        return next;
      });
      setFileDropActive(false);
      requestAnimationFrame(() => composerRef.current?.focus());
    };
    const onFileDrag = (event: Event) => {
      const detail = (event as CustomEvent<HeroiFileDragDetail>).detail;
      if (detail.projectPath === activePath) setFileDropActive(detail.active);
    };
    window.addEventListener(HEROI_FILES_DROPPED_EVENT, onFilesDropped);
    window.addEventListener(HEROI_FILE_DRAG_EVENT, onFileDrag);
    return () => {
      window.removeEventListener(HEROI_FILES_DROPPED_EVENT, onFilesDropped);
      window.removeEventListener(HEROI_FILE_DRAG_EVENT, onFileDrag);
    };
  }, [activePath]);

  useEffect(() => {
    let current = true;
    void tauri.heroiProviderModels(
      provider,
      cliOverride(provider, openaiCli, anthropicCli),
    ).then((result) => {
      if (!current) return;
      setCatalog(result);
    }).catch(() => {
      if (!current) return;
      setCatalog({ provider, models: [] });
    });
    return () => { current = false; };
  }, [anthropicCli, openaiCli, provider]);

  const updateConversation = useCallback((
    conversationId: string,
    update: (conversation: HeroiConversation) => HeroiConversation,
  ) => {
    setConversations((current) => current.map((conversation) => (
      conversation.id === conversationId ? update(conversation) : conversation
    )));
  }, []);

  const patchSettings = useCallback((patch: Partial<Pick<
    HeroiConversation,
    'provider' | 'model' | 'thinking' | 'agentMode' | 'permissionMode'
  >>) => {
    if (activeConversation) {
      updateConversation(activeConversation.id, (conversation) => ({
        ...conversation,
        ...patch,
        model: patch.provider ? 'default' : (patch.model ?? conversation.model),
        thinking: patch.provider || patch.model ? 'default' : (patch.thinking ?? conversation.thinking),
        updatedAt: Date.now(),
      }));
      return;
    }
    if (patch.provider) {
      setDraftProvider(patch.provider);
      setDraftModel('default');
      setDraftThinking('default');
    }
    if (patch.model) {
      setDraftModel(patch.model);
      if (!patch.thinking) setDraftThinking('default');
    }
    if (patch.thinking) setDraftThinking(patch.thinking);
    if (patch.agentMode) setDraftAgentMode(patch.agentMode);
    if (patch.permissionMode) setDraftPermission(patch.permissionMode);
  }, [activeConversation, updateConversation]);

  const handleAgentEvent = useCallback((
    conversationId: string,
    assistantMessageId: string,
    event: HeroiAgentEvent,
  ) => {
    if (event.type === 'session') {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        sessionId: event.sessionId,
        updatedAt: Date.now(),
      }));
      return;
    }
    if (event.type === 'text') {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        updatedAt: Date.now(),
        messages: conversation.messages.map((message) => (
          message.id === assistantMessageId
            ? { ...message, text: message.text ? `${message.text}\n\n${event.text}` : event.text }
            : message
        )),
      }));
      return;
    }
    const activity = event.type === 'activity' ? event.label : event.message;
    if (event.type === 'activity') {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        updatedAt: Date.now(),
        messages: conversation.messages.map((message) => {
          if (message.id !== assistantMessageId) return message;
          const activities = message.activities ?? [];
          const existing = activities.findIndex((entry) => entry.id === event.id);
          const nextActivity: HeroiActivity = {
            id: event.id,
            label: event.label,
            detail: event.detail ?? activities[existing]?.detail,
            state: event.done ? 'done' : 'running',
          };
          return {
            ...message,
            activities: existing >= 0
              ? activities.map((entry, index) => index === existing ? nextActivity : entry)
              : [
                  ...activities.map((entry) => entry.state === 'running'
                    ? { ...entry, state: 'done' as const }
                    : entry),
                  nextActivity,
                ],
          };
        }),
      }));
    } else if (event.message === 'Ready') {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => (
          message.id === assistantMessageId
            ? {
                ...message,
                activities: message.activities?.map((entry) => (
                  entry.state === 'running' ? { ...entry, state: 'done' as const } : entry
                )),
              }
            : message
        )),
      }));
    }
    setActiveRuns((current) => {
      const run = current[conversationId];
      return run ? { ...current, [conversationId]: { ...run, activity } } : current;
    });
  }, [updateConversation]);

  const sendMessage = useCallback(async () => {
    const text = composerText.trim();
    if (!text || !activePath || activeRun) return;
    try {
      broker.require('repository.read');
      broker.require('ai.invoke');
      await broker.readRepository(
        activePath,
        meta?.branch ?? null,
        meta?.head_oid ?? null,
        false,
      );
    } catch (caught) {
      setError(errMessage(caught));
      return;
    }

    const now = Date.now();
    const conversationId = activeConversation?.id ?? mintId('c');
    const assistantMessageId = mintId('m');
    const runId = mintId('heroi-run');
    const userMessage: HeroiMessage = {
      id: mintId('m'), role: 'user', text, createdAt: now, state: 'complete',
    };
    const assistantMessage: HeroiMessage = {
      id: assistantMessageId, role: 'assistant', text: '', createdAt: now + 1, state: 'running',
    };
    const conversation = activeConversation ?? {
      id: conversationId,
      projectPath: activePath,
      title: titleFromText(text),
      provider,
      model: selectedModel,
      thinking: selectedThinking,
      agentMode,
      permissionMode,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    const sessionId = conversation.sessionId;

    if (activeConversation) {
      updateConversation(conversationId, (current) => ({
        ...current,
        messages: [...current.messages, userMessage, assistantMessage],
        updatedAt: now,
      }));
    } else {
      setConversations((current) => [{
        ...conversation,
        messages: [userMessage, assistantMessage],
      }, ...current]);
      setActiveConversationId(conversationId);
      setComposingNew(false);
    }
    setComposerText('');
    setError(null);
    setActiveRuns((current) => ({
      ...current,
      [conversationId]: {
        runId,
        conversationId,
        assistantMessageId,
        activity: t('plugins.heroi.startingAgent', { agent: providerLabel(provider) }),
      },
    }));

    const agentRequest: HeroiAgentRequest = {
      path: activePath,
      provider,
      prompt: text,
      sessionId: sessionId ?? null,
      model: selectedModel,
      thinking: selectedThinking || 'default',
      agentMode,
      permissionMode,
      cliPath: cliOverride(provider, openaiCli, anthropicCli),
    };
    try {
      const outcome = await tauri.heroiAgentSend(
        runId,
        agentRequest,
        (event) => handleAgentEvent(conversationId, assistantMessageId, event),
      );
      updateConversation(conversationId, (current) => ({
        ...current,
        sessionId: outcome.sessionId ?? current.sessionId,
        updatedAt: Date.now(),
        messages: current.messages.map((message) => (
          message.id === assistantMessageId
            ? {
                ...message,
                text: message.text || t('plugins.heroi.emptyReply'),
                state: 'complete',
                activities: message.activities?.map((entry) => (
                  entry.state === 'running' ? { ...entry, state: 'done' as const } : entry
                )),
              }
            : message
        )),
      }));
    } catch (caught) {
      const message = errMessage(caught);
      const stopped = message === 'cancelled';
      updateConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        messages: current.messages.map((row) => (
          row.id === assistantMessageId
            ? {
                ...row,
                text: row.text || (stopped ? t('plugins.heroi.stopped') : message),
                state: stopped ? 'stopped' : 'error',
                activities: row.activities?.map((entry) => (
                  entry.state === 'running'
                    ? { ...entry, state: stopped ? 'stopped' as const : 'error' as const }
                    : entry
                )),
              }
            : row
        )),
      }));
      if (!stopped) setError(message);
    } finally {
      setActiveRuns((current) => {
        if (current[conversationId]?.runId !== runId) return current;
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
      queueMicrotask(() => composerRef.current?.focus());
    }
  }, [
    activeConversation,
    activePath,
    activeRun,
    agentMode,
    anthropicCli,
    broker,
    composerText,
    handleAgentEvent,
    meta?.branch,
    meta?.head_oid,
    openaiCli,
    permissionMode,
    provider,
    selectedModel,
    selectedThinking,
    updateConversation,
  ]);

  const stopRun = useCallback(() => {
    if (!activeRun) return;
    setActiveRuns((current) => ({
      ...current,
      [activeRun.conversationId]: { ...activeRun, activity: t('plugins.heroi.stopping') },
    }));
    void tauri.repoCancelOp(activeRun.runId);
  }, [activeRun]);

  const deleteConversation = useCallback((conversation: HeroiConversation) => {
    if (activeRuns[conversation.id]) return;
    if (!window.confirm(t('plugins.heroi.deleteConfirm', { title: conversation.title }))) return;
    setConversations((current) => current.filter(({ id }) => id !== conversation.id));
    if (activeConversationId === conversation.id) setActiveConversationId(null);
  }, [activeConversationId, activeRuns]);

  const chooseSuggestion = useCallback((suggestion: HeroiComposerSuggestion) => {
    const currentTrigger = composerTrigger(composerText, composerCursor);
    if (!currentTrigger) return;
    const next = replaceComposerTrigger(composerText, currentTrigger, suggestion);
    setComposerText(next.text);
    setComposerCursor(next.cursor);
    setSuggestionIndex(0);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }, [composerCursor, composerText]);

  const toggleActivity = useCallback((activityId: string) => {
    setExpandedActivities((current) => {
      const next = new Set(current);
      if (next.has(activityId)) next.delete(activityId);
      else next.add(activityId);
      return next;
    });
  }, []);

  const openTurnPath = useCallback((path: string) => {
    if (!activePath) return;
    window.dispatchEvent(new CustomEvent(HEROI_OPEN_FILE_EVENT, {
      detail: { projectPath: activePath, path },
    }));
  }, [activePath]);

  const onComposerChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setComposerText(event.target.value);
    setComposerCursor(event.target.selectionStart);
    setSuggestionIndex(0);
  }, []);

  const onComposerKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setSuggestionIndex((current) => (
        event.key === 'ArrowDown'
          ? (current + 1) % suggestions.length
          : (current - 1 + suggestions.length) % suggestions.length
      ));
      return;
    }
    if (suggestions.length > 0 && (event.key === 'Tab' || event.key === 'Enter')) {
      event.preventDefault();
      chooseSuggestion(suggestions[suggestionIndex] ?? suggestions[0]);
      return;
    }
    if (event.key === 'Escape' && suggestions.length > 0) {
      event.preventDefault();
      setComposerCursor(-1);
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void sendMessage();
      return;
    }
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      patchSettings({ agentMode: agentMode === 'build' ? 'plan' : 'build' });
    }
  }, [agentMode, chooseSuggestion, patchSettings, sendMessage, suggestionIndex, suggestions]);

  const repoName = activePath ? pathLeaf(activePath) : t('plugins.heroi.noRepositoryShort');
  const activeIsRunning = Boolean(activeRun);
  const activeThreadState = activeIsRunning
    ? 'running'
    : activeConversation?.messages.at(-1)?.state ?? 'stopped';
  const branchLabel = meta?.branch ?? repoName;

  return (
    <div
      ref={rootRef}
      className="plugin-surface plugin-heroi plugin-heroi-chat-only"
      data-surface-id={request.contribution.id}
      data-focused={request.lifecycle.focused || undefined}
      tabIndex={-1}
    >
      {!activePath ? (
        <div className="plugin-heroi-no-repo" role="status">
          <HeroiLogo size={32} className="plugin-heroi-logo" />
          <strong>{t('plugins.heroi.noRepository')}</strong>
          <span>{t('plugins.heroi.noRepositoryHint')}</span>
        </div>
      ) : (
        <div className="plugin-heroi-chat-layout">
          <aside className="plugin-heroi-chat-rail" aria-label={t('plugins.heroi.chatsForRepo', { repo: repoName })}>
            <div className="plugin-heroi-chat-rail-head">
              <strong>{t('plugins.heroi.threads')}</strong>
              <button
                type="button"
                aria-label={t('plugins.heroi.newConversation')}
                onClick={() => {
                  setComposingNew(true);
                  setActiveConversationId(null);
                  setComposerText('');
                  setError(null);
                  queueMicrotask(() => composerRef.current?.focus());
                }}
              >
                <Icon name="plus" size={13} />
              </button>
            </div>
            <div className="plugin-heroi-thread-filters" aria-label={t('plugins.heroi.threadFilters')}>
              <button
                type="button"
                className={threadFilter === 'all' ? 'active' : undefined}
                aria-pressed={threadFilter === 'all'}
                onClick={() => setThreadFilter('all')}
              >
                {t('plugins.heroi.all')}
              </button>
              <button
                type="button"
                className={threadFilter === 'running' ? 'active' : undefined}
                aria-pressed={threadFilter === 'running'}
                onClick={() => setThreadFilter('running')}
              >
                {t('plugins.heroi.running')}
              </button>
            </div>
            <div className="plugin-heroi-chat-list">
              {visibleConversations.length === 0 ? (
                <p className="plugin-heroi-chat-list-empty">
                  {threadFilter === 'running'
                    ? t('plugins.heroi.noRunningThreads')
                    : t('plugins.heroi.noRepoChats')}
                </p>
              ) : visibleConversations.map((conversation) => {
                const isRunning = Boolean(activeRuns[conversation.id]);
                const lastState = conversation.messages.at(-1)?.state;
                return (
                  <div
                    key={conversation.id}
                    className={'plugin-heroi-chat-row' + (conversation.id === activeConversationId ? ' active' : '')}
                  >
                    <button
                      type="button"
                      className="plugin-heroi-chat-open"
                      onClick={() => {
                        setComposingNew(false);
                        setActiveConversationId(conversation.id);
                        setError(null);
                      }}
                    >
                      <span className={`plugin-heroi-thread-dot ${isRunning ? 'running' : lastState ?? 'complete'}`} />
                      <span className="plugin-heroi-chat-copy">
                        <strong>{conversation.title}</strong>
                        <small>{providerLabel(conversation.provider)} · {conversation.model}</small>
                      </span>
                      <time>{relativeTime(conversation.updatedAt)}</time>
                    </button>
                    <button
                      type="button"
                      className="plugin-heroi-chat-delete"
                      aria-label={t('plugins.heroi.deleteConversation', { title: conversation.title })}
                      disabled={Boolean(activeRuns[conversation.id])}
                      onClick={() => deleteConversation(conversation)}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          </aside>

          <main className="plugin-heroi-thread">
            <header className="plugin-heroi-thread-head">
              <div className="plugin-heroi-thread-context">
                <span className={`plugin-heroi-thread-dot ${activeThreadState}`} />
                <strong>{activeConversation?.title ?? t('plugins.heroi.newConversationTitle')}</strong>
                <span className="plugin-heroi-context-separator" />
                <span>{providerLabel(provider)} · {selectedCatalogModel?.name ?? selectedModel}</span>
                <span className="plugin-heroi-context-separator" />
                <code title={activePath}>{branchLabel}</code>
              </div>
              <div className="plugin-heroi-thread-actions">
                {activeIsRunning && (
                  <button type="button" className="plugin-heroi-header-stop" onClick={stopRun}>
                    {t('plugins.heroi.stop')}
                  </button>
                )}
                <button
                  type="button"
                  className="plugin-heroi-open-review"
                  onClick={() => window.dispatchEvent(new CustomEvent(HEROI_OPEN_REVIEW_EVENT))}
                >
                  {t('plugins.heroi.openReview')}
                </button>
              </div>
            </header>

            <div ref={messagesRef} className="plugin-heroi-messages" aria-live="polite">
              {!activeConversation ? (
                <div className="plugin-heroi-thread-empty">
                  <HeroiLogo size={30} className="plugin-heroi-logo" />
                  <strong>{t('plugins.heroi.askAgent', { repo: repoName })}</strong>
                  <span>{t('plugins.heroi.askAgentHint')}</span>
                </div>
              ) : activeConversation.messages.map((message) => {
                const activities = message.activities ?? [];
                const toolsRunning = message.state === 'running'
                  || activities.some((entry) => entry.state === 'running');
                const toolsExpanded = toolGroupOpen[message.id] ?? toolsRunning;
                return (
                  <article key={message.id} className={`plugin-heroi-message ${message.role}`}>
                    <header>
                      <span>{message.role === 'user'
                        ? t('plugins.heroi.you')
                        : `Heroi · ${providerLabel(activeConversation.provider)}`}</span>
                      {message.state && message.state !== 'complete' && (
                        <span className={`plugin-heroi-message-state ${message.state}`}>
                          {message.state === 'running'
                            ? activeRuns[activeConversation.id]?.activity
                            : t(message.state === 'stopped'
                              ? 'plugins.heroi.state.stopped'
                              : 'plugins.heroi.state.error')}
                        </span>
                      )}
                    </header>
                    {message.role === 'assistant' ? (
                      <AssistantTurnBody
                        messageId={message.id}
                        text={message.text}
                        activities={activities}
                        projectPath={activeConversation.projectPath}
                        toolsExpanded={toolsExpanded}
                        onToggleGroup={() => setToolGroupOpen((current) => ({
                          ...current,
                          [message.id]: !toolsExpanded,
                        }))}
                        expandedActivities={expandedActivities}
                        onToggleActivity={toggleActivity}
                        onOpenPath={openTurnPath}
                      />
                    ) : (
                      message.text ? <MessageMarkdown text={message.text} /> : null
                    )}
                  </article>
                );
              })}
            </div>

            <div
              className={'plugin-heroi-composer-wrap' + (fileDropActive ? ' file-drop-active' : '')}
              data-heroi-file-drop="true"
            >
              {fileDropActive && (
                <div className="plugin-heroi-file-drop-callout" role="status">
                  <Icon name="file-plus" size={14} />
                  Drop to reference in this message
                </div>
              )}
              {error && <div className="plugin-heroi-error" role="alert">{error}</div>}
              <div className="plugin-heroi-composer">
                <div className="plugin-heroi-mode-tabs" role="group" aria-label={t('plugins.heroi.mode')}>
                  <button
                    type="button"
                    className={agentMode === 'plan' ? 'active' : undefined}
                    disabled={Boolean(activeRun)}
                    onClick={() => patchSettings({ agentMode: 'plan', permissionMode: 'read' })}
                  >
                    {t('plugins.heroi.plan')}
                  </button>
                  <button
                    type="button"
                    className={agentMode === 'build' ? 'active' : undefined}
                    disabled={Boolean(activeRun)}
                    onClick={() => patchSettings({ agentMode: 'build', permissionMode: 'build' })}
                  >
                    {t('plugins.heroi.build')}
                  </button>
                  <kbd>Shift+Tab</kbd>
                </div>
                <div className="plugin-heroi-composer-editor">
                  {suggestions.length > 0 && (
                    <div id="heroi-composer-suggestions" className="plugin-heroi-suggestions" role="listbox" aria-label={trigger?.marker === '@' ? 'Repository files' : 'Skills'}>
                      <TreeIconSprite />
                      {suggestions.map((suggestion, index) => (
                        <button
                          key={`${suggestion.kind}:${suggestion.value}`}
                          type="button"
                          role="option"
                          aria-selected={index === suggestionIndex}
                          className={index === suggestionIndex ? 'active' : undefined}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => chooseSuggestion(suggestion)}
                        >
                          {suggestion.kind === 'file'
                            ? <TreeFileIcon path={suggestion.value} size={15} />
                            : <Icon name="sparkle" size={12} />}
                          <span>{suggestion.kind === 'file' ? `@${suggestion.value}` : `/${suggestion.value}`}</span>
                          <small>{suggestion.detail}</small>
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={composerRef}
                    rows={3}
                    value={composerText}
                    disabled={Boolean(activeRun)}
                    placeholder={t('plugins.heroi.composerPlaceholder', {
                      mode: agentMode === 'build' ? 'Build' : 'Plan',
                      shortcut: navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl',
                    })}
                    aria-label={t('plugins.heroi.composerLabel')}
                    aria-controls={suggestions.length > 0 ? 'heroi-composer-suggestions' : undefined}
                    onChange={onComposerChange}
                    onSelect={(event) => setComposerCursor(event.currentTarget.selectionStart)}
                    onKeyDown={onComposerKeyDown}
                  />
                </div>
                <div className="plugin-heroi-composer-footer">
                  <div className="plugin-heroi-composer-context" title={activePath}>
                    <Icon name="folder" size={11} />
                    <code>{branchLabel}</code>
                  </div>
                  <div className="plugin-heroi-config">
                    <Select
                      className="plugin-heroi-native-select"
                      containerClassName="plugin-heroi-select-provider"
                      aria-label={t('plugins.heroi.provider')}
                      value={provider}
                      disabled={Boolean(activeRun || activeConversation)}
                      onChange={(event) => patchSettings({ provider: event.target.value as HeroiProvider })}
                    >
                      {PROVIDERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                    </Select>
                    <Select
                      className="plugin-heroi-native-select"
                      containerClassName="plugin-heroi-select-model"
                      aria-label={t('plugins.heroi.model')}
                      value={selectedModel}
                      disabled={Boolean(activeRun) || modelOptions.length === 0}
                      onChange={(event) => patchSettings({ model: event.target.value })}
                    >
                      {modelOptions.map((entry) => (
                        <option key={entry.slug} value={entry.slug}>{entry.name}</option>
                      ))}
                    </Select>
                    {thinkingOptions.length > 0 && (
                      <Select
                        className="plugin-heroi-native-select"
                        containerClassName="plugin-heroi-select-thinking"
                        aria-label={t('plugins.heroi.thinking')}
                        value={selectedThinking}
                        disabled={Boolean(activeRun)}
                        onChange={(event) => patchSettings({ thinking: event.target.value })}
                      >
                        {thinkingOptions.map((entry) => (
                          <option key={entry.id} value={entry.id}>{entry.label}</option>
                        ))}
                      </Select>
                    )}
                    <Select
                      className="plugin-heroi-native-select"
                      containerClassName="plugin-heroi-select-permission"
                      aria-label={t('plugins.heroi.permission')}
                      value={permissionMode}
                      disabled={Boolean(activeRun)}
                      onChange={(event) => patchSettings({ permissionMode: event.target.value as PermissionMode })}
                    >
                      <option value="read">{t('plugins.heroi.permissionRead')}</option>
                      <option value="build">{t('plugins.heroi.build')}</option>
                      <option value="full">{t('plugins.heroi.fullAccess')}</option>
                    </Select>
                    {activeRun ? (
                      <button type="button" className="plugin-heroi-stop" onClick={stopRun}>
                        {t('plugins.heroi.stop')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="plugin-heroi-send"
                        disabled={!composerText.trim()}
                        onClick={() => void sendMessage()}
                      >
                        {t('plugins.heroi.send')} <kbd>{navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'}+Enter</kbd>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
