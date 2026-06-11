import { useEffect, useMemo, useRef, useState } from 'react';

import { searchDiffs, type DiffMatch } from '../lib/diffSearch';
import type { FileDiff } from '../lib/types';
import { Icon } from './Icon';

/**
 * Focus (and select) an open bar's input — for re-invoking ⌘F while the bar
 * is already up, and for handing it focus after the command palette closes
 * (the palette restores focus on unmount, which would otherwise steal it
 * from the freshly mounted input).
 */
export function focusDiffSearchInput(): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLInputElement>('.diff-search-bar input');
    el?.focus();
    el?.select();
  });
}

/**
 * Floating ⌘F text-search bar over a diff pane (Local Changes / Review).
 * Matches are computed with `searchDiffs` over the whole pool; Enter /
 * Shift+Enter (or ↓/↑) step through them with wrapping, calling `onJump`
 * so the owner selects the matched file. The preview line under the input
 * carries the match's path + text, since jumping only lands on the file —
 * not yet the exact line inside the virtualized diff.
 */
export function DiffSearchBar({
  diffs,
  onJump,
  onClose,
  placeholder,
}: {
  diffs: Pick<FileDiff, 'path' | 'patch' | 'binary'>[];
  onJump: (m: DiffMatch) => void;
  onClose: () => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  // The matcher runs on a debounced copy so typing into a 40-file pool
  // doesn't re-scan megabytes of patch text per keystroke.
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query), 120);
    return () => window.clearTimeout(t);
  }, [query]);

  const result = useMemo(() => searchDiffs(diffs, debounced), [diffs, debounced]);
  const matches = result.matches;

  // -1 = not navigated yet: the first Enter lands on the first match instead
  // of stepping past it. Reset whenever the match list recomputes.
  const [pos, setPos] = useState(-1);
  useEffect(() => setPos(-1), [matches]);

  const inputRef = useRef<HTMLInputElement>(null);

  const step = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    const next =
      pos === -1
        ? dir === 1
          ? 0
          : matches.length - 1
        : (pos + dir + matches.length) % matches.length;
    setPos(next);
    onJump(matches[next]);
    // Stepping from the prev/next buttons must not strand focus there.
    inputRef.current?.focus();
  };

  const current = matches.length > 0 ? matches[Math.max(0, pos)] : null;
  const total = `${matches.length}${result.truncated ? '+' : ''}`;

  return (
    <div className="diff-search-bar" role="search" aria-label="Search in diff">
      <div className="ds-row">
        <Icon name="search" size={13} />
        <input
          ref={inputRef}
          autoFocus
          value={query}
          placeholder={placeholder ?? 'Search in diff…'}
          aria-label={placeholder ?? 'Search in diff'}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              step(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              step(-1);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <span className="ds-count" role="status" aria-live="polite">
          {!debounced.trim()
            ? ''
            : matches.length === 0
              ? 'No results'
              : pos >= 0
                ? `${pos + 1}/${total}`
                : `${total} found`}
        </span>
        <button
          type="button"
          className="ds-nav"
          onClick={() => step(-1)}
          disabled={matches.length === 0}
          aria-label="Previous match"
          title="Previous match (⇧↵)"
        >
          <Icon name="chev-up" size={13} />
        </button>
        <button
          type="button"
          className="ds-nav"
          onClick={() => step(1)}
          disabled={matches.length === 0}
          aria-label="Next match"
          title="Next match (↵)"
        >
          <Icon name="chev-down" size={13} />
        </button>
        <button
          type="button"
          className="ds-close"
          onClick={onClose}
          aria-label="Close search"
          title="Close (Esc)"
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      {current && (
        <div className="ds-preview" title={`${current.path} — ${current.lineText.trim()}`}>
          <span className={'ds-kind ' + current.kind} aria-hidden="true">
            {current.kind === 'add' ? '+' : current.kind === 'del' ? '−' : '·'}
          </span>
          <span className="ds-path">{current.path}</span>
          <span className="ds-line">{current.lineText.trim()}</span>
        </div>
      )}
    </div>
  );
}
