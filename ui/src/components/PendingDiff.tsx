import type { FileDiff } from '../lib/types';
import { Diff } from './Diff';

/** Failed replacements keep the last inspected text visible, without hunk actions. */
export function PendingDiff({ diff, layout, onRetry }: {
  diff: FileDiff;
  layout: 'unified' | 'split';
  onRetry: () => void;
}) {
  return <>
    <div className="lc-file-note" role={diff.patchError ? 'alert' : 'status'}>
      {diff.patchError
        ? `${diff.patch ? 'Previous comparison is out of date. ' : ''}${diff.patchError}`
        : diff.patch ? 'Loading current file… Previous comparison shown below.' : 'Loading file…'}
      {diff.patchError && <button type="button" className="h-link" onClick={onRetry}>Retry</button>}
    </div>
    {diff.patch && <Diff patch={diff.patch} layout={layout} hideFileHeader />}
  </>;
}
