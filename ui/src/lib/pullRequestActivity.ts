import type {
  PullRequestActivitySnapshot,
  PullRequestRepository,
} from './types';

export type PullRequestActivityEvent =
  | { kind: 'comments'; count: number; authors: string[] }
  | { kind: 'reviews'; decisions: string[] }
  | { kind: 'failed-checks'; names: string[] }
  | { kind: 'push'; branch: string }
  | { kind: 'terminal'; state: 'merged' | 'closed' };

export function pullRequestFollowKey(repository: PullRequestRepository, id: number): string {
  return `${repository.provider}:${repository.label}:${id}`;
}

function normalized(value: string): string {
  return value.trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');
}

function failedCheck(status: string): boolean {
  return ['FAILURE', 'FAILED', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'REJECTED', 'BROKEN']
    .includes(normalized(status));
}

function terminalState(state: string): 'merged' | 'closed' | null {
  const value = normalized(state);
  if (value === 'MERGED' || value === 'COMPLETED') return 'merged';
  if (value === 'CLOSED' || value === 'ABANDONED') return 'closed';
  return null;
}

function reviewDecision(state: string): string | null {
  const value = normalized(state);
  if (value === 'APPROVED' || value === 'APPROVED_WITH_SUGGESTIONS') return 'approved';
  if (value === 'CHANGES_REQUESTED' || value === 'REJECTED' || value === 'WAITING_FOR_AUTHOR') {
    return 'requested changes';
  }
  return null;
}

export function pullRequestActivityEvents(
  previous: PullRequestActivitySnapshot | null,
  next: PullRequestActivitySnapshot,
): PullRequestActivityEvent[] {
  if (!previous) return [];
  const events: PullRequestActivityEvent[] = [];
  const previousComments = new Set(previous.comments.map((comment) => comment.id));
  const comments = next.comments.filter((comment) => !comment.is_system && !previousComments.has(comment.id));
  if (comments.length > 0) {
    events.push({
      kind: 'comments',
      count: comments.length,
      authors: [...new Set(comments.map((comment) => comment.author).filter(Boolean))],
    });
  }

  const previousReviews = new Map(previous.reviews.map((review) => [review.id, normalized(review.state)]));
  const decisions = next.reviews.flatMap((review) => {
    const decision = reviewDecision(review.state);
    if (!decision || previousReviews.get(review.id) === normalized(review.state)) return [];
    return [`${review.author} ${decision}`];
  });
  if (decisions.length > 0) events.push({ kind: 'reviews', decisions });

  const previousChecks = new Map(previous.checks.map((check) => [check.id, check.status]));
  const failed = next.checks
    .filter((check) => failedCheck(check.status) && !failedCheck(previousChecks.get(check.id) ?? ''))
    .map((check) => check.name);
  if (failed.length > 0) events.push({ kind: 'failed-checks', names: [...new Set(failed)] });

  if (previous.source_commit && next.source_commit && previous.source_commit !== next.source_commit) {
    events.push({ kind: 'push', branch: next.source_branch });
  }

  const previousTerminal = terminalState(previous.state);
  const nextTerminal = terminalState(next.state);
  if (!previousTerminal && nextTerminal) events.push({ kind: 'terminal', state: nextTerminal });
  return events;
}

export function pullRequestActivityChanged(
  previous: PullRequestActivitySnapshot,
  next: PullRequestActivitySnapshot,
): boolean {
  const fingerprint = (snapshot: PullRequestActivitySnapshot) => JSON.stringify({
    state: snapshot.state,
    source_commit: snapshot.source_commit,
    updated_at: snapshot.updated_at,
    checks_complete: snapshot.checks_complete,
    comments: snapshot.comments.map((comment) => [comment.id, comment.is_system]),
    reviews: snapshot.reviews.map((review) => [review.id, review.state]),
    checks: snapshot.checks.map((check) => [check.id, check.status]),
  });
  return fingerprint(previous) !== fingerprint(next);
}

export function pullRequestNotificationBody(events: readonly PullRequestActivityEvent[]): string {
  return events.map((event) => {
    if (event.kind === 'comments') {
      const who = event.authors.length === 1 ? `${event.authors[0]} added ` : '';
      return `${who}${event.count} new ${event.count === 1 ? 'comment' : 'comments'}`;
    }
    if (event.kind === 'reviews') return event.decisions.join(', ');
    if (event.kind === 'failed-checks') return `Failed: ${event.names.join(', ')}`;
    if (event.kind === 'push') return `New commits pushed to ${event.branch}`;
    return event.state === 'merged' ? 'Pull request merged' : 'Pull request closed';
  }).join(' · ');
}

export function isTerminalPullRequest(snapshot: PullRequestActivitySnapshot): boolean {
  return terminalState(snapshot.state) != null;
}
