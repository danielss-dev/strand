import { useState } from 'react';

import { Icon, type IconName } from './Icon';
import { useRepo } from '../stores/repo';

type SideTab = 'git' | 'files';

interface RowProps {
  icon?: IconName;
  label: string;
  badge?: number | string;
  active?: boolean;
  onClick?: () => void;
}

function SideRow({ icon, label, badge, active, onClick }: RowProps) {
  return (
    <div className={'side-row' + (active ? ' active' : '')} onClick={onClick}>
      {icon && <span className="ico"><Icon name={icon} size={14} /></span>}
      <span className="label">{label}</span>
      {badge != null && badge !== 0 && <span className="badge">{badge}</span>}
    </div>
  );
}

interface SectionProps {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  count?: number;
}

function SideSection({ label, collapsed, onToggle, count }: SectionProps) {
  return (
    <div className={'side-section' + (collapsed ? ' collapsed' : '')} onClick={onToggle}>
      <Icon name="chev-down" size={8} stroke={2} className="chev" />
      <span>{label}</span>
      {count != null && <span className="count">{count}</span>}
    </div>
  );
}

interface SidebarProps {
  onOpenRepo: () => void;
  onOpenRecent: (path: string) => void;
}

export function Sidebar({ onOpenRepo, onOpenRecent }: SidebarProps) {
  const view = useRepo((s) => s.view);
  const setView = useRepo((s) => s.setView);
  const selectFile = useRepo((s) => s.selectFile);
  const status = useRepo((s) => s.status);
  const meta = useRepo((s) => s.meta);
  const recents = useRepo((s) => s.recents);
  const forgetRecent = useRepo((s) => s.forgetRecent);

  const [tab, setTab] = useState<SideTab>('git');
  const [filter, setFilter] = useState('');
  const [sections, setSections] = useState({
    branches: true, remotes: true, tags: false, stashes: true, submods: false,
  });

  const unstaged = status.filter((s) => !s.staged).length;
  const toggle = (k: keyof typeof sections) => setSections((s) => ({ ...s, [k]: !s[k] }));

  return (
    <div className="sidebar">
      <div className="side-primary">
        <SideRow
          icon="changes"
          label="Local Changes"
          badge={unstaged || undefined}
          active={view === 'local'}
          onClick={() => { setView('local'); selectFile(null); }}
        />
        <SideRow
          icon="graph"
          label="All Commits"
          active={view === 'commits'}
          onClick={() => { setView('commits'); selectFile(null); }}
        />
      </div>

      <div className="side-tabs">
        <button className={'side-tab' + (tab === 'git' ? ' on' : '')} onClick={() => setTab('git')}>
          <Icon name="branch" size={12} />
          <span>Git</span>
        </button>
        <button className={'side-tab' + (tab === 'files' ? ' on' : '')} onClick={() => setTab('files')}>
          <Icon name="folder" size={12} />
          <span>Files</span>
        </button>
      </div>

      <div className="side-filter">
        <Icon name="search" size={11} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={tab === 'git' ? 'Filter branches, tags…' : 'Filter files'}
        />
      </div>

      <div className="side-scroll">
        {!meta ? (
          <EmptyRepoState recents={recents} onOpenRepo={onOpenRepo} onOpenRecent={onOpenRecent} onForget={forgetRecent} />
        ) : tab === 'git' ? (
          <>
            <SideSection label="Branches" collapsed={!sections.branches} onToggle={() => toggle('branches')} count={0} />
            <SideSection label="Remotes" collapsed={!sections.remotes} onToggle={() => toggle('remotes')} count={0} />
            <SideSection label="Tags" collapsed={!sections.tags} onToggle={() => toggle('tags')} count={0} />
            <SideSection label="Stashes" collapsed={!sections.stashes} onToggle={() => toggle('stashes')} count={0} />
            <SideSection label="Submodules" collapsed={!sections.submods} onToggle={() => toggle('submods')} count={0} />
          </>
        ) : (
          <div className="lc-empty" style={{ padding: '16px 12px', fontSize: 11 }}>
            File tree — coming soon.
          </div>
        )}
      </div>
    </div>
  );
}

interface EmptyProps {
  recents: ReturnType<typeof useRepo.getState>['recents'];
  onOpenRepo: () => void;
  onOpenRecent: (path: string) => void;
  onForget: (path: string) => Promise<void>;
}

function EmptyRepoState({ recents, onOpenRepo, onOpenRecent, onForget }: EmptyProps) {
  return (
    <div className="lc-empty" style={{ padding: '16px 12px', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>No repository open. Use <kbd>⌘O</kbd>, drop a folder onto the window, or:</div>
      <button
        onClick={onOpenRepo}
        style={{
          padding: '6px 10px', borderRadius: 6,
          background: 'var(--bg-elev)', color: 'var(--text-1)',
          border: '1px solid var(--border)', fontSize: 11, cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        Open repository…
      </button>

      {recents.length > 0 && (
        <div>
          <div style={{ color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10, margin: '4px 0 6px' }}>
            Recent
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {recents.map((r) => (
              <div
                key={r.path}
                onClick={() => onOpenRecent(r.path)}
                title={r.path}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 6px', borderRadius: 4, cursor: 'pointer',
                  color: 'var(--text-1)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-elev)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                <span
                  onClick={(e) => { e.stopPropagation(); void onForget(r.path); }}
                  title="Remove from recents"
                  style={{ color: 'var(--text-dim)', padding: 2 }}
                >
                  <Icon name="x" size={9} stroke={2} />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
