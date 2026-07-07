import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { autosquashPlan } from '../lib/rebase';
import { errMessage } from '../lib/tauri';
import { useRepo } from '../stores/repo';
import type { RebaseAction, RebaseStep } from '../lib/types';

/** A row in the plan: the commit plus the user's chosen verb + reword message. */
interface Row {
  oid: string;
  short: string;
  subject: string;
  author: string;
  isMerge: boolean;
  action: RebaseAction;
  /** Reword message, seeded from the subject; only read when action is reword. */
  message: string;
}

const ACTIONS: { value: RebaseAction; label: string }[] = [
  { value: 'pick', label: 'Pick' },
  { value: 'reword', label: 'Reword' },
  { value: 'squash', label: 'Squash' },
  { value: 'fixup', label: 'Fixup' },
  { value: 'drop', label: 'Drop' },
];
const KEY_TO_ACTION: Record<string, RebaseAction> = {
  p: 'pick',
  r: 'reword',
  s: 'squash',
  f: 'fixup',
  d: 'drop',
};

/**
 * Interactive-rebase sequence editor. Lists the commits in `base..HEAD`
 * (oldest→newest, as git's todo shows them) and lets the user reorder them and
 * set a per-commit verb (pick / reword / squash / fixup / drop). On submit the
 * plan is handed to `interactiveRebase`, which drives `git rebase -i` with no
 * editor (see `strand-core::history`). A conflict is an expected outcome —
 * close, and the store routes to Local Changes (resolve, then Continue on the
 * banner). Reuses the `.clone-dialog` shell + the shared dialog conventions
 * (focus trap, focus restore, Esc-close, busy flag, mounted-guard, error slot).
 *
 * Keyboard model: the list is a `role=listbox` driven by `aria-activedescendant`
 * — ↑/↓ move the focused row, ⌥↑/⌥↓ reorder it, `p`/`r`/`s`/`f`/`d` (or
 * Backspace = drop) set its verb. The per-row `<select>` and reword `<input>`
 * stay directly Tab-reachable for pointer/AT users.
 */
export function RebaseEditor({
  base,
  label,
  onClose,
  onToast,
}: {
  /** The commit *before* the first editable one; `null` = rebase from the root. */
  base: string | null;
  /** Short human label for the starting point, shown in the blurb. */
  label: string;
  onClose: () => void;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const loadRebaseTodo = useRepo((s) => s.loadRebaseTodo);
  const interactiveRebase = useRepo((s) => s.interactiveRebase);

  const [rows, setRows] = useState<Row[] | null>(null);
  // How many fixup!/squash! commits autosquash moved under their targets
  // (0 = none, no notice). The seeded plan stays fully editable.
  const [autosquashed, setAutosquashed] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  // Original commit order, to detect a no-op plan (all pick + unchanged order).
  const origOrderRef = useRef<string[]>([]);
  // Re-arm on mount — StrictMode's dev remount reuses the same ref, so a
  // cleanup-only effect would leave it permanently false (frozen busy state).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Restore focus to whatever opened the dialog when it closes.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);

  // Load the editable range once.
  useEffect(() => {
    let alive = true;
    loadRebaseTodo(base)
      .then((entries) => {
        if (!alive) return;
        origOrderRef.current = entries.map((e) => e.oid);
        let next: Row[] = entries.map((e) => ({
          oid: e.oid,
          short: e.short,
          subject: e.subject,
          author: e.author,
          isMerge: e.is_merge,
          action: 'pick',
          message: e.subject,
        }));
        // Seed the plan like `git rebase --autosquash`: fixup!/squash! commits
        // move under their targets with the matching verb. Still just a seed —
        // every row stays editable, and isNoop correctly sees a non-noop plan.
        const plan = autosquashPlan(entries.map((e) => ({ oid: e.oid, subject: e.subject })));
        if (plan) {
          const byOid = new Map(next.map((r) => [r.oid, r]));
          next = plan.map((s) => ({ ...byOid.get(s.oid)!, action: s.action }));
        }
        setAutosquashed(plan ? plan.filter((s) => s.action !== 'pick').length : 0);
        setRows(next);
        setFocused(0);
      })
      .catch((e) => {
        if (alive) setLoadError(errMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [base, loadRebaseTodo]);

  // Move keyboard focus into the list once it's populated.
  useEffect(() => {
    if (rows && rows.length > 0) listRef.current?.focus();
  }, [rows]);

  // Keep the focused row scrolled into view.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${focused}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  function onTrapKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const setAction = (i: number, action: RebaseAction) =>
    setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, action } : r)));
  const setMessage = (i: number, message: string) =>
    setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, message } : r)));
  const move = (i: number, dir: -1 | 1) => {
    let moved = false;
    setRows((rs) => {
      if (!rs) return rs;
      const j = i + dir;
      if (j < 0 || j >= rs.length) return rs;
      const next = rs.slice();
      [next[i], next[j]] = [next[j], next[i]];
      moved = true;
      return next;
    });
    if (moved) setFocused(i + dir);
  };

  function onListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!rows) return;
    const tag = (e.target as HTMLElement).tagName;
    // The per-row select / reword input own their own keys.
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (e.altKey) move(focused, 1);
      else setFocused((f) => Math.min(rows.length - 1, f + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.altKey) move(focused, -1);
      else setFocused((f) => Math.max(0, f - 1));
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      setAction(focused, 'drop');
    } else if (KEY_TO_ACTION[e.key.toLowerCase()]) {
      e.preventDefault();
      setAction(focused, KEY_TO_ACTION[e.key.toLowerCase()]);
    }
  }

  const hasMerges = useMemo(() => !!rows?.some((r) => r.isMerge), [rows]);
  const allDropped = useMemo(() => !!rows && rows.length > 0 && rows.every((r) => r.action === 'drop'), [rows]);
  // The first *kept* commit can't be squashed/fixed up — there's nothing before
  // it to fold into. git would error; flag it up front.
  const firstKeptCombines = useMemo(() => {
    const first = rows?.find((r) => r.action !== 'drop');
    return first ? first.action === 'squash' || first.action === 'fixup' : false;
  }, [rows]);
  const isNoop = useMemo(() => {
    if (!rows) return false;
    const orig = origOrderRef.current;
    return (
      rows.length === orig.length &&
      rows.every((r, i) => r.action === 'pick' && r.oid === orig[i])
    );
  }, [rows]);

  const canSubmit =
    !!rows && rows.length > 0 && !busy && !allDropped && !firstKeptCombines && !isNoop;

  async function submit() {
    if (!rows || !canSubmit) return;
    setBusy(true);
    setSubmitError(null);
    const steps: RebaseStep[] = rows.map((r) => ({
      action: r.action,
      oid: r.oid,
      message: r.action === 'reword' ? r.message : null,
    }));
    try {
      const conflicted = await interactiveRebase(base, steps);
      onToast(
        conflicted
          ? 'Rebase paused on conflicts — resolve them in Local Changes, then Continue'
          : 'Interactive rebase complete',
      );
      // A conflict is an expected outcome — close and let the resolver open
      // (the store switched to Local Changes). Only a real failure keeps us open.
      onClose();
    } catch (e) {
      if (mountedRef.current) setSubmitError(errMessage(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const keptCount = rows ? rows.filter((r) => r.action !== 'drop').length : 0;

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="clone-dialog rebase-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Interactive rebase"
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="rebase" size={15} />
          <span className="title">Interactive rebase</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body">
          {loadError ? (
            <div className="clone-error">{loadError}</div>
          ) : !rows ? (
            <p className="stash-blurb">Loading commits…</p>
          ) : rows.length === 0 ? (
            <p className="stash-blurb">
              No commits to rebase — nothing sits after <code>{label}</code>.
            </p>
          ) : (
            <>
              <p className="stash-blurb">
                Rebasing {keptCount} of {rows.length} commit{rows.length === 1 ? '' : 's'} after{' '}
                <code>{label}</code>. Reorder with ⌥↑/⌥↓; set each verb with the menu or{' '}
                <kbd>p</kbd>/<kbd>r</kbd>/<kbd>s</kbd>/<kbd>f</kbd>/<kbd>d</kbd>.
              </p>

              {autosquashed > 0 ? (
                <div className="rebase-warn" role="note">
                  Autosquash: {autosquashed} fixup commit{autosquashed === 1 ? '' : 's'} moved under{' '}
                  {autosquashed === 1 ? 'its target' : 'their targets'} — review the plan before
                  running.
                </div>
              ) : null}
              {hasMerges ? (
                <div className="rebase-warn" role="note">
                  This range contains a merge commit — interactive rebase flattens merges into a
                  linear history.
                </div>
              ) : null}
              {firstKeptCombines ? (
                <div className="rebase-warn" role="note">
                  The first kept commit can't be squashed or fixed up — there's nothing before it to
                  fold into.
                </div>
              ) : null}

              <div
                ref={listRef}
                className="rebase-list"
                role="listbox"
                tabIndex={0}
                aria-label="Rebase plan"
                aria-activedescendant={`rebase-row-${focused}`}
                onKeyDown={onListKeyDown}
              >
                {rows.map((r, i) => (
                  <div
                    key={r.oid}
                    id={`rebase-row-${i}`}
                    data-idx={i}
                    role="option"
                    aria-selected={i === focused}
                    className={
                      'rebase-row' +
                      (i === focused ? ' focused' : '') +
                      (r.action === 'drop' ? ' dropped' : '')
                    }
                    onClick={(e) => {
                      setFocused(i);
                      // Don't yank focus back to the list when the click landed on
                      // the row's own controls — refocusing closes the just-opened
                      // <select> dropdown and blurs the reword input.
                      if (!(e.target as HTMLElement).closest('select, input, button')) {
                        listRef.current?.focus();
                      }
                    }}
                  >
                    <span className="rb-move">
                      <button
                        type="button"
                        aria-label="Move up"
                        disabled={i === 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          move(i, -1);
                        }}
                      >
                        <Icon name="chev-up" size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label="Move down"
                        disabled={i === rows.length - 1}
                        onClick={(e) => {
                          e.stopPropagation();
                          move(i, 1);
                        }}
                      >
                        <Icon name="chev-down" size={12} />
                      </button>
                    </span>
                    <select
                      className="rb-action"
                      value={r.action}
                      disabled={busy}
                      aria-label={`Action for commit ${r.short}`}
                      onChange={(e) => setAction(i, e.target.value as RebaseAction)}
                    >
                      {ACTIONS.map((a) => (
                        <option key={a.value} value={a.value}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                    <code className="rb-sha">{r.short}</code>
                    {r.action === 'reword' ? (
                      <input
                        className="rb-reword"
                        value={r.message}
                        disabled={busy}
                        placeholder="New commit message"
                        aria-label={`New message for commit ${r.short}`}
                        onChange={(e) => setMessage(i, e.target.value)}
                      />
                    ) : (
                      <span className="rb-subject">{r.subject}</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {submitError ? <div className="clone-error">{submitError}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {busy ? 'Rebasing…' : 'Start rebase'}
          </button>
        </div>
      </div>
    </div>
  );
}
