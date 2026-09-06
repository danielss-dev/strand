import type { PullRequest, PullRequestBoundary, PullRequestFeedback, PullRequestReviewThread, PullRequestSuggestionRequest } from './types';

/** Exact standard suggestion fences; offset forms have no guessed coordinates. */
export function suggestionBlocks(body: string): string[] {
  const result: string[] = [];
  let fence: { width: number; wanted: boolean; lines: string[] } | null = null;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (fence) {
      if (/^`+$/.test(trimmed) && trimmed.length >= fence.width) {
        if (fence.wanted) result.push(fence.lines.length ? fence.lines.join('\n') + '\n' : '');
        fence = null;
      } else fence.lines.push(line);
    } else {
      const width = trimmed.match(/^`{3,}/)?.[0].length;
      if (width) fence = { width, wanted: trimmed.slice(width).trim() === 'suggestion', lines: [] };
    }
  }
  return result;
}

export function reviewBoundaries(saved: { head: string; reviewedAt: string } | null, provider: PullRequestBoundary[]): PullRequestBoundary[] {
  const rows = saved ? [{ head: saved.head, label: `My reviewed head · ${saved.reviewedAt}`, iteration: null }, ...provider] : provider;
  const seen = new Set<string>();
  return rows.filter(row => /^[a-f0-9]{40}$/i.test(row.head) && !seen.has(row.head) && !!seen.add(row.head));
}

export function feedbackLocation(thread: PullRequestReviewThread): string {
  const line = thread.end_line > 0 ? `${thread.side === 'additions' ? 'new' : 'old'} lines ${thread.start_line}–${thread.end_line}` : 'file feedback';
  return thread.path ? `${thread.path} · ${line}` : 'Pull request feedback';
}

export function feedbackSuggestions(feedback: PullRequestFeedback): { key: string; label: string; request: PullRequestSuggestionRequest }[] {
  const seen = new Set<string>();
  return feedback.threads.filter(t => !t.is_resolved).flatMap(thread => thread.comments.flatMap(comment =>
    suggestionBlocks(comment.body).map((_, index) => ({
      key: JSON.stringify([thread.id, comment.id, index]),
      label: `${feedbackLocation(thread)} · ${comment.author} · suggestion ${index + 1}${thread.is_outdated ? ' · outdated' : ''}`,
      request: { thread_id: thread.id, comment_id: comment.id, suggestion_index: index, expected_head: feedback.source_commit, expected_body: comment.body },
    })),
  )).filter(row => !seen.has(row.key) && !!seen.add(row.key));
}

/** Literal quoted feedback keeps embedded headings/HTML separate from our context. */
export function exportHostedFeedback(pr: Pick<PullRequest, 'id' | 'title' | 'url'>, feedback: PullRequestFeedback): string {
  const literal = (text: string) => text.split(/\r?\n/).map(line => `> ${line}`).join('\n');
  const sections = [`# Unresolved pull request feedback`, literal(`#${pr.id} ${pr.title}\n${pr.url}`), `Source commit: ${feedback.source_commit}`, 'Snapshot of unresolved discussion. Old-side, outdated and prior-iteration coordinates are context, not instructions to edit current lines.'];
  const threads = new Set<string>();
  for (const thread of feedback.threads) {
    if (thread.is_resolved || threads.has(thread.id)) continue;
    threads.add(thread.id);
    sections.push(`## Thread ${threads.size}`, literal(`${feedbackLocation(thread)}\nThread ID: ${thread.id}\n${thread.is_outdated ? 'Outdated' : 'Provider has not marked outdated'}${thread.iteration_id != null ? ` · Azure iteration ${thread.iteration_id}` : ''}`));
    const comments = new Set<string>();
    for (const comment of thread.comments) {
      if (comments.has(comment.id) || comment.is_system) continue;
      comments.add(comment.id);
      sections.push(literal(`${comment.author} · ${comment.created_at}\nComment ID: ${comment.id}\n${comment.url}\n\n${comment.body}`));
    }
  }
  if (!threads.size) sections.push('No unresolved feedback.');
  return sections.join('\n\n') + '\n';
}
