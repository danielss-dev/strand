import { useEffect, useState } from 'react';

import { Select } from '../../components/Select';
import { repoAiStyle } from '../../lib/db';
import { errMessage, tauri } from '../../lib/tauri';
import type { AiProvider, AiProviderStatus } from '../../lib/types';
import { useRepo } from '../../stores/repo';
import {
  type AiConnectionSnapshot,
  type AnthropicModel,
  type OpenAiModel,
  useSettings,
} from '../../stores/settings';

const PROVIDERS: { id: AiProvider; label: string }[] = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
];

const OPENAI_MODELS: { id: OpenAiModel; label: string; hint: string }[] = [
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', hint: 'Fastest · recommended for writing' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', hint: 'Balanced' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', hint: 'Highest capability' },
];

const ANTHROPIC_MODELS: { id: AnthropicModel; label: string; hint: string }[] = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'Fastest' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', hint: 'Balanced · recommended for writing' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', hint: 'Highest capability' },
];

type CliStatus = AiProviderStatus | null;

function savedCliStatus(provider: AiProvider, snapshot: AiConnectionSnapshot | null): CliStatus {
  if (!snapshot) return null;
  return {
    provider,
    installed: snapshot.installed,
    logged_in: snapshot.loggedIn,
    account_hint: snapshot.loggedIn ? 'Connected' : undefined,
  };
}

function formatCliStatus(status: CliStatus, cliLabel: string): string {
  if (!status) return 'Status not checked';
  if (!status.installed) return `${cliLabel} not found`;
  if (status.error) return status.error;
  if (status.logged_in) return status.account_hint ?? 'Signed in';
  return 'Installed · sign-in required';
}

/**
 * AI writing suggestions via vendor CLIs (Codex / Claude Code).
 * Auth and billing stay in the official tools; Strand only orchestrates them.
 */
export function AiSection() {
  const aiProvider = useSettings((s) => s.aiProvider);
  const openaiModel = useSettings((s) => s.openaiModel);
  const anthropicModel = useSettings((s) => s.anthropicModel);
  const aiConnectionStatus = useSettings((s) => s.aiConnectionStatus);
  const openaiCli = useSettings((s) => s.openaiCli);
  const anthropicCli = useSettings((s) => s.anthropicCli);
  const set = useSettings((s) => s.set);
  const meta = useRepo((s) => s.meta);

  const [openaiStatus, setOpenaiStatus] = useState<CliStatus>(null);
  const [anthropicStatus, setAnthropicStatus] = useState<CliStatus>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [repoStyle, setRepoStyle] = useState('');

  useEffect(() => {
    let current = true;
    setRepoStyle('');
    if (meta?.common_dir) {
      void repoAiStyle.get(meta.common_dir).then((value) => {
        if (current) setRepoStyle(value ?? '');
      });
    }
    return () => { current = false; };
  }, [meta?.common_dir]);

  const isOpenAi = aiProvider === 'openai';
  const providerName = isOpenAi ? 'OpenAI' : 'Anthropic';
  const cliLabel = isOpenAi ? 'Codex CLI' : 'Claude Code CLI';
  const cliPath = isOpenAi ? openaiCli : anthropicCli;
  const liveStatus = isOpenAi ? openaiStatus : anthropicStatus;
  const savedStatus = aiConnectionStatus[aiProvider];
  const status = liveStatus ?? savedCliStatus(aiProvider, savedStatus);
  const models = isOpenAi ? OPENAI_MODELS : ANTHROPIC_MODELS;
  const model = isOpenAi ? openaiModel : anthropicModel;
  const modelHint = models.find((option) => option.id === model)?.hint;

  function setStatus(value: CliStatus) {
    if (isOpenAi) setOpenaiStatus(value);
    else setAnthropicStatus(value);
  }

  function saveStatus(value: AiProviderStatus) {
    const current = useSettings.getState().aiConnectionStatus;
    set('aiConnectionStatus', {
      ...current,
      [aiProvider]: {
        installed: value.installed,
        loggedIn: value.logged_in,
        checkedAt: Date.now(),
      },
    });
  }

  function clearSavedStatus() {
    const current = useSettings.getState().aiConnectionStatus;
    set('aiConnectionStatus', { ...current, [aiProvider]: null });
  }

  async function checkStatus() {
    setBusy(true);
    setMessage(null);
    try {
      const checked = await tauri.aiProviderStatus(aiProvider, openaiCli, anthropicCli);
      setStatus(checked);
      saveStatus(checked);
    } catch (e) {
      setMessage(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    setBusy(true);
    setMessage(null);
    try {
      await tauri.aiProviderLogin(aiProvider, openaiCli, anthropicCli);
      setMessage('Sign-in started. Complete it in the browser or CLI window, then check status.');
    } catch (e) {
      setMessage(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setMessage(null);
    try {
      await tauri.aiProviderLogout(aiProvider, openaiCli, anthropicCli);
      const checked = await tauri.aiProviderStatus(aiProvider, openaiCli, anthropicCli);
      setStatus(checked);
      saveStatus(checked);
      setMessage('Signed out.');
    } catch (e) {
      setMessage(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section ai-settings" aria-label="AI">
      <div className="ai-settings-intro">
        <span className="settings-field-label">AI writing</span>
        <p>Generate commit messages and pull request drafts with your existing provider subscription.</p>
      </div>

      <div className="settings-rows">
        <label className="settings-frow">
          <span className="settings-frow-text">
            <span className="settings-field-label">Provider</span>
            <span className="settings-frow-hint">Choose the account used for text generation</span>
          </span>
          <Select
            className="settings-select"
            aria-label="AI writing provider"
            value={aiProvider}
            onChange={(event) => {
              setMessage(null);
              set('aiProvider', event.target.value as AiProvider);
            }}
          >
            {PROVIDERS.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.label}</option>
            ))}
          </Select>
        </label>

        <label className="settings-frow">
          <span className="settings-frow-text">
            <span className="settings-field-label">Model</span>
            <span className="settings-frow-hint">{modelHint} · used for commits and pull requests</span>
          </span>
          <Select
            className="settings-select ai-model-select"
            aria-label={`${providerName} writing model`}
            value={model}
            onChange={(event) => {
              if (isOpenAi) set('openaiModel', event.target.value as OpenAiModel);
              else set('anthropicModel', event.target.value as AnthropicModel);
            }}
          >
            {models.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </Select>
        </label>
      </div>

      <div className="ai-provider-card">
        <div className="ai-provider-head">
          <div>
            <span className="settings-field-label">{providerName} account</span>
            <p>
              {status?.logged_in
                ? `Connected. Your sign-in is saved by ${cliLabel}.`
                : isOpenAi
                  ? 'Connect with your ChatGPT subscription.'
                  : 'Connect with your Claude subscription.'}
            </p>
          </div>
          <span
            className="ai-provider-status"
            data-state={status?.logged_in ? 'ready' : status ? 'attention' : 'idle'}
            aria-live="polite"
            title={savedStatus ? `Last checked ${new Date(savedStatus.checkedAt).toLocaleString()}` : undefined}
          >
            <i aria-hidden="true" />
            {status?.logged_in && !liveStatus ? 'Connected · saved' : formatCliStatus(status, cliLabel)}
          </span>
        </div>

        <label className="settings-field ai-cli-path">
          <span className="settings-field-label">{cliLabel} path <em>Optional</em></span>
          <input
            type="text"
            className="clone-input"
            aria-label={`Custom ${cliLabel} path`}
            placeholder={`Use ${isOpenAi ? 'codex' : 'claude'} on PATH`}
            value={cliPath ?? ''}
            onChange={(event) => {
              setStatus(null);
              clearSavedStatus();
              if (isOpenAi) set('openaiCli', event.target.value.trim() || null);
              else set('anthropicCli', event.target.value.trim() || null);
            }}
          />
        </label>

        <div className="settings-row ai-provider-actions">
          {!status?.logged_in && (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void login()}>
              {isOpenAi ? 'Sign in with ChatGPT' : 'Sign in to Claude'}
            </button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={() => void checkStatus()}>
            {busy ? 'Checking…' : status?.logged_in ? 'Refresh status' : 'Check status'}
          </button>
          {status?.logged_in && (
            <button type="button" className="btn ai-sign-out" disabled={busy} onClick={() => void logout()}>
              Sign out
            </button>
          )}
        </div>
        {message && <p className="settings-hint ai-provider-message" aria-live="polite">{message}</p>}
      </div>

      <div className="settings-field">
        <span className="settings-field-label">Repository writing profile</span>
        <textarea
          className="clone-input ai-writing-profile"
          aria-label="Repository AI writing profile"
          disabled={!meta?.common_dir}
          maxLength={1_000}
          placeholder={meta ? 'Optional style, terminology, or audience guidance' : 'Open a repository to set its writing profile'}
          value={repoStyle}
          onChange={(event) => setRepoStyle(event.target.value)}
          onBlur={() => {
            if (meta?.common_dir) void repoAiStyle.set(meta.common_dir, repoStyle);
          }}
        />
        <p className="settings-hint">
          {meta
            ? `Shared by this repository family. ${repoStyle.length}/1,000 characters.`
            : 'Recent commit subjects are still used automatically when no profile is set.'}
        </p>
      </div>
    </section>
  );
}
