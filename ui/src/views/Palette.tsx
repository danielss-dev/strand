import { useState } from 'react';

import { Icon } from '../components/Icon';
import { useSettings } from '../stores/settings';

export interface PaletteAction {
  id: string;
  label: string;
  shortcut?: string;
  run(): void;
}

interface Props {
  actions: PaletteAction[];
  onClose: () => void;
}

export function CommandPalette({ actions, onClose }: Props) {
  const [q, setQ] = useState('');
  const platform = useSettings((s) => s.platform);
  const cmdKey = platform === 'mac' ? '⌘' : 'Ctrl ';

  const filtered = q
    ? actions.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()))
    : actions;

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="palette">
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type a command, branch, or file…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered[0]) {
                filtered[0].run();
                onClose();
              }
            }}
          />
        </div>
        <div className="palette-list">
          {filtered.length === 0 && (
            <div className="palette-sect">No matches</div>
          )}
          {filtered.map((a) => (
            <div
              key={a.id}
              className="palette-item"
              onClick={() => { a.run(); onClose(); }}
            >
              <span className="ico"><Icon name="command" size={14} /></span>
              <span className="label">{a.label}</span>
              {a.shortcut && <span className="kbd">{a.shortcut}</span>}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <div className="grp"><span className="kbd">↑↓</span> navigate</div>
          <div className="grp"><span className="kbd">↵</span> run</div>
          <div className="grp"><span className="kbd">{cmdKey}K</span> toggle</div>
          <div className="grp right"><span className="kbd">esc</span> close</div>
        </div>
      </div>
    </div>
  );
}
