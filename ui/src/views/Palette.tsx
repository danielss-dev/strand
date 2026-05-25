import { useEffect, useRef, useState } from 'react';

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
  const [sel, setSel] = useState(0);
  const platform = useSettings((s) => s.platform);
  const cmdKey = platform === 'mac' ? '⌘' : 'Ctrl ';
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = q
    ? actions.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()))
    : actions;

  // Reset selection whenever the visible list changes so we never point at
  // a stale index.
  useEffect(() => { setSel(0); }, [q, filtered.length]);

  // Keep the selected row in view as the user navigates with the keyboard.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const node = list.children.item(sel) as HTMLElement | null;
    node?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

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
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(Math.max(filtered.length - 1, 0), s + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === 'Enter') {
                const item = filtered[sel];
                if (item) { item.run(); onClose(); }
              }
            }}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="palette-sect">No matches</div>
          )}
          {filtered.map((a, i) => (
            <div
              key={a.id}
              className={'palette-item' + (i === sel ? ' active' : '')}
              onMouseMove={() => { if (i !== sel) setSel(i); }}
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
