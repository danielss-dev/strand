import type { FileDiff } from './types';

/**
 * Exporting diffs to the clipboard (Local Changes / Review context menus and
 * the palette's "Copy … diff" actions): raw concatenated patch text for
 * re-applying, or fenced Markdown for pasting into an AI agent / PR comment.
 */

type ExportDiff = Pick<FileDiff, 'patch' | 'binary' | 'path'>;

/**
 * Join the diffs' patch texts into one multi-file patch, normalizing each to
 * end with exactly one `\n`. Empty patches (including binary files without a
 * stub patch) are skipped; an all-empty input yields `''`.
 */
export function concatPatches(diffs: ExportDiff[]): string {
  let out = '';
  for (const d of diffs) {
    if (d.patch.length === 0) continue;
    out += d.patch.replace(/\n*$/, '\n');
  }
  return out;
}

/**
 * Render the diffs as Markdown: an optional `# title` header, then per file a
 * `### path` heading and a fenced ```diff block. Binary or patch-less files
 * get an "_binary file changed_" line instead of a fence.
 */
export function patchesToMarkdown(diffs: ExportDiff[], opts?: { title?: string }): string {
  const sections: string[] = [];
  if (opts?.title) sections.push(`# ${opts.title}`);
  for (const d of diffs) {
    const body =
      d.binary || d.patch.length === 0 ? '_binary file changed_' : fencedDiff(d.patch);
    sections.push(`### ${d.path}\n\n${body}`);
  }
  return sections.length === 0 ? '' : sections.join('\n\n') + '\n';
}

/** Fence a patch, lengthening the fence past any backtick run in the patch
 * itself (CommonMark: a fence must be longer than any run it encloses).
 * Shared with lib/reviewExport for note excerpts. */
export function fencedDiff(patch: string): string {
  const runs = patch.match(/`{3,}/g);
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}diff\n${patch.replace(/\n*$/, '')}\n${fence}`;
}
