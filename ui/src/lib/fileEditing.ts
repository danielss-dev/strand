/** Working-tree text can be edited only when the backend accepted the file.
 * Presentation context (standalone or embedded in Work) is intentionally not
 * part of this decision. */
export function canEditFileContent(editable: boolean, revision: string | null): boolean {
  return editable && revision === null;
}

export function fileDraftKey(repoPath: string | null, path: string, revision: string | null): string | null {
  if (!repoPath || revision !== null) return null;
  return `${repoPath}\u0000${path}`;
}
