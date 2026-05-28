import { PatchDiff } from '@pierre/diffs/react';
import type { CSSProperties } from 'react';

/**
 * Thin wrapper around `@pierre/diffs` so the rest of the app talks to one
 * stable shape — Pierre is on v1 but its full prop surface is large and
 * still moving. New features (split/stacked, annotations, accept/reject
 * UI) get added here, not at call sites.
 */
export interface DiffProps {
  /** Unified diff text for a single file, as produced by `strand-core`. */
  patch: string;
  /** Toggle between stacked (unified) and side-by-side layouts. */
  layout?: 'unified' | 'split';
  /** Hide Pierre's `diff --git`/path header. Useful when we slice one
   *  file's patch into per-hunk patches and don't want the same header
   *  repeated above each hunk. */
  hideFileHeader?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Diff({
  patch,
  layout = 'unified',
  hideFileHeader = false,
  className,
  style,
}: DiffProps) {
  return (
    <PatchDiff
      patch={patch}
      options={{
        diffStyle: layout,
        // Pierre ships matching light/dark themes. Strand is currently dark-only
        // (theme management lands in 0.5); switch to a ThemesType object once
        // light theme is wired.
        theme: 'pierre-dark',
        disableBackground: true,
        disableFileHeader: hideFileHeader,
      }}
      className={className}
      style={style}
    />
  );
}
