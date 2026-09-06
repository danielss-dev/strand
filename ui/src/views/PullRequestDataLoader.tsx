import { useCallback, useEffect, useRef, useState } from 'react';
import { incompleteLabel } from '../lib/pullRequestPages';
import { errMessage, tauri } from '../lib/tauri';
import type { PullRequest, PullRequestDataPage } from '../lib/types';

export function PullRequestDataLoader({ path, pr, onPage }: {
  path: string; pr: PullRequest; onPage: (page: PullRequestDataPage) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  const stop = useCallback(() => {
    if (request.current) void tauri.repoPullRequestCancelRead(request.current).catch(() => {});
    request.current = null;
    setBusy(false);
  }, []);
  useEffect(() => { setError(null); return stop; }, [path, pr.id, pr.source_commit, stop]);
  const next = pr.data_pages?.[0];
  const load = useCallback(async () => {
    if (!next || request.current) return;
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setError(null);
    try {
      const page = await tauri.repoPullRequestDataPage(path, pr.id, pr.source_commit, next, id);
      if (request.current === id) onPage(page);
    } catch (caught) {
      if (request.current === id) setError(errMessage(caught));
    } finally {
      if (request.current === id) { request.current = null; setBusy(false); }
    }
  }, [next, onPage, path, pr.id, pr.source_commit]);
  useEffect(() => {
    const run = () => { void load(); };
    window.addEventListener('strand:pull-request-load-more', run);
    window.addEventListener('strand:pull-request-cancel-read', stop);
    return () => {
      window.removeEventListener('strand:pull-request-load-more', run);
      window.removeEventListener('strand:pull-request-cancel-read', stop);
    };
  }, [load, stop]);
  if (!next) return null;
  return <div className="pr-data-status" role="status">
    <span>{incompleteLabel(pr)}</span>
    <button type="button" className="h-link" disabled={busy} onClick={() => void load()}>
      {busy ? 'Loading…' : `Load more ${next.kind}`}
    </button>
    {busy && <button type="button" className="h-link" onClick={stop}>Cancel loading</button>}
    {(error || next.error) && <span role="alert">{error || next.error} · Retry loading or refresh.</span>}
  </div>;
}
