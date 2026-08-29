import { useCallback, useEffect, useMemo, useState } from 'react';

import { Icon } from '../../../components/Icon';
import { errMessage } from '../../../lib/tauri';
import { t } from '../../../lib/i18n';
import type { SurfaceRenderRequest } from '../../../workbench/SurfaceHost';
import { useRepo } from '../../../stores/repo';
import { useSettings } from '../../../stores/settings';
import type { PluginCapabilityBroker } from '../../capabilities';
import { pluginStateKey, usePlugins } from '../../../stores/plugins';

interface T3Thread {
  id: string;
  title: string;
  updatedAt: number;
  messages: readonly { role: 'user' | 'assistant'; text: string }[];
}

const DEFAULT_THREADS: T3Thread[] = [
  {
    id: 'welcome',
    title: 'Getting started',
    updatedAt: Date.now(),
    messages: [
      {
        role: 'assistant',
        text: 'T3Code is Daniels\' agent harness inside Strand. Pick a provider, start a thread, and plan work against the active repository.',
      },
    ],
  },
];

export function T3CodeView({
  request,
  broker,
}: {
  request: SurfaceRenderRequest;
  broker: PluginCapabilityBroker;
}) {
  const meta = useRepo((state) => state.meta);
  const unstagedCount = useRepo((state) => state.unstagedDiffs.length);
  const stagedCount = useRepo((state) => state.stagedDiffs.length);
  const aiProvider = useSettings((state) => state.aiProvider);
  const openaiModel = useSettings((state) => state.openaiModel);
  const anthropicModel = useSettings((state) => state.anthropicModel);
  const openaiCli = useSettings((state) => state.openaiCli);
  const anthropicCli = useSettings((state) => state.anthropicCli);
  const loadPluginState = usePlugins((state) => state.loadState);
  const savePluginState = usePlugins((state) => state.saveState);

  const [threads, setThreads] = useState<T3Thread[]>(DEFAULT_THREADS);
  const [activeThreadId, setActiveThreadId] = useState(DEFAULT_THREADS[0].id);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  const stateKey = pluginStateKey('daniels.t3code', request.instanceId);
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? threads[0];
  const repoSnapshot = useMemo(() => ({
    path: meta?.path ?? '',
    branch: meta?.branch ?? null,
    head: meta?.head_oid ?? null,
    dirty: unstagedCount + stagedCount > 0,
  }), [meta?.branch, meta?.head_oid, meta?.path, stagedCount, unstagedCount]);

  useEffect(() => {
    let current = true;
    void loadPluginState<{ threads?: T3Thread[]; activeThreadId?: string }>(stateKey).then((stored) => {
      if (!current) return;
      if (stored?.threads?.length) setThreads(stored.threads);
      if (stored?.activeThreadId) setActiveThreadId(stored.activeThreadId);
      setRestored(true);
    });
    return () => { current = false; };
  }, [loadPluginState, stateKey]);

  useEffect(() => {
    if (!restored) return;
    void savePluginState(stateKey, { threads, activeThreadId });
  }, [activeThreadId, restored, savePluginState, stateKey, threads]);

  const createThread = useCallback(() => {
    const thread: T3Thread = {
      id: crypto.randomUUID(),
      title: t('plugins.t3code.newThread'),
      updatedAt: Date.now(),
      messages: [{
        role: 'assistant',
        text: t('plugins.t3code.threadReady'),
      }],
    };
    setThreads((current) => [thread, ...current]);
    setActiveThreadId(thread.id);
    setDraft('');
    setError(null);
  }, []);

  const sendPrompt = useCallback(async () => {
    const prompt = draft.trim();
    if (!prompt || busy) return;
    if (!meta?.path) {
      setError(t('plugins.t3code.noRepository'));
      return;
    }
    if (!broker.has('ai.invoke')) {
      setError(t('plugins.t3code.noAiPermission'));
      return;
    }

    setBusy(true);
    setError(null);
    const userMessage = { role: 'user' as const, text: prompt };
    setThreads((current) => current.map((thread) => (
      thread.id === activeThreadId
        ? {
            ...thread,
            title: thread.messages.length <= 1 ? prompt.slice(0, 48) : thread.title,
            updatedAt: Date.now(),
            messages: [...thread.messages, userMessage],
          }
        : thread
    )));
    setDraft('');

    try {
      const snapshot = await broker.readRepository(
        repoSnapshot.path,
        repoSnapshot.branch,
        repoSnapshot.head,
        repoSnapshot.dirty,
      );
      const model = aiProvider === 'openai' ? openaiModel : anthropicModel;
      const styleInstruction = [
        'You are T3Code, an agent planning assistant embedded in Strand.',
        snapshot ? `Repository: ${snapshot.name} (${snapshot.branch ?? 'detached'})` : '',
        'Reply with a concise plan or next action.',
        `User request: ${prompt}`,
      ].filter(Boolean).join('\n');
      const outcome = await broker.invokeAi(
        meta.path,
        aiProvider,
        model,
        {
          opId: `t3code-${Date.now()}`,
          sensitiveDecision: { mode: 'scan' },
          styleInstruction,
        },
        openaiCli,
        anthropicCli,
      );
      const assistantText = [outcome.subject, outcome.body].filter(Boolean).join('\n\n');
      setThreads((current) => current.map((thread) => (
        thread.id === activeThreadId
          ? {
              ...thread,
              updatedAt: Date.now(),
              messages: [...thread.messages, { role: 'assistant', text: assistantText }],
            }
          : thread
      )));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }, [
    activeThreadId,
    aiProvider,
    anthropicCli,
    anthropicModel,
    broker,
    draft,
    busy,
    meta?.path,
    openaiCli,
    openaiModel,
    repoSnapshot,
  ]);

  return (
    <div
      className="plugin-surface plugin-t3code"
      data-surface-id={request.contribution.id}
      data-focused={request.lifecycle.focused || undefined}
    >
      <aside className="plugin-t3code-sidebar" aria-label={t('plugins.t3code.threads')}>
        <div className="plugin-t3code-sidebar-head">
          <strong>{t('plugins.t3code.title')}</strong>
          <button type="button" className="btn ghost" onClick={createThread}>
            <Icon name="plus" size={12} /> {t('plugins.t3code.newThread')}
          </button>
        </div>
        <ul className="plugin-t3code-thread-list" role="listbox" aria-label={t('plugins.t3code.threads')}>
          {threads.map((thread) => (
            <li key={thread.id}>
              <button
                type="button"
                role="option"
                aria-selected={thread.id === activeThreadId}
                className={'plugin-t3code-thread' + (thread.id === activeThreadId ? ' active' : '')}
                onClick={() => setActiveThreadId(thread.id)}
              >
                <span className="plugin-t3code-thread-title">{thread.title}</span>
                <span className="plugin-t3code-thread-meta">
                  {new Date(thread.updatedAt).toLocaleString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="plugin-t3code-main">
        <header className="plugin-t3code-toolbar">
          <div className="plugin-t3code-repo">
            <Icon name="folder" size={12} />
            <span>{meta?.name ?? t('plugins.t3code.noRepositoryShort')}</span>
            {repoSnapshot.branch && <span className="plugin-t3code-branch">{repoSnapshot.branch}</span>}
          </div>
          <div className="plugin-t3code-provider">
            <Icon name="sparkle" size={12} />
            <span>{aiProvider === 'openai' ? 'Codex' : 'Claude Code'}</span>
          </div>
        </header>

        <div className="plugin-t3code-transcript" aria-live="polite">
          {activeThread.messages.map((message, index) => (
            <article
              key={`${activeThread.id}-${index}`}
              className={'plugin-t3code-message' + (message.role === 'user' ? ' user' : ' assistant')}
            >
              <span className="plugin-t3code-message-role">
                {message.role === 'user' ? t('plugins.t3code.you') : t('plugins.t3code.agent')}
              </span>
              <p>{message.text}</p>
            </article>
          ))}
        </div>

        <form
          className="plugin-t3code-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendPrompt();
          }}
        >
          <textarea
            className="clone-input plugin-t3code-input"
            aria-label={t('plugins.t3code.prompt')}
            placeholder={t('plugins.t3code.promptPlaceholder')}
            value={draft}
            disabled={busy || !request.lifecycle.visible}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void sendPrompt();
              }
            }}
          />
          <button type="submit" className="btn primary" disabled={busy || draft.trim().length === 0}>
            {busy ? t('plugins.t3code.sending') : t('plugins.t3code.send')}
          </button>
        </form>
        {error && <p className="plugin-t3code-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
