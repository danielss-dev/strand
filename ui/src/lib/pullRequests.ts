import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';

import { hashPatch } from './patch';
import type { PullRequest } from './types';

export type CheckTone = 'success' | 'running' | 'failed' | 'neutral';

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
