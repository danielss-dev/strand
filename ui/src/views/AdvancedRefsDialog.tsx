import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Dialog } from '../components/Dialog';
import { Select } from '../components/Select';
import { errMessage, tauri } from '../lib/tauri';
import type { AdvancedRefs, GitNote, ReplaceReview, TagEditKind, TagEditReview } from '../lib/advancedRefs';
import { useRepo } from '../stores/repo';

export function AdvancedRefsDialog({ path, initialMode = 'notes', initialTag = '', onClose }: { path: string; initialMode?: 'notes' | 'replace' | TagEditKind; initialTag?: string; onClose: () => void }) {
  const [mode, setMode] = useState(initialMode);
  const [notesRef, setNotesRef] = useState('refs/notes/commits');
  const [data, setData] = useState<AdvancedRefs | null>(null);
  const [revision, setRevision] = useState('HEAD');
  const [note, setNote] = useState<GitNote | null>(null);
  const [message, setMessage] = useState('');
  const [original, setOriginal] = useState('');
  const [replacement, setReplacement] = useState('');
  const [replaceReview, setReplaceReview] = useState<ReplaceReview | null>(null);
  const [tag, setTag] = useState(initialTag);
  const [target, setTarget] = useState('HEAD');
  const [annotation, setAnnotation] = useState('');
  const [tagReview, setTagReview] = useState<TagEditReview | null>(null);
  const [remote, setRemote] = useState('');
  const [published, setPublished] = useState('Publication has not been checked.');
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [output, setOutput] = useState('');
  const first = useRef<HTMLSelectElement>(null);
  const mounted = useRef(true);
  const reads = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++reads.current;
    try { const next = await tauri.repoAdvancedRefs(path, notesRef); if (mounted.current && seq === reads.current) setData(next); }
    catch (e) { if (mounted.current && seq === reads.current) { setData(null); setError(errMessage(e)); } }
  }, [path, notesRef]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const changed = () => { setConfirm(''); void refresh(); };
    // Any tab in this repository family can change the shared refs. Reads remain
    // confined to this open dialog; no advanced-ref work rides the repo snapshot.
    const unlisten = listen<string>('repo://changed', changed);
    window.addEventListener('focus', changed);
    return () => { mounted.current = false; reads.current++; window.removeEventListener('focus', changed); void unlisten.then((fn) => fn()); };
  }, [refresh]);
  useEffect(() => { const focus = requestAnimationFrame(() => first.current?.focus()); return () => cancelAnimationFrame(focus); }, []);
  async function run(work: () => Promise<void>, mutation = false) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); if (mutation) { setOutput('Local Git reference updated.'); setConfirm(''); } }
    catch (e) { if (mounted.current) setError(errMessage(e)); }
    finally {
      if (mutation) { await refresh(); const repo = useRepo.getState(); if (repo.activePath === path) await Promise.all([repo.refreshLocalChanges(), repo.refreshLog()]); }
      if (mounted.current) { setBusy(false); requestAnimationFrame(() => first.current?.focus()); }
    }
  }
  async function inspectNote(object = revision) { const read = await tauri.repoGitNote(path, notesRef, object); setNote(read); setMessage(read.message ?? ''); setRevision(object); setConfirm(''); }
  async function inspectTag() {
    const review = await tauri.repoTagEditReview(path, tag, mode === 'reannotate' ? `refs/tags/${tag}` : target);
    setTagReview(review); setAnnotation(review.annotation ?? ''); setRemote(review.remotes[0] ?? ''); setAcknowledged(false); setPublished('Publication has not been checked.'); setConfirm('');
  }
  function clearTag() { setTagReview(null); setAcknowledged(false); setConfirm(''); }
  const tags = useRepo((s) => s.refs.tags);
  return <Dialog title="Git notes, replacements & tag editing" size="lg" busy={busy} initialFocusRef={first} onClose={onClose}
    footer={<><span role="status">{busy ? 'Working with Git…' : ''}</span><button className="btn" disabled={busy} onClick={() => void refresh()}>Refresh refs</button><button className="btn" disabled={busy} onClick={onClose}>Close</button></>}>
    <div className="clone-body git-tool-body">
      <p className="stash-blurb">Repository: <code>{path}</code>. These are Git objects and refs, separate from Strand’s local Review notes.</p>
      <label className="clone-field"><span className="lbl">Action</span><Select ref={first} className="clone-input" value={mode} disabled={busy} onChange={(e) => { setMode(e.target.value as typeof mode); clearTag(); setReplaceReview(null); setConfirm(''); setOutput(''); }}>
        <option value="notes">Inspect / edit Git notes</option><option value="replace">Inspect / edit replace refs</option><option value="retarget">Retarget an existing tag</option><option value="reannotate">Re-annotate an existing tag</option>
      </Select></label>
      {mode === 'notes' && <>
        <label className="clone-field"><span className="lbl">Notes namespace</span><input className="clone-input" value={notesRef} list="git-notes-refs" disabled={busy} onChange={(e) => { setNotesRef(e.target.value); setNote(null); }} /><datalist id="git-notes-refs">{data?.notes_refs.map((r) => <option key={r} value={r} />)}</datalist></label>
        <label className="clone-field"><span className="lbl">Existing notes{data?.notes_truncated ? ' (first 2,000)' : ''}</span><Select className="clone-input" value="" disabled={busy || !data?.notes.length} onChange={(e) => { if (e.target.value) void run(() => inspectNote(e.target.value)); }}><option value="">Choose an annotated object…</option>{data?.notes.map((n) => <option key={n.object} value={n.object}>{n.object}</option>)}</Select></label>
        <label className="clone-field"><span className="lbl">Object revision</span><input className="clone-input" value={revision} disabled={busy} onChange={(e) => { setRevision(e.target.value); setNote(null); }} /></label>
        <button className="btn" disabled={busy || !revision} onClick={() => void run(() => inspectNote())}>Inspect note / reload draft</button>
        {note && <section className="git-tool-review" aria-label="Git note editor">
          <code>{note.target.oid}</code><p>{note.target.kind} · {note.target.subject}</p>
          <label className="clone-field"><span className="lbl">Git note text</span><textarea className="clone-input" rows={6} value={message} disabled={busy} onChange={(e) => setMessage(e.target.value)} /></label>
          <p>{note.message === null ? 'No existing note in this namespace.' : 'This replaces the existing note.'} Changes to this namespace by another client cause Save to refuse; reload explicitly to inspect them.</p>
          <div className="git-tool-actions"><button className="btn primary" disabled={busy || !message.trim()} onClick={() => void run(async () => { await tauri.repoGitNoteWrite(path, notesRef, note.target.oid, note.ref_tip, message); await inspectNote(note.target.oid); }, true)}>Save Git note</button>
            <button className="btn danger" disabled={busy || note.message === null} onClick={() => { if (confirm !== 'note') { setConfirm('note'); return; } void run(async () => { await tauri.repoGitNoteWrite(path, notesRef, note.target.oid, note.ref_tip, null); await inspectNote(note.target.oid); }, true); }}>{confirm === 'note' ? 'Confirm remove Git note' : 'Remove Git note…'}</button></div>
        </section>}
      </>}
      {mode === 'replace' && <>
        <p className="stash-note">Git replacement refs change how replacement-aware Git commands read objects; they do not rewrite the original object. Strand’s ordinary in-process graph/diff readers show original objects. This inspector shows raw object identities.</p>
        <label className="clone-field"><span className="lbl">Existing replacement{data?.replacements_truncated ? ' (first 2,000)' : ''}</span><Select className="clone-input" disabled={busy || !data?.replacements.length} value="" onChange={(e) => { const r = data?.replacements.find((r) => r.original === e.target.value); if (!r) return; setOriginal(r.original); setReplacement(r.replacement); void run(async () => setReplaceReview(await tauri.repoReplaceReview(path, r.original, r.replacement))); }}><option value="">Choose a replace ref…</option>{data?.replacements.map((r) => <option key={r.original} value={r.original}>{r.original} → {r.replacement}</option>)}</Select></label>
        <label className="clone-field"><span className="lbl">Original object revision</span><input className="clone-input" disabled={busy} value={original} onChange={(e) => { setOriginal(e.target.value); setReplaceReview(null); }} /></label>
        <label className="clone-field"><span className="lbl">Replacement object revision</span><input className="clone-input" disabled={busy} value={replacement} onChange={(e) => { setReplacement(e.target.value); setReplaceReview(null); }} /></label>
        <button className="btn" disabled={busy || !original || !replacement} onClick={() => void run(async () => { setReplaceReview(await tauri.repoReplaceReview(path, original, replacement)); setConfirm(''); })}>Review replacement</button>
        {replaceReview && <section className="git-tool-review" aria-label="Replacement review">
          <p>Original {replaceReview.original.kind}: <code>{replaceReview.original.oid}</code> · {replaceReview.original.subject}</p>
          <p>Replacement {replaceReview.replacement.kind}: <code>{replaceReview.replacement.oid}</code> · {replaceReview.replacement.subject}</p>
          <p>Current replace ref: <code>{replaceReview.previous ?? 'none'}</code></p>
          <div className="git-tool-actions"><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await tauri.repoReplaceWrite(path, replaceReview.original.oid, replaceReview.replacement.oid, replaceReview.previous); setReplaceReview(null); }, true)}>Set reviewed replacement</button>
            <button className="btn danger" disabled={busy || !replaceReview.previous} onClick={() => { if (confirm !== 'replace') { setConfirm('replace'); return; } void run(async () => { await tauri.repoReplaceWrite(path, replaceReview.original.oid, null, replaceReview.previous); setReplaceReview(null); }, true); }}>{confirm === 'replace' ? 'Confirm remove replacement' : 'Remove replacement…'}</button></div>
        </section>}
      </>}
      {(mode === 'retarget' || mode === 'reannotate') && <>
        <label className="clone-field"><span className="lbl">Existing tag name</span><input className="clone-input" value={tag} list="edit-tag-names" disabled={busy} onChange={(e) => { setTag(e.target.value); clearTag(); }} /><datalist id="edit-tag-names">{tags.map((t) => <option key={t.name} value={t.name} />)}</datalist></label>
        {mode === 'retarget' && <label className="clone-field"><span className="lbl">New target revision</span><input className="clone-input" disabled={busy} value={target} onChange={(e) => { setTarget(e.target.value); clearTag(); }} /></label>}
        <button className="btn" disabled={busy || !tag || (mode === 'retarget' && !target)} onClick={() => void run(inspectTag)}>Review current and new target</button>
        {tagReview && <section className="git-tool-review" aria-label="Tag edit review">
          <p>Current target: <code>{tagReview.current.oid}</code> · {tagReview.current.subject}</p><p>New target: <code>{tagReview.proposed.oid}</code> · {tagReview.proposed.subject}</p><p>{tagReview.changed_files} changed files between targets.</p>
          {mode === 'reannotate' ? <label className="clone-field"><span className="lbl">New tag annotation</span><textarea className="clone-input" rows={5} disabled={busy} value={annotation} onChange={(e) => { setAnnotation(e.target.value); setAcknowledged(false); }} /></label> : <pre>{tagReview.annotation || 'Lightweight tag — no annotation.'}</pre>}
          {tagReview.signed && <p className="clone-error">This tag is signed. Editing requires a new signature; this workflow will not remove it. Use signed-tag creation.</p>}
          {tagReview.remotes.length > 0 ? <>
            <label className="clone-field"><span className="lbl">Remote publication</span><Select className="clone-input" value={remote} disabled={busy} onChange={(e) => { setRemote(e.target.value); setPublished('Publication has not been checked.'); setAcknowledged(false); }}>{tagReview.remotes.map((r) => <option key={r} value={r}>{r}</option>)}</Select></label>
            <button className="btn" disabled={busy || !remote} onClick={() => void run(async () => { setPublished('Publication is unknown until this check completes.'); const result = await tauri.repoTagPublished(path, remote, tagReview.name); setPublished(result.oid ? `Published on ${result.remote} at ${result.oid}${result.oid === tagReview.ref_oid ? ' (matches current local tag)' : ' (differs from current local tag)'}. Last checked ${new Date().toLocaleTimeString()}.` : `No matching tag on ${result.remote} at the last check.`); })}>Check published tag</button><p>{published}</p>
          </> : <p>No remotes are currently configured.</p>}
          <label className="stash-note"><input type="checkbox" checked={acknowledged} disabled={busy || tagReview.signed} onChange={(e) => setAcknowledged(e.target.checked)} /> I reviewed both targets. This changes the local tag; existing copies on {tagReview.remotes.length ? tagReview.remotes.join(', ') : 'other repositories'} remain unchanged and may differ. Publication can change after a check.</label>
          <button className="btn danger" disabled={busy || !acknowledged || tagReview.signed || (mode === 'reannotate' && !annotation.trim())} onClick={() => void run(async () => { await tauri.repoTagEdit(path, tagReview.name, tagReview.proposed.oid, tagReview.ref_oid, mode, mode === 'reannotate' ? annotation : null); clearTag(); }, true)}>{mode === 'retarget' ? 'Retarget reviewed local tag' : 'Replace reviewed tag annotation'}</button>
        </section>}
      </>}
      {error && <div className="clone-error" role="alert">{error}</div>}{output && <p role="status">{output}</p>}
    </div>
  </Dialog>;
}
