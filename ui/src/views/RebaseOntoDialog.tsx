import { useEffect, useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
import { t } from '../lib/i18n';
import { withMovedBranches } from '../lib/rebase';
import { errMessage, tauri } from '../lib/tauri';
import { useRepo } from '../stores/repo';
import type { RebaseRefPreview } from '../lib/types';
import { UpdateRefsToggle } from './RebaseUpdateRefs';

/**
 * Confirm a plain `git rebase <onto>` and choose whether other local branches
 * in the range follow (`--update-refs`). The choice is remembered per repo as
 * Strand's `strand.rebaseUpdateRefs` once the rebase starts.
 *
 * The sidebar Rebase menu and a branch drag-and-drop both open this dialog.
 * A drop that has to switch branches first passes `checkout` and `wrap`; the
 * branch preview is skipped then, because it is computed from the current
 * HEAD, not the branch the drop checks out.
 */
export function RebaseOntoDialog({
  onto,
  branch,
  onClose,
  onToast,
  checkout = null,
  wrap,
}: {
  onto: string;
  branch: string;
  onClose: () => void;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
  /** Branch a drop checks out before rebasing; null when HEAD is already `branch`. */
  checkout?: string | null;
  /** Runs the rebase after that checkout, switching back if it fails. */
  wrap?: <T>(step: () => Promise<T>) => Promise<T>;
}) {
  const rebase = useRepo((s) => s.rebase);
  const loadRebaseUpdateRefs = useRepo((s) => s.loadRebaseUpdateRefs);
  const setRebaseUpdateRefs = useRepo((s) => s.setRebaseUpdateRefs);
  const path = useRepo((s) => s.activePath);

  const [supported, setSupported] = useState(true);
  const [updateRefs, setUpdateRefs] = useState(false);
  const [preview, setPreview] = useState<RebaseRefPreview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    loadRebaseUpdateRefs()
      .then((setting) => {
        if (!alive) return;
        setSupported(setting.supported);
        setUpdateRefs(setting.supported && setting.enabled);
      })
      .catch((caught) => {
        if (alive) setError(errMessage(caught));
      });
    if (path && !checkout) {
      tauri.repoRebaseRefPreview(path, onto)
        .then((rows) => {
          if (alive) setPreview(rows);
        })
        .catch((caught) => {
          if (alive) setError(errMessage(caught));
        });
    }
    return () => {
      alive = false;
    };
  }, [checkout, loadRebaseUpdateRefs, onto, path]);

  function onToggle(enabled: boolean) {
    setUpdateRefs(enabled);
    setError(null);
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Remember the choice only once a rebase actually starts.
      if (supported) await setRebaseUpdateRefs(updateRefs);
      const run = () => rebase(onto, supported && updateRefs);
      const outcome = wrap ? await wrap(run) : await run();
      const done = outcome.paused
        ? t('rebase.plainConflict', { onto })
        : t('rebase.plainDone', { branch, onto });
      onToast(outcome.paused ? done : withMovedBranches(done, outcome.moved));
      onClose();
    } catch (caught) {
      if (mountedRef.current) setError(errMessage(caught));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const moving = preview.filter((row) => row.will_move);
  const blocked = preview.filter((row) => !row.will_move);

  return (
    <Dialog
      title={t('rebase.ontoTitle')}
      icon="rebase"
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Rebasing…' : 'Rebase'}
          </button>
        </>
      }
    >
      <div className="clone-body">
        <p className="stash-blurb">
          {t('rebase.ontoBlurb', { branch, onto })}
          {checkout ? ` ${t('drag.git.checkoutFirst', { branch: checkout })}` : null}
        </p>
        <UpdateRefsToggle
          supported={supported}
          enabled={updateRefs}
          busy={busy}
          onChange={(enabled) => void onToggle(enabled)}
        />
        {!supported ? <p className="rebase-warn">{t('rebase.updateRefsUnsupported')}</p> : null}
        {supported && updateRefs && moving.length > 0 ? (
          <p className="stash-blurb">{t('rebase.willMove', { branches: moving.map((row) => row.name).join(', ') })}</p>
        ) : null}
        {supported && updateRefs
          ? blocked.map((row) => (
              <p key={row.full_ref} className="stash-blurb">
                {t('rebase.wontMove', { branch: row.name })}
              </p>
            ))
          : null}
        {error ? <div className="clone-error">{error}</div> : null}
      </div>
    </Dialog>
  );
}
