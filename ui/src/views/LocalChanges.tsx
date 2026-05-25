import { Icon } from '../components/Icon';
import { useRepo } from '../stores/repo';

/** Placeholder for the three-section staging workspace described in PRD §5. */
export function LocalChanges() {
  const status = useRepo((s) => s.status);
  const unstaged = status.filter((s) => !s.staged);
  const staged = status.filter((s) => s.staged);

  return (
    <div className="lc-stack">
      <div className="lc-main">
        <div className="lc-files">
          <div className="lc-col-head">
            Unstaged
            <span className="count">{unstaged.length}</span>
            <div className="h-actions">
              <span className="h-link">Stage all</span>
            </div>
          </div>
          {unstaged.length === 0 ? (
            <div className="lc-empty">
              <div className="ico"><Icon name="check" size={20} stroke={2} /></div>
              <strong>Nothing to commit</strong>
              The working tree matches HEAD.
            </div>
          ) : (
            <div className="lc-list">
              {unstaged.map((f) => <FileRow key={f.path} path={f.path} status={f.kind} />)}
            </div>
          )}

          <div className="lc-col-head" style={{ borderTop: '0.5px solid var(--border)' }}>
            Staged
            <span className="count">{staged.length}</span>
            <div className="h-actions">
              <span className="h-link">Unstage all</span>
            </div>
          </div>
          <div className="lc-list">
            {staged.map((f) => <FileRow key={f.path} path={f.path} status={f.kind} />)}
          </div>
        </div>

        <div className="lc-diff">
          <div className="lc-empty">
            <strong>Select a file</strong>
            Pick something on the left to see its diff.
          </div>
        </div>
      </div>

      <div className="lc-commit-bar">
        <div className="cb-top">
          <div className="subject-row">
            <input className="subject" placeholder="Commit subject" />
          </div>
          <label className="amend">
            <input type="checkbox" /> <span>Amend</span>
          </label>
          <button className="btn primary cb-commit">
            Commit
            <span className="kbd-inline">⌘↵</span>
          </button>
        </div>
        <textarea className="cb-body" placeholder="Description (optional)" />
      </div>
    </div>
  );
}

function FileRow({ path, status }: { path: string; status: string }) {
  const idx = path.lastIndexOf('/');
  const dir = idx >= 0 ? path.slice(0, idx) : '';
  const name = idx >= 0 ? path.slice(idx + 1) : path;
  const code = status[0]?.toUpperCase() ?? '?';
  return (
    <div className="lc-row">
      <div />
      <span className="ftype"><Icon name="file" size={13} /></span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <span className="fname">{name}</span>
        {dir && <span className="fpath"> · {dir}</span>}
      </span>
      <span className={`stat ${code}`}>{code}</span>
    </div>
  );
}
