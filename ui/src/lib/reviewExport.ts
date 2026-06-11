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
    if (file.notes.length === 0) continue;
    const parts: string[] = [`## ${file.path}`];
    for (const note of file.notes) {
      if (note.line == null) {
        // Whole-file notes are bullets; consecutive ones join into one list.
        const last = parts.length - 1;
        if (parts[last].startsWith('- ')) parts[last] += `\n- ${note.text}`;
        else parts.push(`- ${note.text}`);
        continue;
      }
      const excerpt = excerptAround(file.patch, note.line);
      if (excerpt != null) parts.push(fencedDiff(excerpt));
      parts.push(`**Note:** ${note.text}`);
    }
    sections.push(parts.join('\n\n'));
  }
  sections.push('Please address each note above.');
  return sections.join('\n\n') + '\n';
}

/**
 * Quote a ±4-line window of `patch` around the NEW-side line `target`,
 * clipped to the hunk that contains it (windows never bleed into another
 * hunk's header or body). Returns `null` when no hunk covers the line —
 * the caller then emits the note without an excerpt.
 */
function excerptAround(patch: string, target: number, context = 4): string | null {
  const lines = patch.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(lines[i]);
    if (!m) continue;
    let newLine = parseInt(m[1], 10);
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
        if (newLine === target && hit === -1) hit = j;
        newLine++;
      }
    }
    if (hit !== -1) {
      return lines.slice(Math.max(bodyStart, hit - context), Math.min(bodyEnd, hit + context + 1)).join('\n');
    }
    i = bodyEnd - 1; // resume the header scan past this hunk's body
  }
  return null;
}
