import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { Icon } from '../components/Icon';
import { useRepo } from '../stores/repo';
import { errMessage, tauri } from '../lib/tauri';
import type { PullRequest, PullRequestList } from '../lib/types';

const providerName = (provider: PullRequestList['repository']['provider']) =>
  provider === 'git_hub' ? 'GitHub' : 'Azure DevOps';

function displayState(pr: PullRequest): string {
  if (pr.is_draft) return 'draft';
  if (pr.state === 'active') return 'open';
  if (pr.state === 'completed') return 'merged';
  if (pr.state === 'abandoned') return 'closed';
  return pr.state;
}

function dateLabel(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function PullRequestDetails({ pr }: { pr: PullRequest }) {
  const open = () => { if (pr.url) void shellOpen(pr.url); };
  return (
    <article className="pr-detail" aria-label={`Pull request ${pr.id}: ${pr.title}`}>
      <header className="pr-detail-head">
        <div>
          <div className="pr-detail-kicker">#{pr.id} · {pr.author}</div>
          <h2>{pr.title}</h2>
        </div>
        <button type="button" className="btn" onClick={open} disabled={!pr.url}>
          <Icon name="external" size={13} /> Open on host
        </button>
      </header>

      <div className="pr-pills" aria-label="Pull request status">
        <span className={`pr-state ${displayState(pr)}`}>{displayState(pr)}</span>
        {pr.review_status && <span>{pr.review_status.toLowerCase()}</span>}
        {pr.merge_status && <span>{pr.merge_status.toLowerCase()}</span>}
      </div>

      <dl className="pr-meta-grid">
        <div><dt>Branches</dt><dd><code>{pr.source_branch}</code> → <code>{pr.target_branch}</code></dd></div>
        <div><dt>Created</dt><dd>{dateLabel(pr.created_at) || 'Not reported'}</dd></div>
        <div><dt>Updated</dt><dd>{dateLabel(pr.updated_at) || 'Not reported'}</dd></div>
        <div><dt>Changes</dt><dd>{[
          pr.changed_files != null ? `${pr.changed_files} files` : null,
          pr.additions != null ? `+${pr.additions}` : null,
          pr.deletions != null ? `−${pr.deletions}` : null,
        ].filter(Boolean).join(' · ') || 'Not reported'}</dd></div>
        <div><dt>Discussion</dt><dd>{pr.comment_count} comments · {pr.commit_count} commits</dd></div>
      </dl>

      {pr.labels.length > 0 && (
        <section className="pr-detail-section">
          <h3>Labels</h3>
          <div className="pr-pills">{pr.labels.map((label) => <span key={label}>{label}</span>)}</div>
        </section>
      )}

      <section className="pr-detail-section">
        <h3>Description</h3>
        {pr.description
          ? <pre className="pr-description">{pr.description}</pre>
          : <p className="pr-muted">No description.</p>}
      </section>

      <section className="pr-detail-section">
        <h3>Reviewers</h3>
        {pr.reviewers.length > 0 ? (
          <ul className="pr-facts">
            {pr.reviewers.map((reviewer, index) => (
              <li key={`${reviewer.name}:${index}`}>
                <span>{reviewer.name}{reviewer.required ? ' · required' : ''}</span>
                <strong>{reviewer.status.toLowerCase()}</strong>
              </li>
            ))}
          </ul>
        ) : <p className="pr-muted">No reviewers reported.</p>}
      </section>

      <section className="pr-detail-section">
        <h3>Checks</h3>
        {pr.checks.length > 0 ? (
          <ul className="pr-facts">
            {pr.checks.map((check, index) => (
              <li key={`${check.name}:${index}`}><span>{check.name}</span><strong>{check.status.toLowerCase()}</strong></li>
            ))}
          </ul>
        ) : <p className="pr-muted">No checks reported.</p>}
      </section>
    </article>
  );
}

export function PullRequests() {
  const path = useRepo((state) => state.activePath);
  const [data, setData] = useState<PullRequestList | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PullRequest | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const detailGeneration = useRef(0);

  const refresh = useCallback(async () => {
    if (!path) return;
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await tauri.repoPullRequests(path);
      if (generation.current !== current) return;
      setData(next);
      setSelectedId((selected) =>
        next.pull_requests.some((pr) => pr.id === selected)
          ? selected
          : (next.pull_requests[0]?.id ?? null));
    } catch (caught) {
      if (generation.current !== current) return;
      setData(null);
      setSelectedId(null);
      setError(errMessage(caught));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
      detailGeneration.current += 1;
    };
  }, [refresh]);

  const selectedSummary = useMemo(
    () => data?.pull_requests.find((pr) => pr.id === selectedId) ?? null,
    [data, selectedId],
  );

  useEffect(() => {
    if (!path || selectedId == null || !data) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    const current = ++detailGeneration.current;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    // Avoid spawning one provider CLI per key-repeat while the user walks the
    // list; only the row they settle on pays for a rich-detail request.
    const timer = window.setTimeout(() => {
      void tauri.repoPullRequest(path, selectedId).then(
        (next) => {
          if (detailGeneration.current === current) setDetail(next);
        },
        (caught) => {
          if (detailGeneration.current === current) setDetailError(errMessage(caught));
        },
      ).finally(() => {
        if (detailGeneration.current === current) setDetailLoading(false);
      });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      detailGeneration.current += 1;
    };
  }, [path, selectedId, data, detailReload]);

  const move = (delta: number) => {
    if (!data?.pull_requests.length) return;
    const index = Math.max(0, data.pull_requests.findIndex((pr) => pr.id === selectedId));
    const next = Math.min(data.pull_requests.length - 1, Math.max(0, index + delta));
    setSelectedId(data.pull_requests[next].id);
    document.getElementById(`pr-row-${data.pull_requests[next].id}`)?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <div className="pr-view">
      <div className="pr-toolbar">
        <div>
          <strong>Pull Requests</strong>
          {data && <span>{providerName(data.repository.provider)} · {data.repository.label} · {data.repository.remote}</span>}
        </div>
        <button type="button" className="h-link" onClick={() => void refresh()} disabled={loading}>
          <Icon name="refresh" size={12} className={loading ? 'spin' : ''} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <div className="pr-empty" role="alert">
          <Icon name="remote" size={28} />
          <strong>Pull requests are not available yet</strong>
          <p>{error}</p>
          <span>Strand uses the signed-in provider CLI so it never stores your access token.</span>
          <button type="button" className="btn" onClick={() => void refresh()}>Try again</button>
        </div>
      ) : loading && !data ? (
        <div className="pr-empty" aria-live="polite"><Icon name="refresh" size={28} className="spin" /><strong>Loading pull requests…</strong></div>
      ) : data && data.pull_requests.length === 0 ? (
        <div className="pr-empty"><Icon name="check" size={28} /><strong>No pull requests found</strong><p>This repository has no open, closed, or merged pull requests in the latest 100.</p></div>
      ) : data ? (
        <div className="pr-main">
          <PanelGroup direction="horizontal" autoSaveId="strand:pull-requests">
            <Panel defaultSize={34} minSize={22} maxSize={55}>
              <div
                className="pr-list"
                role="listbox"
                aria-label="Pull requests"
                aria-activedescendant={selectedId != null ? `pr-row-${selectedId}` : undefined}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); move(1); }
                  else if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); move(-1); }
                  else if (event.key === 'Home') { event.preventDefault(); setSelectedId(data.pull_requests[0]?.id ?? null); }
                  else if (event.key === 'End') { event.preventDefault(); setSelectedId(data.pull_requests.at(-1)?.id ?? null); }
                  else if (event.key === 'Enter' && selectedSummary?.url) { event.preventDefault(); void shellOpen(selectedSummary.url); }
                }}
              >
                {data.pull_requests.map((pr) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={pr.id === selectedId}
                    id={`pr-row-${pr.id}`}
                    key={pr.id}
                    tabIndex={-1}
                    className={`pr-row${pr.id === selectedId ? ' selected' : ''}`}
                    onClick={() => setSelectedId(pr.id)}
                    onDoubleClick={() => { if (pr.url) void shellOpen(pr.url); }}
                  >
                    <span className="pr-row-top"><b>#{pr.id}</b><span className={`pr-state ${displayState(pr)}`}>{displayState(pr)}</span></span>
                    <strong>{pr.title}</strong>
                    <span className="pr-row-meta">{pr.author} · {pr.source_branch} → {pr.target_branch}</span>
                  </button>
                ))}
              </div>
            </Panel>
            <PanelResizeHandle className="rs-handle vert" />
            <Panel minSize={35}>
              {detailLoading ? (
                <div className="pr-empty pr-detail-empty" aria-live="polite">
                  <Icon name="refresh" size={24} className="spin" />
                  <strong>Loading PR #{selectedId}…</strong>
                </div>
              ) : detailError ? (
                <div className="pr-empty pr-detail-empty" role="alert">
                  <Icon name="remote" size={24} />
                  <strong>Could not load PR #{selectedId}</strong>
                  <p>{detailError}</p>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setDetailReload((value) => value + 1)}
                  >
                    Try again
                  </button>
                </div>
              ) : detail ? <PullRequestDetails pr={detail} /> : null}
            </Panel>
          </PanelGroup>
        </div>
      ) : null}
    </div>
  );
}
