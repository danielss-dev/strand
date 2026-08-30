import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import { Icon } from '../../../components/Icon';
import { Select } from '../../../components/Select';
import { plural, t } from '../../../lib/i18n';
import { errMessage, tauri } from '../../../lib/tauri';
import type { HeroiAgentEvent, HeroiAgentRequest } from '../../../lib/types';
import { useRepo } from '../../../stores/repo';
import { useSettings } from '../../../stores/settings';
import { pluginStateKey, usePlugins } from '../../../stores/plugins';
import type { SurfaceRenderRequest } from '../../../workbench/SurfaceHost';
import type { PluginCapabilityBroker } from '../../capabilities';
import { HEROI_NEW_CONVERSATION_EVENT } from './events';
import { HeroiLogo } from './HeroiLogo';

export type HeroiProvider = 'claude' | 'codex' | 'cursor';
type AgentMode = 'plan' | 'build';
type PermissionMode = 'read' | 'build' | 'full';
type ThinkingLevel = 'default' | 'low' | 'medium' | 'high';
type MessageState = 'running' | 'complete' | 'stopped' | 'error';

interface HeroiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  state?: MessageState;
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

const MODELS: Record<HeroiProvider, readonly string[]> = {
  claude: ['default', 'opus', 'sonnet'],
  codex: ['default', 'gpt-5.6-codex', 'gpt-5.4'],
  cursor: ['default', 'auto'],
};

const THINKING: readonly ThinkingLevel[] = ['default', 'low', 'medium', 'high'];

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
  const [draftThinking, setDraftThinking] = useState<ThinkingLevel>('default');
  const [draftAgentMode, setDraftAgentMode] = useState<AgentMode>('build');
  const [draftPermission, setDraftPermission] = useState<PermissionMode>('build');
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

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
  const activeConversation = composingNew
    ? null
    : repoConversations.find((conversation) => conversation.id === activeConversationId) ?? null;

  const provider = activeConversation?.provider ?? draftProvider;
  const model = activeConversation?.model ?? draftModel;
  const thinking = activeConversation?.thinking ?? draftThinking;
  const agentMode = activeConversation?.agentMode ?? draftAgentMode;
  const permissionMode = activeConversation?.permissionMode ?? draftPermission;

  useEffect(() => {
    let current = true;
    void loadPluginState<PersistedHeroiState>(stateKey).then((stored) => {
      if (!current) return;
      const restoredConversations = (stored?.conversations ?? []).map((conversation) => ({
        ...conversation,
        updatedAt: conversation.updatedAt ?? conversation.createdAt,
        messages: conversation.messages.map((message) => (
          message.state === 'running' ? { ...message, state: 'stopped' as const } : message
        )),
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
      if (activeRun) return;
      setComposingNew(true);
      setActiveConversationId(null);
      setComposerText('');
      setError(null);
      queueMicrotask(() => composerRef.current?.focus());
    };
    window.addEventListener(HEROI_NEW_CONVERSATION_EVENT, onNew);
    return () => window.removeEventListener(HEROI_NEW_CONVERSATION_EVENT, onNew);
  }, [activeRun]);

  useEffect(() => {
    const element = messagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [activeConversation?.messages, activeRun?.activity]);

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
        updatedAt: Date.now(),
      }));
      return;
    }
    if (patch.provider) {
      setDraftProvider(patch.provider);
      setDraftModel('default');
    }
    if (patch.model) setDraftModel(patch.model);
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
    setActiveRun((current) => (
      current?.conversationId === conversationId ? { ...current, activity } : current
    ));
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
      model,
      thinking,
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
    setActiveRun({
      runId,
      conversationId,
      assistantMessageId,
      activity: t('plugins.heroi.startingAgent', { agent: providerLabel(provider) }),
    });

    const agentRequest: HeroiAgentRequest = {
      path: activePath,
      provider,
      prompt: text,
      sessionId: sessionId ?? null,
      model,
      thinking,
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
              }
            : row
        )),
      }));
      if (!stopped) setError(message);
    } finally {
      setActiveRun((current) => current?.runId === runId ? null : current);
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
    model,
    openaiCli,
    permissionMode,
    provider,
    thinking,
    updateConversation,
  ]);

  const stopRun = useCallback(() => {
    if (!activeRun) return;
    setActiveRun((current) => current ? { ...current, activity: t('plugins.heroi.stopping') } : current);
    void tauri.repoCancelOp(activeRun.runId);
  }, [activeRun]);

  const deleteConversation = useCallback((conversation: HeroiConversation) => {
    if (activeRun?.conversationId === conversation.id) return;
    if (!window.confirm(t('plugins.heroi.deleteConfirm', { title: conversation.title }))) return;
    setConversations((current) => current.filter(({ id }) => id !== conversation.id));
    if (activeConversationId === conversation.id) setActiveConversationId(null);
  }, [activeConversationId, activeRun?.conversationId]);

  const onComposerKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void sendMessage();
      return;
    }
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      patchSettings({ agentMode: agentMode === 'build' ? 'plan' : 'build' });
    }
  }, [agentMode, patchSettings, sendMessage]);

  const repoName = activePath ? pathLeaf(activePath) : t('plugins.heroi.noRepositoryShort');

  return (
    <div
      ref={rootRef}
      className="plugin-surface plugin-heroi plugin-heroi-chat-only"
      data-surface-id={request.contribution.id}
      data-focused={request.lifecycle.focused || undefined}
      tabIndex={-1}
    >
      <header className="plugin-heroi-titlebar">
        <div className="plugin-heroi-title-brand">
          <HeroiLogo size={14} className="plugin-heroi-logo" />
          <span>heroi</span>
          <span className="plugin-heroi-dot">/</span>
          <span className="plugin-heroi-repo-name" title={activePath}>{repoName}</span>
        </div>
        <span className="plugin-heroi-scope-label">{t('plugins.heroi.repoChatsOnly')}</span>
      </header>

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
              <span>{t('plugins.heroi.chats')}</span>
              <span>{repoConversations.length}</span>
            </div>
            <button
              type="button"
              className="plugin-heroi-new-chat"
              disabled={Boolean(activeRun)}
              onClick={() => {
                setComposingNew(true);
                setActiveConversationId(null);
                setComposerText('');
                setError(null);
                queueMicrotask(() => composerRef.current?.focus());
              }}
            >
              <Icon name="plus" size={13} />
              {t('plugins.heroi.newConversation')}
            </button>
            <div className="plugin-heroi-chat-list">
              {repoConversations.length === 0 ? (
                <p className="plugin-heroi-chat-list-empty">{t('plugins.heroi.noRepoChats')}</p>
              ) : repoConversations.map((conversation) => (
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
                    <span className="plugin-heroi-chat-provider">{providerLabel(conversation.provider)}</span>
                    <span>{conversation.title}</span>
                  </button>
                  <button
                    type="button"
                    className="plugin-heroi-chat-delete"
                    aria-label={t('plugins.heroi.deleteConversation', { title: conversation.title })}
                    disabled={activeRun?.conversationId === conversation.id}
                    onClick={() => deleteConversation(conversation)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              ))}
            </div>
          </aside>

          <main className="plugin-heroi-thread">
            <header className="plugin-heroi-thread-head">
              <div>
                <strong>{activeConversation?.title ?? t('plugins.heroi.newConversationTitle')}</strong>
                <span>{activeConversation
                  ? plural(activeConversation.messages.length, {
                      one: 'plugins.heroi.messageCount.one',
                      other: 'plugins.heroi.messageCount.other',
                    })
                  : t('plugins.heroi.newConversationHint')}</span>
              </div>
              {activeRun && (
                <div className="plugin-heroi-run-state" role="status" aria-live="polite">
                  <span className="plugin-heroi-run-pulse" />
                  <span>{activeRun.activity}</span>
                </div>
              )}
            </header>

            <div ref={messagesRef} className="plugin-heroi-messages" aria-live="polite">
              {!activeConversation ? (
                <div className="plugin-heroi-thread-empty">
                  <HeroiLogo size={30} className="plugin-heroi-logo" />
                  <strong>{t('plugins.heroi.askAgent', { repo: repoName })}</strong>
                  <span>{t('plugins.heroi.askAgentHint')}</span>
                </div>
              ) : activeConversation.messages.map((message) => (
                <article key={message.id} className={`plugin-heroi-message ${message.role}`}>
                  <header>
                    <span>{message.role === 'user' ? t('plugins.heroi.you') : providerLabel(activeConversation.provider)}</span>
                    {message.state && message.state !== 'complete' && (
                      <span className={`plugin-heroi-message-state ${message.state}`}>
                        {message.state === 'running'
                          ? activeRun?.activity
                          : t(message.state === 'stopped'
                            ? 'plugins.heroi.state.stopped'
                            : 'plugins.heroi.state.error')}
                      </span>
                    )}
                  </header>
                  {message.text && <div className="plugin-heroi-message-body">{message.text}</div>}
                </article>
              ))}
            </div>

            <div className="plugin-heroi-composer-wrap">
              {error && <div className="plugin-heroi-error" role="alert">{error}</div>}
              <div className="plugin-heroi-composer">
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
                  onChange={(event) => setComposerText(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                />
                {activeRun ? (
                  <button
                    type="button"
                    className="plugin-heroi-stop"
                    aria-label={t('plugins.heroi.stop')}
                    onClick={stopRun}
                  >
                    <Icon name="x" size={13} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="plugin-heroi-send"
                    aria-label={t('plugins.heroi.send')}
                    disabled={!composerText.trim()}
                    onClick={() => void sendMessage()}
                  >
                    <Icon name="arrow-up" size={14} />
                  </button>
                )}
              </div>
              <div className="plugin-heroi-config">
                <Select
                  className="plugin-heroi-native-select"
                  aria-label={t('plugins.heroi.provider')}
                  value={provider}
                  disabled={Boolean(activeRun || activeConversation)}
                  onChange={(event) => patchSettings({ provider: event.target.value as HeroiProvider })}
                >
                  {PROVIDERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                </Select>
                <Select
                  className="plugin-heroi-native-select"
                  aria-label={t('plugins.heroi.model')}
                  value={model}
                  disabled={Boolean(activeRun)}
                  onChange={(event) => patchSettings({ model: event.target.value })}
                >
                  {MODELS[provider].map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                </Select>
                <Select
                  className="plugin-heroi-native-select"
                  aria-label={t('plugins.heroi.thinking')}
                  value={thinking}
                  disabled={Boolean(activeRun)}
                  onChange={(event) => patchSettings({ thinking: event.target.value as ThinkingLevel })}
                >
                  {THINKING.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                </Select>
                <Select
                  className="plugin-heroi-native-select"
                  aria-label={t('plugins.heroi.mode')}
                  value={agentMode}
                  disabled={Boolean(activeRun)}
                  onChange={(event) => patchSettings({ agentMode: event.target.value as AgentMode })}
                >
                  <option value="build">Build</option>
                  <option value="plan">Plan</option>
                </Select>
                <Select
                  className="plugin-heroi-native-select"
                  aria-label={t('plugins.heroi.permission')}
                  value={permissionMode}
                  disabled={Boolean(activeRun)}
                  onChange={(event) => patchSettings({ permissionMode: event.target.value as PermissionMode })}
                >
                  <option value="read">{t('plugins.heroi.permissionRead')}</option>
                  <option value="build">Build</option>
                  <option value="full">Full access</option>
                </Select>
              </div>
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
