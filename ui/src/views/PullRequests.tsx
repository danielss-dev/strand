import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import type { GitStatusEntry } from '@pierre/trees';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { ParsedDiff } from '../components/Diff';
import { Icon, type IconName } from '../components/Icon';
import { PierreTree } from '../components/PierreTree';
import { applyCommentFormat, type CommentFormat } from '../lib/commentComposer';
import { renderMarkdown } from '../lib/markdown';
import {
  checkTone,
  diffStats,
  markdownUrl,
  parsePullRequestPatch,
  pullRequestReadiness,
  pullRequestForBranch,
  relativeTimeLabel,
} from '../lib/pullRequests';
import { pullRequestActivityChanged, pullRequestFollowKey } from '../lib/pullRequestActivity';
import { errMessage, tauri } from '../lib/tauri';
import { treeFileOrder } from '../lib/treeOrder';
import type { PullRequest, PullRequestActivitySnapshot, PullRequestCheck, PullRequestComment, PullRequestList, PullRequestReviewThread } from '../lib/types';
import { useRepo } from '../stores/repo';
import { usePullRequests } from '../stores/pullRequests';
import { useSettings } from '../stores/settings';
import { PullRequestMergeControl } from './PullRequestMergeControl';

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

function ProviderImage({ src, alt, baseUrl }: { src: string; alt: string; baseUrl?: string }) {
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = markdownUrl(src, baseUrl);
  if (!url) return <span className="markdown-image invalid">[Image unavailable: {alt || 'attachment'}]</span>;
  if (!visible || failed) {
    return (
      <span className="markdown-image">
        <button type="button" onClick={() => { setFailed(false); setVisible(true); }}>
          <Icon name="eye" size={13} />
          {failed ? 'Try image again' : `Show image${alt ? `: ${alt}` : ''}`}
        </button>
        <small>Loaded only when you choose to view it</small>
      </span>
    );
  }
  return (
    <span className="markdown-image loaded">
      <img src={url} alt={alt || 'Comment attachment'} onError={() => setFailed(true)} />
      {alt && <small>{alt}</small>}
    </span>
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
        // PR content is untrusted. Images stay inert until the user explicitly
        // reveals one, so opening a PR never leaks a remote request.
        renderImage: (src, alt, key) => <ProviderImage src={src} alt={alt} baseUrl={baseUrl} key={key} />,
      })}
    </div>
  );
}

const COMMENT_TOOLS: { format: CommentFormat; label: string; mark: string }[] = [
  { format: 'bold', label: 'Bold', mark: 'B' },
  { format: 'italic', label: 'Italic', mark: 'I' },
  { format: 'code', label: 'Code', mark: '<>' },
  { format: 'quote', label: 'Quote', mark: '❯' },
  { format: 'bullet-list', label: 'Bulleted list', mark: '•' },
  { format: 'numbered-list', label: 'Numbered list', mark: '1.' },
  { format: 'task-list', label: 'Task list', mark: '☑' },
  { format: 'link', label: 'Link', mark: '↗' },
  { format: 'image', label: 'Image or screenshot by URL', mark: '▧' },
];

function authorInitials(author: string): string {
  const words = author.trim().split(/[\s_-]+/).filter(Boolean);
  return (words.length > 1 ? words.slice(0, 2).map((word) => word[0]).join('') : author.slice(0, 2)).toUpperCase();
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
  onViewInChanges,
}: {
  path: string;
  pr: PullRequest;
  onUpdated: (next: PullRequest) => void;
  onViewInChanges: (comment: PullRequestComment) => void;
}) {
  const platform = useSettings((state) => state.platform);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectMode = (next: 'write' | 'preview') => {
    setMode(next);
    requestAnimationFrame(() => document.getElementById(`pr-comment-${pr.id}-${next}-tab`)?.focus());
  };

  const format = (kind: CommentFormat) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const edit = applyCommentFormat(draft, textarea.selectionStart, textarea.selectionEnd, kind);
    setDraft(edit.value);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    });
  };

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
        <div className="pr-composer-head">
          <label htmlFor={`pr-comment-${pr.id}`}>Add to the conversation</label>
          <div
            className="pr-composer-tabs"
            role="tablist"
            aria-label="Comment editor mode"
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              selectMode(mode === 'write' ? 'preview' : 'write');
            }}
          >
            <button
              type="button"
              role="tab"
              id={`pr-comment-${pr.id}-write-tab`}
              aria-controls={`pr-comment-${pr.id}-write-panel`}
              aria-selected={mode === 'write'}
              tabIndex={mode === 'write' ? 0 : -1}
              onClick={() => setMode('write')}
            >
              <Icon name="edit" size={12} /> Write
            </button>
            <button
              type="button"
              role="tab"
              id={`pr-comment-${pr.id}-preview-tab`}
              aria-controls={`pr-comment-${pr.id}-preview-panel`}
              aria-selected={mode === 'preview'}
              tabIndex={mode === 'preview' ? 0 : -1}
              onClick={() => setMode('preview')}
            >
              <Icon name="eye" size={12} /> Preview
            </button>
          </div>
        </div>
        <div className="pr-comment-editor">
          <div className="pr-comment-tools" role="toolbar" aria-label="Markdown formatting">
            {COMMENT_TOOLS.map((tool) => (
              <button
                type="button"
                key={tool.format}
                aria-label={tool.label}
                title={tool.label}
                disabled={posting || mode === 'preview'}
                onClick={() => format(tool.format)}
              >
                <span aria-hidden="true">{tool.mark}</span>
              </button>
            ))}
          </div>
          {mode === 'write' ? (
            <div
              className="pr-comment-write"
              role="tabpanel"
              id={`pr-comment-${pr.id}-write-panel`}
              aria-labelledby={`pr-comment-${pr.id}-write-tab`}
            >
              <textarea
                ref={textareaRef}
                id={`pr-comment-${pr.id}`}
                value={draft}
                maxLength={65_536}
                rows={6}
                placeholder="Leave a comment…"
                disabled={posting}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            </div>
          ) : (
            <div
              className="pr-comment-preview"
              role="tabpanel"
              id={`pr-comment-${pr.id}-preview-panel`}
              aria-labelledby={`pr-comment-${pr.id}-preview-tab`}
            >
              {draft.trim()
                ? <ProviderMarkdown source={draft} baseUrl={pr.url} />
                : <p className="pr-muted">Nothing to preview yet.</p>}
            </div>
          )}
        </div>
        <div className="pr-comment-actions">
          <div>
            <span>Markdown supported · Image URLs stay private until clicked</span>
            <span>{draft.length.toLocaleString()} / 65,536 · {platform === 'mac' ? '⌘' : 'Ctrl'}+Enter to send</span>
          </div>
          <button type="submit" className="btn" disabled={posting || !draft.trim()}>
            {posting ? 'Commenting…' : 'Comment'}
          </button>
        </div>
        {message && <p className={`pr-comment-message ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}
      </form>

      <section className="pr-comments" aria-label="Pull request comments">
        <div className="pr-comments-head">
          <h3>Conversation</h3>
          <span>{pr.comments.length} {pr.comments.length === 1 ? 'comment' : 'comments'}</span>
        </div>
        {pr.comments.length > 0 ? pr.comments.map((comment) => {
          const commentUrl = markdownUrl(comment.url, pr.url);
          const avatarUrl = markdownUrl(comment.avatar_url ?? undefined);
          return (
            <div className={`pr-comment-row${comment.is_system ? ' system' : ''}`} key={comment.id}>
              <div className="pr-comment-marker" aria-hidden="true">
                {comment.is_system
                  ? <Icon name="history" size={14} />
                  : (
                    <>
                      <span>{authorInitials(comment.author)}</span>
                      {avatarUrl && (
                        <img
                          src={avatarUrl}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          onError={(event) => { event.currentTarget.hidden = true; }}
                        />
                      )}
                    </>
                  )}
              </div>
              <article className="pr-comment">
                <header>
                  <div className="pr-comment-author">
                    <strong>{comment.author}</strong>
                    {comment.is_system && <span>system</span>}
                    {comment.path && <code>{comment.path}</code>}
                  </div>
                  <div className="pr-comment-links">
                    {comment.path && (
                      <button type="button" onClick={() => onViewInChanges(comment)} title="View this comment in Changes">
                        <Icon name="changes" size={11} />
                        View in changes
                      </button>
                    )}
                    {commentUrl ? (
                      <button type="button" onClick={() => void shellOpen(commentUrl)} title="Open this comment on host">
                        <time dateTime={comment.created_at}>{dateLabel(comment.created_at)}</time>
                        <Icon name="external" size={10} />
                      </button>
                    ) : <time dateTime={comment.created_at}>{dateLabel(comment.created_at)}</time>}
                  </div>
                </header>
                <div className="pr-comment-body">
                  <ProviderMarkdown source={comment.body} baseUrl={commentUrl || pr.url} />
                </div>
              </article>
            </div>
          );
        }) : <p className="pr-muted">No comments yet.</p>}
      </section>
    </div>
  );
}

function fileGitStatus(file: FileDiffMetadata): GitStatusEntry['status'] {
  if (file.type === 'new') return 'added';
  if (file.type === 'deleted') return 'deleted';
  if (file.type.startsWith('rename')) return 'renamed';
  return 'modified';
}

function PullRequestInlineThread({ thread, prUrl }: { thread: PullRequestReviewThread; prUrl: string }) {
  const lineLabel = thread.start_line === thread.end_line
    ? `${thread.end_line}`
    : `${thread.start_line}–${thread.end_line}`;
  return (
    <article
      id={`pr-review-thread-${thread.id}`}
      tabIndex={-1}
      className={`pr-inline-thread${thread.is_resolved ? ' resolved' : ''}${thread.is_outdated ? ' outdated' : ''}`}
    >
      <header>
        <strong>{thread.side === 'deletions' ? 'Old' : 'New'} line{thread.start_line === thread.end_line ? '' : 's'} {lineLabel}</strong>
        <div>
          {thread.is_resolved && <span>Resolved</span>}
          {thread.is_outdated && <span>Outdated</span>}
        </div>
      </header>
      {thread.comments.map((comment) => {
        const commentUrl = markdownUrl(comment.url, prUrl);
        const avatarUrl = markdownUrl(comment.avatar_url ?? undefined);
        return (
          <section className="pr-inline-thread-comment" key={comment.id}>
            <div className="pr-inline-thread-author">
              <span className="pr-inline-avatar" aria-hidden="true">
                {authorInitials(comment.author)}
                {avatarUrl && <img src={avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} />}
              </span>
              <strong>{comment.author}</strong>
              {commentUrl ? (
                <button type="button" onClick={() => void shellOpen(commentUrl)} title="Open this comment on host">
                  <time dateTime={comment.created_at}>{dateLabel(comment.created_at)}</time>
                  <Icon name="external" size={10} />
                </button>
              ) : <time dateTime={comment.created_at}>{dateLabel(comment.created_at)}</time>}
            </div>
            <ProviderMarkdown source={comment.body} baseUrl={commentUrl || prUrl} />
          </section>
        );
      })}
    </article>
  );
}

type InlineCommentAnnotation =
  | { kind: 'composer'; range: SelectedLineRange }
  | { kind: 'thread'; thread: PullRequestReviewThread };

type PullRequestChangesTarget = {
  path: string;
  threadId: string | null;
  requestId: number;
};

function PullRequestChanges({
  path,
  provider,
  pr,
  onUpdated,
  navigationTarget,
  onNavigationComplete,
}: {
  path: string;
  provider: PullRequestList['repository']['provider'];
  pr: PullRequest;
  onUpdated: (next: PullRequest) => void;
  navigationTarget: PullRequestChangesTarget | null;
  onNavigationComplete: (requestId: number) => void;
}) {
  const diffMode = useSettings((state) => state.diffMode);
  const platform = useSettings((state) => state.platform);
  const setDiffMode = useRepo((state) => state.setDiffMode);
  const [patch, setPatch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [postingComment, setPostingComment] = useState(false);
  const [commentMessage, setCommentMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    void tauri.repoPullRequestDiff(path, pr.id).then(
      (next) => {
        if (generation.current === current) {
          setPatch(next);
          setError(null);
        }
      },
      (caught) => {
        if (generation.current === current) setError(errMessage(caught));
      },
    ).finally(() => {
      if (generation.current === current) setLoading(false);
    });
    return () => { generation.current += 1; };
  }, [path, pr.id, pr.source_commit, reload]);

  const parsed = useMemo(() => {
    if (patch == null) return { files: [] as FileDiffMetadata[], error: null as string | null };
    try {
      return { files: parsePullRequestPatch(patch), error: null };
    } catch (caught) {
      return { files: [] as FileDiffMetadata[], error: errMessage(caught) };
    }
  }, [patch]);
  const files = parsed.files;
  const filesByPath = useMemo(() => new Map(files.map((file) => [file.name, file])), [files]);
  const treePaths = useMemo(() => treeFileOrder(files.map((file) => file.name)), [files]);
  const treeStatus = useMemo<GitStatusEntry[]>(
    () => files.map((file) => ({ path: file.name, status: fileGitStatus(file) })),
    [files],
  );
  const selectedFile = selectedPath ? filesByPath.get(selectedPath) ?? null : null;
  const selectedStats = selectedFile ? diffStats(selectedFile) : null;
  const selectedThreads = useMemo(
    () => selectedFile ? (pr.review_threads ?? []).filter((thread) => thread.path === selectedFile.name) : [],
    [pr.review_threads, selectedFile],
  );

  useEffect(() => {
    setSelectedPath((current) => {
      if (navigationTarget && filesByPath.has(navigationTarget.path)) return navigationTarget.path;
      return current && filesByPath.has(current) ? current : treePaths[0] ?? null;
    });
  }, [filesByPath, navigationTarget, treePaths]);

  useEffect(() => {
    if (!navigationTarget || navigationTarget.path !== selectedPath) return;
    const frame = requestAnimationFrame(() => {
      const threadTarget = navigationTarget.threadId
        ? document.getElementById(`pr-review-thread-${navigationTarget.threadId}`)
        : null;
      const target = threadTarget ?? document.getElementById(`pr-diff-file-${pr.id}`);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
      onNavigationComplete(navigationTarget.requestId);
    });
    return () => cancelAnimationFrame(frame);
  }, [navigationTarget, onNavigationComplete, pr.id, selectedPath]);

  useEffect(() => {
    setCollapsed(false);
    setSelectedLines(null);
    setCommentDraft('');
    setCommentMessage(null);
  }, [selectedPath]);

  const stalePatch = patch != null && (loading || error != null);
  const openForReview = pr.state === 'open' || pr.state === 'active';
  const inlineCommentsSupported = provider === 'git_hub' && openForReview && !stalePatch;
  const selectLines = useCallback((range: SelectedLineRange | null) => {
    if (!inlineCommentsSupported || !range) {
      setSelectedLines(null);
      return;
    }
    const startSide = range.side ?? 'additions';
    const endSide = range.endSide ?? startSide;
    if (startSide !== endSide) {
      setSelectedLines({ start: range.end, end: range.end, side: endSide, endSide });
      return;
    }
    setSelectedLines({
      start: Math.min(range.start, range.end),
      end: Math.max(range.start, range.end),
      side: startSide,
      endSide: startSide,
    });
    setCommentMessage(null);
  }, [inlineCommentsSupported]);

  const openInlineComment = useCallback((range: SelectedLineRange) => {
    selectLines(range);
    requestAnimationFrame(() => document.getElementById(`pr-inline-comment-${pr.id}`)?.focus());
  }, [pr.id, selectLines]);

  const inlineAnnotations = useMemo<DiffLineAnnotation<InlineCommentAnnotation>[]>(() => {
    const annotations: DiffLineAnnotation<InlineCommentAnnotation>[] = selectedThreads.map((thread) => ({
      side: thread.side,
      lineNumber: thread.end_line,
      metadata: { kind: 'thread' as const, thread },
    }));
    if (selectedLines) {
      const side = selectedLines.endSide ?? selectedLines.side ?? 'additions';
      annotations.push({
        side,
        lineNumber: selectedLines.end,
        metadata: { kind: 'composer' as const, range: selectedLines },
      });
    }
    return annotations;
  }, [selectedLines, selectedThreads]);

  const submitInlineComment = async () => {
    if (!selectedFile || !selectedLines || postingComment || stalePatch) return;
    const body = commentDraft.trim();
    if (!body) return;
    const side = selectedLines.side ?? 'additions';
    setPostingComment(true);
    setCommentMessage(null);
    let posted = false;
    try {
      await tauri.repoPullRequestInlineComment(
        path,
        pr.id,
        body,
        selectedFile.name,
        selectedLines.start,
        selectedLines.end,
        side,
        pr.source_commit,
      );
      posted = true;
      setCommentDraft('');
      setSelectedLines(null);
      const next = await tauri.repoPullRequest(path, pr.id);
      onUpdated(next);
      setCommentMessage({ tone: 'ok', text: 'Inline comment added.' });
    } catch (caught) {
      setCommentMessage({
        tone: 'error',
        text: posted
          ? `Comment was added, but the pull request could not refresh: ${errMessage(caught)}`
          : errMessage(caught),
      });
    } finally {
      setPostingComment(false);
    }
  };

  const move = (delta: number) => {
    if (!treePaths.length) return;
    const current = selectedPath ? treePaths.indexOf(selectedPath) : -1;
    const next = Math.min(treePaths.length - 1, Math.max(0, current + delta));
    setSelectedPath(treePaths[next]);
  };

  if (loading && patch == null) {
    return <div className="pr-empty pr-tab-empty" aria-live="polite"><Icon name="refresh" size={24} className="spin" /><strong>Loading code changes…</strong></div>;
  }
  if ((error && patch == null) || parsed.error) {
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
      {stalePatch && (
        <div className={`pr-inline-refresh${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
          <Icon name={error ? 'x' : 'refresh'} size={12} className={loading ? 'spin' : undefined} />
          <span>{error ? `Could not update changes: ${error}` : 'Updating changes for the latest push…'}</span>
          {error && <button type="button" className="h-link" onClick={() => setReload((value) => value + 1)}>Retry</button>}
        </div>
      )}
      <PanelGroup direction="horizontal" autoSaveId="strand:pull-request-changes-v2">
        <Panel defaultSize={22} minSize={14} maxSize={36}>
          <div
            className="pr-file-tree"
            aria-label="Changed files"
            onKeyDown={(event) => {
              if (event.key === 'j') { event.preventDefault(); move(1); }
              else if (event.key === 'k') { event.preventDefault(); move(-1); }
            }}
          >
            <div className="pr-file-count">{files.length} changed {files.length === 1 ? 'file' : 'files'}</div>
            <PierreTree
              paths={treePaths}
              gitStatus={treeStatus}
              selectedPath={selectedPath}
              followFocus
              onSelect={(next) => {
                if (!next) setSelectedPath(null);
                else if (filesByPath.has(next)) setSelectedPath(next);
              }}
              emptyLabel="No changed files."
            />
          </div>
        </Panel>
        <PanelResizeHandle className="rs-handle vert" />
        <Panel minSize={35}>
          <div className="pr-diff-scroll">
            {selectedFile && (
              <>
                <div className="pr-diff-header">
                  <button
                    type="button"
                    id={`pr-diff-file-${pr.id}`}
                    className="lc-hunkfile pr-file-toggle"
                    onClick={() => setCollapsed((value) => !value)}
                    aria-expanded={!collapsed}
                    title={collapsed ? 'Expand diff' : 'Collapse diff'}
                  >
                    <Icon name={collapsed ? 'chev-right' : 'chev-down'} size={12} className="chev" />
                    <span className="path">{selectedFile.name}</span>
                    <span className="stat-del">−{selectedStats?.deletions ?? 0}</span>
                    <span className="stat-add">+{selectedStats?.additions ?? 0}</span>
                  </button>
                  <div className="pr-diff-tools" aria-label="Diff view controls">
                    <button
                      type="button"
                      className={'icon-btn' + (diffMode === 'stacked' ? ' on' : '')}
                      onClick={() => setDiffMode('stacked')}
                      title="Stacked (unified)"
                      aria-label="Stacked (unified) diff view"
                      aria-pressed={diffMode === 'stacked'}
                    >
                      <Icon name="unified" size={13} />
                    </button>
                    <button
                      type="button"
                      className={'icon-btn' + (diffMode === 'split' ? ' on' : '')}
                      onClick={() => setDiffMode('split')}
                      title="Split (side-by-side)"
                      aria-label="Split (side-by-side) diff view"
                      aria-pressed={diffMode === 'split'}
                    >
                      <Icon name="split" size={13} />
                    </button>
                  </div>
                </div>
                {commentMessage && (
                  <div className={`pr-inline-message ${commentMessage.tone}`} role={commentMessage.tone === 'error' ? 'alert' : 'status'}>
                    {commentMessage.text}
                  </div>
                )}
                {!collapsed && (
                  <ParsedDiff<InlineCommentAnnotation>
                    fileDiff={selectedFile}
                    layout={diffMode === 'split' ? 'split' : 'unified'}
                    hideFileHeader
                    className="pr-review-diff"
                    selectedLines={selectedLines}
                    lineAnnotations={inlineAnnotations}
                    onLineSelected={inlineCommentsSupported ? selectLines : undefined}
                    onGutterUtilityClick={inlineCommentsSupported ? openInlineComment : undefined}
                    renderAnnotation={(annotation) => annotation.metadata.kind === 'thread' ? (
                      <PullRequestInlineThread thread={annotation.metadata.thread} prUrl={pr.url} />
                    ) : selectedLines ? (
                      <form
                        className="pr-inline-composer"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void submitInlineComment();
                        }}
                      >
                        <div className="pr-inline-composer-head">
                          <strong>
                            {selectedFile.name} · {selectedLines.side === 'deletions' ? 'old' : 'new'} line{selectedLines.start === selectedLines.end ? '' : 's'}{' '}
                            {selectedLines.start === selectedLines.end ? selectedLines.start : `${selectedLines.start}–${selectedLines.end}`}
                          </strong>
                          <button type="button" className="icon-btn" onClick={() => setSelectedLines(null)} aria-label="Cancel inline comment" title="Cancel">
                            <Icon name="x" size={12} />
                          </button>
                        </div>
                        <textarea
                          id={`pr-inline-comment-${pr.id}`}
                          value={commentDraft}
                          onChange={(event) => setCommentDraft(event.target.value)}
                          placeholder="Leave a comment on these lines…"
                          rows={3}
                          maxLength={65_536}
                          disabled={postingComment}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                              event.preventDefault();
                              void submitInlineComment();
                            }
                          }}
                        />
                        <div className="pr-inline-actions">
                          <span>{commentDraft.length.toLocaleString()} / 65,536 · {platform === 'mac' ? '⌘' : 'Ctrl'}+Enter</span>
                          <button type="submit" className="btn primary" disabled={!commentDraft.trim() || postingComment}>
                            {postingComment ? 'Adding…' : 'Add comment'}
                          </button>
                        </div>
                      </form>
                    ) : null}
                  />
                )}
              </>
            )}
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
  provider,
  pr,
  onUpdated,
  onToast,
  followed,
  notificationPermission,
  onToggleFollow,
}: {
  path: string;
  provider: PullRequestList['repository']['provider'];
  pr: PullRequest;
  onUpdated: (next: PullRequest) => void;
  onToast: (message: string, kind?: 'success' | 'error') => void;
  followed: boolean;
  notificationPermission: 'unknown' | 'granted' | 'denied';
  onToggleFollow: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const [changesTarget, setChangesTarget] = useState<PullRequestChangesTarget | null>(null);
  const changesRequest = useRef(0);
  const open = () => { if (pr.url) void shellOpen(pr.url); };
  const selectTab = (next: DetailTab) => {
    setTab(next);
    document.getElementById(`pr-tab-${pr.id}-${next}`)?.focus();
  };
  const tabIndex = DETAIL_TABS.findIndex((item) => item.id === tab);
  const readiness = pullRequestReadiness(pr, provider);
  const readinessIcon: IconName = readiness.tone === 'ready'
    ? 'check'
    : readiness.tone === 'blocked'
      ? 'x'
      : readiness.tone === 'pending'
        ? 'history'
        : 'circle';
  const checksLabel = readiness.checks.total > 0
    ? `${readiness.checks.passed}/${readiness.checks.total} checks passed`
    : 'No checks reported';
  const mergeDisabledReason = pr.is_draft
    ? 'Mark this pull request ready before merging'
    : !['open', 'active'].includes(pr.state)
      ? 'Only an open pull request can be merged'
      : !pr.source_commit
        ? 'Refresh this pull request before merging'
        : '';
  const viewCommentInChanges = (comment: PullRequestComment) => {
    if (!comment.path) return;
    const thread = (pr.review_threads ?? []).find((candidate) =>
      candidate.comments.some((item) => item.id === comment.id));
    changesRequest.current += 1;
    setChangesTarget({
      path: comment.path,
      threadId: thread?.id ?? null,
      requestId: changesRequest.current,
    });
    setTab('changes');
  };
  const completeChangesNavigation = useCallback((requestId: number) => {
    setChangesTarget((current) => current?.requestId === requestId ? null : current);
  }, []);

  return (
    <article className="pr-detail" aria-label={`Pull request ${pr.id}: ${pr.title}`}>
      <header className="pr-detail-head">
        <div>
          <div className="pr-detail-kicker">#{pr.id} · {pr.author}</div>
          <h2>{pr.title}</h2>
        </div>
        <div className="pr-detail-actions">
          <button
            type="button"
            className={`btn pr-follow${followed ? ' on' : ''}`}
            aria-pressed={followed}
            onClick={onToggleFollow}
            title={followed ? 'Stop following this pull request' : 'Follow this pull request'}
          >
            <Icon name="bell" size={13} /> {followed ? 'Following' : 'Follow'}
          </button>
          <PullRequestMergeControl
            path={path}
            provider={provider}
            pr={pr}
            disabledReason={mergeDisabledReason}
            onMerged={onUpdated}
            onToast={onToast}
          />
          <button type="button" className="btn" onClick={open} disabled={!pr.url}>
            <Icon name="external" size={13} /> Open on host
          </button>
        </div>
      </header>

      <div className={`pr-readiness ${readiness.tone}`} aria-label="Pull request readiness">
        <div className="pr-readiness-main">
          <span className="pr-readiness-icon" aria-hidden="true">
            <Icon name={readinessIcon} size={14} />
          </span>
          <span className={`pr-state ${displayState(pr)}`}>{displayState(pr)}</span>
          <span>
            <strong>{readiness.label}</strong>
            <small>{readiness.summary}</small>
          </span>
        </div>
        <div className="pr-readiness-facts">
          <span><Icon name="check" size={11} /> {checksLabel}</span>
          <span><Icon name="eye" size={11} /> {readiness.reviewLabel}</span>
          <span title={dateLabel(pr.updated_at) || undefined}>
            <Icon name="history" size={11} /> Updated {relativeTimeLabel(pr.updated_at)}
          </span>
          {followed && notificationPermission === 'denied' && (
            <span className="pr-notification-warning" title="Allow Strand notifications in system settings">
              <Icon name="bell" size={11} /> Notifications blocked
            </span>
          )}
        </div>
        {readiness.details.length > 0 && (
          <details className="pr-readiness-details">
            <summary>{readiness.details.length} status {readiness.details.length === 1 ? 'detail' : 'details'}</summary>
            <ul>
              {readiness.details.map((detail) => <li key={detail}>{detail}</li>)}
            </ul>
          </details>
        )}
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
        {tab === 'conversation' && (
          <PullRequestConversation
            path={path}
            pr={pr}
            onUpdated={onUpdated}
            onViewInChanges={viewCommentInChanges}
          />
        )}
        {tab === 'changes' && (
          <PullRequestChanges
            path={path}
            provider={provider}
            pr={pr}
            onUpdated={onUpdated}
            navigationTarget={changesTarget}
            onNavigationComplete={completeChangesNavigation}
          />
        )}
      </div>
    </article>
  );
}

export function PullRequests({
  onToast,
}: {
  onToast: (message: string, kind?: 'success' | 'error') => void;
}) {
  const path = useRepo((state) => state.activePath);
  const meta = useRepo((state) => state.meta);
  const currentBranch = meta && !meta.detached ? meta.branch : null;
  const followed = usePullRequests((state) => state.followed);
  const notificationPermission = usePullRequests((state) => state.permission);
  const activityRevision = usePullRequests((state) => state.activityRevision);
  const follow = usePullRequests((state) => state.follow);
  const unfollow = usePullRequests((state) => state.unfollow);
  const setActive = usePullRequests((state) => state.setActive);
  const clearActive = usePullRequests((state) => state.clearActive);
  const activity = usePullRequests((state) => state.activity);
  const pollFollowed = usePullRequests((state) => state.pollAll);
  const seedAfterProviderWrite = usePullRequests((state) => state.seedAfterProviderWrite);
  const [data, setData] = useState<PullRequestList | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [openedId, setOpenedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PullRequest | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const autoOpenedContext = useRef<string | null>(null);
  const visibleActivity = useRef<PullRequestActivitySnapshot | null>(null);

  const refresh = useCallback(async () => {
    if (!path) return;
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await tauri.repoPullRequests(path);
      if (generation.current !== current) return;
      const branchPullRequest = pullRequestForBranch(next.pull_requests, currentBranch);
      const preferredId = branchPullRequest?.id ?? next.pull_requests[0]?.id ?? null;
      const autoOpenContext = `${path}\0${currentBranch ?? '<detached>'}`;
      const shouldAutoOpen = autoOpenedContext.current !== autoOpenContext;
      setData(next);
      setSelectedId((selected) =>
        !shouldAutoOpen && next.pull_requests.some((pr) => pr.id === selected)
          ? selected
          : preferredId);
      setOpenedId((opened) =>
        next.pull_requests.some((pr) => pr.id === opened) ? opened : null);
      if (shouldAutoOpen) {
        autoOpenedContext.current = autoOpenContext;
        setOpenedId(branchPullRequest?.id ?? null);
      }
      setLastUpdatedAt(Date.now());
    } catch (caught) {
      if (generation.current !== current) return;
      setError(errMessage(caught));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [currentBranch, path]);

  useEffect(() => {
    setData(null);
    setSelectedId(null);
    setOpenedId(null);
    setDetail(null);
    setError(null);
    setDetailError(null);
    visibleActivity.current = null;
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
  const openedSummary = useMemo(
    () => data?.pull_requests.find((pr) => pr.id === openedId) ?? null,
    [data, openedId],
  );
  const openedKey = data && openedId != null
    ? pullRequestFollowKey(data.repository, openedId)
    : null;
  const openedFollowed = openedKey ? followed[openedKey] ?? null : null;
  const openedRevision = openedKey ? activityRevision[openedKey] ?? 0 : 0;
  const observedRevision = useRef(0);

  useEffect(() => {
    observedRevision.current = openedRevision;
  }, [openedKey]);

  useEffect(() => {
    if (!openedKey || openedRevision === observedRevision.current) return;
    observedRevision.current = openedRevision;
    setDetailReload((value) => value + 1);
  }, [openedKey, openedRevision]);

  useEffect(() => {
    const pr = detail ?? openedSummary;
    if (!path || !data || !pr) return;
    const key = pullRequestFollowKey(data.repository, pr.id);
    setActive(path, data.repository, pr);
    return () => clearActive(key);
  }, [clearActive, data, detail, openedSummary, path, setActive]);

  useEffect(() => {
    if (!path || !data || openedId == null || openedFollowed) {
      visibleActivity.current = null;
      return;
    }
    let cancelled = false;
    const revalidate = async () => {
      try {
        const next = await activity(path, openedId);
        if (cancelled) return;
        const previous = visibleActivity.current;
        visibleActivity.current = next;
        if (previous && pullRequestActivityChanged(previous, next)) {
          setDetailReload((value) => value + 1);
        }
      } catch {
        // Full-detail refresh keeps its own visible error state; background
        // activity failures do not replace or clear the current PR.
      }
    };
    void revalidate();
    const timer = window.setInterval(() => { void revalidate(); }, 60_000);
    const onFocus = () => { void revalidate(); };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [activity, data, openedFollowed, openedId, path]);

  useEffect(() => {
    if (openedId != null || !data) return;
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [data, openedId, refresh]);

  useEffect(() => {
    if (!path || openedId == null) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    const current = ++detailGeneration.current;
    setDetail((currentDetail) => currentDetail?.id === openedId ? currentDetail : null);
    setDetailError(null);
    setDetailLoading(true);
    // Briefly coalesce rapid pointer activation; keyboard list navigation does
    // not load details until Enter opens the selected PR.
    const timer = window.setTimeout(() => {
      void tauri.repoPullRequest(path, openedId).then(
        (next) => {
          if (detailGeneration.current === current) {
            setDetail(next);
            setDetailError(null);
            setLastUpdatedAt(Date.now());
          }
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
  }, [path, openedId, detailReload]);

  const move = (delta: number) => {
    if (!data?.pull_requests.length) return;
    const index = Math.max(0, data.pull_requests.findIndex((pr) => pr.id === selectedId));
    const next = Math.min(data.pull_requests.length - 1, Math.max(0, index + delta));
    setSelectedId(data.pull_requests[next].id);
    document.getElementById(`pr-row-${data.pull_requests[next].id}`)?.scrollIntoView({ block: 'nearest' });
  };

  const openPullRequest = (id: number) => {
    setSelectedId(id);
    setOpenedId(id);
  };

  const closePullRequest = () => {
    setOpenedId(null);
    window.requestAnimationFrame(() => document.getElementById('pr-listbox')?.focus());
  };

  const updatePullRequest = useCallback((next: PullRequest) => {
    setDetail(next);
    setData((current) => current ? {
      ...current,
      pull_requests: current.pull_requests.map((item) => item.id === next.id ? next : item),
    } : current);
    if (path && data) {
      const key = pullRequestFollowKey(data.repository, next.id);
      if (usePullRequests.getState().followed[key]) {
        void seedAfterProviderWrite(path, next.id).catch(() => {});
      }
    }
  }, [data, path, seedAfterProviderWrite]);

  const toggleFollow = useCallback(() => {
    if (!path || !data || !detail) return;
    const key = pullRequestFollowKey(data.repository, detail.id);
    if (followed[key]) {
      void unfollow(key, true).then(
        () => onToast(`Stopped following PR #${detail.id}`),
        (caught) => onToast(`Could not unfollow PR #${detail.id}: ${errMessage(caught)}`, 'error'),
      );
    } else {
      void follow(path, data.repository, detail, true).then(
        () => onToast(`Following PR #${detail.id}`),
        (caught) => onToast(`Could not follow PR #${detail.id}: ${errMessage(caught)}`, 'error'),
      );
    }
  }, [data, detail, follow, followed, onToast, path, unfollow]);

  const manualRefresh = useCallback(() => {
    void refresh();
    if (openedId != null) setDetailReload((value) => value + 1);
  }, [openedId, refresh]);

  const requestMergeMenu = useCallback((pr: PullRequest | null) => {
    if (!pr || pr.is_draft || !['open', 'active'].includes(pr.state) || !pr.source_commit) {
      onToast('Open an active, non-draft pull request before merging.', 'error');
      return;
    }
    window.dispatchEvent(new CustomEvent('strand:pull-request-merge-menu'));
  }, [onToast]);

  useEffect(() => {
    const onMergeRequest = () => requestMergeMenu(detail);
    window.addEventListener('strand:pull-request-merge', onMergeRequest);
    return () => window.removeEventListener('strand:pull-request-merge', onMergeRequest);
  }, [detail, requestMergeMenu]);

  return (
    <div className="pr-view">
      <div className="pr-toolbar">
        <div>
          {openedId != null ? (
            <button type="button" className="h-link pr-back" onClick={closePullRequest}>
              <Icon name="chev-left" size={12} /> Pull Requests
            </button>
          ) : <strong>Pull Requests</strong>}
          {data && openedSummary ? (
            <span>#{openedSummary.id} · {openedSummary.title}</span>
          ) : data ? (
            <span>{providerName(data.repository.provider)} · {data.repository.label} · {data.repository.remote}</span>
          ) : null}
        </div>
        <div className="pr-toolbar-actions">
          {openedFollowed?.error ? (
            <span className="pr-refresh-failed" role="status" title={openedFollowed.error}>
              Updates delayed · <button type="button" className="h-link" onClick={() => void pollFollowed()}>Retry</button>
            </span>
          ) : (error && data) || (detailError && detail) ? (
            <span className="pr-refresh-failed" role="alert" title={detailError ?? error ?? undefined}>Refresh failed</span>
          ) : lastUpdatedAt ? (
            <span>Updated {relativeTimeLabel(new Date(lastUpdatedAt).toISOString())}</span>
          ) : null}
          <button type="button" className="h-link" onClick={manualRefresh} disabled={loading || detailLoading}>
            <Icon name="refresh" size={12} className={loading || detailLoading ? 'spin' : ''} />
            {loading || detailLoading ? 'Updating…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && !data ? (
        <div className="pr-empty" role="alert">
          <Icon name="remote" size={28} />
          <strong>Pull requests are not available yet</strong>
          <p>{error}</p>
          <span>Strand uses the signed-in provider CLI so it never stores your access token.</span>
          <button type="button" className="btn" onClick={manualRefresh}>Try again</button>
        </div>
      ) : loading && !data ? (
        <div className="pr-empty" aria-live="polite"><Icon name="refresh" size={28} className="spin" /><strong>Loading pull requests…</strong></div>
      ) : data && data.pull_requests.length === 0 ? (
        <div className="pr-empty"><Icon name="check" size={28} /><strong>No pull requests found</strong><p>This repository has no open, closed, or merged pull requests in the latest 100.</p></div>
      ) : data ? (
        <div className="pr-main">
          {openedId == null ? (
            <div className="pr-list-screen">
              <div
                id="pr-listbox"
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
                  else if (event.key === 'Enter' && selectedSummary) { event.preventDefault(); openPullRequest(selectedSummary.id); }
                }}
              >
                {data.pull_requests.map((pr) => {
                  const isFollowed = Boolean(followed[pullRequestFollowKey(data.repository, pr.id)]);
                  return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={pr.id === selectedId}
                    id={`pr-row-${pr.id}`}
                    key={pr.id}
                    tabIndex={-1}
                    className={`pr-row${pr.id === selectedId ? ' selected' : ''}`}
                    onClick={() => openPullRequest(pr.id)}
                  >
                    <span className="pr-row-top">
                      <b>#{pr.id}</b>
                      <span className="pr-row-status">
                        {isFollowed && <span className="pr-followed-badge" title="Following"><Icon name="bell" size={11} /> Following</span>}
                        <span className={`pr-state ${displayState(pr)}`}>{displayState(pr)}</span>
                      </span>
                    </span>
                    <strong>{pr.title}</strong>
                    <span className="pr-row-meta">{pr.author} · {pr.source_branch} → {pr.target_branch}</span>
                  </button>
                  );
                })}
              </div>
            </div>
          ) : detail && path ? (
            <PullRequestDetails
              key={`${path}:${detail.id}`}
              path={path}
              provider={data.repository.provider}
              pr={detail}
              onUpdated={updatePullRequest}
              onToast={onToast}
              followed={Boolean(openedFollowed)}
              notificationPermission={notificationPermission}
              onToggleFollow={toggleFollow}
            />
          ) : detailLoading ? (
            <div className="pr-empty pr-detail-empty" aria-live="polite">
              <Icon name="refresh" size={24} className="spin" />
              <strong>Loading PR #{openedId}…</strong>
            </div>
          ) : detailError ? (
            <div className="pr-empty pr-detail-empty" role="alert">
              <Icon name="remote" size={24} />
              <strong>Could not load PR #{openedId}</strong>
              <p>{detailError}</p>
              <button type="button" className="btn" onClick={() => setDetailReload((value) => value + 1)}>Try again</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
