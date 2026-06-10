import { useEffect, useState } from 'react';

import { pickDirectory } from '../../lib/dialog';
import { errMessage, isTauri, tauri } from '../../lib/tauri';
import { useSettings } from '../../stores/settings';

/**
 * Git — the global identity (`user.name` / `user.email`, written to
 * `~/.gitconfig`) and the default clone/open folder. Identity edits need an
 * explicit Save: unlike the appearance toggles this writes a file git itself
 * reads, so no half-typed names should land there live.
 */
export function GitSection() {
  const defaultCloneDir = useSettings((s) => s.defaultCloneDir);
  const set = useSettings((s) => s.set);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void tauri
      .gitGlobalIdentity()
      .then((id) => {
        if (cancelled) return;
        setName(id.name ?? '');
        setEmail(id.email ?? '');
        setLoaded(true);
      })
      .catch((e) => {
        if (!cancelled) setStatus(errMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setStatus(null);
    try {
      await tauri.gitSetGlobalIdentity(name.trim(), email.trim());
      setDirty(false);
      setStatus('Saved to global git config.');
    } catch (e) {
      setStatus(errMessage(e));
    }
  }

  async function chooseDefaultDir() {
    const dir = await pickDirectory('Default clone & open folder', defaultCloneDir ?? undefined);
    if (dir) set('defaultCloneDir', dir);
  }

  return (
    <section className="settings-section" aria-label="Git">
      <div className="settings-field">
        <span className="settings-field-label">Global identity</span>
        <p className="settings-hint">
          Written to your global git config — used as the author of new commits
          everywhere, not just in Strand.
        </p>
        <div className="settings-row">
          <input
            type="text"
            className="clone-input"
            aria-label="Name"
            placeholder="Name"
            value={name}
            disabled={!loaded}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />
          <input
            type="email"
            className="clone-input"
            aria-label="Email"
            placeholder="Email"
            value={email}
            disabled={!loaded}
            onChange={(e) => {
              setEmail(e.target.value);
              setDirty(true);
            }}
          />
        </div>
        <div className="settings-row">
          <button
            type="button"
            className="btn primary"
            disabled={!loaded || !dirty || !name.trim() || !email.trim()}
            onClick={() => void save()}
          >
            Save identity
          </button>
          {status && <span className="settings-hint">{status}</span>}
        </div>
      </div>

      <div className="settings-field">
        <span className="settings-field-label">Default clone &amp; open folder</span>
        <p className="settings-hint">
          Where the clone dialog and the open-repository picker start.
        </p>
        <div className="settings-row">
          <span className="settings-path" title={defaultCloneDir ?? undefined}>
            {defaultCloneDir ?? 'No folder chosen'}
          </span>
          <button type="button" className="btn" onClick={() => void chooseDefaultDir()}>
            Choose…
          </button>
          {defaultCloneDir && (
            <button type="button" className="btn" onClick={() => set('defaultCloneDir', null)}>
              Clear
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
