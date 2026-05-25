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

export function Sidebar() {
  const view = useRepo((s) => s.view);
  const setView = useRepo((s) => s.setView);
  const selectFile = useRepo((s) => s.selectFile);
  const status = useRepo((s) => s.status);

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
        {tab === 'git' ? (
          <>
            <SideSection label="Branches" collapsed={!sections.branches} onToggle={() => toggle('branches')} count={0} />
            <SideSection label="Remotes" collapsed={!sections.remotes} onToggle={() => toggle('remotes')} count={0} />
            <SideSection label="Tags" collapsed={!sections.tags} onToggle={() => toggle('tags')} count={0} />
            <SideSection label="Stashes" collapsed={!sections.stashes} onToggle={() => toggle('stashes')} count={0} />
            <SideSection label="Submodules" collapsed={!sections.submods} onToggle={() => toggle('submods')} count={0} />
            <div className="lc-empty" style={{ padding: '16px 12px', fontSize: 11 }}>
              No repository open. Use ⌘O to open one.
            </div>
          </>
        ) : (
          <div className="lc-empty" style={{ padding: '16px 12px', fontSize: 11 }}>
            Open a repository to browse its files.
          </div>
        )}
      </div>
    </div>
  );
}
