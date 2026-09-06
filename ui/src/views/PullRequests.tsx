import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import type { GitStatusEntry } from '@pierre/trees';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { ParsedDiff } from '../components/Diff';
import { DiffLayoutToggle, toPierreLayout } from '../components/DiffChrome';
import { ContextMenu, type MenuItem } from '../components/ContextMenu';
import { EmptyState } from '../components/EmptyState';
import { Icon, type IconName } from '../components/Icon';
import { PaneHeader } from '../components/PaneHeader';
import { PierreTree } from '../components/PierreTree';
import { applyCommentFormat, type CommentFormat } from '../lib/commentComposer';
import { pullRequestReview } from '../lib/db';
import { renderMarkdown } from '../lib/markdown';
import {
  buildPullRequestTimeline,
  canMarkPullRequestReady,
  checkTone,
  diffStats,
  filterPullRequests,
  isOpenPullRequest,
  isReopenablePullRequest,
  reconcilePullRequestSelection,
  type PullRequestInboxFilter,
  markdownUrl,
  parsePullRequestPatch,
  pullRequestReadiness,
  pullRequestForBranch,
  relativeTimeLabel,
  withPullRequestThreadReply,
  withPullRequestThreadUpdate,
} from '../lib/pullRequests';
import {
  filterPullRequestReviewPaths,
  nextUnresolvedThreadTarget,
  pullRequestFileVerdict,
  pullRequestFilePatchHash,
  pullRequestReviewMark,
  unresolvedThreadCounts,
  unresolvedThreadTargets,
  type PullRequestFileVerdict,
  type PullRequestReviewFilter,
} from '../lib/pullRequestReview';
import { pullRequestActivityChanged, pullRequestFollowKey } from '../lib/pullRequestActivity';
import { errMessage, tauri } from '../lib/tauri';
import { treeFileOrder } from '../lib/treeOrder';
import type {
  PullRequest,
  PullRequestActivitySnapshot,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCreateOutcome,
  PullRequestDataPage,
  PullRequestList,
  PullRequestPendingComment,
  PullRequestReview,
  PullRequestReviewDraft,
  PullRequestReviewEvent,
  PullRequestReviewThread,
} from '../lib/types';
import { useRepo } from '../stores/repo';
import { usePullRequests } from '../stores/pullRequests';
import { useSettings } from '../stores/settings';
import { PullRequestDataLoader } from './PullRequestDataLoader';
import { PullRequestInboxLoader } from './PullRequestInboxLoader';
import { appendPullRequestPage, uniqueBy } from '../lib/pullRequestPages';
import { PullRequestMergeControl } from './PullRequestMergeControl';
import { PullRequestCreateDialog } from './PullRequestCreateDialog';

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

function PullRequestCommentComposer({
  path,
  pr,
  draft,
  onDraft,
  onUpdated,
}: {
  path: string;
  pr: PullRequest;
  draft: string;
  onDraft: (draft: string) => void;
  onUpdated: (next: PullRequest) => void;
}) {
  const platform = useSettings((state) => state.platform);
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
    onDraft(edit.value);
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
      onDraft('');
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
      <form
        className="pr-comment-form pr-comment-form-compact"
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
                onChange={(event) => onDraft(event.target.value)}
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
  );
}

function PullRequestCommentCard({
  comment,
  pr,
  onViewInCode,
}: {
  comment: PullRequestComment;
  pr: PullRequest;
  onViewInCode: (comment: PullRequestComment) => void;
}) {
  const commentUrl = markdownUrl(comment.url, pr.url);
  const avatarUrl = markdownUrl(comment.avatar_url ?? undefined);
  return (
    <div className={`pr-comment-row${comment.is_system ? ' system' : ''}`}>
      <div className="pr-comment-marker" aria-hidden="true">
        {comment.is_system ? <Icon name="history" size={14} /> : (
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
              <button type="button" onClick={() => onViewInCode(comment)} title="View this comment in Code">
                <Icon name="changes" size={11} /> View in Code
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
}

function PullRequestSummary({
  path,
  provider,
  pr,
  draft,
  onDraft,
  onUpdated,
  onToast,
}: {
  path: string;
  provider: PullRequestList['repository']['provider'];
  pr: PullRequest;
  draft: string;
  onDraft: (draft: string) => void;
  onUpdated: (next: PullRequest) => void;
  onToast: (message: string, kind?: 'success' | 'error') => void;
}) {
  const reviewers = pr.reviewers.length
    ? pr.reviewers.map((reviewer) => reviewer.name).join(', ')
    : 'No reviewers';
  return (
    <div className="pr-tab-scroll pr-summary">
      <dl className="pr-summary-facts">
        <div><dt><Icon name="branch" size={14} /> Branch</dt><dd><code>{pr.source_branch}</code><Icon name="chev-right" size={11} /><code>{pr.target_branch}</code></dd></div>
        <div><dt><Icon name="blame" size={14} /> Reviewers</dt><dd>{reviewers}</dd></div>
        <div><dt><Icon name="changes" size={14} /> Comments</dt><dd>{pr.comment_count || 'No comments'}</dd></div>
        <div><dt><Icon name="history" size={14} /> Commits</dt><dd>{pr.commit_count || pr.commits.length || 'No commits reported'}</dd></div>
        <div><dt><Icon name="changes" size={14} /> Code</dt><dd>{[
          pr.changed_files != null ? `${pr.changed_files} file${pr.changed_files === 1 ? '' : 's'}` : null,
          pr.additions != null ? `+${pr.additions}` : null,
          pr.deletions != null ? `−${pr.deletions}` : null,
        ].filter(Boolean).join(' · ') || 'Change totals unavailable'}</dd></div>
      </dl>

      {pr.labels.length > 0 && <div className="pr-pills">{pr.labels.map((label) => <span key={label}>{label}</span>)}</div>}

      <details className="pr-summary-section" open>
        <summary>Description</summary>
        <div className="pr-summary-section-body">
          {pr.description ? <ProviderMarkdown source={pr.description} baseUrl={pr.url} /> : <p className="pr-muted">No description.</p>}
        </div>
      </details>

      <details className="pr-summary-section" open>
        <summary>Checks <span>{pr.checks.length}{!pr.checks_complete ? '+' : ''}</span></summary>
        <div className="pr-summary-section-body">
          {pr.checks.length > 0 ? (
            <ul className="pr-facts">
              {pr.checks.map((check, index) => (
                <li key={`${check.name}:${index}`}><span>{check.name}</span><CheckStatus check={check} /></li>
              ))}
            </ul>
          ) : <p className="pr-muted">No checks reported.</p>}
        </div>
      </details>

      <details className="pr-summary-section" open>
        <summary>Reviews <span>{(pr.reviews ?? []).length}{pr.data_pages?.some((p) => p.kind === 'reviews') ? '+' : ''}</span></summary>
        <div className="pr-summary-section-body pr-existing-reviews">
          {(pr.reviews ?? []).length > 0 ? (pr.reviews ?? []).map((review) => (
            <PullRequestReviewCard
              key={review.id}
              path={path}
              provider={provider}
              pr={pr}
              review={review}
              onUpdated={onUpdated}
              onToast={onToast}
            />
          )) : <p className="pr-muted">No submitted reviews.</p>}
        </div>
      </details>

      <section className="pr-summary-comments">
        <h3>Comments <span>{pr.comments.length}</span></h3>
        {isOpenPullRequest(pr) ? (
          <PullRequestCommentComposer path={path} pr={pr} draft={draft} onDraft={onDraft} onUpdated={onUpdated} />
        ) : (
          <p className="pr-muted">This pull request is {displayState(pr)}. Its discussion is read-only in Strand.</p>
        )}
      </section>
    </div>
  );
}

function PullRequestReviewCard({
  path,
  provider,
  pr,
  review,
  onUpdated,
  onToast,
}: {
  path: string;
  provider: PullRequestList['repository']['provider'];
  pr: PullRequest;
  review: PullRequestReview;
  onUpdated: (next: PullRequest) => void;
  onToast: (message: string, kind?: 'success' | 'error') => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(review.body);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'update' | 'dismiss' | null>(null);
  const reviewUrl = markdownUrl(review.url, pr.url);
  const canWrite = isOpenPullRequest(pr);
  const stateLabel = review.state.replaceAll('_', ' ').toLowerCase();

  useEffect(() => {
    if (!editing) setBody(review.body);
  }, [editing, review.body]);

  const refreshAfterWrite = async (success: string) => {
    try {
      onUpdated(await tauri.repoPullRequest(path, pr.id));
      onToast(success);
    } catch (caught) {
      onToast(`${success}, but PR #${pr.id} could not refresh: ${errMessage(caught)}`, 'error');
    }
  };

  const updateReview = async () => {
    const nextBody = body.trim();
    if (!nextBody || busy) return;
    setBusy('update');
    try {
      await tauri.repoPullRequestUpdateReview(path, pr.id, review.id, nextBody);
      setEditing(false);
      await refreshAfterWrite('Updated review summary');
    } catch (caught) {
      onToast(`Could not update review: ${errMessage(caught)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const dismissReview = async () => {
    const message = reason.trim();
    if (busy || (provider === 'git_hub' && !message)) return;
    setBusy('dismiss');
    try {
      await tauri.repoPullRequestDismissReview(path, pr.id, review.id, message);
      setDismissing(false);
      setReason('');
      await refreshAfterWrite(provider === 'git_hub' ? 'Dismissed review' : 'Reset your Azure DevOps vote');
    } catch (caught) {
      onToast(`${provider === 'git_hub' ? 'Could not dismiss review' : 'Could not reset vote'}: ${errMessage(caught)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="pr-existing-review">
      <header>
        <div>
          <strong>{review.author}</strong>
          <span className={`pr-review-state ${review.state.toLowerCase()}`}>{stateLabel}</span>
        </div>
        <div className="pr-existing-review-meta">
          {review.submitted_at && <time dateTime={review.submitted_at}>{dateLabel(review.submitted_at)}</time>}
          {reviewUrl && (
            <button type="button" className="h-link" onClick={() => void shellOpen(reviewUrl)} title="Open this review on host">
              <Icon name="external" size={10} />
            </button>
          )}
        </div>
      </header>

      {editing ? (
        <form className="pr-existing-review-form" onSubmit={(event) => { event.preventDefault(); void updateReview(); }}>
          <label htmlFor={`pr-review-body-${review.id}`}>Review summary</label>
          <textarea
            id={`pr-review-body-${review.id}`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={4}
            maxLength={65_536}
            disabled={busy != null}
            autoFocus
          />
          <div className="pr-existing-review-actions">
            <button type="button" className="btn" disabled={busy != null} onClick={() => { setEditing(false); setBody(review.body); }}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!body.trim() || busy != null}>{busy === 'update' ? 'Saving…' : 'Save summary'}</button>
          </div>
        </form>
      ) : (
        <div className="pr-existing-review-body">
          {review.body ? <ProviderMarkdown source={review.body} baseUrl={reviewUrl || pr.url} /> : <p className="pr-muted">No review summary.</p>}
        </div>
      )}

      {canWrite && !editing && (review.can_update || review.can_dismiss) && (
        <div className="pr-existing-review-actions">
          {review.can_update && <button type="button" className="btn" disabled={busy != null} onClick={() => setEditing(true)}>Edit summary</button>}
          {review.can_dismiss && provider === 'git_hub' && (
            <button type="button" className="btn danger" disabled={busy != null} aria-expanded={dismissing} onClick={() => setDismissing((value) => !value)}>
              {dismissing ? 'Cancel dismissal' : 'Dismiss review…'}
            </button>
          )}
          {review.can_dismiss && provider === 'azure_dev_ops' && (
            <button type="button" className="btn danger" disabled={busy != null} onClick={() => void dismissReview()}>
              {busy === 'dismiss' ? 'Resetting…' : 'Reset my vote'}
            </button>
          )}
        </div>
      )}

      {canWrite && review.can_dismiss && provider === 'git_hub' && dismissing && (
        <form className="pr-existing-review-form" onSubmit={(event) => { event.preventDefault(); void dismissReview(); }}>
          <label htmlFor={`pr-review-dismiss-${review.id}`}>Reason for dismissal</label>
          <textarea
            id={`pr-review-dismiss-${review.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={65_536}
            disabled={busy != null}
            autoFocus
          />
          <div className="pr-existing-review-actions">
            <button type="button" className="btn" disabled={busy != null} onClick={() => { setDismissing(false); setReason(''); }}>Cancel</button>
            <button type="submit" className="btn danger" disabled={!reason.trim() || busy != null}>{busy === 'dismiss' ? 'Dismissing…' : 'Confirm dismissal'}</button>
          </div>
        </form>
      )}
    </article>
  );
}

function PullRequestTimeline({
  path,
  pr,
  draft,
  onDraft,
  onUpdated,
  onViewInCode,
}: {
  path: string;
  pr: PullRequest;
  draft: string;
  onDraft: (draft: string) => void;
  onUpdated: (next: PullRequest) => void;
  onViewInCode: (comment: PullRequestComment) => void;
}) {
  const events = useMemo(() => buildPullRequestTimeline(pr), [pr]);
  return (
    <div className="pr-tab-scroll pr-timeline">
      <div className="pr-timeline-feed" aria-label="Pull request timeline">
        {events.map((event) => {
          if (event.kind === 'comment') {
            return <PullRequestCommentCard key={event.id} comment={event.comment} pr={pr} onViewInCode={onViewInCode} />;
          }
          if (event.kind === 'commit') {
            const avatarUrl = markdownUrl(event.commit.avatar_url ?? undefined);
            return (
              <div className="pr-timeline-event pr-commit-event" key={event.id}>
                <div className="pr-timeline-marker" aria-hidden="true">
                  <span>{authorInitials(event.commit.author)}</span>
                  {avatarUrl && <img src={avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.hidden = true; }} />}
                </div>
                <div className="pr-timeline-event-body">
                  <div><strong>{event.commit.author}</strong> added a commit</div>
                  <button type="button" disabled={!event.commit.url} onClick={() => event.commit.url && void shellOpen(event.commit.url)}>
                    <code>{event.commit.id.slice(0, 7)}</code><span>{event.commit.title}</span>{event.commit.url && <Icon name="external" size={10} />}
                  </button>
                  <time dateTime={event.at}>{dateLabel(event.at)}</time>
                </div>
              </div>
            );
          }
          const completed = event.kind === 'completed';
          return (
            <div className={`pr-timeline-event pr-lifecycle-event${completed ? ` ${event.state}` : ''}`} key={event.id}>
              <div className="pr-timeline-marker" aria-hidden="true"><Icon name={completed ? (event.state === 'merged' ? 'check' : 'x') : 'branch'} size={14} /></div>
              <div className="pr-timeline-event-body">
                <strong>{completed ? `Pull request ${event.state}` : 'Pull request opened'}</strong>
                <time dateTime={event.at}>{dateLabel(event.at)}</time>
              </div>
            </div>
          );
        })}
      </div>
      {isOpenPullRequest(pr) ? (
        <PullRequestCommentComposer path={path} pr={pr} draft={draft} onDraft={onDraft} onUpdated={onUpdated} />
      ) : (
        <p className="pr-muted">This pull request is {displayState(pr)}. Its timeline is read-only in Strand.</p>
      )}
    </div>
  );
}

function fileGitStatus(file: FileDiffMetadata): GitStatusEntry['status'] {
  if (file.type === 'new') return 'added';
  if (file.type === 'deleted') return 'deleted';
  if (file.type.startsWith('rename')) return 'renamed';
  return 'modified';
}

function PullRequestInlineThread({
  thread,
  prUrl,
  canWrite,
  replying,
  replyDraft,
  writeKind,
  message,
  platform,
  onStartReply,
  onCancelReply,
  onReplyDraft,
  onSubmitReply,
  onSetResolved,
}: {
  thread: PullRequestReviewThread;
  prUrl: string;
  canWrite: boolean;
  replying: boolean;
  replyDraft: string;
  writeKind: 'reply' | 'resolve' | undefined;
  message: { tone: 'ok' | 'error'; text: string } | undefined;
  platform: string;
  onStartReply: () => void;
  onCancelReply: () => void;
  onReplyDraft: (value: string) => void;
  onSubmitReply: () => void;
  onSetResolved: (resolved: boolean) => void;
}) {
  const lineLabel = thread.start_line === thread.end_line
    ? `${thread.end_line}`
    : `${thread.start_line}–${thread.end_line}`;
  const busy = writeKind != null;
  return (
    <article
      id={`pr-review-thread-${thread.id}`}
      tabIndex={-1}
      className={`pr-inline-thread${thread.is_resolved ? ' resolved' : ''}${thread.is_outdated ? ' outdated' : ''}`}
    >
      <header>
        <strong>{thread.side === 'deletions' ? 'Old' : 'New'} line{thread.start_line === thread.end_line ? '' : 's'} {lineLabel}</strong>
        <div className="pr-inline-thread-head-actions">
          <div className="pr-inline-thread-labels">
            {thread.is_resolved && <span>Resolved</span>}
            {thread.is_outdated && <span>Outdated</span>}
          </div>
          {canWrite && thread.can_reply && (
            <button
              type="button"
              id={`pr-thread-reply-${thread.id}`}
              className="h-link"
              aria-expanded={replying}
              disabled={busy}
              onClick={replying ? onCancelReply : onStartReply}
            >
              {replying ? 'Cancel reply' : 'Reply'}
            </button>
          )}
          {canWrite && !thread.is_resolved && thread.can_resolve && (
            <button
              type="button"
              id={`pr-thread-state-${thread.id}`}
              className="h-link"
              disabled={busy}
              onClick={() => onSetResolved(true)}
            >
              {writeKind === 'resolve' ? 'Resolving…' : 'Resolve'}
            </button>
          )}
          {canWrite && thread.is_resolved && thread.can_unresolve && (
            <button
              type="button"
              id={`pr-thread-state-${thread.id}`}
              className="h-link"
              disabled={busy}
              onClick={() => onSetResolved(false)}
            >
              {writeKind === 'resolve' ? 'Reopening…' : 'Reopen'}
            </button>
          )}
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
      {message && (
        <div className={`pr-thread-message ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </div>
      )}
      {canWrite && replying && (
        <form
          className="pr-thread-reply"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitReply();
          }}
        >
          <textarea
            id={`pr-thread-reply-input-${thread.id}`}
            value={replyDraft}
            onChange={(event) => onReplyDraft(event.target.value)}
            placeholder="Reply to this thread…"
            rows={3}
            maxLength={65_536}
            disabled={writeKind === 'reply'}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onCancelReply();
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                onSubmitReply();
              }
            }}
          />
          <div className="pr-inline-actions">
            <span>{replyDraft.length.toLocaleString()} / 65,536 · {platform === 'mac' ? '⌘' : 'Ctrl'}+Enter</span>
            <button type="button" className="btn" onClick={onCancelReply} disabled={writeKind === 'reply'}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!replyDraft.trim() || writeKind === 'reply'}>
              {writeKind === 'reply' ? 'Replying…' : 'Reply'}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

type InlineCommentAnnotation =
  | { kind: 'composer'; range: SelectedLineRange }
  | { kind: 'draft'; comment: PullRequestPendingComment; index: number }
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
  const [replyingThreadId, setReplyingThreadId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [threadWrites, setThreadWrites] = useState<Record<string, 'reply' | 'resolve'>>({});
  const [threadMessages, setThreadMessages] = useState<Record<string, { tone: 'ok' | 'error'; text: string }>>({});
  const [reviewFilter, setReviewFilter] = useState<PullRequestReviewFilter>('all');
  const [viewed, setViewed] = useState<Record<string, string>>({});
  const [viewedLoaded, setViewedLoaded] = useState(false);
  const [keyboardThreadId, setKeyboardThreadId] = useState<string | null>(null);
  const [reviewDraft, setReviewDraft] = useState<PullRequestReviewDraft>({
    head_sha: pr.source_commit,
    body: '',
    comments: [],
  });
  const [reviewDraftLoaded, setReviewDraftLoaded] = useState(false);
  const [reviewSubmitOpen, setReviewSubmitOpen] = useState(false);
  const [reviewSubmitMode, setReviewSubmitMode] = useState<'write' | 'preview'>('write');
  const [submittingReview, setSubmittingReview] = useState(false);
  const generation = useRef(0);
  const viewedGeneration = useRef(0);
  const reviewDraftGeneration = useRef(0);
  const viewedWrite = useRef<Promise<void>>(Promise.resolve());
  const reviewDraftWrite = useRef<Promise<void>>(Promise.resolve());
  const currentPr = useRef(pr);
  const reviewKey = useMemo(
    () => `${provider}:${encodeURIComponent(pr.url || path)}:${pr.id}`,
    [path, pr.id, pr.url, provider],
  );

  useEffect(() => {
    currentPr.current = pr;
  }, [pr]);

  useEffect(() => {
    const current = ++viewedGeneration.current;
    setViewed({});
    setViewedLoaded(false);
    void pullRequestReview.getViewed(reviewKey).then(
      (stored) => {
        if (viewedGeneration.current === current) {
          setViewed(stored ?? {});
          setViewedLoaded(true);
        }
      },
      (caught) => {
        if (viewedGeneration.current === current) {
          setCommentMessage({ tone: 'error', text: `Could not load review progress: ${errMessage(caught)}` });
        }
      },
    );
    return () => { viewedGeneration.current += 1; };
  }, [reviewKey]);

  useEffect(() => {
    const current = ++reviewDraftGeneration.current;
    setReviewDraft({ head_sha: pr.source_commit, body: '', comments: [] });
    setReviewDraftLoaded(false);
    void pullRequestReview.getDraft(reviewKey).then(
      (stored) => {
        if (reviewDraftGeneration.current === current) {
          setReviewDraft(stored ?? { head_sha: pr.source_commit, body: '', comments: [] });
          setReviewDraftLoaded(true);
        }
      },
      (caught) => {
        if (reviewDraftGeneration.current === current) {
          setCommentMessage({ tone: 'error', text: `Could not load pending review: ${errMessage(caught)}` });
        }
      },
    );
    return () => { reviewDraftGeneration.current += 1; };
  }, [pr.source_commit, reviewKey]);

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
  const allTreePaths = useMemo(() => treeFileOrder(files.map((file) => file.name)), [files]);
  const unresolvedByPath = useMemo(
    () => unresolvedThreadCounts(pr.review_threads ?? []),
    [pr.review_threads],
  );
  const unresolvedCount = useMemo(
    () => [...unresolvedByPath.values()].reduce((total, count) => total + count, 0),
    [unresolvedByPath],
  );
  const verdicts = useMemo(() => {
    const next = new Map<string, PullRequestFileVerdict>();
    for (const file of files) {
      next.set(
        file.name,
        pullRequestFileVerdict(viewed[file.name], pr.source_commit, pullRequestFilePatchHash(file)),
      );
    }
    return next;
  }, [files, pr.source_commit, viewed]);
  const viewedCount = useMemo(
    () => [...verdicts.values()].filter((verdict) => verdict === 'viewed').length,
    [verdicts],
  );
  const treePaths = useMemo(
    () => filterPullRequestReviewPaths(allTreePaths, reviewFilter, verdicts, unresolvedByPath),
    [allTreePaths, reviewFilter, unresolvedByPath, verdicts],
  );
  const treeStatus = useMemo<GitStatusEntry[]>(
    () => treePaths.map((filePath) => ({ path: filePath, status: fileGitStatus(filesByPath.get(filePath)!) })),
    [filesByPath, treePaths],
  );
  const fileStats = useMemo(
    () => new Map(files.map((file) => [file.name, diffStats(file)])),
    [files],
  );
  const parsedTotals = useMemo(
    () => [...fileStats.values()].reduce(
      (total, stats) => ({ additions: total.additions + stats.additions, deletions: total.deletions + stats.deletions }),
      { additions: 0, deletions: 0 },
    ),
    [fileStats],
  );
  const selectedFile = selectedPath ? filesByPath.get(selectedPath) ?? null : null;
  const selectedStats = selectedFile ? diffStats(selectedFile) : null;
  const selectedThreads = useMemo(
    () => selectedFile ? (pr.review_threads ?? []).filter((thread) => thread.path === selectedFile.name) : [],
    [pr.review_threads, selectedFile],
  );
  const threadTargets = useMemo(
    () => unresolvedThreadTargets(allTreePaths, pr.review_threads ?? []),
    [allTreePaths, pr.review_threads],
  );
  const openForReview = pr.state === 'open' || pr.state === 'active';

  useEffect(() => {
    if (navigationTarget && filesByPath.has(navigationTarget.path) && !treePaths.includes(navigationTarget.path)) {
      setReviewFilter('all');
    }
  }, [filesByPath, navigationTarget, treePaths]);

  useEffect(() => {
    setSelectedPath((current) => {
      if (navigationTarget && filesByPath.has(navigationTarget.path)) return navigationTarget.path;
      return current && treePaths.includes(current) ? current : treePaths[0] ?? null;
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
    if (!keyboardThreadId) return;
    const thread = (pr.review_threads ?? []).find((candidate) => candidate.id === keyboardThreadId);
    if (!thread || thread.path !== selectedPath) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`pr-review-thread-${keyboardThreadId}`);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
      setKeyboardThreadId(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [keyboardThreadId, pr.review_threads, selectedPath]);

  useEffect(() => {
    const openReview = () => {
      if (!openForReview) return;
      setReviewSubmitOpen(true);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.pr-review-submit textarea')?.focus());
    };
    window.addEventListener('strand:pull-request-review-open', openReview);
    return () => window.removeEventListener('strand:pull-request-review-open', openReview);
  }, [openForReview]);

  useEffect(() => {
    setCollapsed(false);
    setSelectedLines(null);
    setCommentDraft('');
    setCommentMessage(null);
  }, [selectedPath]);

  const stalePatch = patch != null && (loading || error != null);
  const inlineCommentsSupported = openForReview && !stalePatch;
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
    reviewDraft.comments.forEach((comment, index) => {
      if (comment.path === selectedFile?.name) {
        annotations.push({
          side: comment.side,
          lineNumber: comment.end_line,
          metadata: { kind: 'draft', comment, index },
        });
      }
    });
    if (selectedLines) {
      const side = selectedLines.endSide ?? selectedLines.side ?? 'additions';
      annotations.push({
        side,
        lineNumber: selectedLines.end,
        metadata: { kind: 'composer' as const, range: selectedLines },
      });
    }
    return annotations;
  }, [reviewDraft.comments, selectedFile?.name, selectedLines, selectedThreads]);

  const persistReviewDraft = useCallback((next: PullRequestReviewDraft) => {
    reviewDraftWrite.current = reviewDraftWrite.current
      .catch(() => undefined)
      .then(() => pullRequestReview.setDraft(reviewKey, next))
      .catch((caught) => {
        setCommentMessage({ tone: 'error', text: `Could not save pending review: ${errMessage(caught)}` });
      });
  }, [reviewKey]);

  const updateReviewDraft = useCallback((next: PullRequestReviewDraft, persist = true) => {
    setReviewDraft(next);
    if (persist) persistReviewDraft(next);
  }, [persistReviewDraft]);

  const addPendingComment = () => {
    if (!selectedFile || !selectedLines || !reviewDraftLoaded || stalePatch) return;
    const body = commentDraft.trim();
    if (!body) return;
    if (reviewDraft.head_sha !== pr.source_commit && (reviewDraft.body.trim() || reviewDraft.comments.length > 0)) {
      setCommentMessage({ tone: 'error', text: 'The pending review belongs to an older head. Submit or discard it before adding comments from this patch.' });
      setReviewSubmitOpen(true);
      return;
    }
    if (reviewDraft.comments.length >= 100) {
      setCommentMessage({ tone: 'error', text: 'A review can contain at most 100 pending comments.' });
      return;
    }
    const side = selectedLines.side ?? 'additions';
    updateReviewDraft({
      head_sha: pr.source_commit,
      body: reviewDraft.body,
      comments: [...reviewDraft.comments, {
        path: selectedFile.name,
        start_line: selectedLines.start,
        end_line: selectedLines.end,
        side,
        body,
      }],
    });
    setCommentDraft('');
    setSelectedLines(null);
    setCommentMessage({ tone: 'ok', text: 'Comment added to the pending review.' });
  };

  const removePendingComment = (index: number) => {
    const next = {
      ...reviewDraft,
      comments: reviewDraft.comments.filter((_, candidate) => candidate !== index),
    };
    updateReviewDraft(next);
  };

  const submitReview = async (event: PullRequestReviewEvent) => {
    if (submittingReview || !reviewDraftLoaded || !openForReview) return;
    const body = reviewDraft.body.trim();
    if (reviewDraft.head_sha !== pr.source_commit) {
      setCommentMessage({ tone: 'error', text: 'This pending review belongs to an older head. Refresh and discard or rewrite it before submitting.' });
      return;
    }
    if (event === 'comment' && !body && reviewDraft.comments.length === 0) {
      setCommentMessage({ tone: 'error', text: 'Add a summary or pending comment before submitting a comment review.' });
      return;
    }
    if (event === 'request_changes' && !body) {
      setCommentMessage({ tone: 'error', text: 'Request changes needs a review summary.' });
      return;
    }
    setSubmittingReview(true);
    setCommentMessage(null);
    let submitted = false;
    try {
      await tauri.repoPullRequestSubmitReview(
        path,
        pr.id,
        event,
        body,
        reviewDraft.comments,
        reviewDraft.head_sha,
      );
      submitted = true;
      const empty = { head_sha: pr.source_commit, body: '', comments: [] };
      updateReviewDraft(empty);
      setReviewSubmitOpen(false);
      const next = await tauri.repoPullRequest(path, pr.id);
      onUpdated(next);
      setCommentMessage({ tone: 'ok', text: event === 'approve' ? 'Review approved.' : event === 'request_changes' ? 'Changes requested.' : 'Review submitted.' });
    } catch (caught) {
      setCommentMessage({
        tone: 'error',
        text: submitted
          ? `Review was submitted, but the pull request could not refresh: ${errMessage(caught)}`
          : errMessage(caught),
      });
    } finally {
      setSubmittingReview(false);
    }
  };

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

  const focusThreadControl = (threadId: string, control: 'reply' | 'state') => {
    requestAnimationFrame(() => document.getElementById(`pr-thread-${control}-${threadId}`)?.focus({ preventScroll: true }));
  };

  const startThreadReply = (threadId: string) => {
    setReplyingThreadId(threadId);
    setThreadMessages((current) => {
      if (!current[threadId]) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    requestAnimationFrame(() => document.getElementById(`pr-thread-reply-input-${threadId}`)?.focus());
  };

  const cancelThreadReply = (threadId: string) => {
    setReplyingThreadId((current) => current === threadId ? null : current);
    focusThreadControl(threadId, 'reply');
  };

  const setThreadReplyDraft = (threadId: string, value: string) => {
    setReplyDrafts((current) => ({ ...current, [threadId]: value }));
  };

  const submitThreadReply = async (thread: PullRequestReviewThread) => {
    const body = (replyDrafts[thread.id] ?? '').trim();
    if (!body || threadWrites[thread.id]) return;
    setThreadWrites((current) => ({ ...current, [thread.id]: 'reply' }));
    setThreadMessages((current) => {
      const next = { ...current };
      delete next[thread.id];
      return next;
    });
    try {
      const reply = await tauri.repoPullRequestThreadReply(path, thread.id, body);
      const next = withPullRequestThreadReply(currentPr.current, thread.id, reply);
      currentPr.current = next;
      onUpdated(next);
      setReplyDrafts((current) => {
        const next = { ...current };
        delete next[thread.id];
        return next;
      });
      setReplyingThreadId((current) => current === thread.id ? null : current);
      setThreadMessages((current) => ({
        ...current,
        [thread.id]: { tone: 'ok', text: 'Reply added.' },
      }));
      focusThreadControl(thread.id, 'reply');
    } catch (caught) {
      setThreadMessages((current) => ({
        ...current,
        [thread.id]: { tone: 'error', text: errMessage(caught) },
      }));
    } finally {
      setThreadWrites((current) => {
        const next = { ...current };
        delete next[thread.id];
        return next;
      });
    }
  };

  const setThreadResolved = async (thread: PullRequestReviewThread, resolved: boolean) => {
    if (threadWrites[thread.id]) return;
    setThreadWrites((current) => ({ ...current, [thread.id]: 'resolve' }));
    setThreadMessages((current) => {
      const next = { ...current };
      delete next[thread.id];
      return next;
    });
    try {
      const update = await tauri.repoPullRequestThreadResolve(path, thread.id, resolved);
      const next = withPullRequestThreadUpdate(currentPr.current, update);
      currentPr.current = next;
      onUpdated(next);
      setThreadMessages((current) => ({
        ...current,
        [thread.id]: { tone: 'ok', text: resolved ? 'Thread resolved.' : 'Thread reopened.' },
      }));
      focusThreadControl(thread.id, 'state');
    } catch (caught) {
      setThreadMessages((current) => ({
        ...current,
        [thread.id]: { tone: 'error', text: errMessage(caught) },
      }));
    } finally {
      setThreadWrites((current) => {
        const next = { ...current };
        delete next[thread.id];
        return next;
      });
    }
  };

  const persistViewed = useCallback((next: Record<string, string>) => {
    viewedWrite.current = viewedWrite.current
      .catch(() => undefined)
      .then(() => pullRequestReview.setViewed(reviewKey, next))
      .catch((caught) => {
        setCommentMessage({ tone: 'error', text: `Could not save review progress: ${errMessage(caught)}` });
      });
  }, [reviewKey]);

  const toggleViewed = useCallback((filePath: string | null = selectedPath) => {
    if (!filePath || !viewedLoaded) return;
    const file = filesByPath.get(filePath);
    if (!file) return;
    const next = { ...viewed };
    if (verdicts.get(filePath) === 'viewed') delete next[filePath];
    else next[filePath] = pullRequestReviewMark(pr.source_commit, pullRequestFilePatchHash(file));
    setViewed(next);
    persistViewed(next);
  }, [filesByPath, persistViewed, pr.source_commit, selectedPath, verdicts, viewed, viewedLoaded]);

  const moveThread = useCallback((direction: 1 | -1) => {
    const activeThread = document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<HTMLElement>('[id^="pr-review-thread-"]')
      : null;
    const target = nextUnresolvedThreadTarget(
      threadTargets,
      allTreePaths,
      selectedPath,
      activeThread?.id.slice('pr-review-thread-'.length) ?? null,
      direction,
    );
    if (!target) return;
    if (!treePaths.includes(target.path)) setReviewFilter('all');
    setSelectedPath(target.path);
    setCollapsed(false);
    setKeyboardThreadId(target.threadId);
  }, [allTreePaths, selectedPath, threadTargets, treePaths]);

  const move = (delta: number) => {
    if (!treePaths.length) return;
    const current = selectedPath ? treePaths.indexOf(selectedPath) : -1;
    const next = Math.min(treePaths.length - 1, Math.max(0, current + delta));
    setSelectedPath(treePaths[next]);
  };
  const reviewDraftStale = reviewDraft.head_sha !== pr.source_commit && (
    reviewDraft.body.trim().length > 0 || reviewDraft.comments.length > 0
  );

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
    <div
      className="pr-changes"
      onKeyDown={(event) => {
        const target = event.target;
        if (
          event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey ||
          target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)
        ) return;
        if (event.key === 'j' || event.key === ']') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'k' || event.key === '[') {
          event.preventDefault();
          move(-1);
        } else if (event.key.toLowerCase() === 'n') {
          event.preventDefault();
          moveThread(event.shiftKey ? -1 : 1);
        } else if (event.key.toLowerCase() === 'v' && selectedPath) {
          event.preventDefault();
          toggleViewed();
        }
      }}
    >
      {stalePatch && (
        <div className={`pr-inline-refresh${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
          <Icon name={error ? 'x' : 'refresh'} size={12} className={loading ? 'spin' : undefined} />
          <span>{error ? `Could not update code: ${error}` : 'Updating code for the latest push…'}</span>
          {error && <button type="button" className="h-link" onClick={() => setReload((value) => value + 1)}>Retry</button>}
        </div>
      )}
      <div className="pr-code-overview" aria-label="Code change summary">
        <span><Icon name="branch" size={12} /><code>{pr.source_branch}</code><Icon name="chev-right" size={10} /><code>{pr.target_branch}</code></span>
        <span>{pr.commit_count || pr.commits.length} {pr.commit_count === 1 || pr.commits.length === 1 ? 'commit' : 'commits'}</span>
        <span>{viewedCount}/{files.length} viewed</span>
        <span>{unresolvedCount} unresolved {unresolvedCount === 1 ? 'thread' : 'threads'}</span>
        <span className="stat-add">+{pr.additions ?? parsedTotals.additions}</span>
        <span className="stat-del">−{pr.deletions ?? parsedTotals.deletions}</span>
        {openForReview && (
          <button
            type="button"
            className="h-link pr-submit-review-toggle"
            aria-expanded={reviewSubmitOpen}
            onClick={() => setReviewSubmitOpen((value) => !value)}
          >
            <Icon name="changes" size={11} /> Review{reviewDraft.comments.length > 0 ? ` (${reviewDraft.comments.length})` : ''}
          </button>
        )}
      </div>
      {reviewSubmitOpen && openForReview && (
        <section className="pr-review-submit" aria-label="Submit review">
          <div className="pr-review-submit-head">
            <div>
              <strong>Submit review</strong>
              <span>{reviewDraft.comments.length} pending inline {reviewDraft.comments.length === 1 ? 'comment' : 'comments'}</span>
            </div>
            <div className="pr-review-submit-tabs" role="tablist" aria-label="Review summary mode">
              {(['write', 'preview'] as const).map((mode) => (
                <button
                  type="button"
                  role="tab"
                  key={mode}
                  aria-selected={reviewSubmitMode === mode}
                  onClick={() => setReviewSubmitMode(mode)}
                >
                  {mode === 'write' ? 'Write' : 'Preview'}
                </button>
              ))}
            </div>
          </div>
          {reviewDraftStale && (
            <div className="pr-review-stale" role="alert">
              This draft targets an older pull-request head and cannot be submitted.
              <button
                type="button"
                className="h-link"
                onClick={() => updateReviewDraft({ head_sha: pr.source_commit, body: '', comments: [] })}
              >
                Discard stale draft
              </button>
            </div>
          )}
          {reviewSubmitMode === 'write' ? (
            <textarea
              value={reviewDraft.body}
              onChange={(event) => updateReviewDraft({ ...reviewDraft, body: event.target.value }, false)}
              onBlur={() => persistReviewDraft(reviewDraft)}
              placeholder="Review summary (required when requesting changes)…"
              rows={4}
              maxLength={65_536}
              disabled={!reviewDraftLoaded || submittingReview}
            />
          ) : (
            <div className="pr-review-submit-preview">
              {reviewDraft.body.trim() ? renderMarkdown(reviewDraft.body) : <p className="pr-muted">Nothing to preview yet.</p>}
            </div>
          )}
          <div className="pr-review-submit-actions">
            <span>{reviewDraft.body.length.toLocaleString()} / 65,536</span>
            <button type="button" className="btn" disabled={!reviewDraftLoaded || submittingReview || reviewDraftStale} onClick={() => void submitReview('comment')}>Comment</button>
            <button type="button" className="btn" disabled={!reviewDraftLoaded || submittingReview || reviewDraftStale} onClick={() => void submitReview('approve')}>Approve</button>
            <button type="button" className="btn danger" disabled={!reviewDraftLoaded || submittingReview || reviewDraftStale || !reviewDraft.body.trim()} onClick={() => void submitReview('request_changes')}>Request changes</button>
          </div>
        </section>
      )}
      <div className="pr-changes-body">
      <PanelGroup direction="horizontal" autoSaveId="strand:pull-request-changes-v2">
        <Panel defaultSize={22} minSize={14} maxSize={36}>
          <div
            className="pr-file-tree"
            aria-label="Changed files"
          >
            <div className="pr-file-count">
              <span>{viewedCount}/{files.length} viewed · {unresolvedCount} unresolved</span>
              <div className="pr-review-filters" role="group" aria-label="Changed file filter">
                {(['all', 'unviewed', 'threads'] as const).map((filter) => (
                  <button
                    type="button"
                    key={filter}
                    aria-pressed={reviewFilter === filter}
                    onClick={() => setReviewFilter(filter)}
                  >
                    {filter === 'all' ? 'All' : filter === 'unviewed' ? 'Unviewed' : 'Threads'}
                  </button>
                ))}
              </div>
            </div>
            <PierreTree
              paths={treePaths}
              gitStatus={treeStatus}
              selectedPath={selectedPath}
              followFocus
              onSelect={(next) => {
                if (!next) setSelectedPath(null);
                else if (filesByPath.has(next)) setSelectedPath(next);
              }}
              onActivate={(paths) => {
                if (paths.length === 1) toggleViewed(paths[0]);
              }}
              menuItems={(paths, context) => context.kind === 'file' && paths.length === 1 ? [{
                label: verdicts.get(paths[0]) === 'viewed' ? 'Mark unviewed' : 'Mark viewed',
                onSelect: () => toggleViewed(paths[0]),
                disabled: !viewedLoaded,
              }] : []}
              rowDecoration={(filePath, kind) => {
                if (kind !== 'file') return null;
                const verdict = verdicts.get(filePath);
                const threads = unresolvedByPath.get(filePath) ?? 0;
                const text = [
                  verdict === 'viewed' ? '✓' : verdict === 'changed' ? 'changed' : '',
                  threads > 0 ? `${threads}` : '',
                ].filter(Boolean).join(' · ');
                if (!text) return null;
                return {
                  text,
                  title: [
                    verdict === 'viewed' ? 'Viewed' : verdict === 'changed' ? 'Changed since viewed' : '',
                    threads > 0 ? `${threads} unresolved ${threads === 1 ? 'thread' : 'threads'}` : '',
                  ].filter(Boolean).join(' · '),
                };
              }}
              rowDecorationKey={`${pr.source_commit}:${Object.entries(viewed).sort().join('|')}:${[...unresolvedByPath].join('|')}`}
              emptyLabel={reviewFilter === 'all' ? 'No changed files.' : `No ${reviewFilter === 'unviewed' ? 'unviewed files' : 'files with unresolved threads'}.`}
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
                      className={`pr-viewed-toggle${verdicts.get(selectedFile.name) === 'viewed' ? ' on' : ''}`}
                      onClick={() => toggleViewed(selectedFile.name)}
                      disabled={!viewedLoaded}
                      aria-pressed={verdicts.get(selectedFile.name) === 'viewed'}
                      title="Toggle viewed (V)"
                    >
                      <Icon name="check" size={12} />
                      {verdicts.get(selectedFile.name) === 'viewed' ? 'Viewed' : verdicts.get(selectedFile.name) === 'changed' ? 'Changed' : 'Mark viewed'}
                    </button>
                    <DiffLayoutToggle />
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
                    layout={toPierreLayout(diffMode)}
                    hideFileHeader
                    className="pr-review-diff"
                    selectedLines={selectedLines}
                    lineAnnotations={inlineAnnotations}
                    onLineSelected={inlineCommentsSupported ? selectLines : undefined}
                    onGutterUtilityClick={inlineCommentsSupported ? openInlineComment : undefined}
                    renderAnnotation={(annotation) => {
                      if (annotation.metadata.kind === 'thread') {
                        const thread = annotation.metadata.thread;
                        return (
                          <PullRequestInlineThread
                            thread={thread}
                            prUrl={pr.url}
                            canWrite={openForReview}
                            replying={replyingThreadId === thread.id}
                            replyDraft={replyDrafts[thread.id] ?? ''}
                            writeKind={threadWrites[thread.id]}
                            message={threadMessages[thread.id]}
                            platform={platform}
                            onStartReply={() => startThreadReply(thread.id)}
                            onCancelReply={() => cancelThreadReply(thread.id)}
                            onReplyDraft={(value) => setThreadReplyDraft(thread.id, value)}
                            onSubmitReply={() => { void submitThreadReply(thread); }}
                            onSetResolved={(resolved) => { void setThreadResolved(thread, resolved); }}
                          />
                        );
                      }
                      if (annotation.metadata.kind === 'draft') {
                        const { comment, index } = annotation.metadata;
                        return (
                          <article className="pr-inline-thread pending" tabIndex={0} aria-label={`Pending review comment on ${comment.path} line ${comment.end_line}`}>
                            <header>
                              <div>
                                <strong>Pending review</strong>
                                <span>{comment.side === 'deletions' ? 'old' : 'new'} line{comment.start_line === comment.end_line ? '' : 's'} {comment.start_line === comment.end_line ? comment.end_line : `${comment.start_line}–${comment.end_line}`}</span>
                              </div>
                              <button type="button" className="h-link danger" onClick={() => removePendingComment(index)}>Remove</button>
                            </header>
                            <div className="pr-inline-thread-body">{renderMarkdown(comment.body)}</div>
                          </article>
                        );
                      }
                      return selectedLines ? (
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
                          <button type="button" className="btn" disabled={!commentDraft.trim() || postingComment || !reviewDraftLoaded} onClick={addPendingComment}>
                            Add to review
                          </button>
                          <button type="submit" className="btn primary" disabled={!commentDraft.trim() || postingComment}>
                            {postingComment ? 'Adding…' : 'Add comment'}
                          </button>
                        </div>
                      </form>
                      ) : null;
                    }}
                  />
                )}
              </>
            )}
          </div>
        </Panel>
      </PanelGroup>
      </div>
    </div>
  );
}

type DetailTab = 'summary' | 'timeline' | 'code';
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'code', label: 'Code' },
];

function PullRequestDetailTabs({
  pr,
  tab,
  onSelect,
}: {
  pr: PullRequest;
  tab: DetailTab;
  onSelect: (tab: DetailTab) => void;
}) {
  const tabIndex = DETAIL_TABS.findIndex((item) => item.id === tab);
  const selectTab = (next: DetailTab) => {
    onSelect(next);
    requestAnimationFrame(() => document.getElementById(`pr-tab-${pr.id}-${next}`)?.focus());
  };
  return (
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
        const count = item.id === 'timeline' ? pr.comment_count + pr.commits.length : item.id === 'code' ? pr.changed_files : null;
        return (
          <button
            type="button"
            role="tab"
            id={`pr-tab-${pr.id}-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`pr-panel-${pr.id}-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            key={item.id}
            onClick={() => onSelect(item.id)}
          >
            {item.label}{count != null ? <span>{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function PullRequestDetails({
  path,
  provider,
  pr,
  tab,
  onTabChange,
  onPage,
  onUpdated,
  onToast,
  followed,
  notificationPermission,
  onToggleFollow,
  onCreateWorktree,
}: {
  path: string;
  provider: PullRequestList['repository']['provider'];
  pr: PullRequest;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onPage: (page: PullRequestDataPage) => void;
  onUpdated: (next: PullRequest) => void;
  onToast: (message: string, kind?: 'success' | 'error') => void;
  followed: boolean;
  notificationPermission: 'unknown' | 'granted' | 'denied';
  onToggleFollow: () => void;
  onCreateWorktree: (start: { ref: string; label: string; branch: string }) => void;
}) {
  const [commentDraft, setCommentDraft] = useState('');
  const [changesTarget, setChangesTarget] = useState<PullRequestChangesTarget | null>(null);
  const [lifecycleMenu, setLifecycleMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);
  const [prActionBusy, setPrActionBusy] = useState(false);
  const changesRequest = useRef(0);
  const open = () => { if (pr.url) void shellOpen(pr.url); };
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
  const lifecycleAction = isOpenPullRequest(pr)
    ? 'close'
    : isReopenablePullRequest(pr)
      ? 'reopen'
      : null;
  useEffect(() => {
    const openReview = () => {
      if (!isOpenPullRequest(pr)) {
        onToast('Only an open pull request can be reviewed.', 'error');
        return;
      }
      onTabChange('code');
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('strand:pull-request-review-open')), 50);
    };
    window.addEventListener('strand:pull-request-review', openReview);
    return () => window.removeEventListener('strand:pull-request-review', openReview);
  }, [onTabChange, onToast, pr]);
  const setLifecycle = async (action: 'close' | 'reopen') => {
    if (prActionBusy) return;
    setPrActionBusy(true);
    try {
      await tauri.repoPullRequestLifecycle(path, pr.id, action);
      let next: PullRequest;
      try {
        next = await tauri.repoPullRequest(path, pr.id);
      } catch (refreshError) {
        onToast(
          `PR #${pr.id} was ${action === 'close' ? 'closed' : 'reopened'}, but it could not refresh: ${errMessage(refreshError)}`,
          'error',
        );
        return;
      }
      onUpdated(next);
      onToast(`${action === 'close' ? 'Closed' : 'Reopened'} PR #${pr.id}`);
    } catch (caught) {
      onToast(`Could not ${action} PR #${pr.id}: ${errMessage(caught)}`, 'error');
    } finally {
      setPrActionBusy(false);
    }
  };
  const openBranchInWorktree = useCallback(async () => {
    if (prActionBusy) return;
    if (!pr.source_commit) {
      onToast('Refresh this pull request before opening its branch.', 'error');
      return;
    }
    setPrActionBusy(true);
    try {
      const prepared = await tauri.repoPullRequestPrepareCheckout(path, pr.id, pr.source_commit);
      onCreateWorktree({
        ref: prepared.start_point,
        label: `PR #${pr.id} · ${prepared.branch}`,
        branch: `pr-${pr.id}-${prepared.branch.replace(/\//g, '-')}`,
      });
    } catch (caught) {
      onToast(`Could not prepare PR #${pr.id} for a worktree: ${errMessage(caught)}`, 'error');
    } finally {
      setPrActionBusy(false);
    }
  }, [onCreateWorktree, onToast, path, pr.id, pr.source_commit, prActionBusy]);
  const updatePrBranch = useCallback(async () => {
    if (prActionBusy) return;
    if (provider !== 'git_hub' || !isOpenPullRequest(pr)) {
      onToast('Provider branch updates are available for open GitHub pull requests.', 'error');
      return;
    }
    if (!pr.source_commit) {
      onToast('Refresh this pull request before updating its branch.', 'error');
      return;
    }
    setPrActionBusy(true);
    try {
      await tauri.repoPullRequestUpdateBranch(path, pr.id, pr.source_commit);
      onToast(`GitHub started updating PR #${pr.id}; refresh after the new head is ready.`);
    } catch (caught) {
      onToast(`Could not update PR #${pr.id}: ${errMessage(caught)}`, 'error');
    } finally {
      setPrActionBusy(false);
    }
  }, [onToast, path, pr, prActionBusy, provider]);
  useEffect(() => {
    const openWorktree = () => { void openBranchInWorktree(); };
    const updateBranch = () => { void updatePrBranch(); };
    window.addEventListener('strand:pull-request-open-worktree', openWorktree);
    window.addEventListener('strand:pull-request-update-branch', updateBranch);
    return () => {
      window.removeEventListener('strand:pull-request-open-worktree', openWorktree);
      window.removeEventListener('strand:pull-request-update-branch', updateBranch);
    };
  }, [openBranchInWorktree, updatePrBranch]);
  const openLifecycleMenu = (button: HTMLButtonElement) => {
    if (prActionBusy) return;
    const rect = button.getBoundingClientRect();
    const items: MenuItem[] = [{
      label: 'Open branch in worktree…',
      icon: 'worktree',
      disabled: !pr.source_commit,
      onSelect: () => { void openBranchInWorktree(); },
    }];
    if (provider === 'git_hub' && isOpenPullRequest(pr)) {
      items.push({
        label: 'Update branch from target',
        icon: 'refresh',
        confirm: true,
        disabled: !pr.source_commit,
        onSelect: () => { void updatePrBranch(); },
      });
    }
    if (lifecycleAction) {
      items.push({
        label: lifecycleAction === 'close' ? 'Close pull request' : 'Reopen pull request',
        icon: lifecycleAction === 'close' ? 'x' : 'refresh',
        danger: lifecycleAction === 'close',
        confirm: lifecycleAction === 'close',
        onSelect: () => { void setLifecycle(lifecycleAction); },
      });
    }
    setLifecycleMenu({
      x: rect.right,
      y: rect.bottom,
      items,
    });
  };
  const viewCommentInCode = (comment: PullRequestComment) => {
    if (!comment.path) return;
    const thread = (pr.review_threads ?? []).find((candidate) =>
      candidate.comments.some((item) => item.id === comment.id));
    changesRequest.current += 1;
    setChangesTarget({
      path: comment.path,
      threadId: thread?.id ?? null,
      requestId: changesRequest.current,
    });
    onTabChange('code');
  };
  const completeChangesNavigation = useCallback((requestId: number) => {
    setChangesTarget((current) => current?.requestId === requestId ? null : current);
  }, []);

  return (
    <article className="pr-detail" aria-label={`Pull request ${pr.id}: ${pr.title}`}>
      <header className="pr-detail-head">
        <div>
          <div className="pr-detail-kicker">{pr.author} · {relativeTimeLabel(pr.created_at)} · {displayState(pr)}</div>
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
          {isOpenPullRequest(pr) && (
            <PullRequestMergeControl
              path={path}
              provider={provider}
              pr={pr}
              disabledReason={mergeDisabledReason}
              onMerged={onUpdated}
              onToast={onToast}
            />
          )}
          <button
            type="button"
            className="btn icon-btn"
            aria-label="Pull request actions"
            aria-haspopup="menu"
            aria-expanded={lifecycleMenu != null}
            disabled={prActionBusy}
            title={prActionBusy ? 'Updating pull request…' : 'Pull request actions'}
            onClick={(event) => openLifecycleMenu(event.currentTarget)}
          >
            <Icon name={prActionBusy ? 'refresh' : 'more'} size={13} className={prActionBusy ? 'spin' : undefined} />
          </button>
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
      <PullRequestDataLoader path={path} pr={pr} onPage={onPage} />
      {lifecycleMenu && (
        <ContextMenu
          x={lifecycleMenu.x}
          y={lifecycleMenu.y}
          items={lifecycleMenu.items}
          onClose={() => setLifecycleMenu(null)}
        />
      )}

      <div
        className={`pr-tab-panel ${tab}`}
        role="tabpanel"
        id={`pr-panel-${pr.id}-${tab}`}
        aria-labelledby={`pr-tab-${pr.id}-${tab}`}
      >
        {tab === 'summary' && (
          <PullRequestSummary
            path={path}
            provider={provider}
            pr={pr}
            draft={commentDraft}
            onDraft={setCommentDraft}
            onUpdated={onUpdated}
            onToast={onToast}
          />
        )}
        {tab === 'timeline' && (
          <PullRequestTimeline
            path={path}
            pr={pr}
            draft={commentDraft}
            onDraft={setCommentDraft}
            onUpdated={onUpdated}
            onViewInCode={viewCommentInCode}
          />
        )}
        {tab === 'code' && (
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
  onCreateWorktree,
}: {
  onToast: (message: string, kind?: 'success' | 'error') => void;
  onCreateWorktree: (start: { ref: string; label: string; branch: string }) => void;
}) {
  const path = useRepo((state) => state.activePath);
  const meta = useRepo((state) => state.meta);
  const refs = useRepo((state) => state.refs);
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
  const followBranchMatch = usePullRequests((state) => state.followBranchMatch);
  const [data, setData] = useState<PullRequestList | null>(null);
  const [inboxFilter, setInboxFilter] = useState<PullRequestInboxFilter>('all');
  const [inboxQuery, setInboxQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [openedId, setOpenedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PullRequest | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('summary');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState<'manual' | 'ai' | false>(false);
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
      setData((current) => current ? { ...next, pull_requests: uniqueBy(next.pull_requests, current.pull_requests.filter((item) => !next.pull_requests.some((pr) => pr.id === item.id)), (pr) => pr.id) } : next);
      setSelectedId((selected) =>
        !shouldAutoOpen && selected != null
          ? selected
          : preferredId);
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
    setInboxFilter('all');
    setInboxQuery('');
    setSelectedId(null);
    setOpenedId(null);
    setDetail(null);
    setError(null);
    setDetailError(null);
    visibleActivity.current = null;
  }, [path]);

  useEffect(() => {
    setDetailTab('summary');
  }, [path, openedId]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
      detailGeneration.current += 1;
    };
  }, [refresh]);

  const filteredPullRequests = useMemo(
    () => filterPullRequests(data?.pull_requests ?? [], inboxFilter, inboxQuery),
    [data, inboxFilter, inboxQuery],
  );
  const selectedSummary = useMemo(
    () => filteredPullRequests.find((pr) => pr.id === selectedId) ?? null,
    [filteredPullRequests, selectedId],
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
    if (openedId != null) return;
    setSelectedId((current) => reconcilePullRequestSelection(filteredPullRequests, current));
  }, [filteredPullRequests, openedId]);

  useEffect(() => {
    const focusSearch = () => {
      setOpenedId(null);
      requestAnimationFrame(() => document.getElementById('pr-inbox-search')?.focus());
    };
    window.addEventListener('strand:pull-request-search', focusSearch);
    return () => window.removeEventListener('strand:pull-request-search', focusSearch);
  }, []);

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
    if (!filteredPullRequests.length) return;
    const index = Math.max(0, filteredPullRequests.findIndex((pr) => pr.id === selectedId));
    const next = Math.min(filteredPullRequests.length - 1, Math.max(0, index + delta));
    setSelectedId(filteredPullRequests[next].id);
    document.getElementById(`pr-row-${filteredPullRequests[next].id}`)?.scrollIntoView({ block: 'nearest' });
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
      pull_requests: current.pull_requests.map((item) => item.id === next.id
        ? { ...next, authored_by_viewer: item.authored_by_viewer }
        : item),
    } : current);
    // The next visible activity poll becomes the new baseline instead of
    // treating our own provider write as a remote change and reloading detail.
    visibleActivity.current = null;
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

  const createdPullRequest = useCallback((outcome: PullRequestCreateOutcome) => {
    setCreateOpen(false);
    onToast(`Created pull request #${outcome.id}`);
    if (!path || !currentBranch) return;
    void tauri.repoPullRequestForBranch(path, currentBranch).then((match) => {
      if (!match) {
        void refresh();
        return;
      }
      setData((current) => ({
        repository: current?.repository ?? match.repository,
        pull_requests: [
          { ...match.pull_request, authored_by_viewer: true },
          ...(current?.pull_requests.filter((item) => item.id !== match.pull_request.id) ?? []),
        ],
      }));
      setSelectedId(match.pull_request.id);
      setOpenedId(match.pull_request.id);
      setDetail(null);
      void followBranchMatch(path, match).catch(() => {});
    }, () => {
      void refresh();
    });
  }, [currentBranch, followBranchMatch, onToast, path, refresh]);

  const requestMergeMenu = useCallback((pr: PullRequest | null) => {
    if (pr && canMarkPullRequestReady(pr)) {
      window.dispatchEvent(new CustomEvent('strand:pull-request-ready'));
      return;
    }
    if (!pr || !['open', 'active'].includes(pr.state)) {
      onToast('Open an active pull request before merging.', 'error');
      return;
    }
    if (pr.is_draft) {
      onToast('The signed-in provider account cannot mark this draft ready for review.', 'error');
      return;
    }
    if (!pr.source_commit) {
      onToast('Refresh this pull request before merging.', 'error');
      return;
    }
    window.dispatchEvent(new CustomEvent('strand:pull-request-merge-menu'));
  }, [onToast]);

  useEffect(() => {
    const onMergeRequest = () => requestMergeMenu(detail);
    window.addEventListener('strand:pull-request-merge', onMergeRequest);
    return () => window.removeEventListener('strand:pull-request-merge', onMergeRequest);
  }, [detail, requestMergeMenu]);

  useEffect(() => {
    const onCreateRequest = (event: Event) => {
      if (!path || !currentBranch) {
        onToast('Check out a branch before creating a pull request.', 'error');
        return;
      }
      setCreateOpen((event as CustomEvent<{ autoFill?: boolean }>).detail?.autoFill ? 'ai' : 'manual');
    };
    window.addEventListener('strand:pull-request-create', onCreateRequest);
    return () => window.removeEventListener('strand:pull-request-create', onCreateRequest);
  }, [currentBranch, onToast, path]);

  return (
    <div className="pr-view">
      {createOpen && path && data && currentBranch ? (
        <PullRequestCreateDialog
          path={path}
          provider={data.repository.provider}
          sourceBranch={currentBranch}
          refs={refs}
          knownTargets={data.pull_requests.map((pr) => pr.target_branch)}
          commonDir={meta?.common_dir ?? path}
          autoFill={createOpen === 'ai'}
          onCreated={createdPullRequest}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
      <div className={`pr-toolbar${openedId != null && detail ? ' detail' : ''}`}>
        <div>
          {openedId != null ? (
            <button type="button" className="h-link pr-back" onClick={closePullRequest}>
              <Icon name="chev-left" size={12} /> Pull Requests
            </button>
          ) : null}
          {data && openedSummary ? (
            <span>#{openedSummary.id} · {openedSummary.title}</span>
          ) : null}
        </div>
        {openedId != null && detail ? (
          <PullRequestDetailTabs pr={detail} tab={detailTab} onSelect={setDetailTab} />
        ) : null}
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
          <button
            type="button"
            className="btn pr-create-button"
            disabled={!path || !data || !currentBranch}
            title={currentBranch ? `Create a pull request from ${currentBranch}` : 'Check out a branch first'}
            onClick={() => setCreateOpen('manual')}
          >
            <Icon name="plus" size={12} />
            Create PR
          </button>
        </div>
      </div>

      {error && !data ? (
        <EmptyState
          icon="remote"
          title="Pull requests are not available yet"
          hint={<>{error}<br />Strand uses the signed-in provider CLI so it never stores your access token.</>}
          action={<button type="button" className="btn" onClick={manualRefresh}>Try again</button>}
        />
      ) : loading && !data ? (
        <EmptyState icon="refresh" spinning title="Loading pull requests…" />
      ) : data && data.pull_requests.length === 0 ? (
        <EmptyState
          icon="check"
          title="No pull requests found"
          hint="No pull requests were returned by the provider."
        />
      ) : data ? (
        <div className="pr-main">
          {openedId == null ? (
            <div className="pr-list-screen">
              <PaneHeader
                title="Pull requests"
                meta={
                  <>
                    Review and track work across {providerName(data.repository.provider)}
                    {data.repository.viewer ? <> as <strong>{data.repository.viewer}</strong></> : null}.
                  </>
                }
              />
              {path && <PullRequestInboxLoader path={path} data={data} onPage={(page) => setData((current) => current ? { ...page, pull_requests: uniqueBy(current.pull_requests, page.pull_requests, (pr) => pr.id) } : page)} />}
              <div className="pr-inbox-controls">
                <label className="pr-inbox-search" htmlFor="pr-inbox-search">
                  <Icon name="search" size={17} />
                  <input
                    id="pr-inbox-search"
                    type="search"
                    value={inboxQuery}
                    placeholder="Search pull requests"
                    autoComplete="off"
                    onChange={(event) => setInboxQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown' && filteredPullRequests.length) {
                        event.preventDefault();
                        document.getElementById('pr-listbox')?.focus();
                      }
                    }}
                  />
                  {inboxQuery && (
                    <button type="button" onClick={() => setInboxQuery('')} aria-label="Clear pull request search">
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </label>
                <div
                  className="pr-inbox-filters"
                  role="tablist"
                  aria-label="Pull request filter"
                  onKeyDown={(event) => {
                    const filters: PullRequestInboxFilter[] = ['all', 'authored', 'completed'];
                    const index = filters.indexOf(inboxFilter);
                    let next = index;
                    if (event.key === 'ArrowRight') next = (index + 1) % filters.length;
                    else if (event.key === 'ArrowLeft') next = (index - 1 + filters.length) % filters.length;
                    else if (event.key === 'Home') next = 0;
                    else if (event.key === 'End') next = filters.length - 1;
                    else return;
                    event.preventDefault();
                    setInboxFilter(filters[next]);
                    requestAnimationFrame(() => document.getElementById(`pr-filter-${filters[next]}`)?.focus());
                  }}
                >
                  {([
                    ['all', 'All', data.pull_requests.length],
                    ['authored', 'Authored', data.pull_requests.filter((pr) => pr.authored_by_viewer).length],
                    ['completed', 'Completed', data.pull_requests.filter((pr) => ['merged', 'closed', 'completed', 'abandoned'].includes(pr.state.toLowerCase())).length],
                  ] as const).map(([id, label, count]) => (
                    <button
                      type="button"
                      role="tab"
                      id={`pr-filter-${id}`}
                      aria-selected={inboxFilter === id}
                      tabIndex={inboxFilter === id ? 0 : -1}
                      key={id}
                      onClick={() => setInboxFilter(id)}
                    >
                      {label}<span>{count}</span>
                    </button>
                  ))}
                </div>
              </div>
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
                  else if (event.key === 'Home') { event.preventDefault(); setSelectedId(filteredPullRequests[0]?.id ?? null); }
                  else if (event.key === 'End') { event.preventDefault(); setSelectedId(filteredPullRequests.at(-1)?.id ?? null); }
                  else if (event.key === 'Enter' && selectedSummary) { event.preventDefault(); openPullRequest(selectedSummary.id); }
                }}
              >
                {filteredPullRequests.map((pr) => {
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
                    <span className="pr-row-symbol" aria-hidden="true"><Icon name="branch" size={18} /></span>
                    <span className="pr-row-content">
                      <strong>{pr.title}</strong>
                      <span className="pr-row-meta"><b>{pr.author}</b> · {data.repository.label} · <code>{pr.source_branch}</code></span>
                    </span>
                    <span className="pr-row-trailing">
                      <time dateTime={pr.updated_at || pr.created_at}>{relativeTimeLabel(pr.updated_at || pr.created_at)}</time>
                      <span className="pr-row-status">
                        {isFollowed && <span className="pr-followed-badge" title="Following"><Icon name="bell" size={11} /> Following</span>}
                        <span className={`pr-state ${displayState(pr)}`}>{displayState(pr)}</span>
                      </span>
                      {(pr.additions != null || pr.deletions != null) && (
                        <span className="pr-row-diff"><span>+{pr.additions ?? 0}</span><span>−{pr.deletions ?? 0}</span></span>
                      )}
                    </span>
                  </button>
                  );
                })}
                {filteredPullRequests.length === 0 && (
                  <div className="pr-inbox-empty" role="status">
                    <Icon name={inboxFilter === 'completed' ? 'check' : 'search'} size={22} />
                    <strong>{inboxFilter === 'authored' && !data.repository.viewer
                      ? 'Signed-in account unavailable'
                      : inboxQuery ? 'No matching pull requests' : `No ${inboxFilter} pull requests`}</strong>
                    <p>{inboxFilter === 'authored' && !data.repository.viewer
                      ? `Strand could not identify the account signed into ${providerName(data.repository.provider)}. Refresh after signing in again.`
                      : 'Try another filter or search term.'}</p>
                  </div>
                )}
              </div>
            </div>
          ) : detail && path ? (
            <PullRequestDetails
              key={`${path}:${detail.id}`}
              path={path}
              provider={data.repository.provider}
              pr={detail}
              tab={detailTab}
              onTabChange={setDetailTab}
              onUpdated={updatePullRequest}
              onPage={(page) => setDetail((current) => current ? appendPullRequestPage(current, page) : current)}
              onToast={onToast}
              followed={Boolean(openedFollowed)}
              notificationPermission={notificationPermission}
              onToggleFollow={toggleFollow}
              onCreateWorktree={onCreateWorktree}
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
