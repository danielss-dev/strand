import type { ReactNode } from 'react';

import { Icon, type IconName } from './Icon';

export function EmptyState({
  icon,
  title,
  hint,
  action,
  spinning,
}: {
  icon?: IconName;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  spinning?: boolean;
}) {
  return (
    <div className="empty-state">
      {icon ? <Icon name={icon} size={22} className={spinning ? 'spin' : undefined} /> : null}
      <p>{title}</p>
      {hint ? <span>{hint}</span> : null}
      {action}
    </div>
  );
}
