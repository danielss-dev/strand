import type { FileDiff } from './types';

/** Empty-diff copy for Local Changes / Review when there are no hunks. */
export function emptyDiffMessage(
  diff: Pick<FileDiff, 'binary' | 'note'>,
  binaryMessage = 'Binary file — no diff shown.',
): string {
  if (diff.binary) return binaryMessage;
  return diff.note || 'No textual diff.';
}

export function hasNoHunks(diff: Pick<FileDiff, 'binary' | 'adds' | 'dels'>): boolean {
  return diff.binary || (diff.adds === 0 && diff.dels === 0);
}
