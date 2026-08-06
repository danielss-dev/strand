import type { FilesTreeMutationChange } from './types';

export interface WorkFileDraft {
  /** Raw disk contents used by the optimistic write guard. */
  original: string;
  /** LF-normalized text currently shown by the editor. */
  text: string;
}

export function normalizeEditorText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function workFileDraftKey(repoPath: string, path: string): string {
  return `${repoPath}\0${path}`;
}

/** Keep session drafts aligned with file moves and deletes initiated in Strand. */
export function reconcileWorkFileDrafts(
  drafts: Record<string, WorkFileDraft>,
  repoPath: string,
  change: FilesTreeMutationChange,
): Record<string, WorkFileDraft> {
  if (change.kind !== 'move' && change.kind !== 'delete') return drafts;
  const prefix = `${repoPath}\0`;
  let next = drafts;

  for (const [key, draft] of Object.entries(drafts)) {
    if (!key.startsWith(prefix)) continue;
    const path = key.slice(prefix.length);
    if (change.kind === 'delete') {
      if (!change.paths.some((removed) => path === removed || path.startsWith(`${removed}/`))) continue;
      if (next === drafts) next = { ...drafts };
      delete next[key];
      continue;
    }

    const move = change.moves.find(({ from }) => path === from || path.startsWith(`${from}/`));
    if (!move) continue;
    if (next === drafts) next = { ...drafts };
    delete next[key];
    next[workFileDraftKey(repoPath, `${move.to}${path.slice(move.from.length)}`)] = draft;
  }

  return next;
}

/** Working-tree text can be edited only when the backend accepted the file.
 * Presentation context (standalone or embedded in Work) is intentionally not
 * part of this decision. */
export function canEditFileContent(editable: boolean, revision: string | null): boolean {
  return editable && revision === null;
}
