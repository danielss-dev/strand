import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';

import { hashPatch } from './patch';
import { match } from './fuzzy';
import type {
  PullRequest,
  PullRequestComment,
  PullRequestCommit,
  PullRequestProvider,
  PullRequestReviewThreadUpdate,
} from './types';

export type PullRequestInboxFilter = 'all' | 'authored' | 'completed';

export type PullRequestTimelineEvent =
  | { kind: 'opened'; id: string; at: string }
  | { kind: 'commit'; id: string; at: string; commit: PullRequestCommit }
  | { kind: 'comment'; id: string; at: string; comment: PullRequestComment }
  | { kind: 'completed'; id: string; at: string; state: 'merged' | 'closed' };

export function isCompletedPullRequest(pr: PullRequest): boolean {
  return ['merged', 'closed', 'completed', 'abandoned'].includes(pr.state.toLowerCase());
}

export function filterPullRequests(
  pullRequests: readonly PullRequest[],
  filter: PullRequestInboxFilter,
  query: string,
): PullRequest[] {
  const normalizedQuery = query.trim().toLowerCase();
  return pullRequests
    .map((pr, index) => ({ pr, index }))
    .filter(({ pr }) => {
      if (filter === 'authored' && !pr.authored_by_viewer) return false;
      if (filter === 'completed' && !isCompletedPullRequest(pr)) return false;
      return true;
    })
    .map(({ pr, index }) => {
      if (!normalizedQuery) return { pr, index, score: 0 };
      const result = match(
        normalizedQuery,
        pr.title,
        `#${pr.id} ${pr.author} ${pr.source_branch} ${pr.target_branch}`,
      );
      return result ? { pr, index, score: result.score } : null;
    })
    .filter((result): result is { pr: PullRequest; index: number; score: number } => result != null)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ pr }) => pr);
}

export function reconcilePullRequestSelection(
  pullRequests: readonly PullRequest[],
  selectedId: number | null,
): number | null {
  if (selectedId != null && pullRequests.some((pr) => pr.id === selectedId)) return selectedId;
  return pullRequests[0]?.id ?? null;
}

export function buildPullRequestTimeline(pr: PullRequest): PullRequestTimelineEvent[] {
  const fallbackAt = pr.updated_at || pr.created_at;
  const events: PullRequestTimelineEvent[] = [
    { kind: 'opened', id: `opened:${pr.id}`, at: pr.created_at },
  ];
  for (const commit of pr.commits) {
    events.push({
      kind: 'commit',
      id: `commit:${commit.id}`,
      at: commit.committed_at || fallbackAt,
      commit,
    });
  }
  const seenComments = new Set<string>();
  for (const comment of pr.comments) {
    if (seenComments.has(comment.id)) continue;
    seenComments.add(comment.id);
    events.push({
      kind: 'comment',
      id: `comment:${comment.id}`,
      at: comment.created_at || fallbackAt,
      comment,
    });
  }
  if (pr.completed_at && isCompletedPullRequest(pr)) {
    events.push({
      kind: 'completed',
      id: `completed:${pr.id}`,
      at: pr.completed_at,
      state: ['merged', 'completed'].includes(pr.state.toLowerCase()) ? 'merged' : 'closed',
    });
  }
  const rank = { opened: 0, commit: 1, comment: 2, completed: 3 } as const;
  return events.sort((left, right) => {
    const leftAt = Date.parse(left.at);
    const rightAt = Date.parse(right.at);
    const time = (Number.isNaN(leftAt) ? 0 : leftAt) - (Number.isNaN(rightAt) ? 0 : rightAt);
    return time || rank[left.kind] - rank[right.kind] || left.id.localeCompare(right.id);
  });
}

export type CheckTone = 'success' | 'running' | 'failed' | 'neutral';

export type PullRequestReadinessTone = 'ready' | 'blocked' | 'pending' | 'neutral';

export interface PullRequestReadiness {
  tone: PullRequestReadinessTone;
  label: string;
  summary: string;
  details: string[];
  checks: {
    passed: number;
    running: number;
    failed: number;
    unknown: number;
    total: number;
  };
  reviewLabel: string;
}

export function checkTone(status: string): CheckTone {
  const normalized = status.trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (['SUCCESS', 'SUCCEEDED', 'SUCCESSFUL', 'PASSED', 'PASS'].includes(normalized)) {
    return 'success';
  }
  if (['FAILURE', 'FAILED', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(normalized)) {
    return 'failed';
  }
  if (['IN_PROGRESS', 'PENDING', 'QUEUED', 'WAITING', 'EXPECTED', 'REQUESTED', 'RUNNING'].includes(normalized)) {
    return 'running';
  }
  return 'neutral';
}

function normalizedStatus(status: string): string {
  return status.trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');
}

function readableStatus(status: string): string {
  const value = status.trim().replaceAll('_', ' ').toLowerCase();
  return value ? value[0].toUpperCase() + value.slice(1) : '';
}

/**
 * Summarize only readiness signals the provider actually returned. In
 * particular, Azure does not expose its complete policy/check state through
 * the current CLI query, so absent policy data must never become “ready”.
 */
export function pullRequestReadiness(
  pr: PullRequest,
  provider: PullRequestProvider,
): PullRequestReadiness {
  const checks = { passed: 0, running: 0, failed: 0, unknown: 0, total: pr.checks.length };
  for (const check of pr.checks) {
    const tone = checkTone(check.status);
    if (tone === 'success') checks.passed += 1;
    else if (tone === 'running') checks.running += 1;
    else if (tone === 'failed') checks.failed += 1;
    else checks.unknown += 1;
  }

  const details: string[] = [];
  const pending: string[] = [];
  const unknown: string[] = [];
  const state = normalizedStatus(pr.state);
  const review = normalizedStatus(pr.review_status);
  const merge = normalizedStatus(pr.merge_status);
  const active = state === 'OPEN' || state === 'ACTIVE';

  if (!active) {
    const summary = state === 'COMPLETED' || state === 'MERGED'
      ? 'Merged pull request'
      : state === 'ABANDONED' || state === 'CLOSED'
        ? 'Closed pull request'
        : 'Inactive pull request';
    return {
      tone: 'neutral',
      label: 'Read-only history',
      summary,
      details,
      checks,
      reviewLabel: readableStatus(pr.review_status) || 'No review status',
    };
  }

  if (pr.is_draft) pending.push('Mark the pull request ready for review.');
  if (!pr.source_commit) details.push('Refresh to load the current source commit before merging.');

  if (checks.failed > 0) {
    details.push(`${checks.failed} ${checks.failed === 1 ? 'check is' : 'checks are'} failing.`);
  }
  if (checks.running > 0) {
    pending.push(`${checks.running} ${checks.running === 1 ? 'check is' : 'checks are'} still running.`);
  }
  if (checks.unknown > 0) {
    unknown.push(`${checks.unknown} ${checks.unknown === 1 ? 'check has' : 'checks have'} an unrecognized status.`);
  }

  if (review === 'CHANGES_REQUESTED' || review === 'REJECTED') {
    details.push('A reviewer requested changes.');
  } else if (review === 'REVIEW_REQUIRED' || review === 'REQUIRED') {
    pending.push('A required review is still pending.');
  } else if (review && review !== 'APPROVED') {
    unknown.push(`Review state “${readableStatus(pr.review_status)}” is not recognized.`);
  }

  const requiredReviewers = pr.reviewers.filter((reviewer) => reviewer.required);
  if (requiredReviewers.some((reviewer) => {
    const status = normalizedStatus(reviewer.status);
    return status === 'REJECTED' || status === 'CHANGES_REQUESTED' || status === 'WAITING_FOR_AUTHOR';
  })) {
    if (!details.includes('A reviewer requested changes.')) {
      details.push('A required reviewer requested changes.');
    }
  } else if (requiredReviewers.some((reviewer) => {
    const status = normalizedStatus(reviewer.status);
    return status === 'REQUESTED' || status === 'NO_VOTE' || status === 'PENDING';
  })) {
    if (!pending.includes('A required review is still pending.')) {
      pending.push('A required review is still pending.');
    }
  }

  if (['DIRTY', 'CONFLICTS', 'CONFLICT'].includes(merge)) {
    details.push('The source branch has merge conflicts.');
  } else if (['BLOCKED', 'REJECTED_BY_POLICY', 'FAILURE', 'FAILED'].includes(merge)) {
    if (details.length === 0) details.push('The provider reports that merging is blocked.');
  } else if (merge === 'BEHIND') {
    pending.push('The source branch is behind the target branch.');
  } else if (merge === 'UNSTABLE') {
    pending.push('The provider reports an unstable merge state.');
  } else if (merge === 'QUEUED') {
    pending.push('The provider is still evaluating merge readiness.');
  } else if (!['CLEAN', 'SUCCEEDED', 'HAS_HOOKS'].includes(merge)) {
    unknown.push(merge
      ? `Merge state “${readableStatus(pr.merge_status)}” is not recognized.`
      : 'Merge readiness was not reported.');
  }

  if (!pr.checks_complete) {
    unknown.push(provider === 'azure_dev_ops'
      ? 'Azure policy and check details could not be loaded.'
      : 'Provider check details could not be loaded.');
  }

  if (details.length > 0) {
    return {
      tone: 'blocked',
      label: `${details.length} ${details.length === 1 ? 'blocker' : 'blockers'}`,
      summary: 'Resolve before merging',
      details: [...details, ...pending, ...unknown],
      checks,
      reviewLabel: readableStatus(pr.review_status) || 'No review status',
    };
  }
  if (pending.length > 0) {
    return {
      tone: 'pending',
      label: pr.is_draft ? 'Draft pull request' : `${pending.length} ${pending.length === 1 ? 'item' : 'items'} pending`,
      summary: 'Not ready to merge yet',
      details: [...pending, ...unknown],
      checks,
      reviewLabel: readableStatus(pr.review_status) || 'No review status',
    };
  }
  if (unknown.length > 0) {
    return {
      tone: 'neutral',
      label: 'Status incomplete',
      summary: 'Provider will verify on merge',
      details: unknown,
      checks,
      reviewLabel: readableStatus(pr.review_status) || 'No review status',
    };
  }
  return {
    tone: 'ready',
    label: 'Ready to merge',
    summary: 'No blockers reported',
    details,
    checks,
    reviewLabel: readableStatus(pr.review_status) || 'No review required',
  };
}

export function relativeTimeLabel(value: string, now = Date.now()): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return 'Update time unavailable';
  const seconds = Math.round((date.getTime() - now) / 1_000);
  const absolute = Math.abs(seconds);
  if (absolute < 5) return 'just now';
  const compact = absolute < 60
    ? `${absolute}s`
    : absolute < 3_600
      ? `${Math.round(absolute / 60)}m`
      : absolute < 86_400
        ? `${Math.round(absolute / 3_600)}h`
        : `${Math.round(absolute / 86_400)}d`;
  return seconds < 0 ? `${compact} ago` : `in ${compact}`;
}

export function parsePullRequestPatch(patch: string): FileDiffMetadata[] {
  if (!patch.trim()) return [];
  return parsePatchFiles(patch, `pr:${hashPatch(patch)}`, true).flatMap((parsed) => parsed.files);
}

export function canMarkPullRequestReady(pr: PullRequest): boolean {
  return pr.is_draft
    && pr.can_mark_ready
    && ['open', 'active'].includes(pr.state.toLowerCase());
}

export function withPullRequestThreadReply(
  pr: PullRequest,
  threadId: string,
  reply: PullRequestComment,
): PullRequest {
  const thread = pr.review_threads.find((candidate) => candidate.id === threadId);
  if (!thread) return pr;
  const normalizedReply = reply.path ? reply : { ...reply, path: thread.path };
  const reviewThreads = pr.review_threads.map((candidate) => candidate.id === threadId
    ? {
        ...candidate,
        comments: candidate.comments.some((comment) => comment.id === reply.id)
          ? candidate.comments
          : [...candidate.comments, normalizedReply]
              .sort((left, right) => left.created_at.localeCompare(right.created_at)),
      }
    : candidate);
  const comments = [...pr.comments];
  if (!comments.some((comment) => comment.id === reply.id)) comments.push(normalizedReply);
  comments.sort((left, right) => left.created_at.localeCompare(right.created_at));
  return {
    ...pr,
    review_threads: reviewThreads,
    comments,
    comment_count: comments.length,
  };
}

export function withPullRequestThreadUpdate(
  pr: PullRequest,
  update: PullRequestReviewThreadUpdate,
): PullRequest {
  if (!pr.review_threads.some((thread) => thread.id === update.id)) return pr;
  return {
    ...pr,
    review_threads: pr.review_threads.map((thread) => thread.id === update.id
      ? { ...thread, ...update }
      : thread),
  };
}

export function diffStats(file: FileDiffMetadata): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === 'change') {
        additions += content.additions;
        deletions += content.deletions;
      }
    }
  }
  return { additions, deletions };
}

export function markdownUrl(href: string | undefined, baseUrl?: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, baseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

type BranchPullRequest = Pick<PullRequest, 'id' | 'source_branch' | 'state'>;

/** Active PR for the checked-out branch, if one exists. Closed/merged PRs
 *  must never pull the user away from the repository's PR list. */
export function pullRequestForBranch(
  pullRequests: readonly BranchPullRequest[],
  branch: string | null,
): BranchPullRequest | null {
  if (!branch) return null;
  const current = branch.replace(/^refs\/heads\//, '');
  return pullRequests.find((pullRequest) => {
    const source = pullRequest.source_branch.replace(/^refs\/heads\//, '');
    const state = pullRequest.state.toLowerCase();
    return source === current && (state === 'open' || state === 'active');
  }) ?? null;
}
