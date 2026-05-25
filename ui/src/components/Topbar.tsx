import { Icon } from './Icon';
import { isTauri } from '../lib/tauri';
import { useSettings } from '../stores/settings';
import { useRepo } from '../stores/repo';

interface Props {
  onOpenPalette: () => void;
  onSync: () => void;
  syncing: boolean;
}

export function Topbar({ onOpenPalette, onSync, syncing }: Props) {
  const platform = useSettings((s) => s.platform);
  const meta = useRepo((s) => s.meta);

  const branch = meta?.branch ?? 'no repo';
  const ahead = meta?.ahead ?? 0;
  const behind = meta?.behind ?? 0;

  // In Tauri the host window draws real macOS traffic lights / Win11 controls.
  // The HTML fakes are only for browser-only preview (`pnpm dev`).
  const showFakeChrome = !isTauri();

  return (
    <div className="topbar" data-native-chrome={!showFakeChrome ? platform : undefined}>
      {showFakeChrome && platform === 'mac' && (
        <div className="traffic">
          <div className="dot close" />
          <div className="dot min" />
          <div className="dot max" />
        </div>
      )}

      <div className="repo-tabs">
        {meta && (
          <div className="repo-tab active">
            <div className="repo-dot" style={{ background: 'var(--b-1)' }} />
            <div className="repo-name">{meta.name}</div>
            <div className="repo-x" onClick={(e) => e.stopPropagation()}>
              <Icon name="x" size={9} stroke={2} />
            </div>
          </div>
        )}
        <div className="tab-add" title="Open repository">
          <Icon name="plus" size={12} />
        </div>
      </div>

      <div className="topbar-spacer" />

      <div className="sync-group">
        <button className="sync-btn" onClick={onSync} title="Fetch">
          <Icon name="refresh" size={13} className={syncing ? 'spin' : ''} />
        </button>
        <button className="sync-btn" title="Pull">
          <Icon name="arrow-down" size={13} />
          <span className="count">{behind}</span>
        </button>
        <button className="sync-btn" title="Push">
          <Icon name="arrow-up" size={13} />
          <span className="count">{ahead}</span>
        </button>
      </div>

      <div className="branch-btn" title="Switch branch">
        <Icon name="branch" size={13} />
        <span className="branch-name">{branch}</span>
        <Icon name="chev-down" size={11} className="chev" />
      </div>

      <div className="cmd-pill" onClick={onOpenPalette}>
        <Icon name="search" size={13} />
        <span>Quick Launch</span>
        <kbd>{platform === 'mac' ? '⌘K' : 'Ctrl K'}</kbd>
      </div>

      {showFakeChrome && platform === 'win11' && (
        <div className="win-controls">
          <div className="wc"><Icon name="win-min" size={10} stroke={1} /></div>
          <div className="wc"><Icon name="win-max" size={10} stroke={1} /></div>
          <div className="wc close"><Icon name="win-close" size={10} stroke={1.2} /></div>
        </div>
      )}
    </div>
  );
}
