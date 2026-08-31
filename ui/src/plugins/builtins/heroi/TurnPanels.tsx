import { Icon } from '../../../components/Icon';
import { t } from '../../../lib/i18n';
import {
  fileChangesFromActivities,
  groupFileChanges,
  toolCallSummary,
  type HeroiActivityLike,
  type HeroiFileChangeKind,
} from './turnArtifacts';

function activityStateLabel(state: Exclude<HeroiActivityLike['state'], 'running'>): string {
  if (state === 'done') return t('plugins.heroi.activity.done');
  if (state === 'stopped') return t('plugins.heroi.activity.stopped');
  return t('plugins.heroi.activity.error');
}

function kindLabel(kind: HeroiFileChangeKind): string {
  if (kind === 'added') return t('plugins.heroi.files.added');
  if (kind === 'changed') return t('plugins.heroi.files.changed');
  return t('plugins.heroi.files.deleted');
}

export function TurnFileChanges({
  activities,
  projectPath,
  onOpenPath,
}: {
  activities: readonly HeroiActivityLike[];
  projectPath: string;
  onOpenPath: (path: string) => void;
}) {
  const grouped = groupFileChanges(fileChangesFromActivities(activities, projectPath));
  const sections = (
    [
      { kind: 'added' as const, paths: grouped.added },
      { kind: 'changed' as const, paths: grouped.changed },
      { kind: 'deleted' as const, paths: grouped.deleted },
    ] satisfies { kind: HeroiFileChangeKind; paths: string[] }[]
  ).filter((section) => section.paths.length > 0);
  if (sections.length === 0) return null;

  return (
    <div className="plugin-heroi-file-changes" aria-label={t('plugins.heroi.files.label')}>
      <header>{t('plugins.heroi.files.label')}</header>
      {sections.map((section) => (
        <div key={section.kind} className={`plugin-heroi-file-change-group ${section.kind}`}>
          <strong>{kindLabel(section.kind)}</strong>
          <ul>
            {section.paths.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  className="plugin-heroi-file-change-path"
                  title={path}
                  onClick={() => onOpenPath(path)}
                >
                  <code>{path}</code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function TurnToolCalls({
  messageId,
  activities,
  expanded,
  onToggleGroup,
  expandedActivities,
  onToggleActivity,
}: {
  messageId: string;
  activities: readonly HeroiActivityLike[];
  expanded: boolean;
  onToggleGroup: () => void;
  expandedActivities: ReadonlySet<string>;
  onToggleActivity: (activityId: string) => void;
}) {
  if (activities.length === 0) return null;
  const summary = toolCallSummary(activities);
  const status = summary.running > 0
    ? t('plugins.heroi.tools.running', { count: summary.running })
    : summary.failed > 0
      ? t('plugins.heroi.tools.failed', { count: summary.failed })
      : t('plugins.heroi.tools.done');

  return (
    <div className="plugin-heroi-tool-group">
      <button
        type="button"
        className="plugin-heroi-tool-group-toggle"
        aria-expanded={expanded}
        onClick={onToggleGroup}
      >
        <Icon name={expanded ? 'chev-down' : 'chev-right'} size={11} />
        <span>{t('plugins.heroi.tools.label', { count: summary.total })}</span>
        <small className={summary.running > 0 ? 'running' : summary.failed > 0 ? 'error' : undefined}>
          {status}
        </small>
      </button>
      {expanded && (
        <div className="plugin-heroi-activities" role="list">
          {activities.map((activity) => {
            const rowKey = `${messageId}:${activity.id}`;
            const detailOpen = Boolean(activity.detail && expandedActivities.has(rowKey));
            return (
              <div key={activity.id} className={`plugin-heroi-activity ${activity.state}`} role="listitem">
                <button
                  type="button"
                  disabled={!activity.detail}
                  aria-expanded={activity.detail ? detailOpen : undefined}
                  onClick={() => onToggleActivity(rowKey)}
                >
                  <Icon
                    name={detailOpen ? 'chev-down' : 'chev-right'}
                    size={11}
                  />
                  <span>{activity.label}</span>
                  <small>{activity.state === 'running'
                    ? t('plugins.heroi.running')
                    : activityStateLabel(activity.state)}</small>
                </button>
                {detailOpen && activity.detail && (
                  <pre>{activity.detail}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
