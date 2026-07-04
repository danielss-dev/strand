import { fencedDiff } from './patchExport';
import type { ReviewNote } from './types';

/**
 * Rendering review notes into one Markdown prompt — the hand-back half of the
 * agent feedback loop: annotate files/lines in the Review view, then paste the
 * whole bundle into the coding agent. Pure (no store/window access) so the
 * exact output shape stays unit-testable.
 */

export interface ReviewFeedbackFile {
  path: string;
  /** Unified-diff text for the file (whole-file context in the Review view). */
  patch: string;
  notes: ReviewNote[];
}

/**
 * Assemble the export's file list: every pool file that has notes (with its
 * patch, so line notes can quote an excerpt) PLUS noted paths that have left
 * the pool — a note taken in inbox mode survives the file being staged away,
 * so it must still export (with an empty patch → no excerpt) rather than
 * silently dropping. Pool order first, then orphaned paths sorted.
 */
export function collectFeedbackFiles(
  pool: { path: string; patch: string }[],
  notes: Record<string, ReviewNote[]>,
): ReviewFeedbackFile[] {
  const out: ReviewFeedbackFile[] = [];
  const seen = new Set<string>();
  for (const d of pool) {
    const n = notes[d.path];
    if (!n || n.length === 0) continue;
    out.push({ path: d.path, patch: d.patch, notes: n });
    seen.add(d.path);
  }
  const orphans = Object.keys(notes)
    .filter((p) => !seen.has(p) && notes[p].length > 0)
    .sort();
  for (const p of orphans) out.push({ path: p, patch: '', notes: notes[p] });
  return out;
}

/**
 * Build the feedback prompt: a header naming the repo (and branch / baseline
 * when known), then per noted file a `## path` section where each
 * line-anchored note quotes a ±4-line window of the patch around its NEW-side
 * line in a fenced diff block, and each whole-file note renders as a bullet.
 * Files without notes are skipped. Ends with a closing instruction line.
 */
export function buildReviewFeedback(input: {
  repoName: string;
  branch: string | null;
  baselineShort: string | null;
  files: ReviewFeedbackFile[];
}): string {
  const sections: string[] = [
    `# Review feedback — ${input.repoName}` + (input.branch ? ` (branch ${input.branch})` : ''),
  ];
  if (input.baselineShort) sections.push(`Changes reviewed since ${input.baselineShort}.`);
  for (const file of input.files) {
    const section = fileSection(file, '##');
    if (section != null) sections.push(section);
  }
  sections.push('Please address each note above.');
  return sections.join('\n\n') + '\n';
}

/** One repo's slice of a workspace-wide feedback export. */
export interface WorkspaceFeedbackRepo {
  repoName: string;
  branch: string | null;
  baselineShort: string | null;
  files: ReviewFeedbackFile[];
}

/**
 * The workspace-wide variant: one prompt covering every member repo that has
 * notes, grouped by repository — `## repo` sections with the per-file notes
 * demoted one heading level (`### path`). Each repo section carries its own
 * branch / baseline context, since members review in independent modes.
 * Repos without notes are skipped; the closing instruction tells the agent
 * the paths are relative to each repo, not to one shared root.
 */
export function buildWorkspaceReviewFeedback(input: {
  workspaceName: string;
  repos: WorkspaceFeedbackRepo[];
}): string {
  const sections: string[] = [`# Review feedback — ${input.workspaceName} workspace`];
  for (const repo of input.repos) {
    const files = repo.files
      .map((f) => fileSection(f, '###'))
      .filter((s): s is string => s != null);
    if (files.length === 0) continue;
    const head = `## ${repo.repoName}` + (repo.branch ? ` (branch ${repo.branch})` : '');
    const context = repo.baselineShort ? [`Changes reviewed since ${repo.baselineShort}.`] : [];
    sections.push([head, ...context, ...files].join('\n\n'));
  }
  sections.push(
    'Please address each note above. Notes are grouped by repository; file paths are relative to their repository.',
  );
  return sections.join('\n\n') + '\n';
}

/**
 * Render one noted file: a `<hx> path` heading, then per note either a
 * quoted ±4-line excerpt + **Note:** line (line-anchored) or a bullet
 * (whole-file; consecutive bullets join into one list). `null` when the
 * file has no notes — callers skip it entirely.
 */
function fileSection(file: ReviewFeedbackFile, heading: '##' | '###'): string | null {
  if (file.notes.length === 0) return null;
  const parts: string[] = [`${heading} ${file.path}`];
  for (const note of file.notes) {
    if (note.line == null) {
      // Whole-file notes are bullets; consecutive ones join into one list.
      const last = parts.length - 1;
      if (parts[last].startsWith('- ')) parts[last] += `\n- ${note.text}`;
      else parts.push(`- ${note.text}`);
      continue;
    }
    const excerpt = excerptAround(file.patch, note.line, note.side ?? 'new');
    if (excerpt != null) parts.push(fencedDiff(excerpt));
    parts.push(`**Note:** ${note.text}`);
  }
  return parts.join('\n\n');
}

/**
 * Quote a ±4-line window of `patch` around line `target` on the given side
 * (`'new'` counts `+`/context lines, `'old'` counts `-`/context — a note on a
 * deletion-only block anchors to an old-side number, since the line has no
 * new-side home). Windows are clipped to the hunk that contains the hit and
 * never bleed into another hunk's header or body. Returns `null` when no
 * hunk covers the line — the caller then emits the note without an excerpt.
 */
function excerptAround(
  patch: string,
  target: number,
  side: 'new' | 'old',
  context = 4,
): string | null {
  const lines = patch.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(lines[i]);
    if (!m) continue;
    let oldLine = parseInt(m[1], 10);
    let newLine = parseInt(m[2], 10);
    const bodyStart = i + 1;
    let bodyEnd = bodyStart; // exclusive
    let hit = -1;
    for (let j = bodyStart; j < lines.length; j++) {
      const c = lines[j][0];
      // A hunk body is '+' / '-' / ' ' lines (plus "\ No newline" markers);
      // anything else — the next @@ header, a `diff --git`, EOF — ends it.
      if (c !== '+' && c !== '-' && c !== ' ' && c !== '\\') break;
      bodyEnd = j + 1;
      if (c === '+' || c === ' ') {
        if (side === 'new' && newLine === target && hit === -1) hit = j;
        newLine++;
      }
      if (c === '-' || c === ' ') {
        if (side === 'old' && oldLine === target && hit === -1) hit = j;
        oldLine++;
      }
    }
    if (hit !== -1) {
      return lines.slice(Math.max(bodyStart, hit - context), Math.min(bodyEnd, hit + context + 1)).join('\n');
    }
    i = bodyEnd - 1; // resume the header scan past this hunk's body
  }
  return null;
}
