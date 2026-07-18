import { useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { repoActivity } from '../lib/db';
import { errMessage, isCancelled, tauri } from '../lib/tauri';
import type { MaintenanceOutcome, MaintenanceTask, RepoActivityEntry } from '../lib/types';

const TASKS: Array<{
  task: MaintenanceTask;
  label: string;
  description: string;
  command: string;
}> = [
  {
    task: 'integrity-check',
    label: 'Verify integrity',
    description: 'Check every reachable object and reference without changing the repository.',
    command: 'git -c core.fsmonitor= -c core.pager=cat fsck --full',
  },
  {
    task: 'maintenance',
    label: 'Run maintenance',
    description: 'Run the repository’s configured incremental maintenance tasks.',
    command: 'git -c core.fsmonitor= -c core.pager=cat maintenance run',
  },
  {
    task: 'garbage-collect',
    label: 'Garbage collect',
    description: 'Optimize and prune expired unreachable objects using Git’s normal grace periods.',
    command: 'git -c core.fsmonitor= -c core.pager=cat gc',
  },
];

function taskDefinition(task: MaintenanceTask) {
  return TASKS.find((candidate) => candidate.task === task) as (typeof TASKS)[number];
}

function duration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function MaintenanceDialog({
  path,
  onClose,
  onToast,
}: {
  path: string;
  onClose: () => void;
  onToast: (message: string, kind?: 'success' | 'error') => void;
}) {
  const [entries, setEntries] = useState<RepoActivityEntry[]>([]);
  const [running, setRunning] = useState<{ task: MaintenanceTask; opId: string } | null>(null);
  const [confirmGc, setConfirmGc] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    void repoActivity.list(path).then((saved) => {
      if (current) setEntries(saved);
    });
    return () => { current = false; };
  }, [path]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLButtonElement>('.maintenance-action')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, running]);

  function trapFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    ));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function record(entry: RepoActivityEntry) {
    setEntries((current) => [entry, ...current].slice(0, 50));
    try {
      setEntries(await repoActivity.append(path, entry));
    } catch {
      onToast('Activity history could not be saved', 'error');
    }
  }

  async function run(task: MaintenanceTask) {
    if (running) return;
    if (task === 'garbage-collect' && !confirmGc) {
      setConfirmGc(true);
      return;
    }
    setConfirmGc(false);
    const definition = taskDefinition(task);
    const startedAt = Date.now();
    const opId = `maintenance-${startedAt}`;
    setRunning({ task, opId });
    try {
      const outcome = await tauri.repoMaintenance(path, task, opId);
      await record({
        id: opId,
        task,
        started_at: startedAt,
        ...outcome,
      });
      onToast(
        outcome.success ? `${definition.label} completed` : `${definition.label} found problems`,
        outcome.success ? 'success' : 'error',
      );
    } catch (error) {
      const message = isCancelled(error) ? 'Operation cancelled' : errMessage(error);
      const fallback: MaintenanceOutcome = {
        command: definition.command,
        output: message,
        success: false,
        duration_ms: Date.now() - startedAt,
      };
      await record({ id: opId, task, started_at: startedAt, ...fallback });
      onToast(isCancelled(error) ? `${definition.label} cancelled` : `${definition.label} failed: ${message}`, 'error');
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="palette-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget && !running) onClose();
    }}>
      <div
        className="clone-dialog maintenance-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Repository maintenance"
        ref={dialogRef}
        onKeyDown={trapFocus}
      >
        <div className="clone-head">
          <Icon name="sync" size={15} />
          <span className="title">Repository maintenance</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={Boolean(running)} onClick={onClose}>×</button>
        </div>

        <div className="clone-body maintenance-body">
          <p className="stash-blurb">
            Run Git’s own maintenance tools. Every exact command and its captured output are retained for this repository.
          </p>
          <div className="maintenance-actions">
            {TASKS.map((definition) => {
              const active = running?.task === definition.task;
              const confirming = definition.task === 'garbage-collect' && confirmGc;
              return (
                <button
                  key={definition.task}
                  type="button"
                  className={`maintenance-action${confirming ? ' danger' : ''}`}
                  disabled={Boolean(running)}
                  onClick={() => void run(definition.task)}
                >
                  <span>{active ? 'Running…' : confirming ? 'Confirm garbage collection' : definition.label}</span>
                  <small>{definition.description}</small>
                </button>
              );
            })}
          </div>

          <div className="maintenance-log-head">
            <span>Activity</span>
            <span>{entries.length} retained</span>
          </div>
          <div className="maintenance-log" aria-live="polite">
            {entries.length === 0 ? (
              <div className="maintenance-empty">No maintenance activity yet.</div>
            ) : entries.map((entry) => (
              <details key={entry.id} className={`maintenance-entry${entry.success ? '' : ' failed'}`}>
                <summary>
                  <span>{taskDefinition(entry.task).label}</span>
                  <span>{entry.success ? 'Completed' : 'Failed'} · {duration(entry.duration_ms)} · {new Date(entry.started_at).toLocaleString()}</span>
                </summary>
                <code className="maintenance-command">{entry.command}</code>
                <pre>{entry.output || 'Git produced no output.'}</pre>
              </details>
            ))}
          </div>
        </div>

        <div className="clone-foot">
          {running ? (
            <button type="button" className="btn danger" onClick={() => void tauri.repoCancelOp(running.opId)}>Cancel operation</button>
          ) : (
            <button type="button" className="btn primary" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}
