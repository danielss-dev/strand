import type { IconName } from '../components/Icon';
import { t } from '../lib/i18n';
import type {
  SurfaceContribution,
  SurfaceHostKind,
  SurfaceId,
  SurfaceLifecyclePolicy,
  SurfaceScope,
} from './surfaces';
import { SurfaceRegistry } from './surfaces';

export interface BuiltInSurfaceContribution extends SurfaceContribution {
  /** Custom-view v1 ID retained only for persisted-layout migration. */
  legacyId: LegacyCustomFeatureId;
}

export const LEGACY_CUSTOM_FEATURE_IDS = [
  'work',
  'files',
  'local',
  'local-explorer',
  'review',
  'commits',
  'pull-requests',
  'reflog',
  'worktrees',
  'workspace-review',
] as const;

export type LegacyCustomFeatureId = (typeof LEGACY_CUSTOM_FEATURE_IDS)[number];

export const BUILT_IN_SURFACE_IDS = {
  work: 'strand.work.workspace',
  files: 'strand.files.explorer',
  localChanges: 'strand.changes.workspace',
  changesExplorer: 'strand.changes.explorer',
  review: 'strand.review.workspace',
  commits: 'strand.history.commits',
  pullRequests: 'strand.pullRequests.workspace',
  reflog: 'strand.history.reflog',
  worktrees: 'strand.worktrees.dashboard',
  workspaceReview: 'strand.review.workspaceOverview',
} as const satisfies Record<string, SurfaceId>;

const ALL_HOSTS = ['main', 'panel', 'sidebar', 'bottom'] as const satisfies readonly SurfaceHostKind[];

function builtInSurface(
  legacyId: LegacyCustomFeatureId,
  id: SurfaceId,
  title: string,
  description: string,
  icon: IconName,
  scope: SurfaceScope = 'repository',
  lifecycle: SurfaceLifecyclePolicy = 'unmount',
): BuiltInSurfaceContribution {
  return {
    legacyId,
    id,
    title,
    description,
    icon,
    scope,
    hosts: ALL_HOSTS,
    instancePolicy: 'singleton',
    lifecycle,
  };
}

/** Static migration bridge for the ten surfaces supported by Custom view v1. */
export const BUILT_IN_SURFACES = [
  builtInSurface(
    'work',
    BUILT_IN_SURFACE_IDS.work,
    t('nav.work'),
    t('custom.feature.work.description'),
    'terminal',
    'repository',
    'keep-alive',
  ),
  builtInSurface(
    'files',
    BUILT_IN_SURFACE_IDS.files,
    t('nav.files'),
    t('custom.feature.files.description'),
    'folder',
  ),
  builtInSurface(
    'local',
    BUILT_IN_SURFACE_IDS.localChanges,
    t('nav.localChanges'),
    t('custom.feature.local.description'),
    'changes',
  ),
  builtInSurface(
    'local-explorer',
    BUILT_IN_SURFACE_IDS.changesExplorer,
    t('nav.localExplorer'),
    t('custom.feature.localExplorer.description'),
    'changes',
  ),
  builtInSurface(
    'review',
    BUILT_IN_SURFACE_IDS.review,
    t('nav.review'),
    t('custom.feature.review.description'),
    'check',
  ),
  builtInSurface(
    'commits',
    BUILT_IN_SURFACE_IDS.commits,
    t('nav.allCommits'),
    t('custom.feature.commits.description'),
    'graph',
  ),
  builtInSurface(
    'pull-requests',
    BUILT_IN_SURFACE_IDS.pullRequests,
    t('nav.pullRequests'),
    t('custom.feature.pullRequests.description'),
    'remote',
  ),
  builtInSurface(
    'reflog',
    BUILT_IN_SURFACE_IDS.reflog,
    t('nav.reflog'),
    t('custom.feature.reflog.description'),
    'history',
  ),
  builtInSurface(
    'worktrees',
    BUILT_IN_SURFACE_IDS.worktrees,
    t('nav.worktrees'),
    t('custom.feature.worktrees.description'),
    'worktree',
  ),
  builtInSurface(
    'workspace-review',
    BUILT_IN_SURFACE_IDS.workspaceReview,
    t('nav.workspaceReview'),
    t('custom.feature.workspaceReview.description'),
    'workspace',
    'workspace',
  ),
] as const satisfies readonly BuiltInSurfaceContribution[];

const surfaceByLegacyId = new Map<LegacyCustomFeatureId, BuiltInSurfaceContribution>(
  BUILT_IN_SURFACES.map((surface) => [surface.legacyId, surface]),
);
const legacyIdBySurfaceId = new Map<string, LegacyCustomFeatureId>(
  BUILT_IN_SURFACES.map((surface) => [surface.id, surface.legacyId]),
);

/** Ready-to-consume built-in registry for workbench hosts. */
export const builtInSurfaceRegistry = new SurfaceRegistry(BUILT_IN_SURFACES);

export function surfaceIdForLegacyFeature(legacyId: LegacyCustomFeatureId): SurfaceId {
  const surface = surfaceByLegacyId.get(legacyId);
  if (!surface) throw new Error(`No built-in surface maps legacy feature: ${legacyId}`);
  return surface.id;
}

export function legacyFeatureIdForSurface(id: string): LegacyCustomFeatureId | undefined {
  return legacyIdBySurfaceId.get(id);
}
