import { useEffect, useMemo, useRef, useState } from 'react';

import { searchFileText } from '../lib/fileSearch';
import { Icon } from './Icon';

/** Focus and select the query when Mod+F is invoked again on an open bar. */
export function focusFileSearchInput(): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLInputElement>('.file-search-bar input');
    el?.focus();
    el?.select();
  });
}

export function FileSearchBar({
  text,
  onSelect,
  onClose,
}: {
  text: string;
  onSelect: (line: number | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 120);
    return () => window.clearTimeout(timer);
  }, [query]);

  const result = useMemo(() => searchFileText(text, debounced), [text, debounced]);
  const matches = result.matches;
  const [pos, setPos] = useState(-1);
  useEffect(() => {
    setPos(-1);
    onSelect(null);
  }, [matches, onSelect]);

  const inputRef = useRef<HTMLInputElement>(null);
  const step = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    const next = pos === -1
      ? (dir === 1 ? 0 : matches.length - 1)
      : (pos + dir + matches.length) % matches.length;
    setPos(next);
    onSelect(matches[next].line);
    inputRef.current?.focus();
  };

  const current = matches.length > 0 ? matches[Math.max(0, pos)] : null;
  const total = `${matches.length}${result.truncated ? '+' : ''}`;

  return (
    <div
      className="diff-search-bar file-search-bar"
      role="search"
      aria-label="Search in file"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="ds-row">
        <Icon name="search" size={13} />
        <input
          ref={inputRef}
          autoFocus
          value={query}
          placeholder="Search in file…"
          aria-label="Search in file"
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
        <button type="button" className="ds-nav" onClick={() => step(-1)}
          disabled={matches.length === 0} aria-label="Previous match" title="Previous match (⇧↵)">
          <Icon name="chev-up" size={13} />
        </button>
        <button type="button" className="ds-nav" onClick={() => step(1)}
          disabled={matches.length === 0} aria-label="Next match" title="Next match (↵)">
          <Icon name="chev-down" size={13} />
        </button>
        <button type="button" className="ds-close" onClick={onClose}
          aria-label="Close search" title="Close (Esc)">
          <Icon name="x" size={12} />
        </button>
      </div>
      {current && (
        <div className="ds-preview" title={`Line ${current.line} — ${current.lineText.trim()}`}>
          <span className="ds-path">Line {current.line}</span>
          <span className="ds-line">{current.lineText.trim()}</span>
        </div>
      )}
    </div>
  );
}
