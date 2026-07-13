import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import type { FileDiffMetadata } from '@pierre/diffs';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { ParsedDiff } from '../components/Diff';
import { Icon, type IconName } from '../components/Icon';
import { renderMarkdown } from '../lib/markdown';
import { checkTone, diffStats, markdownUrl, parsePullRequestPatch } from '../lib/pullRequests';
import { errMessage, tauri } from '../lib/tauri';
import type { PullRequest, PullRequestCheck, PullRequestList } from '../lib/types';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';

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

function CheckStatus({ check }: { check: PullRequestCheck }) {
  const tone = checkTone(check.status);
  const icon: IconName = tone === 'success' ? 'check' : tone === 'failed' ? 'x' : tone === 'running' ? 'refresh' : 'circle';
  return (
    <strong className={`pr-check-status ${tone}`}>
      <Icon name={icon} size={12} className={tone === 'running' ? 'spin' : undefined} />
      {check.status.toLowerCase()}
    </strong>
  );
}

function ProviderMarkdown({ source, baseUrl }: { source: string; baseUrl?: string }) {
  return (
    <div className="markdown">
      {renderMarkdown(source, {
        onLinkClick: (href) => {
          const url = markdownUrl(href, baseUrl);
          if (url) void shellOpen(url);
        },
        // PR content is untrusted and should not trigger silent remote image
        // requests. Keep the alt text readable; the full content stays on host.
        renderImage: (_src, alt, key) => (
          <span className="markdown-image" key={key}>[Image: {alt || 'attachment'}]</span>
        ),
      })}
    </div>
  );
}

function PullRequestOverview({ pr }: { pr: PullRequest }) {
  return (
    <div className="pr-tab-scroll">
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
          ? <ProviderMarkdown source={pr.description} baseUrl={pr.url} />
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
              <li key={`${check.name}:${index}`}><span>{check.name}</span><CheckStatus check={check} /></li>
            ))}
          </ul>
        ) : <p className="pr-muted">No checks reported.</p>}
      </section>
    </div>
  );
}

function PullRequestConversation({
  path,
  pr,
  onUpdated,
}: {
  path: string;
  pr: PullRequest;
  onUpdated: (next: PullRequest) => void;
}) {
  const platform = useSettings((state) => state.platform);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const submit = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    setMessage(null);
    let posted = false;
    try {
      await tauri.repoPullRequestComment(path, pr.id, body);
      posted = true;
      setDraft('');
      const next = await tauri.repoPullRequest(path, pr.id);
      onUpdated(next);
      setMessage({ tone: 'ok', text: 'Comment added.' });
    } catch (caught) {
      setMessage({
        tone: 'error',
        text: posted
          ? `Comment was added, but the discussion could not refresh: ${errMessage(caught)}`
          : errMessage(caught),
      });
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="pr-tab-scroll pr-conversation">
      <form
        className="pr-comment-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={`pr-comment-${pr.id}`}>Add a comment</label>
        <textarea
          id={`pr-comment-${pr.id}`}
          value={draft}
          maxLength={65_536}
          rows={4}
          placeholder="Write a Markdown comment…"
          disabled={posting}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="pr-comment-actions">
          <span>Markdown supported · {platform === 'mac' ? '⌘' : 'Ctrl'}+Enter to send</span>
          <button type="submit" className="btn" disabled={posting || !draft.trim()}>
            {posting ? 'Adding…' : 'Add comment'}
          </button>
        </div>
        {message && <p className={`pr-comment-message ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}
      </form>

      <section className="pr-comments" aria-label="Pull request comments">
        {pr.comments.length > 0 ? pr.comments.map((comment) => (
          <article className={`pr-comment${comment.is_system ? ' system' : ''}`} key={comment.id}>
            <header>
              <strong>{comment.author}</strong>
              {comment.path && <code>{comment.path}</code>}
              {comment.is_system && <span>system</span>}
              <time dateTime={comment.created_at}>{dateLabel(comment.created_at)}</time>
            </header>
            <ProviderMarkdown source={comment.body} baseUrl={comment.url || pr.url} />
          </article>
        )) : <p className="pr-muted">No comments yet.</p>}
      </section>
    </div>
  );
}

function fileState(file: FileDiffMetadata): string {
  if (file.type === 'new') return 'A';
  if (file.type === 'deleted') return 'D';
  if (file.type.startsWith('rename')) return 'R';
  return 'M';
}

function PullRequestChanges({ path, pr }: { path: string; pr: PullRequest }) {
  const diffMode = useSettings((state) => state.diffMode);
  const [patch, setPatch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    void tauri.repoPullRequestDiff(path, pr.id).then(
      (next) => {
        if (generation.current === current) setPatch(next);
      },
      (caught) => {
        if (generation.current === current) setError(errMessage(caught));
      },
    ).finally(() => {
      if (generation.current === current) setLoading(false);
    });
    return () => { generation.current += 1; };
  }, [path, pr.id, reload]);

  const parsed = useMemo(() => {
    if (patch == null) return { files: [] as FileDiffMetadata[], error: null as string | null };
    try {
      return { files: parsePullRequestPatch(patch), error: null };
    } catch (caught) {
      return { files: [] as FileDiffMetadata[], error: errMessage(caught) };
    }
  }, [patch]);
  const files = parsed.files;
  const selectedFile = files[selected] ?? null;

  useEffect(() => {
    if (selected >= files.length) setSelected(Math.max(0, files.length - 1));
  }, [files.length, selected]);

  const move = (delta: number) => {
    if (!files.length) return;
    const next = Math.min(files.length - 1, Math.max(0, selected + delta));
    setSelected(next);
    document.getElementById(`pr-file-${pr.id}-${next}`)?.scrollIntoView({ block: 'nearest' });
  };

  if (loading) {
    return <div className="pr-empty pr-tab-empty" aria-live="polite"><Icon name="refresh" size={24} className="spin" /><strong>Loading code changes…</strong></div>;
  }
  if (error || parsed.error) {
    return (
      <div className="pr-empty pr-tab-empty" role="alert">
        <Icon name="changes" size={24} />
        <strong>Could not load code changes</strong>
        <p>{error || `The provider patch could not be parsed: ${parsed.error}`}</p>
        <button type="button" className="btn" onClick={() => setReload((value) => value + 1)}>Try again</button>
      </div>
    );
  }
  if (!files.length) {
    return <div className="pr-empty pr-tab-empty"><Icon name="check" size={24} /><strong>No textual changes</strong><p>The provider returned no renderable patch for this pull request.</p></div>;
  }

  return (
    <div className="pr-changes">
      <PanelGroup direction="horizontal" autoSaveId="strand:pull-request-changes">
        <Panel defaultSize={28} minSize={18} maxSize={48}>
          <div
            className="pr-file-list"
            role="listbox"
            aria-label="Changed files"
            aria-activedescendant={`pr-file-${pr.id}-${selected}`}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'j') { event.preventDefault(); move(1); }
              else if (event.key === 'ArrowUp' || event.key === 'k') { event.preventDefault(); move(-1); }
              else if (event.key === 'Home') { event.preventDefault(); setSelected(0); }
              else if (event.key === 'End') { event.preventDefault(); setSelected(files.length - 1); }
            }}
          >
            <div className="pr-file-count">{files.length} changed {files.length === 1 ? 'file' : 'files'}</div>
            {files.map((file, index) => {
              const stats = diffStats(file);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  id={`pr-file-${pr.id}-${index}`}
                  key={`${file.prevName || ''}:${file.name}:${index}`}
                  className={`pr-file-row${index === selected ? ' selected' : ''}`}
                  onClick={() => setSelected(index)}
                >
                  <span className={`pr-file-state ${file.type}`}>{fileState(file)}</span>
                  <span className="pr-file-name" title={file.name}>{file.name}</span>
                  <span className="pr-file-stats"><b>+{stats.additions}</b><i>−{stats.deletions}</i></span>
                </button>
              );
            })}
          </div>
        </Panel>
        <PanelResizeHandle className="rs-handle vert" />
        <Panel minSize={35}>
          <div className="pr-diff-scroll">
            {selectedFile && <ParsedDiff fileDiff={selectedFile} layout={diffMode === 'split' ? 'split' : 'unified'} />}
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

type DetailTab = 'overview' | 'conversation' | 'changes';
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'changes', label: 'Changes' },
];

function PullRequestDetails({
  path,
  pr,
  onUpdated,
}: {
  path: string;
  pr: PullRequest;
  onUpdated: (next: PullRequest) => void;
}) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const open = () => { if (pr.url) void shellOpen(pr.url); };
  const selectTab = (next: DetailTab) => {
    setTab(next);
    document.getElementById(`pr-tab-${pr.id}-${next}`)?.focus();
  };
  const tabIndex = DETAIL_TABS.findIndex((item) => item.id === tab);

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

      <div
        className="pr-detail-tabs"
        role="tablist"
        aria-label="Pull request details"
        onKeyDown={(event) => {
          let next = tabIndex;
          if (event.key === 'ArrowRight') next = (tabIndex + 1) % DETAIL_TABS.length;
          else if (event.key === 'ArrowLeft') next = (tabIndex - 1 + DETAIL_TABS.length) % DETAIL_TABS.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = DETAIL_TABS.length - 1;
          else return;
          event.preventDefault();
          selectTab(DETAIL_TABS[next].id);
        }}
      >
        {DETAIL_TABS.map((item) => {
          const count = item.id === 'conversation' ? pr.comment_count : item.id === 'changes' ? pr.changed_files : null;
          return (
            <button
              type="button"
              role="tab"
              id={`pr-tab-${pr.id}-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`pr-panel-${pr.id}-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              key={item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label}{count != null ? <span>{count}</span> : null}
            </button>
          );
        })}
      </div>

      <div
        className={`pr-tab-panel ${tab}`}
        role="tabpanel"
        id={`pr-panel-${pr.id}-${tab}`}
        aria-labelledby={`pr-tab-${pr.id}-${tab}`}
      >
        {tab === 'overview' && <PullRequestOverview pr={pr} />}
        {tab === 'conversation' && <PullRequestConversation path={path} pr={pr} onUpdated={onUpdated} />}
        {tab === 'changes' && <PullRequestChanges path={path} pr={pr} />}
      </div>
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
                  <button type="button" className="btn" onClick={() => setDetailReload((value) => value + 1)}>Try again</button>
                </div>
              ) : detail && path ? (
                <PullRequestDetails
                  key={`${path}:${detail.id}`}
                  path={path}
                  pr={detail}
                  onUpdated={setDetail}
                />
              ) : null}
            </Panel>
          </PanelGroup>
        </div>
      ) : null}
    </div>
  );
}
