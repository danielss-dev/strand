import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { pageKey } from '../lib/pullRequestPages';
import { errMessage, tauri } from '../lib/tauri';
import type { PullRequest, PullRequestDataPage, PullRequestPageCursor } from '../lib/types';

type Page = PullRequestPageCursor;
const labels: Record<Page['kind'], string> = {
  checks: 'checks', reviews: 'reviews', comments: 'comments', commits: 'commits', threads: 'review threads', replies: 'replies',
};
const Pages = createContext<{
  pages: Page[]; busy: string | null; error: { key: string; text: string } | null;
  load: (page: Page) => Promise<void>; stop: () => void;
} | null>(null);

/** One request owner per PR, shared by the controls in its content sections. */
export function PullRequestPages({ path, pr, onPage, children }: {
  path: string; pr: PullRequest; onPage: (page: PullRequestDataPage) => void; children: ReactNode;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const request = useRef<string | null>(null);
  const stop = useCallback(() => {
    if (request.current) void tauri.repoPullRequestCancelRead(request.current).catch(() => {});
    request.current = null; setBusy(null);
  }, []);
  useEffect(() => { setError(null); return stop; }, [path, pr.id, pr.source_commit, stop]);
  const load = useCallback(async (page: Page) => {
    if (request.current) return;
    const id = crypto.randomUUID(); request.current = id;
    const key = pageKey(page); setBusy(key); setError(null);
    try {
      const next = await tauri.repoPullRequestDataPage(path, pr.id, pr.source_commit, page, id);
      if (request.current === id) onPage(next);
    } catch (caught) {
      if (request.current === id) setError({ key, text: errMessage(caught) });
    } finally {
      if (request.current === id) { request.current = null; setBusy(null); }
    }
  }, [path, pr.id, pr.source_commit, onPage]);
  const next = pr.data_pages?.[0];
  useEffect(() => {
    const run = () => { if (next) void load(next); };
    window.addEventListener('strand:pull-request-load-more', run);
    window.addEventListener('strand:pull-request-cancel-read', stop);
    return () => {
      window.removeEventListener('strand:pull-request-load-more', run);
      window.removeEventListener('strand:pull-request-cancel-read', stop);
    };
  }, [load, next, stop]);
  return <Pages.Provider value={{ pages: pr.data_pages ?? [], busy, error, load, stop }}>{children}</Pages.Provider>;
}

export function PullRequestDataLoader({ kinds, threadId }: { kinds: Page['kind'][]; threadId?: string }) {
  const state = useContext(Pages);
  if (!state) return null;
  return <>{state.pages.filter(page => kinds.includes(page.kind) && (!threadId || page.thread_id === threadId)).map(page => {
    const key = pageKey(page);
    const loading = state.busy === key;
    const error = state.error?.key === key ? state.error.text : page.error;
    return <div className="pr-section-loader" key={key} role="status">
      <button type="button" className="h-link" disabled={!!state.busy} onClick={() => void state.load(page)}>
        {loading ? `Loading ${labels[page.kind]}…` : `Load more ${labels[page.kind]}`}
      </button>
      {loading && <button type="button" className="h-link" onClick={state.stop}>Cancel</button>}
      {error && <span role="alert">{error} Try loading again.</span>}
    </div>;
  })}</>;
}
