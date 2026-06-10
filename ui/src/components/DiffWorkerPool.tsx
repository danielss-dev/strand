import { useEffect, type ReactNode } from 'react';
import { WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react';
// Vite bundles the package's worker entry as a real Worker module.
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker';

import { useSettings } from '../stores/settings';

/**
 * Mounts Pierre's shared highlight worker pool for every diff surface in the
 * app. Without it, `@pierre/diffs` tokenizes with Shiki *synchronously on the
 * main thread* — a whole-file Review patch stalls every keystroke. With it,
 * diffs paint as plain text immediately, syntax colors stream in from the
 * workers, and highlighted ASTs are LRU-cached by `cacheKey` so revisiting a
 * file (j/k in Review) skips the work entirely.
 *
 * Both Pierre themes are registered up front (Shiki dual-theme tokens), so a
 * light/dark flip never re-highlights — each instance just switches palette.
 */
export function DiffWorkerPool({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => new DiffsWorker(),
        // One worker keeps up with single-file review; the second covers
        // Local Changes' stacked multi-file views without idling 6 more.
        poolSize: 2,
      }}
      highlighterOptions={{
        theme: { dark: 'pierre-dark', light: 'pierre-light' },
        lineDiffType: initialLineDiffType(),
      }}
    >
      <RenderOptionsSync />
      {children}
    </WorkerPoolContextProvider>
  );
}

function initialLineDiffType(): 'word-alt' | 'none' {
  return useSettings.getState().diffWordHighlight ? 'word-alt' : 'none';
}

/**
 * The pool's render options are global (they key the worker AST cache), so
 * the word-highlight setting has to be pushed into the pool when it changes —
 * per-instance options are ignored while a pool is active.
 */
function RenderOptionsSync() {
  const pool = useWorkerPool();
  const wordHighlight = useSettings((s) => s.diffWordHighlight);
  useEffect(() => {
    void pool
      ?.setRenderOptions({ lineDiffType: wordHighlight ? 'word-alt' : 'none' })
      .catch((e) => console.warn('diff worker setRenderOptions failed', e));
  }, [pool, wordHighlight]);
  return null;
}
