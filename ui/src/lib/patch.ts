/**
 * Split a per-file unified patch — what `FileDiff.patch` carries — into one
 * patch per hunk. Each returned patch keeps the original file header
 * (`diff --git`, `index`, `---`, `+++`, plus any `new file mode`-style
 * lines) followed by exactly one `@@` hunk, so it can be fed to
 * `git apply` (or `git2::Diff::from_buffer` on the Rust side).
 *
 * Returns an empty array if the patch has no hunks (binary, mode-only, etc.).
 */
export function splitPatchByHunk(patch: string): string[] {
  if (!patch) return [];
  const lines = patch.split('\n');

  // Find the first hunk-header line. Everything before it is the file
  // header; reused verbatim for each hunk.
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  if (firstHunk === -1) return [];

  const header = lines.slice(0, firstHunk);

  // Indexes of every `@@` line, then one past the end so we can slice in pairs.
  const hunkStarts: number[] = [];
  for (let i = firstHunk; i < lines.length; i++) {
    if (lines[i].startsWith('@@')) hunkStarts.push(i);
  }
  hunkStarts.push(lines.length);

  const out: string[] = [];
  for (let i = 0; i < hunkStarts.length - 1; i++) {
    const body = lines.slice(hunkStarts[i], hunkStarts[i + 1]);
    const parts = [...header, ...body];
    let text = parts.join('\n');
    // `git apply` / `git2::Diff::from_buffer` expect a terminating newline
    // on the patch buffer. The original may already end in one (which
    // we'd then double — harmless), so normalize.
    if (!text.endsWith('\n')) text += '\n';
    out.push(text);
  }
  return out;
}
