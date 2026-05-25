import { Icon } from './Icon';
import { useRepo } from '../stores/repo';

export function StatusBar() {
  const meta = useRepo((s) => s.meta);
  const status = useRepo((s) => s.status);

  const modified = status.filter((s) => !s.staged).length;
  const staged = status.filter((s) => s.staged).length;

  return (
    <div className="statusbar">
      <div className="sb-item">
        <Icon name="branch" size={11} />
        <span className="branch">{meta?.branch ?? '—'}</span>
      </div>
      {meta && (
        <>
          <div className="sb-item">
            <span style={{ color: 'var(--add)' }}>{meta.ahead}↑</span>
            <span style={{ color: 'var(--del)' }}>{meta.behind}↓</span>
          </div>
          <span className="sep">·</span>
        </>
      )}
      <div className="sb-item">
        <Icon name="sync" size={11} />
        <span>{meta ? 'Up to date' : 'No repo'}</span>
      </div>

      <div className="right">
        <div className="sb-item">{modified} modified · {staged} staged</div>
        <span className="sep">·</span>
        <div className="sb-item">UTF-8 · LF</div>
      </div>
    </div>
  );
}
