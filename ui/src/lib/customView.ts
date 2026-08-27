/**
 * Pure layout model for the experimental Custom view.
 *
 * The tree mirrors Work's proven nested-pane shape, but a leaf owns one
 * Strand feature instead of a tab list. Keeping the model UI-free makes the
 * persisted format easy to validate and the split/collapse rules testable.
 */

export const CUSTOM_FEATURE_IDS = [
  'work',
  'local',
  'review',
  'commits',
  'pull-requests',
  'reflog',
  'worktrees',
  'workspace-review',
] as const;

export type CustomFeatureId = (typeof CUSTOM_FEATURE_IDS)[number];
export type CustomSplitDirection = 'horizontal' | 'vertical';

export interface CustomPane {
  kind: 'pane';
  id: string;
  feature: CustomFeatureId | null;
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
  version: 1;
  layout: CustomLayout;
}

export type CustomTemplateId = 'blank' | 'focus' | 'vscode' | 'review';

export const CUSTOM_VIEW_VERSION = 1;
export const CUSTOM_ROOT_PANE_ID = 'custom-pane-root';
const MAX_CUSTOM_PANES = CUSTOM_FEATURE_IDS.length;

const featureIds = new Set<string>(CUSTOM_FEATURE_IDS);

export function emptyCustomView(): CustomViewModel {
  return {
    activePaneId: CUSTOM_ROOT_PANE_ID,
    layout: { kind: 'pane', id: CUSTOM_ROOT_PANE_ID, feature: null },
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

/** Assigning an already-used feature moves it to the target pane. A feature
 * mounts at most once, preventing duplicated global listeners and shared
 * selection state from fighting each other. */
export function setCustomPaneFeature(
  state: CustomViewModel,
  paneId: string,
  feature: CustomFeatureId | null,
): CustomViewModel {
  if (!findCustomPane(state.layout, paneId)) return state;
  const layout = mapCustomPanes(state.layout, (pane) => {
    if (pane.id === paneId) return pane.feature === feature ? pane : { ...pane, feature };
    return feature != null && pane.feature === feature ? { ...pane, feature: null } : pane;
  });
  return layout === state.layout
    ? state
    : { layout, activePaneId: paneId };
}

export function splitCustomPane(
  state: CustomViewModel,
  paneId: string,
  direction: CustomSplitDirection,
  makeId: () => string,
): CustomViewModel {
  const pane = findCustomPane(state.layout, paneId);
  if (!pane || customPanes(state.layout).length >= MAX_CUSTOM_PANES) return state;
  const newPane: CustomPane = { kind: 'pane', id: makeId(), feature: null };
  const split: CustomSplit = {
    kind: 'split',
    id: `custom-split-${newPane.id}`,
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
    if (pane.feature == null) return state;
    return { layout: { ...pane, feature: null }, activePaneId: pane.id };
  }
  const collapsed = collapseCustomPane(state.layout, paneId);
  return { layout: collapsed.layout, activePaneId: collapsed.focusPaneId };
}

export function createCustomTemplate(
  template: CustomTemplateId,
  makeId: () => string,
): CustomViewModel {
  if (template === 'blank') {
    const pane = customPane(makeId(), null);
    return { layout: pane, activePaneId: pane.id };
  }
  if (template === 'focus') {
    const pane = customPane(makeId(), 'work');
    return { layout: pane, activePaneId: pane.id };
  }
  if (template === 'review') {
    const review = customPane(makeId(), 'review');
    const commits = customPane(makeId(), 'commits');
    return {
      layout: customSplit(makeId(), 'horizontal', 60, review, commits),
      activePaneId: review.id,
    };
  }

  // A developer workbench: the live Work surface gets the broad canvas while
  // staging and history share a narrower inspector column.
  const work = customPane(makeId(), 'work');
  const local = customPane(makeId(), 'local');
  const commits = customPane(makeId(), 'commits');
  const inspector = customSplit(makeId(), 'vertical', 56, local, commits);
  return {
    layout: customSplit(makeId(), 'horizontal', 68, work, inspector),
    activePaneId: work.id,
  };
}

/** Parse the SQLite value defensively. Corrupt, oversized, duplicate-ID, or
 * duplicate-feature trees fall back to the first-run layout. */
export function parseStoredCustomView(value: unknown): CustomViewModel | null {
  if (!isRecord(value) || value.version !== CUSTOM_VIEW_VERSION) return null;
  const ids = new Set<string>();
  const features = new Set<CustomFeatureId>();
  let paneCount = 0;

  const parse = (node: unknown, depth: number): CustomLayout | null => {
    if (!isRecord(node) || depth > MAX_CUSTOM_PANES * 2) return null;
    if (node.kind === 'pane') {
      if (!validId(node.id) || ids.has(node.id)) return null;
      const feature = node.feature;
      if (feature !== null && (typeof feature !== 'string' || !featureIds.has(feature))) return null;
      if (feature !== null && features.has(feature as CustomFeatureId)) return null;
      ids.add(node.id);
      if (feature !== null) features.add(feature as CustomFeatureId);
      paneCount += 1;
      if (paneCount > MAX_CUSTOM_PANES) return null;
      return { kind: 'pane', id: node.id, feature: feature as CustomFeatureId | null };
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

function customPane(id: string, feature: CustomFeatureId | null): CustomPane {
  return { kind: 'pane', id: `custom-pane-${id}`, feature };
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

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
