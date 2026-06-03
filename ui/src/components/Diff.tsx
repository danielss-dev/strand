import { PatchDiff } from '@pierre/diffs/react';
import type { CSSProperties } from 'react';

import { useSettings } from '../stores/settings';

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
  // Follow the app theme — Pierre ships matching pierre-light / pierre-dark.
  // `disableBackground` keeps the surface on our tokens; the theme drives the
  // syntax colors, which need to flip with light/dark.
  const pierreTheme = useSettings((s) => s.resolvedTheme) === 'light' ? 'pierre-light' : 'pierre-dark';
  return (
    <PatchDiff
      patch={patch}
      options={{
        diffStyle: layout,
        theme: pierreTheme,
        disableBackground: true,
        disableFileHeader: hideFileHeader,
      }}
      className={className}
      style={style}
    />
  );
}
