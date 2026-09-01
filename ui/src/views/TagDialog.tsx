import { useEffect, useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
import { errMessage } from '../lib/tauri';
import { useRepo } from '../stores/repo';

/**
 * Modal for creating a git tag at a target commit. A non-empty message makes
 * an **annotated** tag (tagger from the user's git config); an empty message
 * makes a **lightweight** tag.
 *
 * Opened from three places, each supplying the target: the Tags section's `+`
 * (HEAD), the command palette (HEAD), and a commit's detail panel (that
 * commit). `target` is the revspec to tag (`null` ⇒ HEAD); `targetLabel` is
 * the human label shown in the blurb. On success the new tag shows up in the
 * sidebar Tags list and as a chip on the graph (the store refreshes refs).
 */
export function TagDialog({
  target,
  targetLabel,
  onClose,
}: {
  target: string | null;
  targetLabel: string;
  onClose: () => void;
}) {
  const createTag = useRepo((s) => s.createTag);

  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  async function submit() {
    if (busy) return;
    const tagName = name.trim();
    if (!tagName) {
      setError('Tag name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createTag(tagName, target, message.trim() || null);
      onClose();
    } catch (e) {
      if (mountedRef.current) setError(errMessage(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const annotated = message.trim().length > 0;

  return (
    <Dialog
      title="New tag"
      icon="tag"
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create tag'}
          </button>
        </>
      }
    >
      <div className="clone-body">
        <p className="stash-blurb">
          Tag <code>{targetLabel}</code>. Leave the message empty for a lightweight tag.
        </p>

        <label className="clone-field">
          <span className="lbl">Name</span>
          <input
            autoFocus
            className="clone-input"
            placeholder="v1.0.0"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </label>

        <label className="clone-field">
          <span className="lbl">Message</span>
          <textarea
            className="clone-input"
            placeholder="Annotation (optional)"
            value={message}
            disabled={busy}
            rows={3}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>

        <div className="stash-note">
          {annotated ? 'Creates an annotated tag.' : 'Creates a lightweight tag.'}
        </div>

        {error ? <div className="clone-error">{error}</div> : null}
      </div>
    </Dialog>
  );
}
