import { useEffect, useRef, useState } from 'react';

import { quickNotes } from '../../../lib/db';
import { useRepo } from '../../../stores/repo';

const SAVE_DELAY_MS = 350;

function repoName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

export function QuickNotesView() {
  const repoPath = useRepo((state) => state.activePath);
  const [note, setNote] = useState('');
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteRef = useRef('');
  const loadedPathRef = useRef<string | null>(null);

  noteRef.current = note;
  loadedPathRef.current = loadedPath;

  useEffect(() => {
    setNote('');
    setLoadedPath(null);
    if (!repoPath) return;

    let cancelled = false;
    void quickNotes.get(repoPath).then((stored) => {
      if (cancelled) return;
      setNote(stored ?? '');
      setLoadedPath(repoPath);
    }).catch((error) => console.warn('quick notes load failed', error));
    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (loadedPathRef.current === repoPath) {
        void quickNotes.set(repoPath, noteRef.current)
          .catch((error) => console.warn('quick notes save failed', error));
      }
    };
  }, [repoPath]);

  useEffect(() => {
    if (!repoPath || loadedPath !== repoPath) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void quickNotes.set(repoPath, note)
        .catch((error) => console.warn('quick notes save failed', error));
    }, SAVE_DELAY_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
    };
  }, [loadedPath, note, repoPath]);

  if (!repoPath) {
    return (
      <div className="custom-empty" role="status">
        <div className="custom-empty-copy">
          <strong>No repository open</strong>
          <span>Open a repository to view its quick notes.</span>
        </div>
      </div>
    );
  }

  return (
    <section className="plugin-quick-notes" aria-label={`Quick notes for ${repoName(repoPath)}`}>
      <header>
        <strong>Quick Notes</strong>
        <span title={repoPath}>{repoName(repoPath)}</span>
      </header>
      <textarea
        aria-label={`Notes for ${repoName(repoPath)}`}
        disabled={loadedPath !== repoPath}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Write notes for this repository…"
        spellCheck
        value={note}
      />
    </section>
  );
}
