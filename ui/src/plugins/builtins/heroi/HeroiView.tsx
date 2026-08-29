import { useCallback, useEffect, useMemo, useState } from 'react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';

import { Icon } from '../../../components/Icon';
import { Select } from '../../../components/Select';
import { errMessage, isTauri, tauri } from '../../../lib/tauri';
import { t } from '../../../lib/i18n';
import type { AiProvider, AiProviderStatus } from '../../../lib/types';
import type { SurfaceRenderRequest } from '../../../workbench/SurfaceHost';
import { useRepo } from '../../../stores/repo';
import { useSettings } from '../../../stores/settings';
import { useWork } from '../../../stores/work';
import type { PluginCapabilityBroker } from '../../capabilities';
import { pluginStateKey, usePlugins } from '../../../stores/plugins';

export type HeroiAgent = 'claude' | 'codex' | 'gemini' | 'aider' | 'shell';

interface HeroiSession {
  id: string;
  title: string;
  agent: HeroiAgent;
  updatedAt: number;
  messages: readonly { role: 'user' | 'assistant' | 'system'; text: string }[];
}

const AGENTS: readonly { id: HeroiAgent; label: string; command: string }[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini' },
  { id: 'aider', label: 'Aider', command: 'aider' },
  { id: 'shell', label: 'Shell', command: '' },
];

const HEROI_REPO_URL = 'https://github.com/danielss-dev/heroi';

function agentLabel(agent: HeroiAgent): string {
  return AGENTS.find((entry) => entry.id === agent)?.label ?? agent;
}

function launchCommand(agent: HeroiAgent): string {
  return AGENTS.find((entry) => entry.id === agent)?.command ?? '';
}

function welcomeSession(agent: HeroiAgent): HeroiSession {
  return {
    id: 'welcome',
    title: 'Getting started',
    agent,
    updatedAt: Date.now(),
    messages: [{ role: 'system', text: t('plugins.heroi.welcome') }],
  };
}

function providerForAgent(agent: HeroiAgent): AiProvider | null {
  if (agent === 'codex') return 'openai';
  if (agent === 'claude') return 'anthropic';
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
  const unstagedCount = useRepo((state) => state.unstagedDiffs.length);
  const stagedCount = useRepo((state) => state.stagedDiffs.length);
  const setView = useRepo((state) => state.setView);
  const openaiModel = useSettings((state) => state.openaiModel);
  const anthropicModel = useSettings((state) => state.anthropicModel);
  const openaiCli = useSettings((state) => state.openaiCli);
  const anthropicCli = useSettings((state) => state.anthropicCli);
  const addTerminal = useWork((state) => state.addTerminal);
  const loadPluginState = usePlugins((state) => state.loadState);
  const savePluginState = usePlugins((state) => state.saveState);

  const [agent, setAgent] = useState<HeroiAgent>('claude');
  const [sessions, setSessions] = useState<HeroiSession[]>(() => [welcomeSession('claude')]);
  const [activeSessionId, setActiveSessionId] = useState('welcome');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [providerStatus, setProviderStatus] = useState<Partial<Record<AiProvider, AiProviderStatus>>>({});

  const stateKey = pluginStateKey('daniels.heroi', request.instanceId);
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const provider = providerForAgent(agent);

  const project = useMemo(() => ({
    path: meta?.path ?? '',
    name: meta?.name ?? null,
    branch: meta?.branch ?? null,
    head: meta?.head_oid ?? null,
    dirty: unstagedCount + stagedCount > 0,
    linked: meta?.is_linked_worktree ?? false,
  }), [meta?.branch, meta?.head_oid, meta?.is_linked_worktree, meta?.name, meta?.path, stagedCount, unstagedCount]);

  useEffect(() => {
    let current = true;
    void loadPluginState<{
      sessions?: HeroiSession[];
      activeSessionId?: string;
      agent?: HeroiAgent;
    }>(stateKey).then((stored) => {
      if (!current) return;
      if (stored?.sessions?.length) setSessions(stored.sessions);
      if (stored?.activeSessionId) setActiveSessionId(stored.activeSessionId);
      if (stored?.agent) setAgent(stored.agent);
      setRestored(true);
    });
    return () => { current = false; };
  }, [loadPluginState, stateKey]);

  useEffect(() => {
    if (!restored) return;
    void savePluginState(stateKey, { sessions, activeSessionId, agent });
  }, [activeSessionId, agent, restored, savePluginState, sessions, stateKey]);

  useEffect(() => {
    if (!request.lifecycle.visible || !isTauri() || !provider) return;
    void tauri.aiProviderStatus(provider, openaiCli, anthropicCli)
      .then((status) => setProviderStatus((current) => ({ ...current, [provider]: status })))
      .catch(() => undefined);
  }, [anthropicCli, openaiCli, provider, request.lifecycle.visible]);

  const createSession = useCallback(() => {
    const session: HeroiSession = {
      id: crypto.randomUUID(),
      title: t('plugins.heroi.newSession'),
      agent,
      updatedAt: Date.now(),
      messages: [{ role: 'system', text: t('plugins.heroi.sessionReady', { agent: agentLabel(agent) }) }],
    };
    setSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
    setDraft('');
    setError(null);
  }, [agent]);

  const openHeroiRepo = useCallback(async () => {
    try {
      await shellOpen(HEROI_REPO_URL);
    } catch (e) {
      setError(errMessage(e));
    }
  }, []);

  const runInWork = useCallback(() => {
    if (!meta?.path) {
      setError(t('plugins.heroi.noRepository'));
      return;
    }
    addTerminal(meta.path);
    setView('work');
    const command = launchCommand(agent);
    const note = command
      ? t('plugins.heroi.launchedWithCommand', { agent: agentLabel(agent), command })
      : t('plugins.heroi.launchedShell', { agent: agentLabel(agent) });
    setSessions((current) => current.map((session) => (
      session.id === activeSessionId
        ? {
            ...session,
            title: session.messages.filter((m) => m.role !== 'system').length === 0
              ? `Run ${agentLabel(agent)}`
              : session.title,
            agent,
            updatedAt: Date.now(),
            messages: [
              ...session.messages,
              { role: 'assistant', text: note },
            ],
          }
        : session
    )));
    setError(null);
  }, [activeSessionId, addTerminal, agent, meta?.path, setView]);

  const sendPlan = useCallback(async () => {
    const prompt = draft.trim();
    if (!prompt || busy) return;
    if (!meta?.path) {
      setError(t('plugins.heroi.noRepository'));
      return;
    }
    if (!provider) {
      setError(t('plugins.heroi.planNeedsProvider'));
      return;
    }
    if (!broker.has('ai.invoke')) {
      setError(t('plugins.heroi.noAiPermission'));
      return;
    }

    setBusy(true);
    setError(null);
    setSessions((current) => current.map((session) => (
      session.id === activeSessionId
        ? {
            ...session,
            title: session.messages.filter((m) => m.role !== 'system').length === 0
              ? prompt.slice(0, 48)
              : session.title,
            agent,
            updatedAt: Date.now(),
            messages: [...session.messages, { role: 'user', text: prompt }],
          }
        : session
    )));
    setDraft('');

    try {
      const snapshot = await broker.readRepository(
        project.path,
        project.branch,
        project.head,
        project.dirty,
      );
      const model = provider === 'openai' ? openaiModel : anthropicModel;
      const outcome = await broker.invokeAi(
        meta.path,
        provider,
        model,
        {
          opId: `heroi-${Date.now()}`,
          sensitiveDecision: { mode: 'scan' },
          styleInstruction: [
            'You are Heroi, Daniels\' local AI agent orchestrator embedded in Strand.',
            `Selected agent: ${agentLabel(agent)}.`,
            'Reply with a concise plan for what that agent should do next in this repository.',
            snapshot
              ? `Project: ${snapshot.name} @ ${snapshot.branch ?? 'detached'} (${snapshot.dirty ? 'dirty' : 'clean'})`
              : '',
            `Path: ${meta.path}`,
            `User: ${prompt}`,
          ].filter(Boolean).join('\n'),
        },
        openaiCli,
        anthropicCli,
      );
      const text = [outcome.subject, outcome.body].filter(Boolean).join('\n\n');
      setSessions((current) => current.map((session) => (
        session.id === activeSessionId
          ? {
              ...session,
              updatedAt: Date.now(),
              messages: [...session.messages, { role: 'assistant', text }],
            }
          : session
      )));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }, [
    activeSessionId,
    agent,
    anthropicCli,
    anthropicModel,
    broker,
    busy,
    draft,
    meta?.path,
    openaiCli,
    openaiModel,
    project,
    provider,
  ]);

  const liveStatus = provider ? providerStatus[provider] : null;
  const command = launchCommand(agent);

  return (
    <div
      className="plugin-surface plugin-heroi"
      data-surface-id={request.contribution.id}
      data-focused={request.lifecycle.focused || undefined}
    >
      <aside className="plugin-heroi-sidebar" aria-label={t('plugins.heroi.sidebar')}>
        <div className="plugin-heroi-brand">
          <Icon name="sparkle" size={14} />
          <div>
            <strong>{t('plugins.heroi.title')}</strong>
            <span>{t('plugins.heroi.subtitle')}</span>
          </div>
        </div>

        <section className="plugin-heroi-project" aria-label={t('plugins.heroi.project')}>
          <header>
            <Icon name="folder" size={12} />
            <span>{t('plugins.heroi.project')}</span>
          </header>
          <div className="plugin-heroi-project-card">
            <strong>{project.name ?? t('plugins.heroi.noRepositoryShort')}</strong>
            {project.branch && <span className="plugin-heroi-chip">{project.branch}</span>}
            {project.linked && <span className="plugin-heroi-chip">{t('plugins.heroi.worktree')}</span>}
            {project.dirty && <span className="plugin-heroi-chip dirty">{t('plugins.heroi.dirty')}</span>}
          </div>
        </section>

        <div className="plugin-heroi-sidebar-head">
          <span>{t('plugins.heroi.sessions')}</span>
          <button type="button" className="btn ghost" onClick={createSession}>
            <Icon name="plus" size={12} /> {t('plugins.heroi.newSession')}
          </button>
        </div>
        <ul className="plugin-heroi-session-list" role="listbox" aria-label={t('plugins.heroi.sessions')}>
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                role="option"
                aria-selected={session.id === activeSessionId}
                className={'plugin-heroi-session' + (session.id === activeSessionId ? ' active' : '')}
                onClick={() => {
                  setActiveSessionId(session.id);
                  setAgent(session.agent);
                }}
              >
                <span className="plugin-heroi-session-title">{session.title}</span>
                <span className="plugin-heroi-session-meta">{agentLabel(session.agent)}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="plugin-heroi-main">
        <header className="plugin-heroi-toolbar">
          <label>
            <span>{t('plugins.heroi.agent')}</span>
            <Select
              className="settings-select"
              aria-label={t('plugins.heroi.agent')}
              value={agent}
              onChange={(event) => setAgent(event.target.value as HeroiAgent)}
            >
              {AGENTS.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.label}</option>
              ))}
            </Select>
          </label>
          <div className="plugin-heroi-toolbar-actions">
            <button type="button" className="btn primary" disabled={!meta?.path} onClick={runInWork}>
              <Icon name="terminal" size={12} /> {t('plugins.heroi.runInWork')}
            </button>
            <button type="button" className="btn ghost" onClick={() => void openHeroiRepo()}>
              {t('plugins.heroi.openProject')}
            </button>
          </div>
        </header>

        <div className="plugin-heroi-status-bar">
          <span>
            <Icon name="sparkle" size={11} />
            {agentLabel(agent)}
            {command ? ` · ${command}` : ''}
            {provider && (
              <>
                {' · '}
                {liveStatus?.logged_in
                  ? (liveStatus.account_hint ?? t('plugins.heroi.providerReady'))
                  : liveStatus?.installed
                    ? t('plugins.heroi.providerNeedsLogin')
                    : t('plugins.heroi.providerMissing')}
              </>
            )}
          </span>
          <span>{t('plugins.heroi.bridgeHint')}</span>
        </div>

        <div className="plugin-heroi-transcript" aria-live="polite">
          {activeSession.messages.map((message, index) => (
            <article
              key={`${activeSession.id}-${index}`}
              className={`plugin-heroi-message ${message.role}`}
            >
              <span className="plugin-heroi-message-role">
                {message.role === 'user'
                  ? t('plugins.heroi.you')
                  : message.role === 'system'
                    ? t('plugins.heroi.system')
                    : t('plugins.heroi.agentRole')}
              </span>
              <p>{message.text}</p>
            </article>
          ))}
        </div>

        <form
          className="plugin-heroi-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendPlan();
          }}
        >
          <textarea
            className="clone-input plugin-heroi-input"
            aria-label={t('plugins.heroi.prompt')}
            placeholder={provider
              ? t('plugins.heroi.planPlaceholder')
              : t('plugins.heroi.runPlaceholder')}
            value={draft}
            disabled={busy || !request.lifecycle.visible || !provider}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && provider) {
                event.preventDefault();
                void sendPlan();
              }
            }}
          />
          <div className="plugin-heroi-composer-actions">
            <span className="plugin-heroi-composer-meta">
              {provider ? t('plugins.heroi.planMode') : t('plugins.heroi.terminalMode')}
            </span>
            <button
              type="submit"
              className="btn primary"
              disabled={busy || !provider || draft.trim().length === 0}
            >
              {busy ? t('plugins.heroi.sending') : t('plugins.heroi.plan')}
            </button>
          </div>
        </form>
        {error && <p className="plugin-heroi-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
