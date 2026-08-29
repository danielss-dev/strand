import { useCallback, useEffect, useMemo, useState } from 'react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';

import { Icon } from '../../../components/Icon';
import { errMessage } from '../../../lib/tauri';
import { t } from '../../../lib/i18n';
import type { SurfaceRenderRequest } from '../../../workbench/SurfaceHost';
import { useRepo } from '../../../stores/repo';
import { useWork } from '../../../stores/work';
import type { PluginCapabilityBroker } from '../../capabilities';
import { pluginStateKey, usePlugins } from '../../../stores/plugins';

export type HeroiAgent = 'claude' | 'codex' | 'gemini' | 'aider' | 'shell';

interface HeroiTab {
  id: string;
  agent: HeroiAgent;
  label: string;
  running: boolean;
}

type RightPanel = 'git' | 'files';

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

function defaultTabs(): HeroiTab[] {
  return [{
    id: 'shell-default',
    agent: 'shell',
    label: 'Shell',
    running: false,
  }];
}

function pathLeaf(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
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
  const setView = useRepo((state) => state.setView);
  const selectFile = useRepo((state) => state.selectFile);
  const addTerminal = useWork((state) => state.addTerminal);
  const loadPluginState = usePlugins((state) => state.loadState);
  const savePluginState = usePlugins((state) => state.saveState);

  const [agentTabs, setAgentTabs] = useState<HeroiTab[]>(defaultTabs);
  const [activeTabId, setActiveTabId] = useState('shell-default');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rightPanel, setRightPanel] = useState<RightPanel>('git');
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  const stateKey = pluginStateKey('daniels.heroi', request.instanceId);
  const activeAgentTab = agentTabs.find((tab) => tab.id === activeTabId) ?? agentTabs[0];
  const command = activeAgentTab ? launchCommand(activeAgentTab.agent) : '';

  const project = useMemo(() => ({
    path: meta?.path ?? '',
    name: meta?.name ?? null,
    branch: meta?.branch ?? null,
    dirty: unstagedDiffs.length + stagedDiffs.length > 0,
    linked: meta?.is_linked_worktree ?? false,
  }), [meta?.branch, meta?.is_linked_worktree, meta?.name, meta?.path, stagedDiffs.length, unstagedDiffs.length]);

  useEffect(() => {
    let current = true;
    void loadPluginState<{
      agentTabs?: HeroiTab[];
      activeTabId?: string;
      rightPanel?: RightPanel;
    }>(stateKey).then((stored) => {
      if (!current) return;
      if (stored?.agentTabs?.length) setAgentTabs(stored.agentTabs.map((tab) => ({ ...tab, running: false })));
      if (stored?.activeTabId) setActiveTabId(stored.activeTabId);
      if (stored?.rightPanel) setRightPanel(stored.rightPanel);
      setRestored(true);
    });
    return () => { current = false; };
  }, [loadPluginState, stateKey]);

  useEffect(() => {
    if (!restored) return;
    void savePluginState(stateKey, {
      agentTabs: agentTabs.map(({ id, agent, label }) => ({ id, agent, label, running: false })),
      activeTabId,
      rightPanel,
    });
  }, [activeTabId, agentTabs, restored, rightPanel, savePluginState, stateKey]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.plugin-heroi-tab-picker')) setPickerOpen(false);
    };
    window.addEventListener('mousedown', onPointer);
    return () => window.removeEventListener('mousedown', onPointer);
  }, [pickerOpen]);

  const addAgentTab = useCallback((agent: HeroiAgent) => {
    const tab: HeroiTab = {
      id: crypto.randomUUID(),
      agent,
      label: agentLabel(agent),
      running: false,
    };
    setAgentTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    setPickerOpen(false);
    setError(null);
    setStatusNote(null);
  }, []);

  const closeAgentTab = useCallback((tabId: string) => {
    setAgentTabs((current) => {
      const next = current.filter((tab) => tab.id !== tabId);
      const resolved = next.length === 0 ? defaultTabs() : next;
      setActiveTabId((active) => {
        if (active !== tabId) return active;
        return resolved[resolved.length - 1]?.id ?? 'shell-default';
      });
      return resolved;
    });
  }, []);

  const openHeroiRepo = useCallback(async () => {
    try {
      await shellOpen(HEROI_REPO_URL);
    } catch (e) {
      setError(errMessage(e));
    }
  }, []);

  const runActiveAgent = useCallback(() => {
    if (!meta?.path || !activeAgentTab) {
      setError(t('plugins.heroi.noRepository'));
      return;
    }
    void broker.readRepository(
      project.path,
      project.branch,
      meta.head_oid,
      project.dirty,
    ).catch(() => undefined);

    addTerminal(meta.path, null, activeAgentTab.label);
    setAgentTabs((current) => current.map((tab) => (
      tab.id === activeAgentTab.id ? { ...tab, running: true } : tab
    )));
    setView('work');
    const note = command
      ? t('plugins.heroi.launchedWithCommand', { agent: activeAgentTab.label, command })
      : t('plugins.heroi.launchedShell', { agent: activeAgentTab.label });
    setStatusNote(note);
    setError(null);
  }, [activeAgentTab, addTerminal, broker, command, meta, project, setView]);

  const openChangedFile = useCallback((path: string) => {
    selectFile(path);
    setView('local');
  }, [selectFile, setView]);

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

  return (
    <div
      className="plugin-surface plugin-heroi"
      data-surface-id={request.contribution.id}
      data-focused={request.lifecycle.focused || undefined}
    >
      <aside className="plugin-heroi-left" aria-label={t('plugins.heroi.sidebar')}>
        <div className="plugin-heroi-brand">
          <img src="/heroilogo.png" alt="" width={16} height={16} className="plugin-heroi-logo" />
          <span>{t('plugins.heroi.title')}</span>
        </div>

        <div className="plugin-heroi-repo-list">
          {tabs.length === 0 ? (
            <div className="plugin-heroi-empty">
              <p>{t('plugins.heroi.emptyRepos')}</p>
              <p>{t('plugins.heroi.emptyReposHint')}</p>
            </div>
          ) : (
            <ul role="listbox" aria-label={t('plugins.heroi.project')}>
              {tabs.map((tab) => {
                const selected = tab.path === (activeTabPath ?? meta?.path);
                return (
                  <li key={tab.path}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={'plugin-heroi-repo' + (selected ? ' active' : '')}
                      onClick={() => { void setActiveTab(tab.path); }}
                    >
                      <Icon name="folder" size={13} />
                      <span className="plugin-heroi-repo-name">{tab.meta?.name ?? pathLeaf(tab.path)}</span>
                      {tab.meta?.branch && (
                        <span className="plugin-heroi-repo-branch">{tab.meta.branch}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="plugin-heroi-left-foot">
          <button type="button" className="btn ghost plugin-heroi-foot-btn" onClick={() => void openHeroiRepo()}>
            <Icon name="external" size={12} />
            {t('plugins.heroi.openProject')}
          </button>
        </div>
      </aside>

      <section className="plugin-heroi-center" aria-label={t('plugins.heroi.title')}>
        <header className="plugin-heroi-topbar">
          {project.path ? (
            <>
              <Icon name="folder-open" size={13} />
              <span className="plugin-heroi-path">/{pathLeaf(project.path)}</span>
              {project.branch && <span className="plugin-heroi-chip">{project.branch}</span>}
              {project.linked && <span className="plugin-heroi-chip">{t('plugins.heroi.worktree')}</span>}
              {project.dirty && <span className="plugin-heroi-chip dirty">{t('plugins.heroi.dirty')}</span>}
              <div className="plugin-heroi-topbar-spacer" />
              <button
                type="button"
                className="btn primary"
                disabled={!meta?.path || !request.lifecycle.visible}
                onClick={runActiveAgent}
              >
                <Icon name="terminal" size={12} />
                {t('plugins.heroi.run')}
              </button>
            </>
          ) : (
            <span className="plugin-heroi-muted">{t('plugins.heroi.selectWorkspace')}</span>
          )}
        </header>

        {project.path ? (
          <>
            <div className="plugin-heroi-tabbar" aria-label={t('plugins.heroi.agentTabs')}>
              <div className="plugin-heroi-tab-strip">
                {agentTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={'plugin-heroi-agent-tab' + (tab.id === activeTabId ? ' active' : '')}
                    onClick={() => setActiveTabId(tab.id)}
                  >
                    {tab.running ? (
                      <span className="plugin-heroi-running" aria-hidden />
                    ) : (
                      <Icon name={tab.agent === 'shell' ? 'terminal' : 'sparkle'} size={11} />
                    )}
                    <span>{tab.label}</span>
                    <span
                      className="plugin-heroi-tab-close"
                      role="button"
                      tabIndex={0}
                      aria-label={t('plugins.heroi.closeTab')}
                      onClick={(event) => {
                        event.stopPropagation();
                        closeAgentTab(tab.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          event.stopPropagation();
                          closeAgentTab(tab.id);
                        }
                      }}
                    >
                      <Icon name="x" size={10} />
                    </span>
                  </button>
                ))}
              </div>
              <div className="plugin-heroi-tab-picker">
                <button
                  type="button"
                  className="plugin-heroi-add-tab"
                  aria-label={t('plugins.heroi.newTab')}
                  aria-expanded={pickerOpen}
                  onClick={() => setPickerOpen((open) => !open)}
                >
                  <Icon name="plus" size={13} />
                </button>
                {pickerOpen && (
                  <div className="plugin-heroi-picker-menu" role="menu">
                    {AGENTS.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        role="menuitem"
                        onClick={() => addAgentTab(agent.id)}
                      >
                        <Icon name={agent.id === 'shell' ? 'terminal' : 'sparkle'} size={12} />
                        {agent.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="plugin-heroi-terminal">
              <div className="plugin-heroi-terminal-copy">
                <Icon name={activeAgentTab?.agent === 'shell' ? 'terminal' : 'sparkle'} size={22} />
                <strong>{activeAgentTab?.label ?? t('plugins.heroi.agent')}</strong>
                <p>
                  {command
                    ? t('plugins.heroi.terminalHintCommand', { command })
                    : t('plugins.heroi.terminalHintShell')}
                </p>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!meta?.path || !request.lifecycle.visible}
                  onClick={runActiveAgent}
                >
                  <Icon name="terminal" size={12} />
                  {t('plugins.heroi.runInWork')}
                </button>
                {statusNote && <p className="plugin-heroi-status-note">{statusNote}</p>}
              </div>
            </div>
          </>
        ) : (
          <div className="plugin-heroi-terminal plugin-heroi-terminal-empty">
            <p>{t('plugins.heroi.selectWorkspace')}</p>
          </div>
        )}
        {error && <p className="plugin-heroi-error" role="alert">{error}</p>}
      </section>

      <aside className="plugin-heroi-right" aria-label={t('plugins.heroi.inspector')}>
        <div className="plugin-heroi-right-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={rightPanel === 'git'}
            className={rightPanel === 'git' ? 'active' : undefined}
            onClick={() => setRightPanel('git')}
          >
            <Icon name="branch" size={12} />
            {t('plugins.heroi.git')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={rightPanel === 'files'}
            className={rightPanel === 'files' ? 'active' : undefined}
            onClick={() => setRightPanel('files')}
          >
            <Icon name="folder" size={12} />
            {t('plugins.heroi.files')}
          </button>
        </div>

        {rightPanel === 'git' ? (
          <div className="plugin-heroi-right-body">
            <header className="plugin-heroi-right-head">
              <Icon name="branch" size={13} />
              <span>{t('plugins.heroi.git')}</span>
            </header>
            {!project.path ? (
              <p className="plugin-heroi-empty-inline">{t('plugins.heroi.gitEmpty')}</p>
            ) : changedFiles.length === 0 ? (
              <p className="plugin-heroi-empty-inline">{t('plugins.heroi.gitClean')}</p>
            ) : (
              <ul className="plugin-heroi-file-list">
                {changedFiles.map((file) => (
                  <li key={`${file.kind}:${file.path}`}>
                    <button type="button" onClick={() => openChangedFile(file.path)}>
                      <span className={'plugin-heroi-file-kind ' + file.kind}>{file.kind}</span>
                      <span className="plugin-heroi-file-path">{file.path}</span>
                      <span className="plugin-heroi-file-stats">
                        +{file.adds} −{file.dels}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="plugin-heroi-right-body">
            <header className="plugin-heroi-right-head">
              <Icon name="folder" size={13} />
              <span>{t('plugins.heroi.files')}</span>
            </header>
            {!project.path ? (
              <p className="plugin-heroi-empty-inline">{t('plugins.heroi.filesEmpty')}</p>
            ) : (
              <div className="plugin-heroi-files-hint">
                <p>{t('plugins.heroi.filesHint')}</p>
                <button type="button" className="btn ghost" onClick={() => setView('work')}>
                  <Icon name="folder-open" size={12} />
                  {t('plugins.heroi.openFilesInWork')}
                </button>
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
