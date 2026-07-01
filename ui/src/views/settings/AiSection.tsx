import { useCallback, useEffect, useState } from 'react';

import { errMessage, tauri } from '../../lib/tauri';
import type { AiProvider, AiProviderStatus } from '../../lib/types';
import { useSettings } from '../../stores/settings';

const PROVIDERS: { id: AiProvider; label: string }[] = [
  { id: 'openai', label: 'OpenAI (ChatGPT subscription)' },
  { id: 'anthropic', label: 'Anthropic (Claude Code CLI)' },
];

/**
 * AI — commit message suggestions via vendor CLIs (Codex / Claude Code).
 * Auth and billing stay in the official tools; Strand only orchestrates them.
 */
export function AiSection() {
  const aiProvider = useSettings((s) => s.aiProvider);
  const openaiCli = useSettings((s) => s.openaiCli);
  const anthropicCli = useSettings((s) => s.anthropicCli);
  const set = useSettings((s) => s.set);

  const [status, setStatus] = useState<AiProviderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await tauri.aiProviderStatus(aiProvider, openaiCli, anthropicCli);
      setStatus(s);
    } catch (e) {
      setMessage(errMessage(e));
      setStatus(null);
    }
  }, [aiProvider, openaiCli, anthropicCli]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function login() {
    setBusy(true);
    setMessage(null);
    try {
      await tauri.aiProviderLogin(aiProvider, openaiCli, anthropicCli);
      setMessage('Browser opened — complete sign-in there, then click Refresh status.');
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
      await refresh();
      setMessage('Signed out.');
    } catch (e) {
      setMessage(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const panelHint =
    aiProvider === 'openai'
      ? 'Uses your ChatGPT subscription via the Codex CLI. Install from developers.openai.com/codex if missing.'
      : 'Uses the Claude Code CLI (`claude`). For API billing, run `claude auth login --console` in a terminal once.';

  const statusLine = !status
    ? 'Checking…'
    : !status.installed
      ? 'CLI not found on PATH'
      : status.logged_in
        ? status.account_hint ?? 'Signed in'
        : 'Not signed in';

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
        <span className="settings-field-label">Status</span>
        <p className="settings-hint">{statusLine}</p>
        <div className="settings-row">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void login()}>
            {aiProvider === 'openai' ? 'Sign in with ChatGPT' : 'Sign in to Claude Code'}
          </button>
          <button type="button" className="btn" disabled={busy || !status?.logged_in} onClick={() => void logout()}>
            Sign out
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
            Refresh status
          </button>
        </div>
        {message && <p className="settings-hint">{message}</p>}
      </div>

      <div className="settings-field">
        <span className="settings-field-label">Custom Codex CLI path</span>
        <input
          type="text"
          className="clone-input"
          aria-label="Custom Codex CLI path"
          placeholder="Leave empty to use codex on PATH"
          value={openaiCli ?? ''}
          onChange={(e) => set('openaiCli', e.target.value.trim() || null)}
        />
      </div>

      <div className="settings-field">
        <span className="settings-field-label">Custom Claude CLI path</span>
        <input
          type="text"
          className="clone-input"
          aria-label="Custom Claude CLI path"
          placeholder="Leave empty to use claude on PATH"
          value={anthropicCli ?? ''}
          onChange={(e) => set('anthropicCli', e.target.value.trim() || null)}
        />
      </div>
    </section>
  );
}
