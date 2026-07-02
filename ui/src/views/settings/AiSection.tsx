import { useCallback, useState } from 'react';

import { errMessage, tauri } from '../../lib/tauri';
import type { AiProvider, AiProviderStatus } from '../../lib/types';
import { useSettings } from '../../stores/settings';

const PROVIDERS: { id: AiProvider; label: string }[] = [
  { id: 'openai', label: 'OpenAI (ChatGPT subscription)' },
  { id: 'anthropic', label: 'Anthropic (Claude Code CLI)' },
];

type CliStatus = AiProviderStatus | null;

function formatCliStatus(status: CliStatus, cliLabel: string): string {
  if (!status) return 'Not checked yet.';
  if (!status.installed) return `${cliLabel} CLI not found on PATH or at the custom path above.`;
  if (status.logged_in) return status.account_hint ?? 'Signed in';
  return 'Installed but not signed in';
}

/**
 * AI — commit message suggestions via vendor CLIs (Codex / Claude Code).
 * Auth and billing stay in the official tools; Strand only orchestrates them.
 */
export function AiSection() {
  const aiProvider = useSettings((s) => s.aiProvider);
  const openaiCli = useSettings((s) => s.openaiCli);
  const anthropicCli = useSettings((s) => s.anthropicCli);
  const set = useSettings((s) => s.set);

  const [openaiStatus, setOpenaiStatus] = useState<CliStatus>(null);
  const [anthropicStatus, setAnthropicStatus] = useState<CliStatus>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
      setMessage('Browser opened — complete sign-in there, then click Check CLI status.');
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
      ? 'Uses your ChatGPT subscription via the Codex CLI. Sign-in is prompted when you first suggest a message.'
      : 'Uses the Claude Code CLI (`claude`). Sign-in is prompted when you first suggest a message.';

  return (
    <section className="settings-section" aria-label="AI">
      <div className="settings-field">
        <span className="settings-field-label">Commit message provider</span>
        <select
          className="settings-select"
          aria-label="Commit message provider"
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
