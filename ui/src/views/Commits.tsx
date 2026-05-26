import { useRepo } from '../stores/repo';

/** Placeholder commit graph — table only, no SVG lanes yet. PRD §6.2. */
export function Commits() {
  const commits = useRepo((s) => s.commits);

  return (
    <div className="graph-wrap">
      <div className="graph-toolbar">
        <div className="graph-search">
          <input placeholder="Search commits…" aria-label="Search commits" />
        </div>
      </div>
      <div className="graph-split">
        <div className="graph-main">
          <table className="graph-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}></th>
                <th>Message</th>
                <th style={{ width: 160 }}>Author</th>
                <th style={{ width: 100 }}>Date</th>
                <th style={{ width: 80 }}>Hash</th>
              </tr>
            </thead>
            <tbody>
              {commits.map((c) => (
                <tr key={c.hash}>
                  <td className="graph-col" />
                  <td className="msg"><span className="msg-text">{c.subject}</span></td>
                  <td className="author">{c.author_name}</td>
                  <td className="date">{relativeDate(c.time_unix)}</td>
                  <td className="hash">{c.short_hash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function relativeDate(unix: number): string {
  const delta = Date.now() / 1000 - unix;
  if (delta < 60) return `${Math.round(delta)}s`;
  if (delta < 3600) return `${Math.round(delta / 60)}m`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h`;
  return `${Math.round(delta / 86400)}d`;
}
