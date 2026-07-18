import { useEffect, useMemo, useRef, useState } from 'react';

import { Diff } from '../components/Diff';
import { Icon } from '../components/Icon';
import { ImageDiff } from '../components/ImageDiff';
import { isImagePath } from '../lib/image';
import { errMessage, tauri } from '../lib/tauri';
import type { DiffStatus, FileDiff } from '../lib/types';
import { useSettings } from '../stores/settings';

export interface CompareChoice {
  value: string;
  label: string;
}

/** First-class commit-ish comparison with a changed-file list and full diff. */
export function CompareRefsDialog({
  repoPath,
  choices,
  initialFrom,
  initialTo,
  title = 'Compare revisions',
  onClose,
}: {
  repoPath: string;
  choices: CompareChoice[];
  initialFrom: string;
  initialTo: string;
  title?: string;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const diffMode = useSettings((state) => state.diffMode);
  const layout = diffMode === 'split' ? 'split' : 'unified';

  const uniqueChoices = useMemo(() => {
    const seen = new Set<string>();
    return choices.filter((choice) => {
      if (seen.has(choice.value)) return false;
      seen.add(choice.value);
      return true;
    });
  }, [choices]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void tauri.repoDiffBetween(repoPath, from, to).then(
      (next) => {
        if (cancelled) return;
        setDiffs(next);
        setSelectedFile((current) =>
          current && next.some((diff) => diff.path === current) ? current : (next[0]?.path ?? null),
        );
        setLoading(false);
      },
      (caught) => {
        if (cancelled) return;
        setDiffs([]);
        setSelectedFile(null);
        setError(errMessage(caught));
        setLoading(false);
      },
    );
    return () => { cancelled = true; };
  }, [repoPath, from, to]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function trapFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const focused = diffs.find((diff) => diff.path === selectedFile) ?? null;
  const adds = diffs.reduce((total, diff) => total + diff.adds, 0);
  const dels = diffs.reduce((total, diff) => total + diff.dels, 0);

  return (
    <div className="palette-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className="clone-dialog compare-refs-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={trapFocus}
      >
        <div className="clone-head">
          <Icon name="compare" size={15} />
          <span className="title">{title}</span>
          <span className="compare-refs-summary">
            {loading ? 'Diffing…' : `${diffs.length} files · +${adds} −${dels}`}
          </span>
          <button type="button" className="cd-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="compare-refs-pickers">
          <label>
            <span>From</span>
            <select autoFocus value={from} onChange={(event) => setFrom(event.target.value)}>
              {uniqueChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="btn ghost compare-swap"
            onClick={() => { setFrom(to); setTo(from); }}
            aria-label="Swap comparison direction"
            title="Swap comparison direction"
          >
            ⇄
          </button>
          <label>
            <span>To</span>
            <select value={to} onChange={(event) => setTo(event.target.value)}>
              {uniqueChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </select>
          </label>
        </div>
        <div className="compare-refs-message">
          {error ? <div className="clone-error compare-refs-error">{error}</div> : null}
        </div>
        <div className="compare-refs-body">
          <div className="compare-refs-files" role="listbox" aria-label="Changed files">
            {diffs.map((diff) => (
              <button
                key={diff.path}
                type="button"
                role="option"
                aria-selected={diff.path === selectedFile}
                className={'compare-refs-file' + (diff.path === selectedFile ? ' active' : '')}
                onClick={() => setSelectedFile(diff.path)}
                onKeyDown={(event) => {
                  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const options = Array.from(
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('.compare-refs-file') ?? [],
                  );
                  const current = options.indexOf(event.currentTarget);
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? options.length - 1
                        : Math.max(0, Math.min(options.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
                  options[next]?.focus();
                  options[next]?.click();
                }}
                title={diff.old_path ? `${diff.old_path} → ${diff.path}` : diff.path}
              >
                <span className={`stat ${statusLetter(diff.status)}`}>{statusLetter(diff.status)}</span>
                <span className="path">{diff.path}</span>
                <span className="counts">+{diff.adds} −{diff.dels}</span>
              </button>
            ))}
            {!loading && !error && diffs.length === 0 ? (
              <div className="compare-refs-empty">No changes between these revisions.</div>
            ) : null}
          </div>
          <div className="compare-refs-diff">
            {loading ? (
              <div className="compare-refs-empty">Loading comparison…</div>
            ) : focused ? (
              focused.binary && isImagePath(focused.path) ? (
                <ImageDiff
                  path={focused.path}
                  oldSrc={focused.status === 'added' ? null : { rev: from }}
                  newSrc={focused.status === 'deleted' ? null : { rev: to }}
                  repoPath={repoPath}
                />
              ) : focused.binary || focused.patch.length === 0 ? (
                <div className="compare-refs-empty">
                  {focused.binary ? 'Binary file — no textual diff.' : 'No textual diff.'}
                </div>
              ) : (
                <Diff patch={focused.patch} layout={layout} />
              )
            ) : (
              <div className="compare-refs-empty">Select a changed file to inspect its diff.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function statusLetter(status: DiffStatus): string {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  if (status === 'renamed') return 'R';
  if (status === 'copied') return 'C';
  if (status === 'typechange') return 'T';
  return 'M';
}
