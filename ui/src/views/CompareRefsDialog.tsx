import { useEffect, useMemo, useState } from 'react';

import { Dialog } from '../components/Dialog';
import { Diff } from '../components/Diff';
import { DiffLayoutToggle, toPierreLayout } from '../components/DiffChrome';
import { ImageDiff } from '../components/ImageDiff';
import { PierreTree } from '../components/PierreTree';
import { Select } from '../components/Select';
import { compareRefsTree } from '../lib/compareRefsTree';
import { isImagePath } from '../lib/image';
import { errMessage, tauri } from '../lib/tauri';
import type { FileDiff } from '../lib/types';
import { useSettings } from '../stores/settings';

export interface CompareChoice {
  value: string;
  label: string;
}

/** First-class commit-ish comparison with a full file tree and per-file diff. */
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
  const [tree, setTree] = useState(() => compareRefsTree([], [], []));
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const diffMode = useSettings((state) => state.diffMode);
  const layout = toPierreLayout(diffMode);

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
    void Promise.all([
      tauri.repoDiffBetween(repoPath, from, to),
      tauri.repoTreeAt(repoPath, from),
      tauri.repoTreeAt(repoPath, to),
    ]).then(
      ([next, fromTree, toTree]) => {
        if (cancelled) return;
        const nextTree = compareRefsTree(fromTree, toTree, next);
        setDiffs(next);
        setTree(nextTree);
        setSelectedFile((current) =>
          current && nextTree.paths.includes(current) ? current : (next[0]?.path ?? nextTree.paths[0] ?? null),
        );
        setLoading(false);
      },
      (caught) => {
        if (cancelled) return;
        setDiffs([]);
        setTree(compareRefsTree([], [], []));
        setSelectedFile(null);
        setError(errMessage(caught));
        setLoading(false);
      },
    );
    return () => { cancelled = true; };
  }, [repoPath, from, to]);

  const focused = diffs.find((diff) => diff.path === selectedFile)
    ?? diffs.find((diff) => diff.status === 'renamed' && diff.old_path === selectedFile)
    ?? null;
  const adds = diffs.reduce((total, diff) => total + diff.adds, 0);
  const dels = diffs.reduce((total, diff) => total + diff.dels, 0);

  return (
    <Dialog
      title={title}
      icon="compare"
      className="compare-refs-dialog"
      onClose={onClose}
    >
      <div className="compare-refs-pickers">
        <label>
          <span>From</span>
          <Select autoFocus value={from} onChange={(event) => setFrom(event.target.value)}>
            {uniqueChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </Select>
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
          <Select value={to} onChange={(event) => setTo(event.target.value)}>
            {uniqueChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </Select>
        </label>
      </div>
      <div className="compare-refs-message">
        <div className="compare-refs-toolbar">
          <div className="compare-refs-summary">
            {loading ? 'Diffing…' : `${tree.paths.length} files · ${diffs.length} changed · +${adds} −${dels}`}
          </div>
          <div className="compare-refs-layout" role="group" aria-label="Diff layout">
            <DiffLayoutToggle />
          </div>
        </div>
        {error ? <div className="clone-error compare-refs-error">{error}</div> : null}
      </div>
      <div className="compare-refs-body">
        <div className="compare-refs-files" role="region" aria-label="Comparison files">
          {!loading && !error && tree.paths.length > 0 ? (
            <PierreTree
              paths={tree.paths}
              gitStatus={tree.gitStatus}
              selectedPath={selectedFile}
              followFocus
              onSelect={(next, kind) => {
                if (!next || kind === 'file') setSelectedFile(next);
              }}
            />
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
            <div className="compare-refs-empty">
              {selectedFile
                ? 'No change to this file between the selected revisions.'
                : !error && tree.paths.length === 0 && diffs.length === 0
                  ? 'No changes between these revisions.'
                  : 'Select a file to compare between the selected revisions.'}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
