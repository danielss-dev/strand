import { Icon } from './Icon';
import { toPierreLayout } from '../lib/diffLayout';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';

export { toPierreLayout };

/** Shared stacked / split toggle — writes the same setting the main header uses. */
export function DiffLayoutToggle() {
  const diffMode = useSettings((s) => s.diffMode);
  const setDiffMode = useRepo((s) => s.setDiffMode);
  return (
    <>
      <button
        type="button"
        className={'icon-btn' + (diffMode === 'stacked' ? ' on' : '')}
        onClick={() => setDiffMode('stacked')}
        title="Stacked (unified)"
        aria-label="Stacked (unified) diff view"
        aria-pressed={diffMode === 'stacked'}
      >
        <Icon name="unified" size={13} />
      </button>
      <button
        type="button"
        className={'icon-btn' + (diffMode === 'split' ? ' on' : '')}
        onClick={() => setDiffMode('split')}
        title="Split (side-by-side)"
        aria-label="Split (side-by-side) diff view"
        aria-pressed={diffMode === 'split'}
      >
        <Icon name="split" size={13} />
      </button>
    </>
  );
}
