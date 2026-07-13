import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';

import { hashPatch } from './patch';
import type { PullRequest, PullRequestProvider } from './types';

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

  if (provider === 'azure_dev_ops') {
    unknown.push('Azure policy and check details are not reported by this integration.');
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
