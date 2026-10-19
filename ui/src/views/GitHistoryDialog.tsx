import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';

import { Dialog } from '../components/Dialog';
import { t } from '../lib/i18n';
import { errMessage, tauri } from '../lib/tauri';
import type { GitActionDirection, GitActionHistory, GitActionOutcome, GitHistoryItem } from '../lib/types';

export function formatGitActionToast(outcome: GitActionOutcome): string {
  const oid = outcome.snapshot_oid?.slice(0, 7);
  switch (outcome.direction) {
    case 'undo':
      return oid
        ? t('gitUndo.undidStash', { label: outcome.label, oid })
        : t('gitUndo.undid', { label: outcome.label });
    case 'redo':
      return oid
        ? t('gitUndo.redidStash', { label: outcome.label, oid })
        : t('gitUndo.redid', { label: outcome.label });
    default: {
      const never: never = outcome.direction;
      return never;
    }
  }
}

export function GitHistoryDialog({
  path,
  onClose,
  onApplied,
  onError,
}: {
  path: string;
  onClose: () => void;
  onApplied: (outcome: GitActionOutcome) => void;
  onError: (message: string) => void;
}) {
  const [history, setHistory] = useState<GitActionHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The stack whose newest entry was just refused; offers to drop it.
  const [refused, setRefused] = useState<GitActionDirection | null>(null);

  const load = useCallback(async () => {
    try {
      setHistory(await tauri.repoGitActionHistory(path));
      setLoadError(null);
    } catch (error) {
      setLoadError(errMessage(error));
    }
  }, [path]);

  useEffect(() => { void load(); }, [load]);

  async function walk(direction: GitActionDirection, count: number) {
    setBusy(true);
    setRefused(null);
    try {
      let last: GitActionOutcome | null = null;
      for (let step = 0; step < count; step += 1) {
        last = direction === 'undo'
          ? await tauri.repoUndoGitAction(path)
          : await tauri.repoRedoGitAction(path);
      }
      if (last) onApplied(last);
      onClose();
    } catch (error) {
      onError(errMessage(error));
      setRefused(direction);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function dropTop(direction: GitActionDirection) {
    setBusy(true);
    try {
      setHistory(await tauri.repoDropGitAction(path, direction));
      setRefused(null);
    } catch (error) {
      onError(errMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button.git-history-row')];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else return;
    event.preventDefault();
    rows[next]?.focus();
  }

  const empty = history != null && history.undo.length === 0 && history.redo.length === 0;

  return (
    <Dialog title={t('gitUndo.history')} icon="history" size="sm" busy={busy} onClose={onClose} className="git-history-dialog">
      <div className="clone-body git-history-body" onKeyDown={onListKeyDown}>
        {loadError && <p className="git-history-label" role="alert">{loadError}</p>}
        {empty && <p className="git-history-label">{t('gitUndo.empty')}</p>}
        {history && history.undo.length > 0 && (
          <HistoryStack
            label={t('gitUndo.undoStack')}
            items={history.undo}
            busy={busy}
            onPick={(index) => { void walk('undo', index + 1); }}
          />
        )}
        {refused && history && history[refused].length > 0 && (
          <div className="git-history-group">
            <span className="git-history-label">{t('gitUndo.dropHint')}</span>
            <button type="button" className="btn" disabled={busy} onClick={() => { void dropTop(refused); }}>
              {t('gitUndo.drop', { label: history[refused][0].label })}
            </button>
          </div>
        )}
        {history && history.redo.length > 0 && (
          <HistoryStack
            label={t('gitUndo.redoStack')}
            items={history.redo}
            busy={busy}
            onPick={(index) => { void walk('redo', index + 1); }}
          />
        )}
        <p className="git-history-label">{t('gitUndo.hint')}</p>
      </div>
    </Dialog>
  );
}

function HistoryStack({
  label,
  items,
  busy,
  onPick,
}: {
  label: string;
  items: GitHistoryItem[];
  busy: boolean;
  onPick: (index: number) => void;
}) {
  return (
    <div className="git-history-group" role="listbox" aria-label={label}>
      <span className="git-history-label">{label}</span>
      {items.map((item, index) => (
        <button
          key={`${item.op}-${index}-${item.label}`}
          type="button"
          className="git-history-row"
          role="option"
          disabled={busy}
          onClick={() => onPick(index)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
