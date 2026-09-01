import type { ReactNode } from 'react';

export function PaneHeader({
  title,
  meta,
  actions,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="pane-head">
      <div className="pane-head-copy">
        {title ? <h2 className="pane-head-title">{title}</h2> : null}
        {meta ? <span className="pane-head-meta">{meta}</span> : null}
      </div>
      {actions ? <div className="pane-head-actions">{actions}</div> : null}
    </div>
  );
}
