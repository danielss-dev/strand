import { useEffect, useRef, useState } from 'react';

import {
  beginDrag,
  branchFromDataset,
  commitDragFromRows,
  commitFromDataset,
  commitZone,
  dragCursor,
  dragGhost,
  finishDrag,
  hitFromDataset,
  moveDrag,
  resolveGitDrop,
  runAfterDropCheckout,
  type BranchIntent,
  type CherryPickIntent,
  type DragCommit,
  type DragSession,
  type DragSource,
  type DropHit,
  type DropIntent,
  type HistoryOperation,
  type PushIntent,
  type RebaseSeed,
} from '../lib/gitDrag';
import { t } from '../lib/i18n';
import { errMessage } from '../lib/tauri';
import type { BranchPushRequest, Commit } from '../lib/types';
import { useRepo } from '../stores/repo';
import { Dialog } from './Dialog';
import { MainlineDialog } from '../views/MainlineDialog';
import { RebaseOntoDialog } from '../views/RebaseOntoDialog';

/**
 * Pointer-drag for sidebar Git rows. Mirrors the Files-tree drag: a movement
 * threshold, window-level move/up listeners, and a cursor-chasing ghost.
 * HTML5 drag events are not used (WebView2 owns those for folder drops).
 * Escape and a no-drop release never call merge or rebase.
 */
export function GitDragHost({
  onOpenMerge,
  onPush,
  onOpenRebase,
  onToast,
}: {
  onOpenMerge: (request: {
    source: string;
    into: string;
    wrap?: <T>(step: () => Promise<T>) => Promise<T>;
  }) => void;
  onPush: (request: BranchPushRequest) => void;
  onOpenRebase: (request: { base: string | null; label: string; seed: RebaseSeed }) => void;
  onToast: (message: string, kind?: 'success' | 'error') => void;
}) {
  const operation = useRepo((s) => s.meta?.operation ?? null);
  const checkout = useRepo((s) => s.checkout);
  const cherryPick = useRepo((s) => s.cherryPick);
  const [mainline, setMainline] = useState<CherryPickIntent | null>(null);
  // Drag-rebase opens the same RebaseOntoDialog as the sidebar Rebase menu,
  // so the --update-refs choice and branch preview apply to drops too.
  const [rebaseOnto, setRebaseOnto] = useState<BranchIntent | null>(null);
  const [pending, setPending] = useState<DropIntent | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const mainlineRef = useRef(mainline);
  mainlineRef.current = mainline;
  const rebaseOntoRef = useRef(rebaseOnto);
  rebaseOntoRef.current = rebaseOnto;
  const operationRef = useRef<HistoryOperation>(operation);
  operationRef.current = operation;
  const openMergeRef = useRef(onOpenMerge);
  openMergeRef.current = onOpenMerge;
  const openRebaseRef = useRef(onOpenRebase);
  openRebaseRef.current = onOpenRebase;
  const checkoutRef = useRef(checkout);
  checkoutRef.current = checkout;
  // Check out the drop's branch, run the step, and switch back if it fails
  // without leaving an operation paused there.
  const onBranch = <T,>(branch: string | null, step: () => Promise<T>): Promise<T> => {
    const meta = useRepo.getState().meta;
    const original = meta && !meta.detached ? meta.branch : null;
    return runAfterDropCheckout(branch, original, (name) => checkoutRef.current(name), step, async () => {
      await useRepo.getState().refreshMeta();
      return useRepo.getState().meta?.operation ?? null;
    });
  };

  useEffect(() => {
    let session: DragSession = { status: 'idle' };
    let ghost: HTMLDivElement | null = null;
    let hover: HTMLElement | null = null;
    let suppressClick = false;
    let detachMove = () => {};

    const clearVisual = () => {
      ghost?.remove();
      ghost = null;
      if (hover) delete hover.dataset.gitDropHover;
      hover = null;
      document.documentElement.classList.remove('git-drag-valid', 'git-drag-invalid');
      document.body.style.userSelect = '';
    };

    const paint = (next: DragSession, x: number, y: number) => {
      if (next.status !== 'dragging') return;
      document.body.style.userSelect = 'none';
      const cursor = dragCursor(next.intent);
      document.documentElement.classList.toggle('git-drag-valid', cursor === 'copy');
      document.documentElement.classList.toggle('git-drag-invalid', cursor === 'no-drop');
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-git-drop]') ?? null;
      if (hover !== row) {
        if (hover) delete hover.dataset.gitDropHover;
        hover = row;
      }
      if (hover) {
        if (next.intent) hover.dataset.gitDropHover = 'valid';
        else delete hover.dataset.gitDropHover;
      }
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'tree-drag-ghost';
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${x + 14}px`;
      ghost.style.top = `${y + 10}px`;
      ghost.classList.toggle('invalid', !next.intent);
      const ghostLabel = next.intent ? dragGhost(next.intent) : null;
      ghost.textContent = ghostLabel
        ? t('drag.git.ghost', ghostLabel)
        : dragSourceLabel(next.source);
    };

    const end = () => {
      detachMove();
      detachMove = () => {};
      session = { status: 'idle' };
      clearVisual();
    };

    const onClick = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || pendingRef.current || mainlineRef.current || rebaseOntoRef.current) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('input, textarea, select, .palette-backdrop, .context-menu, .context-menu-backdrop')) return;
      const row = target.closest<HTMLElement>('[data-git-source]');
      if (!row) return;
      const source = readDragSource(row);
      if (!source) return;
      session = beginDrag(source, event.clientX, event.clientY);

      const onMove = (ev: MouseEvent) => {
        const intent = resolveGitDrop(source, readDropHit(ev.clientX, ev.clientY), operationRef.current);
        const previous = session.status;
        session = moveDrag(session, { x: ev.clientX, y: ev.clientY, intent });
        if (session.status !== 'dragging') return;
        if (previous !== 'dragging') suppressClick = true;
        ev.preventDefault();
        paint(session, ev.clientX, ev.clientY);
      };
      const onUp = (ev: MouseEvent) => {
        const intent = resolveGitDrop(source, readDropHit(ev.clientX, ev.clientY), operationRef.current);
        const chosen = session.status === 'dragging'
          ? finishDrag({ status: 'dragging', source: session.source, intent }, true)
          : null;
        end();
        if (chosen?.kind === 'rebase') {
          openRebaseRef.current({ base: chosen.seed.base, label: chosen.seed.baseLabel, seed: chosen.seed });
          return;
        }
        if (chosen) setPending(chosen);
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        finishDrag(session, false);
        end();
      };
      detachMove = () => {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        window.removeEventListener('keydown', onKey, true);
      };
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('keydown', onKey, true);
    };

    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('click', onClick, true);
      end();
    };
  }, []);

  if (mainline?.mainline) {
    const picked = mainline.mainline;
    const checkoutName = mainline.checkout;
    return (
      <MainlineDialog
        commit={commitForMainline(picked)}
        operation="cherry-pick"
        wrap={checkoutName ? (step) => onBranch(checkoutName, step) : undefined}
        onClose={() => setMainline(null)}
        onToast={onToast}
      />
    );
  }

  if (rebaseOnto) {
    const intent = rebaseOnto;
    const checkoutName = intent.checkout;
    return (
      <RebaseOntoDialog
        onto={intent.rebaseOnto}
        branch={intent.rebaseBranch}
        checkout={checkoutName}
        wrap={checkoutName ? (step) => onBranch(checkoutName, step) : undefined}
        onClose={() => setRebaseOnto(null)}
        onToast={onToast}
      />
    );
  }

  if (!pending) return null;
  const dismiss = () => setPending(null);
  if (pending.kind === 'cherry-pick') {
    return (
      <CherryPickConfirm
        intent={pending}
        onClose={dismiss}
        onConfirm={() => {
          const intent = pending;
          dismiss();
          if (intent.blockedMerge) return;
          if (intent.mainline) {
            setMainline(intent);
            return;
          }
          void (async () => {
            try {
              const conflicted = await onBranch(intent.checkout, () => cherryPick(intent.hashes));
              onToast(
                conflicted
                  ? t('drag.git.cherryConflict', { label: intent.label })
                  : intent.hashes.length > 1
                    ? t('drag.git.cherryDoneMany', { count: intent.hashes.length })
                    : t('drag.git.cherryDone', { label: intent.label }),
              );
            } catch (caught) {
              onToast(t('drag.git.cherryFailed', { error: errMessage(caught) }), 'error');
            }
          })();
        }}
      />
    );
  }
  if (pending.kind === 'push') {
    return (
      <PushConfirm
        intent={pending}
        onClose={dismiss}
        onPush={(request) => {
          dismiss();
          onPush(request);
        }}
      />
    );
  }
  if (pending.kind !== 'branch') return null;
  return (
    <BranchConfirm
      intent={pending}
      onClose={dismiss}
      onMerge={() => {
        const checkoutName = pending.checkout;
        dismiss();
        openMergeRef.current({
          source: pending.mergeRef,
          into: pending.mergeInto,
          wrap: checkoutName ? (step) => onBranch(checkoutName, step) : undefined,
        });
      }}
      onRebase={() => {
        const intent = pending;
        dismiss();
        setRebaseOnto(intent);
      }}
    />
  );
}

function dragSourceLabel(source: DragSource): string {
  if (source.kind !== 'commits') return source.label;
  if (source.commits.length === 1) return source.commits[0].short;
  return t('drag.git.commitCount', { count: source.commits.length });
}

function readDragSource(row: HTMLElement): DragSource | null {
  const branch = branchFromDataset(row.dataset);
  if (branch) return branch;
  const commit = commitFromDataset(row.dataset);
  if (!commit) return null;
  if (row.dataset.gitSelected !== '1') return commitDragFromRows([commit]);
  const raw = row.closest<HTMLElement>('[data-git-selection]')?.dataset.gitSelection;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as DragCommit[];
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item?.hash === 'string')) {
        return {
          kind: 'commits',
          commits: parsed.map((item) => ({ ...item, rewrite: item.rewrite === true })),
        };
      }
    } catch {
      // The visible rows below still name the commits that are on screen.
    }
  }
  const selected = [...document.querySelectorAll<HTMLElement>('[data-git-source="commit"][data-git-selected="1"]')]
    .map((element) => commitFromDataset(element.dataset))
    .filter((item): item is DragCommit => item != null);
  return commitDragFromRows(selected);
}

function readDropHit(x: number, y: number): DropHit | null {
  const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-git-drop]');
  if (!element) return null;
  if (element.dataset.gitDrop === 'commit') {
    const commit = commitFromDataset(element.dataset);
    if (!commit) return null;
    const rect = element.getBoundingClientRect();
    return { kind: 'commit', ...commit, zone: commitZone(y - rect.top, rect.height) };
  }
  return hitFromDataset(element.dataset);
}

function commitForMainline(commit: NonNullable<CherryPickIntent['mainline']>): Commit {
  return {
    hash: commit.hash,
    short_hash: commit.short,
    subject: '',
    body: '',
    author_name: '',
    author_email: '',
    time_unix: 0,
    parents: commit.parents,
  };
}

function CherryPickConfirm({
  intent,
  onClose,
  onConfirm,
}: {
  intent: CherryPickIntent;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      title={t('drag.git.cherryTitle')}
      icon="arrow-down"
      size="sm"
      describedBy="git-drag-description"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          {intent.blockedMerge ? null : (
            <button type="button" className="btn primary" onClick={onConfirm}>{t('drag.git.cherryButton')}</button>
          )}
        </>
      }
    >
      <div className="clone-body">
        <p id="git-drag-description" className="stash-blurb">
          {t('drag.git.cherryBody', { commits: intent.label, branch: intent.branch })}
          {intent.checkout ? ` ${t('drag.git.checkoutFirst', { branch: intent.checkout })}` : null}
        </p>
        {intent.blockedMerge ? (
          <div className="clone-error">{t('drag.git.cherryMergeBlocked', { hash: intent.blockedMerge })}</div>
        ) : null}
      </div>
    </Dialog>
  );
}

function BranchConfirm({
  intent,
  onClose,
  onMerge,
  onRebase,
}: {
  intent: BranchIntent;
  onClose: () => void;
  onMerge: () => void;
  onRebase: () => void;
}) {
  return (
    <Dialog
      title={t('drag.git.branchTitle')}
      icon="branch"
      size="sm"
      describedBy="git-drag-description"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn" onClick={onRebase}>{t('drag.git.rebase')}</button>
          <button type="button" className="btn primary" onClick={onMerge}>{t('drag.git.merge')}</button>
        </>
      }
    >
      <div className="clone-body">
        <p id="git-drag-description" className="stash-blurb">
          {t('drag.git.branchBody', {
            dragged: intent.draggedLabel,
            dropped: intent.droppedLabel,
            mergeRef: intent.mergeRef,
            mergeInto: intent.mergeInto,
            rebaseBranch: intent.rebaseBranch,
            rebaseOnto: intent.rebaseOnto,
          })}
          {intent.checkout ? ` ${t('drag.git.checkoutFirst', { branch: intent.checkout })}` : null}
        </p>
      </div>
    </Dialog>
  );
}

function PushConfirm({
  intent,
  onClose,
  onPush,
}: {
  intent: PushIntent;
  onClose: () => void;
  onPush: (request: BranchPushRequest) => void;
}) {
  const [setUpstream, setSetUpstream] = useState(intent.offerUpstream);
  const upstream = `${intent.remote}/${intent.remoteBranch}`;
  return (
    <Dialog
      title={t('drag.git.pushTitle')}
      icon="arrow-up"
      size="sm"
      describedBy="git-drag-description"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button
            type="button"
            className="btn primary"
            onClick={() => onPush({
              branch: intent.branch,
              remote: intent.remote,
              remoteBranch: intent.remoteBranch,
              mode: 'default',
              setUpstream,
            })}
          >
            {setUpstream ? t('drag.git.pushAndSet') : t('drag.git.pushButton')}
          </button>
        </>
      }
    >
      <div className="clone-body">
        <p id="git-drag-description" className="stash-blurb">
          {t('drag.git.pushBody', { branch: intent.branch, remote: intent.remote, destination: intent.remoteBranch })}
        </p>
        {intent.offerUpstream ? (
          <label className="stash-check">
            <input
              type="checkbox"
              checked={setUpstream}
              onChange={(event) => setSetUpstream(event.target.checked)}
            />
            <span>{t('drag.git.pushUpstream', { upstream, branch: intent.branch })}</span>
          </label>
        ) : null}
      </div>
    </Dialog>
  );
}
