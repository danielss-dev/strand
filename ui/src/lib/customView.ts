/**
 * Pure layout model for the experimental Custom workbench.
 *
 * Layout v2 persists namespaced surface references rather than a closed list
 * of view names. Unknown surface IDs remain in the tree so disabling or
 * uninstalling a future plugin never destroys the user's layout.
 */

import {
  LEGACY_CUSTOM_FEATURE_IDS,
  builtInSurfaceRegistry,
  surfaceIdForLegacyFeature,
  type LegacyCustomFeatureId,
} from '../workbench/builtInSurfaces';
import type {
  SurfaceContextBinding,
  SurfaceId,
  SurfaceRegistry,
} from '../workbench/surfaces';

/** Retained for v1 persistence migration and compatibility with older callers. */
export const CUSTOM_FEATURE_IDS = LEGACY_CUSTOM_FEATURE_IDS;
export type CustomFeatureId = LegacyCustomFeatureId;
export type CustomSurfaceId = SurfaceId;
export type CustomSplitDirection = 'horizontal' | 'vertical';

export interface CustomSurfaceRef {
  surfaceId: CustomSurfaceId;
  instanceId: string;
  binding: SurfaceContextBinding;
}

export interface CustomPane {
  kind: 'pane';
  id: string;
  surface: CustomSurfaceRef | null;
}

export interface CustomSplit {
  kind: 'split';
  id: string;
  direction: CustomSplitDirection;
  /** Initial first-child percentage. Later user resizing is restored by the
   * split's stable react-resizable-panels autoSaveId. */
  ratio: number;
  children: [CustomLayout, CustomLayout];
}

export type CustomLayout = CustomPane | CustomSplit;

export interface CustomViewModel {
  layout: CustomLayout;
  activePaneId: string;
}

export interface StoredCustomView {
  version: 2;
  layout: CustomLayout;
}

export type CustomTemplateId = 'blank' | 'focus' | 'vscode' | 'review';

export const CUSTOM_VIEW_VERSION = 2;
export const CUSTOM_ROOT_PANE_ID = 'custom-pane-root';
/** Independent of the installed contribution count; protects parser/layout work. */
export const MAX_CUSTOM_PANES = 32;

const FOLLOW_ACTIVE = { kind: 'follow-active' } as const;

export function emptyCustomView(): CustomViewModel {
  return {
    activePaneId: CUSTOM_ROOT_PANE_ID,
    layout: { kind: 'pane', id: CUSTOM_ROOT_PANE_ID, surface: null },
  };
}

export function customPanes(layout: CustomLayout): CustomPane[] {
  if (layout.kind === 'pane') return [layout];
  return [...customPanes(layout.children[0]), ...customPanes(layout.children[1])];
}

export function findCustomPane(layout: CustomLayout, paneId: string): CustomPane | null {
  if (layout.kind === 'pane') return layout.id === paneId ? layout : null;
  return findCustomPane(layout.children[0], paneId) ?? findCustomPane(layout.children[1], paneId);
}

/** Assign a surface using its declared instance policy. */
export function setCustomPaneSurface(
  state: CustomViewModel,
  paneId: string,
  surfaceId: CustomSurfaceId | null,
  makeId: () => string,
  registry: SurfaceRegistry = builtInSurfaceRegistry,
  binding: SurfaceContextBinding = FOLLOW_ACTIVE,
): CustomViewModel {
  const target = findCustomPane(state.layout, paneId);
  if (!target) return state;
  if (surfaceId == null) {
    if (target.surface == null) return state;
    return {
      layout: mapCustomPanes(state.layout, (pane) => (
        pane.id === paneId ? { ...pane, surface: null } : pane
      )),
      activePaneId: paneId,
    };
  }
  if (target.surface?.surfaceId === surfaceId && sameBinding(target.surface.binding, binding)) {
    return state;
  }

  const policy = registry.get(surfaceId)?.instancePolicy ?? 'singleton';
  const owner = policy === 'multiple'
    ? null
    : customPanes(state.layout).find((pane) => (
      pane.id !== paneId
      && pane.surface?.surfaceId === surfaceId
      && (policy === 'singleton' || sameBinding(pane.surface.binding, binding))
    )) ?? null;
  const nextSurface = owner?.surface ?? {
    surfaceId,
    instanceId: `custom-surface-${makeId()}`,
    binding,
  };
  const layout = mapCustomPanes(state.layout, (pane) => {
    if (pane.id === paneId) return { ...pane, surface: nextSurface };
    if (owner && pane.id === owner.id) return { ...pane, surface: target.surface };
    return pane;
  });
  return { layout, activePaneId: paneId };
}

export function splitCustomPane(
  state: CustomViewModel,
  paneId: string,
  direction: CustomSplitDirection,
  makeId: () => string,
): CustomViewModel {
  const pane = findCustomPane(state.layout, paneId);
  if (!pane || customPanes(state.layout).length >= MAX_CUSTOM_PANES) return state;
  const id = makeId();
  const newPane = customPane(id, null, makeId);
  const split: CustomSplit = {
    kind: 'split',
    id: `custom-split-${id}`,
    direction,
    ratio: 50,
    children: [pane, newPane],
  };
  return {
    layout: replaceCustomPane(state.layout, pane.id, split),
    activePaneId: newPane.id,
  };
}

export function closeCustomPane(state: CustomViewModel, paneId: string): CustomViewModel {
  const panes = customPanes(state.layout);
  const pane = panes.find((candidate) => candidate.id === paneId);
  if (!pane) return state;
  if (panes.length === 1) {
    if (pane.surface == null) return state;
    return { layout: { ...pane, surface: null }, activePaneId: pane.id };
  }
  const collapsed = collapseCustomPane(state.layout, paneId);
  return { layout: collapsed.layout, activePaneId: collapsed.focusPaneId };
}

export function createCustomTemplate(
  template: CustomTemplateId,
  makeId: () => string,
): CustomViewModel {
  if (template === 'blank') {
    const pane = customPane(makeId(), null, makeId);
    return { layout: pane, activePaneId: pane.id };
  }
  if (template === 'focus') {
    const pane = customPane(makeId(), surfaceIdForLegacyFeature('work'), makeId);
    return { layout: pane, activePaneId: pane.id };
  }
  if (template === 'review') {
    const review = customPane(makeId(), surfaceIdForLegacyFeature('review'), makeId);
    const commits = customPane(makeId(), surfaceIdForLegacyFeature('commits'), makeId);
    return {
      layout: customSplit(makeId(), 'horizontal', 60, review, commits),
      activePaneId: review.id,
    };
  }

  const files = customPane(makeId(), surfaceIdForLegacyFeature('files'), makeId);
  const work = customPane(makeId(), surfaceIdForLegacyFeature('work'), makeId);
  const local = customPane(makeId(), surfaceIdForLegacyFeature('local'), makeId);
  const commits = customPane(makeId(), surfaceIdForLegacyFeature('commits'), makeId);
  const inspector = customSplit(makeId(), 'vertical', 56, local, commits);
  const canvas = customSplit(makeId(), 'horizontal', 72, work, inspector);
  return {
    layout: customSplit(makeId(), 'horizontal', 18, files, canvas),
    activePaneId: work.id,
  };
}

/** Parse v2 defensively and migrate the original closed v1 feature format. */
export function parseStoredCustomView(value: unknown): CustomViewModel | null {
  if (!isRecord(value) || (value.version !== 1 && value.version !== CUSTOM_VIEW_VERSION)) return null;
  const version = value.version;
  const ids = new Set<string>();
  const instanceIds = new Set<string>();
  const singletonSurfaces = new Set<CustomSurfaceId>();
  let paneCount = 0;

  const parse = (node: unknown, depth: number): CustomLayout | null => {
    if (!isRecord(node) || depth > MAX_CUSTOM_PANES * 2) return null;
    if (node.kind === 'pane') {
      if (!validId(node.id) || ids.has(node.id)) return null;
      ids.add(node.id);
      paneCount += 1;
      if (paneCount > MAX_CUSTOM_PANES) return null;

      let surface: CustomSurfaceRef | null;
      if (version === 1) {
        if (node.feature === null) surface = null;
        else if (isLegacyFeatureId(node.feature)) {
          surface = {
            surfaceId: surfaceIdForLegacyFeature(node.feature),
            // Pane IDs are already validated and unique. Reuse that identity
            // so a maximum-length v1 ID cannot become an invalid v2 ID after
            // adding a migration prefix.
            instanceId: node.id,
            binding: FOLLOW_ACTIVE,
          };
        } else return null;
      } else {
        surface = parseSurfaceRef(node.surface);
        if (node.surface !== null && surface == null) return null;
      }

      if (surface) {
        if (instanceIds.has(surface.instanceId)) return null;
        instanceIds.add(surface.instanceId);
        const definition = builtInSurfaceRegistry.get(surface.surfaceId);
        if (definition?.instancePolicy === 'singleton') {
          if (singletonSurfaces.has(surface.surfaceId)) return null;
          singletonSurfaces.add(surface.surfaceId);
        }
      }
      return { kind: 'pane', id: node.id, surface };
    }
    if (node.kind !== 'split' || !validId(node.id) || ids.has(node.id)) return null;
    if (node.direction !== 'horizontal' && node.direction !== 'vertical') return null;
    if (!Array.isArray(node.children) || node.children.length !== 2) return null;
    if (typeof node.ratio !== 'number' || !Number.isFinite(node.ratio) || node.ratio < 18 || node.ratio > 82) {
      return null;
    }
    ids.add(node.id);
    const first = parse(node.children[0], depth + 1);
    const second = parse(node.children[1], depth + 1);
    if (!first || !second) return null;
    return {
      kind: 'split',
      id: node.id,
      direction: node.direction,
      ratio: node.ratio,
      children: [first, second],
    };
  };

  const layout = parse(value.layout, 0);
  if (!layout || paneCount === 0) return null;
  return { layout, activePaneId: customPanes(layout)[0].id };
}

export function storeCustomView(model: CustomViewModel): StoredCustomView {
  return { version: CUSTOM_VIEW_VERSION, layout: model.layout };
}

function customPane(
  id: string,
  surfaceId: CustomSurfaceId | null,
  makeId: () => string,
): CustomPane {
  return {
    kind: 'pane',
    id: `custom-pane-${id}`,
    surface: surfaceId == null ? null : {
      surfaceId,
      instanceId: `custom-surface-${makeId()}`,
      binding: FOLLOW_ACTIVE,
    },
  };
}

function customSplit(
  id: string,
  direction: CustomSplitDirection,
  ratio: number,
  first: CustomLayout,
  second: CustomLayout,
): CustomSplit {
  return { kind: 'split', id: `custom-split-${id}`, direction, ratio, children: [first, second] };
}

function mapCustomPanes(layout: CustomLayout, map: (pane: CustomPane) => CustomPane): CustomLayout {
  if (layout.kind === 'pane') return map(layout);
  const first = mapCustomPanes(layout.children[0], map);
  const second = mapCustomPanes(layout.children[1], map);
  return first === layout.children[0] && second === layout.children[1]
    ? layout
    : { ...layout, children: [first, second] };
}

function replaceCustomPane(
  layout: CustomLayout,
  paneId: string,
  replacement: CustomLayout,
): CustomLayout {
  if (layout.kind === 'pane') return layout.id === paneId ? replacement : layout;
  const first = replaceCustomPane(layout.children[0], paneId, replacement);
  const second = replaceCustomPane(layout.children[1], paneId, replacement);
  return first === layout.children[0] && second === layout.children[1]
    ? layout
    : { ...layout, children: [first, second] };
}

function collapseCustomPane(
  layout: CustomLayout,
  paneId: string,
): { layout: CustomLayout; focusPaneId: string } {
  if (layout.kind === 'pane') return { layout, focusPaneId: layout.id };
  const [first, second] = layout.children;
  if (first.kind === 'pane' && first.id === paneId) {
    return { layout: second, focusPaneId: customPanes(second)[0].id };
  }
  if (second.kind === 'pane' && second.id === paneId) {
    const panes = customPanes(first);
    return { layout: first, focusPaneId: panes[panes.length - 1].id };
  }
  if (findCustomPane(first, paneId)) {
    const collapsed = collapseCustomPane(first, paneId);
    return {
      layout: { ...layout, children: [collapsed.layout, second] },
      focusPaneId: collapsed.focusPaneId,
    };
  }
  const collapsed = collapseCustomPane(second, paneId);
  return {
    layout: { ...layout, children: [first, collapsed.layout] },
    focusPaneId: collapsed.focusPaneId,
  };
}

function parseSurfaceRef(value: unknown): CustomSurfaceRef | null {
  if (!isRecord(value)) return null;
  if (!validSurfaceId(value.surfaceId) || !validId(value.instanceId)) return null;
  const binding = parseBinding(value.binding);
  return binding ? { surfaceId: value.surfaceId, instanceId: value.instanceId, binding } : null;
}

function parseBinding(value: unknown): SurfaceContextBinding | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'follow-active') return FOLLOW_ACTIVE;
  if (value.kind === 'pinned-repository' && validId(value.repositoryId)) {
    return { kind: value.kind, repositoryId: value.repositoryId };
  }
  if (value.kind === 'pinned-worktree' && validId(value.worktreeId)) {
    return { kind: value.kind, worktreeId: value.worktreeId };
  }
  if (value.kind === 'pinned-workspace' && validId(value.workspaceId)) {
    return { kind: value.kind, workspaceId: value.workspaceId };
  }
  return null;
}

function sameBinding(a: SurfaceContextBinding, b: SurfaceContextBinding): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'follow-active') return true;
  if (a.kind === 'pinned-repository' && b.kind === a.kind) return a.repositoryId === b.repositoryId;
  if (a.kind === 'pinned-worktree' && b.kind === a.kind) return a.worktreeId === b.worktreeId;
  return a.kind === 'pinned-workspace' && b.kind === a.kind && a.workspaceId === b.workspaceId;
}

function isLegacyFeatureId(value: unknown): value is LegacyCustomFeatureId {
  return typeof value === 'string'
    && (LEGACY_CUSTOM_FEATURE_IDS as readonly string[]).includes(value);
}

function validSurfaceId(value: unknown): value is CustomSurfaceId {
  return typeof value === 'string'
    && value.length <= 160
    && /^[^.\s]+(?:\.[^.\s]+)+$/.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
