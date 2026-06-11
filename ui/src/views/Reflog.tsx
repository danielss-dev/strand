import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { useRepo } from '../stores/repo';
import { errMessage } from '../lib/tauri';
import type { ReflogEntry } from '../lib/types';
import { ContextMenu, type MenuItem } from '../components/ContextMenu';
import { Icon } from '../components/Icon';

/**
 * Reflog view — the local, chronological record of where HEAD has pointed.
 *
 * Unlike the commit graph (reachable history), the reflog includes commits
 * orphaned by a reset / rebase / amend, so it's the recovery path back to "lost"
 * work. Each row jumps to its target commit in the graph; if that commit is no
 * longer reachable it won't appear there, but the right-click menu recovers it
 * directly (checkout / branch / reset). Lazy-loaded: only this view triggers
 * `refreshReflog`.
 */
export function Reflog({
  onResetTo,
  onCreateBranch,
  onToast,
}: {
  /** Open the Reset dialog targeting a commit (revspec + label). */
  onResetTo: (target: string, label: string) => void;
  /** Open the New-branch dialog from a start point (revspec + label). */
  onCreateBranch: (start: string, label: string) => void;
  onToast: (msg: string) => void;
}) {
  const activePath = useRepo((s) => s.activePath);
  const reflog = useRepo((s) => s.reflog);
  const refreshReflog = useRepo((s) => s.refreshReflog);
  const revealInGraph = useRepo((s) => s.revealInGraph);
  const checkoutCommit = useRepo((s) => s.checkoutCommit);

  const [focused, setFocused] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const focusedRowRef = useRef<HTMLButtonElement>(null);

  // Right-click (or Menu / Shift+F10) on a row — the recovery actions for the
  // commit this entry points at, same pattern as the Commits graph.
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const openEntryMenu = useCallback(
    (entry: ReflogEntry, x: number, y: number) => {
      const selector = `HEAD@{${entry.index}}`;
      const items: MenuItem[] = [
        {
          label: 'Jump to in graph',
          icon: 'graph',
          onSelect: () => revealInGraph(entry.new_oid),
        },
        {
          label: 'Checkout (detached)',
          icon: 'branch',
          onSelect: () => void (async () => {
            try {
              await checkoutCommit(entry.new_oid);
              onToast(`Checked out ${entry.new_short} (detached)`);
            } catch (e) {
              onToast(`Checkout failed: ${errMessage(e)}`);
            }
          })(),
        },
        {
          label: 'Create branch here…',
          icon: 'plus',
          onSelect: () => onCreateBranch(entry.new_oid, entry.new_short),
        },
        {
          label: 'Reset HEAD here…',
          icon: 'history',
          onSelect: () => onResetTo(entry.new_oid, selector),
        },
      ];
      setMenu({ x, y, items });
    },
    [revealInGraph, checkoutCommit, onCreateBranch, onResetTo, onToast],
  );

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
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const entry = reflog[focused];
      const r = focusedRowRef.current?.getBoundingClientRect();
      if (entry && r) {
        e.preventDefault();
        openEntryMenu(entry, r.left + 24, r.bottom - 6);
      }
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
    <>
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
              onContextMenu={(ev) => {
                ev.preventDefault();
                setFocused(i);
                openEntryMenu(e, ev.clientX, ev.clientY);
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
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </>
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
