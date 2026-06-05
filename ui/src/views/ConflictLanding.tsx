import { useEffect, useMemo, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage, tauri } from '../lib/tauri';
import { useRepo } from '../stores/repo';
import { buildViews, parseConflicts, type Resolution } from '../lib/conflictParse';

/**
 * In-pane landing shown when a conflicted file is selected (Fork-style): it
 * explains the conflict and offers the quick path — tick one or both sides and
 * Resolve to take that whole side for every conflict — or **Open merge editor**
 * for the line-by-line three-way resolver. Makes the conflict obvious without
 * hunting for a chip.
 */
export function ConflictLanding({
  path,
  onOpenEditor,
}: {
  path: string;
  onOpenEditor: () => void;
}) {
  const activePath = useRepo((s) => s.activePath);
  const oursBranch = useRepo((s) => s.meta?.branch ?? 'HEAD');
  const resolveConflict = useRepo((s) => s.resolveConflict);

  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ theirs: boolean; ours: boolean }>({ theirs: false, ours: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    setRaw(null);
    setError(null);
    setPicked({ theirs: false, ours: false });
    tauri
      .repoReadConflictFile(activePath, path)
      .then((c) => { if (!cancelled) setRaw(c); })
      .catch((e) => { if (!cancelled) setError(errMessage(e)); });
    return () => { cancelled = true; };
  }, [activePath, path]);

  const parsed = useMemo(() => (raw != null ? parseConflicts(raw) : null), [raw]);
  const total = parsed?.total ?? 0;
  const side: Resolution | null =
    picked.theirs && picked.ours ? 'both' : picked.theirs ? 'theirs' : picked.ours ? 'ours' : null;

  async function resolve() {
    if (!parsed || !side || busy) return;
    setBusy(true);
    try {
      const res = new Map<number, Resolution>();
      for (let i = 0; i < parsed.total; i++) res.set(i, side);
      await resolveConflict(path, buildViews(parsed, res).resultText);
      // The file leaves the conflicts list → the parent closes this landing.
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return <div className="lc-empty"><strong>Couldn’t open {path}</strong>{error}</div>;
  }
  if (!parsed) {
    return <div className="lc-empty">Loading conflicted file…</div>;
  }

  return (
    <div className="conflict-landing">
      <div className="cl-inner">
        <div className="cl-icon"><Icon name="rebase" size={26} /></div>
        <h2 className="cl-title">Merge conflict</h2>
        <p className="cl-sub">
          <code>{path}</code> was changed on both branches.<br />
          Pick a side to take for the whole file, or open the merge editor to resolve line by line.
        </p>

        <div className="cl-cards">
          <SideCard
            label={parsed.theirsLabel}
            role="incoming"
            checked={picked.theirs}
            onToggle={() => setPicked((p) => ({ ...p, theirs: !p.theirs }))}
          />
          <SideCard
            label={oursBranch}
            role="current"
            checked={picked.ours}
            onToggle={() => setPicked((p) => ({ ...p, ours: !p.ours }))}
          />
        </div>

        <div className="cl-actions">
          <button type="button" className="btn primary" disabled={!side || busy} onClick={() => void resolve()}>
            {busy ? 'Resolving…' : side === 'both' ? 'Take both sides' : side === 'theirs' ? 'Take incoming' : side === 'ours' ? 'Take current' : 'Select a side'}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onOpenEditor}>
            <Icon name="split" size={13} /> Open merge editor{total > 1 ? ` (${total} conflicts)` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

function SideCard({
  label,
  role,
  checked,
  onToggle,
}: {
  label: string;
  role: 'incoming' | 'current';
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className={'cl-card' + (checked ? ' on' : '')} onClick={onToggle} aria-pressed={checked}>
      <span className={'cl-check' + (checked ? ' on' : '')}>
        {checked ? <Icon name="check" size={12} stroke={2.4} /> : null}
      </span>
      <span className="cl-card-text">
        <span className="cl-branch"><Icon name="branch" size={13} /> {label}</span>
        <span className="cl-role">{role}</span>
      </span>
    </button>
  );
}
