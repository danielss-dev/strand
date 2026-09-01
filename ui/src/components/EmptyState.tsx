import type { ReactNode } from 'react';

import { Icon, type IconName } from './Icon';

export function EmptyState({
  icon,
  title,
  hint,
  action,
  spinning,
  compact,
}: {
  icon?: IconName;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  spinning?: boolean;
  /** Drop the 160px min-height — for tree panes and other tight slots. */
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'empty-state compact' : 'empty-state'}>
      {icon ? <Icon name={icon} size={22} className={spinning ? 'spin' : undefined} /> : null}
      <p>{title}</p>
      {hint ? <span>{hint}</span> : null}
      {action}
    </div>
  );
}
