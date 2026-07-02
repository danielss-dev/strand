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

export type SideState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; blob: FileBlob };

export function useBlob(
  path: string,
  src: BlobRef | null,
  repoPath?: string,
  refetch?: number,
): SideState {
  const storePath = useRepo((s) => s.activePath);
  const diffsTick = useRepo((s) => s.diffsTick);
  // Default: the active repo, revalidated on its diff refreshes. A caller
  // reviewing another repo (Workspace Review) passes both the repo path and
  // its own refresh counter.
  const activePath = repoPath ?? storePath;
  const [state, setState] = useState<SideState>({ kind: 'loading' });
  // Primitive deps so inline-object props don't refetch every render.
  const absent = src == null;
  const rev = src?.rev ?? null;
  const index = src?.index ?? false;
  // Worktree/index sources are mutable — refetch when the diffs refresh (the
  // agent-watch loop edits files under us). Rev-pinned blobs are immutable.
  const refetchKey = rev == null ? (refetch ?? diffsTick) : 0;
  useEffect(() => {
    if (absent || !activePath) return;
    let cancelled = false;
    // Keep the previous image while revalidating so watcher refreshes don't
    // flash "Loading…" when the bytes are unchanged.
    setState((s) => (s.kind === 'ok' ? s : { kind: 'loading' }));
    tauri
      .repoFileBlob(activePath, path, rev, index)
      .then((b) => { if (!cancelled) setState({ kind: 'ok', blob: b }); })
      .catch((e) => { if (!cancelled) setState({ kind: 'error', message: errMessage(e) }); });
    return () => { cancelled = true; };
  }, [activePath, path, absent, rev, index, refetchKey]);
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
  repoPath,
  refetch,
}: {
  path: string;
  oldSrc: BlobRef | null;
  newSrc: BlobRef | null;
  /** Repo to read blobs from — defaults to the active repo. */
  repoPath?: string;
  /** Refetch counter for mutable (worktree/index) sources when `repoPath` is
   * not the active repo — defaults to the active repo's diff tick. */
  refetch?: number;
}) {
  const before = useBlob(path, oldSrc, repoPath, refetch);
  const after = useBlob(path, newSrc, repoPath, refetch);
  return (
    <div className="img-diff">
      {oldSrc != null && <ImagePane label="Before" tone="del" path={path} state={before} />}
      {newSrc != null && <ImagePane label="After" tone="add" path={path} state={after} />}
    </div>
  );
}

/**
 * Single-image preview (no before/after) — the File view's Content tab for a
 * binary image, where there's just the one version to show.
 */
export function ImagePreview({ path, src }: { path: string; src: BlobRef }) {
  const state = useBlob(path, src);
  return (
    <div className="img-diff img-diff-single">
      <ImagePane path={path} state={state} />
    </div>
  );
}

function ImagePane({
  label,
  tone = 'add',
  path,
  state,
}: {
  /** Omit for a single-image preview (no before/after caption). */
  label?: string;
  tone?: 'del' | 'add';
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
      {label && <figcaption className={`img-diff-label ${tone}`}>{label}</figcaption>}
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
