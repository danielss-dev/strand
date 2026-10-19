import { useEffect, useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
import { t } from '../lib/i18n';
import { errMessage, tauri } from '../lib/tauri';
import type { AmendIntoPlan } from '../lib/types';
import { useRepo } from '../stores/repo';

/**
 * Confirm folding the staged index into one commit. The list is the rewrite
 * range; a merge in that range blocks the action, and an upstream target
 * warns that a force push will be needed.
 */
export function AmendIntoDialog({
  target,
  label,
  subject,
  onClose,
  onToast,
}: {
  target: string;
  label: string;
  subject: string;
  onClose: () => void;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const path = useRepo((s) => s.meta?.path ?? null);
  const amendInto = useRepo((s) => s.amendInto);
  const [plan, setPlan] = useState<AmendIntoPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!path) {
      setLoadError('No repository selected.');
      return;
    }
    let cancelled = false;
    setPlan(null);
    setLoadError(null);
    void tauri.repoAmendIntoPlan(path, target).then(
      (next) => { if (!cancelled) setPlan(next); },
      (caught: unknown) => { if (!cancelled) setLoadError(errMessage(caught)); },
    );
    return () => { cancelled = true; };
  }, [path, target]);

  const blocked = !plan || plan.has_merge || !!loadError;

  async function submit() {
    if (blocked || busy) return;
    setBusy(true);
    setError(null);
    try {
      const conflicted = await amendInto(target);
      onToast(conflicted ? t('amendInto.conflict', { label }) : t('amendInto.done', { label }));
      onClose();
    } catch (caught) {
      if (mountedRef.current) setError(errMessage(caught));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <Dialog
      title={t('amendInto.title')}
      icon="rebase"
      size="sm"
      busy={busy}
      onClose={onClose}
      initialFocusRef={confirmRef}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="btn primary"
            disabled={busy || blocked}
            onClick={() => void submit()}
          >
            {busy ? t('amendInto.busy') : t('amendInto.confirm')}
          </button>
        </>
      }
    >
      <AmendIntoBody
        target={target}
        label={label}
        subject={subject}
        plan={plan}
        loadError={loadError}
        error={error}
      />
    </Dialog>
  );
}

export function AmendIntoBody({
  target,
  label,
  subject,
  plan,
  loadError,
  error,
}: {
  target: string;
  label: string;
  subject: string;
  plan: AmendIntoPlan | null;
  loadError: string | null;
  error: string | null;
}) {
  return (
    <div className="clone-body">
      <p className="stash-blurb">{t('amendInto.blurb', { label, subject })}</p>
      <p className="stash-blurb">{t('amendInto.autostash')}</p>
      {loadError ? <div className="clone-error" role="alert">{loadError}</div> : null}
      {!plan && !loadError ? <p className="stash-blurb">{t('amendInto.loading')}</p> : null}
      {plan ? (
        <>
          <p className="stash-blurb" id="amend-into-rewritten">{t('amendInto.rewritten')}</p>
          <ul className="amend-into-list" tabIndex={0} aria-labelledby="amend-into-rewritten">
            {plan.commits.map((commit) => (
              <li key={commit.oid}>
                <code>{commit.short}</code>
                <span>{commit.subject}</span>
                {commit.oid === target ? <span className="amend-into-target">{t('amendInto.target')}</span> : null}
              </li>
            ))}
          </ul>
          {plan.pushed ? <p className="amend-into-warn" role="status">{t('amendInto.pushed')}</p> : null}
          {plan.has_merge ? <div className="clone-error" role="alert">{t('amendInto.merge')}</div> : null}
        </>
      ) : null}
      {error ? <div className="clone-error" role="alert">{error}</div> : null}
    </div>
  );
}
