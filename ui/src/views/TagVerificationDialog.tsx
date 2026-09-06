import { useEffect, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { errMessage, tauri } from '../lib/tauri';
import type { TagVerification } from '../lib/types';
import { useRepo } from '../stores/repo';

export function TagVerificationDialog({ path, initialName, onClose }: {
  path: string; initialName: string | null; onClose: () => void;
}) {
  const [tags] = useState(() => useRepo.getState().refs.tags);
  const [name, setName] = useState(initialName ?? tags[0]?.name ?? '');
  const [result, setResult] = useState<TagVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!name) return;
    let active = true;
    setBusy(true); setResult(null); setError(null);
    void tauri.repoTagVerify(path, name).then((value) => { if (active) setResult(value); })
      .catch((e) => { if (active) setError(errMessage(e)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [path, name]);
  return <Dialog title="Verify tag signature" icon="tag" size="md" onClose={onClose}
    footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
    <div className="clone-body">
      <label className="clone-field"><span className="lbl">Tag</span>
        <select autoFocus className="clone-input" aria-label="Tag to verify" value={name}
          onChange={(e) => setName(e.target.value)}>
          {!tags.length && <option value="">No tags</option>}
          {tags.map((tag) => <option key={tag.name} value={tag.name}>{tag.name}</option>)}
        </select>
      </label>
      {busy && <p role="status">Verifying…</p>}
      {result && <>
        <strong role="status">{result.status === 'verified' ? 'Valid signature — review Git’s trust details below'
          : result.status === 'unsigned' ? 'Unsigned tag' : 'Signature verification failed'}</strong>
        <p className="settings-hint">Tag object: <code>{result.oid}</code></p>
        <pre className="tag-verification-output" tabIndex={0}>{result.output}</pre>
      </>}
      {error && <p className="clone-error" role="alert">{error}</p>}
    </div>
  </Dialog>;
}
