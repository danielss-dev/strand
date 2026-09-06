import { describe, expect, it } from 'vitest';
import { exportHostedFeedback, feedbackSuggestions, reviewBoundaries, suggestionBlocks } from './hostedReview';
import type { PullRequestFeedback, PullRequestReviewThread } from './types';
const head = 'a'.repeat(40);
const thread = (id = 'T'): PullRequestReviewThread => ({ id, path: 'src/a.ts', start_line: 2, end_line: 3, side: 'additions', is_resolved: false, is_outdated: true, iteration_id: 2, can_reply: true, can_resolve: true, can_unresolve: false, comments: [{ id: 'C', author: 'Ada', avatar_url: null, created_at: '2026-09-06', body: '```suggestion\nreplacement\n```', url: 'https://example.test/pr/1#C', is_system: false, path: 'src/a.ts' }] });
describe('hosted review evolution', () => {
  it('retains immutable reviewed boundaries after a force push and prefers my saved boundary', () => {
    const saved = { head, reviewedAt: '2026-09-06' };
    const choices = reviewBoundaries(saved, [{ head, label: 'provider', iteration: null }, { head: 'b'.repeat(40), label: 'Iteration 2', iteration: 2 }, { head: 'branch-name', label: 'invalid', iteration: null }]);
    expect(choices).toHaveLength(2); expect(choices[0].label).toContain('My reviewed head'); expect(choices[0].head).toBe(head);
  });
  it('parses multiple, empty and blank-line suggestions without guessing offsets or nested fences', () => {
    expect(suggestionBlocks('```suggestion\nx\ny\n```\n```suggestion\n```\n```suggestion\n\n```')).toEqual(['x\ny\n', '', '\n']);
    expect(suggestionBlocks('```text\n```suggestion\nx\n```')).toEqual([]);
    expect(suggestionBlocks('```suggestion:-1+2\nx\n```')).toEqual([]);
    expect(suggestionBlocks('```suggestion\nunclosed')).toEqual([]);
  });
  it('pins a candidate to its original body, stable IDs and source head', () => {
    const t = thread();
    const feedback: PullRequestFeedback = { source_commit: head, threads: [t, t, { ...thread('resolved'), is_resolved: true }] };
    const choices = feedbackSuggestions(feedback);
    expect(choices).toHaveLength(1); expect(choices[0].label).toContain('outdated');
    expect(choices[0].request).toEqual({ thread_id: 'T', comment_id: 'C', suggestion_index: 0, expected_head: head, expected_body: t.comments[0].body });
  });
  it('exports 101 replies once with source, provider, old-side/iteration and file-level context', () => {
    const t = thread(); t.side = 'deletions';
    t.comments = Array.from({ length: 101 }, (_, id) => ({ ...t.comments[0], id: String(id), body: `Feedback ${id}` }));
    t.comments.push(t.comments[100]);
    const file = { ...thread('file'), start_line: 0, end_line: 0 };
    file.comments[0].body = '# Embedded heading\n<script>example</script>';
    const feedback = { source_commit: head, threads: [t, t, file, { ...thread('resolved'), is_resolved: true }] };
    const output = exportHostedFeedback({ id: 42, title: 'Review', url: 'https://example.test/pr/42' }, feedback);
    expect(output.match(/> Feedback \d+/g)).toHaveLength(101);
    expect(output).toContain(`Source commit: ${head}`); expect(output).toContain('https://example.test/pr/42');
    expect(output).toContain('old lines 2–3'); expect(output).toContain('Outdated · Azure iteration 2');
    expect(output).toContain('src/a.ts · file feedback'); expect(output).toContain('> # Embedded heading'); expect(output).not.toContain('Thread ID: resolved');
  });
});
