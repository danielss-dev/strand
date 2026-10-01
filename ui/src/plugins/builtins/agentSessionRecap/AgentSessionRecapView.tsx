import { useEffect, useMemo } from 'react';

import { t } from '../../../lib/i18n';
import type { FileDiff } from '../../../lib/types';
import { useRepo } from '../../../stores/repo';
import type { PluginCapabilityBroker } from '../../capabilities';
import type { SurfaceRenderRequest } from '../../../workbench/SurfaceHost';
import {
  HEROI_OPEN_FILE_EVENT,
  HEROI_OPEN_REVIEW_EVENT,
  type HeroiOpenFileDetail,
} from '../heroi/events';
import { buildAgentSessionRecap, recapKindLabel, RECAP_PATCH_SCAN_LIMIT } from './recap';

function uniqueDiffs(...pools: readonly (readonly FileDiff[])[]): FileDiff[] {
  const byPath = new Map<string, FileDiff>();
  for (const pool of pools) {
    for (const diff of pool) byPath.set(diff.path, diff);
  }
  return [...byPath.values()];
}

function repoName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

export function AgentSessionRecapView({
  request,
  broker,
}: {
  request: SurfaceRenderRequest;
  broker: PluginCapabilityBroker;
}) {
  const path = useRepo((state) => state.activePath);
  const meta = useRepo((state) => state.meta);
  const status = useRepo((state) => state.status);
  const baseline = useRepo((state) => state.baseline);
  const unstagedDiffs = useRepo((state) => state.unstagedDiffs);
  const stagedDiffs = useRepo((state) => state.stagedDiffs);
  const baselineDiffs = useRepo((state) => state.baselineDiffs);
  const reviewUnstagedDiffs = useRepo((state) => state.reviewUnstagedDiffs);
  const visible = request.lifecycle.visible;
  const canReadRepo = broker.has('repository.read');

  useEffect(() => {
    if (!visible || !path || !canReadRepo) return;
    const state = useRepo.getState();
    const releaseReview = state.retainDiffs(path, 'review');
    const releaseLocal = state.retainDiffs(path, 'local');
    let cancelled = false;
    void Promise.all([state.refreshDiffs(), state.refreshReviewDiffs()])
      .then(() => {
        if (cancelled || useRepo.getState().activePath !== path) return;
        const current = useRepo.getState();
        const missing = uniqueDiffs(current.unstagedDiffs, current.stagedDiffs)
          .filter((diff) => diff.patchLoaded === false)
          .slice(0, RECAP_PATCH_SCAN_LIMIT);
        const unstaged = missing
          .filter((diff) => current.unstagedDiffs.some((row) => row.path === diff.path))
          .map((diff) => diff.path);
        const staged = missing
          .filter((diff) => current.stagedDiffs.some((row) => row.path === diff.path))
          .map((diff) => diff.path);
        return Promise.all([
          unstaged.length ? current.loadDiffFiles('unstaged', unstaged) : Promise.resolve(),
          staged.length ? current.loadDiffFiles('staged', staged) : Promise.resolve(),
        ]);
      })
      .catch((error) => console.warn('session recap diff load failed', error));
    return () => {
      cancelled = true;
      releaseReview();
      releaseLocal();
    };
  }, [visible, path, baseline?.oid, canReadRepo]);

  const recap = useMemo(() => {
    const repo = path && canReadRepo
      ? {
          path,
          name: meta?.name ?? repoName(path),
          branch: meta?.branch ?? null,
          head: meta?.head_oid ?? null,
          dirty: status.length > 0,
        }
      : null;
    const review = baseline ? baselineDiffs : reviewUnstagedDiffs;
    return buildAgentSessionRecap({
      repo,
      linkedWorktree: meta?.is_linked_worktree ?? false,
      baselineShort: baseline?.short ?? null,
      status: canReadRepo ? status : [],
      diffs: canReadRepo ? uniqueDiffs(unstagedDiffs, stagedDiffs, review) : [],
    });
  }, [
    path,
    meta,
    status,
    baseline,
    unstagedDiffs,
    stagedDiffs,
    baselineDiffs,
    reviewUnstagedDiffs,
    canReadRepo,
  ]);

  const openFile = (filePath: string) => {
    if (!path) return;
    const detail: HeroiOpenFileDetail = { projectPath: path, path: filePath };
    window.dispatchEvent(new CustomEvent(HEROI_OPEN_FILE_EVENT, { detail }));
  };

  if (recap.state === 'no-repository') {
    return (
      <div className="custom-empty" role="status">
        <div className="custom-empty-copy">
          <strong>{t('plugins.recap.noRepository')}</strong>
          <span>{t('plugins.recap.noRepositoryHint')}</span>
        </div>
      </div>
    );
  }

  if (recap.state === 'empty') {
    return (
      <div className="custom-empty plugin-session-recap-empty" role="status">
        <div className="custom-empty-copy">
          <strong>{t('plugins.recap.empty')}</strong>
          <span>{t('plugins.recap.emptyHint')}</span>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => window.dispatchEvent(new CustomEvent(HEROI_OPEN_REVIEW_EVENT))}
        >
          {t('plugins.heroi.openReview')}
        </button>
      </div>
    );
  }

  return (
    <section className="plugin-session-recap" aria-label={t('plugins.recap.title')}>
      <header className="plugin-session-recap-head">
        <div>
          <strong>{t('plugins.recap.title')}</strong>
          <span title={path ?? undefined}>
            {recap.repoName}
            {recap.branch ? ` · ${recap.branch}` : ''}
          </span>
        </div>
        <div className="plugin-session-recap-badges">
          {recap.linkedWorktree && <span className="plugin-status-badge">{t('plugins.recap.worktree')}</span>}
          {recap.baselineShort
            ? <span className="plugin-status-badge">{t('plugins.recap.since', { short: recap.baselineShort })}</span>
            : <span className="plugin-status-badge">{t('plugins.recap.uncommitted')}</span>}
        </div>
      </header>

      <div className="plugin-session-recap-body">
        <section>
          <h2>{t('plugins.recap.files', { count: recap.files.length })}</h2>
          <ul className="plugin-session-recap-files">
            {recap.files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  className="plugin-session-recap-file"
                  onClick={() => openFile(file.path)}
                >
                  <span>{file.path}</span>
                  <span>{recapKindLabel(file.kind)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>{t('plugins.recap.risky')}</h2>
          {recap.risky.length === 0 ? (
            <p className="plugin-session-recap-muted">{t('plugins.recap.riskyEmpty')}</p>
          ) : (
            <ul className="plugin-session-recap-files">
              {recap.risky.map((file) => (
                <li key={`risky:${file.path}`}>
                  <button
                    type="button"
                    className="plugin-session-recap-file risky"
                    onClick={() => openFile(file.path)}
                  >
                    <span>{file.path}</span>
                    <span>{recapKindLabel(file.kind)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>{t('plugins.recap.todos')}</h2>
          {recap.todos.length === 0 ? (
            <p className="plugin-session-recap-muted">
              {recap.patchesScanned === 0
                ? t('plugins.recap.todosUnavailable')
                : t('plugins.recap.todosEmpty')}
            </p>
          ) : (
            <ul className="plugin-session-recap-todos">
              {recap.todos.map((todo, index) => (
                <li key={`${todo.path}:${index}`}>
                  <button type="button" className="plugin-session-recap-file" onClick={() => openFile(todo.path)}>
                    <span>{todo.path}</span>
                    <span>{todo.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="plugin-session-recap-foot">
        <button
          type="button"
          className="btn primary"
          onClick={() => window.dispatchEvent(new CustomEvent(HEROI_OPEN_REVIEW_EVENT))}
        >
          {t('plugins.heroi.openReview')}
        </button>
      </footer>
    </section>
  );
}
