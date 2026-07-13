import {
  getSingularPatch,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
} from '@pierre/diffs';
import { FileDiff as PierreFileDiff, PatchDiff } from '@pierre/diffs/react';
import { useMemo, type CSSProperties, type ReactNode } from 'react';

import { hashPatch } from '../lib/patch';
import { useSettings, type SettingsState } from '../stores/settings';

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

export interface ParsedDiffProps<LAnnotation = undefined> extends Omit<DiffProps, 'patch'> {
  fileDiff: FileDiffMetadata;
  /** Controlled line selection used by hosted review surfaces. */
  selectedLines?: SelectedLineRange | null;
  /** Inline rows anchored to a side + line in the parsed diff. */
  lineAnnotations?: DiffLineAnnotation<LAnnotation>[];
  renderAnnotation?: (annotation: DiffLineAnnotation<LAnnotation>) => ReactNode;
  /** Pierre emits a complete range after pointer or keyboard selection. */
  onLineSelected?: (range: SelectedLineRange | null) => void;
  /** Opens a line/range action from Pierre's built-in hover-gutter `+`. */
  onGutterUtilityClick?: (range: SelectedLineRange) => void;
}

/**
 * The user-configurable appearance slice of Pierre's options, derived from
 * settings (Settings → Diff). Shared by this wrapper and LocalChanges'
 * FileDiff usage so both render identically.
 *
 * Deliberately NOT applied in MergeResolver — its HighlightLayer measures
 * gutter rows inside Pierre's shadow root, which `disableLineNumbers`
 * would break.
 */
export function diffAppearanceOptions(
  s: Pick<SettingsState, 'diffIndicators' | 'diffLineNumbers' | 'diffWordHighlight'>,
) {
  return {
    diffIndicators: s.diffIndicators,
    disableLineNumbers: !s.diffLineNumbers,
    // Intra-line (word-level) emphasis. 'word-alt' is Pierre's current
    // default, but agent review leans on it hard (single-identifier edits
    // on long lines), so pin it rather than ride the default.
    lineDiffType: (s.diffWordHighlight ? 'word-alt' : 'none') as 'word-alt' | 'none',
  };
}

/**
 * Parse a single-file patch and stamp it with the worker pool's `cacheKey`
 * (content hash). Without the key the pool's highlight LRU never hits, and
 * every mount re-tokenizes — which is exactly the cost j/k review navigation
 * can't afford. Shared with `HunkAnnotatedDiff` (LocalChanges).
 */
export function parseCacheablePatch(patch: string) {
  const fd = getSingularPatch(patch);
  fd.cacheKey = `patch:${hashPatch(patch)}`;
  return fd;
}

/**
 * {@link parseCacheablePatch} memoized per FileDiff object (one per fetch) —
 * used to prime the worker pool's highlight cache for upcoming queue entries
 * without re-parsing whole-file patches on the main thread on every pause.
 * Shared by the Review and Workspace Review prefetchers.
 */
const parsedPatchCache = new WeakMap<{ patch: string }, ReturnType<typeof parseCacheablePatch>>();
export function parsePatchCached(d: { patch: string }): ReturnType<typeof parseCacheablePatch> {
  let parsed = parsedPatchCache.get(d);
  if (!parsed) {
    parsed = parseCacheablePatch(d.patch);
    parsedPatchCache.set(d, parsed);
  }
  return parsed;
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
  const diffIndicators = useSettings((s) => s.diffIndicators);
  const diffLineNumbers = useSettings((s) => s.diffLineNumbers);
  const diffWordHighlight = useSettings((s) => s.diffWordHighlight);
  // Pre-parsed (rather than handing PatchDiff the string) so the diff carries
  // a cacheKey for the worker pool's highlight cache.
  const fileDiff = useMemo(() => {
    try {
      return parseCacheablePatch(patch);
    } catch (e) {
      console.warn('parseCacheablePatch failed', e);
      return null;
    }
  }, [patch]);
  const options = {
    diffStyle: layout,
    theme: pierreTheme,
    disableBackground: true,
    disableFileHeader: hideFileHeader,
    ...diffAppearanceOptions({ diffIndicators, diffLineNumbers, diffWordHighlight }),
  } as const;
  // Parse failure → fall back to Pierre's own patch handling (pre-cacheKey
  // behavior), so anything it tolerated still renders.
  return fileDiff ? (
    <PierreFileDiff fileDiff={fileDiff} options={options} className={className} style={style} />
  ) : (
    <PatchDiff patch={patch} options={options} className={className} style={style} />
  );
}

/** Render an already-parsed provider patch through Strand's Pierre boundary. */
export function ParsedDiff<LAnnotation = undefined>({
  fileDiff,
  layout = 'unified',
  hideFileHeader = false,
  selectedLines,
  lineAnnotations,
  renderAnnotation,
  onLineSelected,
  onGutterUtilityClick,
  className,
  style,
}: ParsedDiffProps<LAnnotation>) {
  const pierreTheme = useSettings((s) => s.resolvedTheme) === 'light' ? 'pierre-light' : 'pierre-dark';
  const diffIndicators = useSettings((s) => s.diffIndicators);
  const diffLineNumbers = useSettings((s) => s.diffLineNumbers);
  const diffWordHighlight = useSettings((s) => s.diffWordHighlight);
  const options = {
    diffStyle: layout,
    theme: pierreTheme,
    disableBackground: true,
    disableFileHeader: hideFileHeader,
    enableLineSelection: Boolean(onLineSelected),
    controlledSelection: Boolean(onLineSelected),
    onLineSelected,
    enableGutterUtility: Boolean(onGutterUtilityClick),
    onGutterUtilityClick,
    ...diffAppearanceOptions({ diffIndicators, diffLineNumbers, diffWordHighlight }),
  } as const;
  return (
    <PierreFileDiff<LAnnotation>
      fileDiff={fileDiff}
      options={options}
      selectedLines={selectedLines}
      lineAnnotations={lineAnnotations}
      renderAnnotation={renderAnnotation}
      className={className}
      style={style}
    />
  );
}
