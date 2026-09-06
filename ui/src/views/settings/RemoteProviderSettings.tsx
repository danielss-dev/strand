import { useEffect, useRef, useState } from 'react';
import { errMessage, tauri } from '../../lib/tauri';
import type { RemoteHostingProvider } from '../../lib/types';
import { useRepo } from '../../stores/repo';

export function RemoteProviderSettings() {
  const path = useRepo((s) => s.activePath);
  const [remotes, setRemotes] = useState<RemoteHostingProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    generation.current += 1;
    setRemotes([]); setError(null); setBusy(false);
    if (path) void tauri.repoHostingProviders(path).then((rows) => { if (active) setRemotes(rows); }).catch((e) => { if (active) setError(errMessage(e)); });
    return () => { active = false; generation.current += 1; };
  }, [path]);
  async function save(remote: string, provider: string) {
    if (!path || busy) return;
    const current = generation.current;
    setBusy(true); setError(null);
    try { await tauri.repoSetHostingProvider(path, remote, provider); if (generation.current === current) setRemotes((rows) => rows.map((r) => r.remote === remote ? { ...r, provider } : r)); }
    catch (e) { if (generation.current === current) setError(errMessage(e)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  return <section className="settings-section">
    <h3>GitLab, Bitbucket Cloud and custom GitHub hosts</h3>
    <p className="settings-hint">GitLab uses <code>glab auth login --hostname HOST</code>. Bitbucket Cloud uses an API credential for <code>api.bitbucket.org</code> from your Git credential helper (Atlassian email and scoped API token). GitHub Enterprise uses <code>gh auth login --hostname HOST</code>; custom API routing stays in gh configuration.</p>
    <p className="settings-hint">Public hosts are detected automatically. For custom hosts, choose the adapter for each remote in the active repository, then refresh Pull Requests. Azure Server profiles continue to use the setup below.</p>
    {remotes.map((r) => <label className="clone-field" key={r.remote}><span className="lbl">{r.remote} · {r.url}</span><select className="clone-input" disabled={busy} value={r.provider} onChange={(e) => void save(r.remote, e.target.value)}><option value="">Automatic</option><option value="github">GitHub / Enterprise</option><option value="gitlab">GitLab</option></select></label>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
