import { useCallback, useEffect, useRef, useState } from 'react';
import { errMessage, tauri } from '../lib/tauri';
import type { PullRequestList } from '../lib/types';

export function PullRequestInboxLoader({ path, data, onPage }: {
  path: string; data: PullRequestList; onPage: (page: PullRequestList) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  const stop = useCallback(() => {
    if (request.current) void tauri.repoPullRequestCancelRead(request.current).catch(() => {});
    request.current = null;
    setBusy(false);
  }, []);
  useEffect(() => stop, [path, stop]);
  const load = useCallback(async () => {
    if (!data.next_cursor || request.current) return;
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true); setError(null);
    try {
      const page = await tauri.repoPullRequestInboxPage(path, data.next_cursor, id);
      if (request.current === id) onPage(page);
    } catch (caught) {
      if (request.current === id) setError(errMessage(caught));
    } finally {
      if (request.current === id) { request.current = null; setBusy(false); }
    }
  }, [data.next_cursor, onPage, path]);
  useEffect(() => {
    const run = () => { void load(); };
    window.addEventListener('strand:pull-request-load-more', run);
    window.addEventListener('strand:pull-request-cancel-read', stop);
    return () => {
      window.removeEventListener('strand:pull-request-load-more', run);
      window.removeEventListener('strand:pull-request-cancel-read', stop);
    };
  }, [load, stop]);
  return <div className="pr-data-status" role="status">
    <span>{data.pull_requests.length} loaded{data.total_count != null ? ` of ${data.total_count}` : ''}
      </span>
    {data.next_cursor && <button type="button" className="h-link" disabled={busy} onClick={() => void load()}>{busy ? 'Loading…' : 'Load more pull requests'}</button>}
    {busy && <button type="button" className="h-link" onClick={stop}>Cancel loading</button>}
    {error && <span role="alert">{error} · Retry loading.</span>}
  </div>;
}
