import { useEffect, useState } from 'react';

import { formatBytes, imageMime } from '../lib/image';
import { errMessage, tauri } from '../lib/tauri';
import { useRepo } from '../stores/repo';
import type { FileBlob } from '../lib/types';

/**
 * Where one side of an image diff reads from: `rev` null with no `index` =
 * the working tree; `index: true` = the staged copy; `rev: 'HEAD'` etc. = the
 * blob at that revision. A null side (the prop, not the ref) means the file
 * doesn't exist there — added files have no Before, deleted files no After.
 */
export interface BlobRef {
  rev: string | null;
  index?: boolean;
}

type SideState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; blob: FileBlob };

function useBlob(path: string, src: BlobRef | null): SideState {
  const activePath = useRepo((s) => s.activePath);
  const [state, setState] = useState<SideState>({ kind: 'loading' });
  // Primitive deps so inline-object props don't refetch every render.
  const absent = src == null;
  const rev = src?.rev ?? null;
  const index = src?.index ?? false;
  useEffect(() => {
    if (absent || !activePath) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    tauri
      .repoFileBlob(activePath, path, rev, index)
      .then((b) => { if (!cancelled) setState({ kind: 'ok', blob: b }); })
      .catch((e) => { if (!cancelled) setState({ kind: 'error', message: errMessage(e) }); });
    return () => { cancelled = true; };
  }, [activePath, path, absent, rev, index]);
  return state;
}

/**
 * Side-by-side before/after preview for a binary image diff. Each pane sits
 * on a checkerboard so transparency reads; a null side (added/deleted file)
 * collapses to a single pane.
 */
export function ImageDiff({
  path,
  oldSrc,
  newSrc,
}: {
  path: string;
  oldSrc: BlobRef | null;
  newSrc: BlobRef | null;
}) {
  const before = useBlob(path, oldSrc);
  const after = useBlob(path, newSrc);
  return (
    <div className="img-diff">
      {oldSrc != null && <ImagePane label="Before" tone="del" path={path} state={before} />}
      {newSrc != null && <ImagePane label="After" tone="add" path={path} state={after} />}
    </div>
  );
}

function ImagePane({
  label,
  tone,
  path,
  state,
}: {
  label: string;
  tone: 'del' | 'add';
  path: string;
  state: SideState;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const src =
    state.kind === 'ok' && !state.blob.too_large
      ? `data:${imageMime(path)};base64,${state.blob.base64}`
      : null;
  // New image bytes → stale dimensions; remeasure from the next onLoad.
  useEffect(() => setDims(null), [src]);

  return (
    <figure className="img-diff-pane">
      <figcaption className={`img-diff-label ${tone}`}>{label}</figcaption>
      <div className="img-diff-checker">
        {state.kind === 'loading' ? (
          <span className="img-diff-note">Loading…</span>
        ) : state.kind === 'error' ? (
          <span className="img-diff-note" title={state.message}>
            Couldn’t load this image.
          </span>
        ) : state.blob.too_large ? (
          <span className="img-diff-note">Image too large to preview (&gt;8 MB)</span>
        ) : (
          // A data-URL'd SVG in an <img> never executes scripts — safe to preview.
          <img
            src={src!}
            alt={`${label}: ${path}`}
            onLoad={(e) =>
              setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
          />
        )}
      </div>
      {state.kind === 'ok' && (
        <div className="img-diff-meta">
          {dims ? `${dims.w}×${dims.h} · ` : ''}
          {formatBytes(state.blob.size)}
        </div>
      )}
    </figure>
  );
}
