import { useState } from 'react';

import { Icon, type IconName } from '../components/Icon';

type Tab = 'content' | 'history' | 'compare' | 'blame';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'content', label: 'Content', icon: 'content' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'compare', label: 'Compare', icon: 'compare' },
  { id: 'blame',   label: 'Blame',   icon: 'blame' },
];

interface Props {
  path: string;
}

/** Placeholder four-tab file view. PRD §6.5. */
export function FileView({ path }: Props) {
  const [tab, setTab] = useState<Tab>('content');

  return (
    <div className="main">
      <div className="main-header">
        <div className="crumb">
          <span className="leaf" style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{path}</span>
        </div>
      </div>
      <div className="tab-strip">
        {TABS.map((t) => (
          <div key={t.id} className={'tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={13} className="tab-ico" />
            <span>{t.label}</span>
          </div>
        ))}
      </div>
      <div className="fv-body">
        <div className="lc-empty" style={{ margin: 'auto' }}>
          <strong>{tab[0]!.toUpperCase() + tab.slice(1)} view</strong>
          Wire up to <code>strand-core</code>.
        </div>
      </div>
    </div>
  );
}
