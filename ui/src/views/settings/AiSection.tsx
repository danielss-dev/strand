import { useCallback, useEffect, useState } from 'react';

import { repoAiStyle } from '../../lib/db';
import { errMessage, tauri } from '../../lib/tauri';
import type { AiProvider, AiProviderStatus } from '../../lib/types';
import { useRepo } from '../../stores/repo';
import { useSettings } from '../../stores/settings';

const PROVIDERS: { id: AiProvider; label: string }[] = [
  { id: 'openai', label: 'OpenAI (ChatGPT subscription)' },
  { id: 'anthropic', label: 'Anthropic (Claude Code CLI)' },
];

type CliStatus = AiProviderStatus | null;

function formatCliStatus(status: CliStatus, cliLabel: string): string {
  if (!status) return 'Not checked yet.';
  if (!status.installed) return `${cliLabel} CLI not found on PATH or at the custom path above.`;
  if (status.error) return status.error;
  if (status.logged_in) return status.account_hint ?? 'Signed in';
  return 'Installed but not signed in';
}

/**
 * AI writing suggestions via vendor CLIs (Codex / Claude Code).
 * Auth and billing stay in the official tools; Strand only orchestrates them.
 */
export function AiSection() {
  const aiProvider = useSettings((s) => s.aiProvider);
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

  const checkBoth = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const [openai, anthropic] = await Promise.all([
        tauri.aiProviderStatus('openai', openaiCli, anthropicCli),
        tauri.aiProviderStatus('anthropic', openaiCli, anthropicCli),
      ]);
      setOpenaiStatus(openai);
      setAnthropicStatus(anthropic);
    } catch (e) {
      setMessage(errMessage(e));
    } finally {
      setBusy(false);
    }
  }, [openaiCli, anthropicCli]);

  async function login(provider: AiProvider) {
    setBusy(true);
    setMessage(null);
    try {
      await tauri.aiProviderLogin(provider, openaiCli, anthropicCli);
      setMessage('Sign-in started — complete it in the browser or CLI window, then click Check CLI status.');
    } catch (e) {
      setMessage(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function logout(provider: AiProvider) {
    setBusy(true);
    setMessage(null);
    try {
      await tauri.aiProviderLogout(provider, openaiCli, anthropicCli);
      await checkBoth();
      setMessage('Signed out.');
    } catch (e) {
      setMessage(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const panelHint =
    aiProvider === 'openai'
      ? 'Uses your ChatGPT subscription via the Codex CLI. Sign-in is prompted when you first generate text.'
      : 'Uses the Claude Code CLI (`claude`). Sign-in is prompted when you first generate text.';

  return (
    <section className="settings-section" aria-label="AI">
      <div className="settings-field">
        <span className="settings-field-label">AI writing provider</span>
        <select
          className="settings-select"
          aria-label="AI writing provider"
          value={aiProvider}
          onChange={(e) => {
            setMessage(null);
            set('aiProvider', e.target.value as AiProvider);
          }}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <p className="settings-hint">{panelHint}</p>
      </div>

      <div className="settings-field">
        <span className="settings-field-label">Repository writing profile</span>
        <textarea
          className="clone-input"
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

      <div className="settings-field">
        <span className="settings-field-label">Codex CLI</span>
        <input
          type="text"
          className="clone-input"
          aria-label="Custom Codex CLI path"
          placeholder="Leave empty to use codex on PATH"
          value={openaiCli ?? ''}
          onChange={(e) => {
            setOpenaiStatus(null);
            set('openaiCli', e.target.value.trim() || null);
          }}
        />
        <p className="settings-hint">{formatCliStatus(openaiStatus, 'Codex')}</p>
        <div className="settings-row">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void login('openai')}
          >
            Sign in with ChatGPT
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !openaiStatus?.logged_in}
            onClick={() => void logout('openai')}
          >
            Sign out
          </button>
        </div>
      </div>

      <div className="settings-field">
        <span className="settings-field-label">Claude Code CLI</span>
        <input
          type="text"
          className="clone-input"
          aria-label="Custom Claude CLI path"
          placeholder="Leave empty to use claude on PATH"
          value={anthropicCli ?? ''}
          onChange={(e) => {
            setAnthropicStatus(null);
            set('anthropicCli', e.target.value.trim() || null);
          }}
        />
        <p className="settings-hint">{formatCliStatus(anthropicStatus, 'Claude Code')}</p>
        <div className="settings-row">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void login('anthropic')}
          >
            Sign in to Claude Code
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !anthropicStatus?.logged_in}
            onClick={() => void logout('anthropic')}
          >
            Sign out
          </button>
        </div>
      </div>

      <div className="settings-field">
        <div className="settings-row">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void checkBoth()}>
            Check CLI status
          </button>
        </div>
        {message && <p className="settings-hint">{message}</p>}
      </div>
    </section>
  );
}
