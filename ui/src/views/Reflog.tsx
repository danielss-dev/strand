import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { useRepo } from '../stores/repo';
import { Icon } from '../components/Icon';

/**
 * Reflog view — the local, chronological record of where HEAD has pointed.
 *
 * Unlike the commit graph (reachable history), the reflog includes commits
 * orphaned by a reset / rebase / amend, so it's the recovery path back to "lost"
 * work. Each row jumps to its target commit in the graph; if that commit is no
 * longer reachable it won't appear there, but the short OID shown here is enough
 * to recover it manually. Lazy-loaded: only this view triggers `refreshReflog`.
 */
export function Reflog() {
  const activePath = useRepo((s) => s.activePath);
  const reflog = useRepo((s) => s.reflog);
  const refreshReflog = useRepo((s) => s.refreshReflog);
  const revealInGraph = useRepo((s) => s.revealInGraph);

  const [focused, setFocused] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const focusedRowRef = useRef<HTMLButtonElement>(null);

  // Load (and reload on tab switch) whenever this view is mounted. Re-reading on
  // focus is handled by the row click → graph jump, which leaves this view.
  useEffect(() => {
    void refreshReflog();
  }, [activePath, refreshReflog]);

  // Keep the roving focus index in range as the list size changes.
  useEffect(() => {
    setFocused((f) => Math.min(f, Math.max(0, reflog.length - 1)));
  }, [reflog.length]);

  useEffect(() => {
    focusedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (reflog.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocused((f) => Math.min(f + 1, reflog.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocused((f) => Math.max(f - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = reflog[focused];
      if (entry) revealInGraph(entry.new_oid);
    }
  };

  if (reflog.length === 0) {
    return (
      <div className="reflog-empty">
        <Icon name="history" size={22} />
        <p>No reflog entries yet.</p>
        <span>HEAD movements — commits, checkouts, resets, merges — will appear here.</span>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="reflog-list"
      role="listbox"
      tabIndex={0}
      aria-label="HEAD reflog"
      aria-activedescendant={`reflog-row-${focused}`}
      onKeyDown={onKeyDown}
    >
      {reflog.map((e, i) => {
        const { op, rest } = splitMessage(e.message);
        return (
          <button
            type="button"
            key={`${e.index}-${e.new_oid}`}
            id={`reflog-row-${i}`}
            ref={i === focused ? focusedRowRef : undefined}
            role="option"
            aria-selected={i === focused}
            className={'reflog-row' + (i === focused ? ' focused' : '')}
            onClick={() => {
              setFocused(i);
              revealInGraph(e.new_oid);
            }}
            title="Jump to this commit in the graph"
          >
            <span className="sel">HEAD@&#123;{e.index}&#125;</span>
            <span className={'op ' + opClass(op)}>{op}</span>
            <span className="msg">{rest || <em>(no message)</em>}</span>
            <span className="when">{relTime(e.time_unix)}</span>
            <span className="hash">{e.new_short}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Split a reflog message into its leading operation (`commit`, `checkout`,
 * `reset`, `rebase (finish)`, …) and the rest. git writes these as `<op>: <rest>`;
 * messages without a colon (rare) fall back to the whole string as `rest`.
 */
function splitMessage(message: string): { op: string; rest: string } {
  const idx = message.indexOf(':');
  if (idx === -1) return { op: 'move', rest: message };
  return { op: message.slice(0, idx).trim(), rest: message.slice(idx + 1).trim() };
}

/** Color the op badge by family so destructive/rewriting moves stand out. */
function opClass(op: string): string {
  const head = op.split(' ')[0];
  if (head === 'reset' || head === 'rebase') return 'warn';
  if (head === 'commit' || head === 'merge' || head === 'pull') return 'add';
  if (head === 'checkout' || head === 'clone' || head === 'branch') return 'nav';
  return '';
}

function relTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
