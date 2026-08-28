import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { ContextMenu, type MenuItem } from '../components/ContextMenu';
import { Icon, type IconName } from '../components/Icon';
import {
  MAX_CUSTOM_PANES,
  customPanes,
  type CustomLayout,
  type CustomPane,
  type CustomSurfaceRef,
  type CustomSurfaceId,
  type CustomTemplateId,
} from '../lib/customView';
import { t } from '../lib/i18n';
import { useCustomView } from '../stores/customView';
import { DEFAULT_WORKSPACE_ID, useWorkspaces } from '../stores/workspaces';
import { BUILT_IN_SURFACE_IDS, builtInSurfaceRegistry } from '../workbench';

export interface CustomPaneFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

const SURFACES = builtInSurfaceRegistry.listForHost('panel');

const TEMPLATES: readonly {
  id: CustomTemplateId;
  label: string;
  icon: IconName;
  thumb: ReactNode;
}[] = [
  {
    id: 'vscode',
    label: t('custom.template.vscode'),
    icon: 'workspace',
    thumb: <span className="custom-template-thumb" aria-hidden="true"><i /><i /><i /></span>,
  },
  {
    id: 'review',
    label: t('custom.template.review'),
    icon: 'check',
    thumb: <span className="custom-template-thumb" aria-hidden="true"><i /><i /></span>,
  },
  {
    id: 'focus',
    label: t('custom.template.focus'),
    icon: 'terminal',
    thumb: <span className="custom-template-thumb" aria-hidden="true"><i /></span>,
  },
  {
    id: 'blank',
    label: t('custom.template.blank'),
    icon: 'x',
    thumb: <span className="custom-template-thumb" aria-hidden="true" />,
  },
] as const;

export function CustomView({
  renderSurface,
  onWorkFrame,
}: {
  renderSurface: (surface: CustomSurfaceRef, active: boolean) => ReactNode;
  onWorkFrame: (frame: CustomPaneFrame | null) => void;
}) {
  const workspaces = useWorkspaces((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaces((state) => state.activeWorkspaceId);
  const workspaceId = activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  const workspaceName = workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? 'Default';
  const layout = useCustomView((state) => state.layout);
  const activePaneId = useCustomView((state) => state.activePaneId);
  const restored = useCustomView((state) => state.restored);
  const restoredWorkspaceId = useCustomView((state) => state.workspaceId);
  const restore = useCustomView((state) => state.restore);
  const activatePane = useCustomView((state) => state.activatePane);
  const setSurface = useCustomView((state) => state.setSurface);
  const splitPane = useCustomView((state) => state.splitPane);
  const closePane = useCustomView((state) => state.closePane);
  const applyTemplate = useCustomView((state) => state.applyTemplate);
  const canUndo = useCustomView((state) => state.canUndo);
  const undo = useCustomView((state) => state.undo);
  const [templateMenu, setTemplateMenu] = useState<{ x: number; y: number } | null>(null);
  const [saveVisible, setSaveVisible] = useState(false);
  const panes = useMemo(() => customPanes(layout), [layout]);
  const used = useMemo(
    () => new Map(panes.flatMap((pane) => (
      pane.surface ? [[pane.surface.surfaceId, pane.id] as const] : []
    ))),
    [panes],
  );
  const activeSurfaceId = panes.find((pane) => pane.id === activePaneId)?.surface?.surfaceId ?? null;
  const activeSurface = activeSurfaceId ? builtInSurfaceRegistry.get(activeSurfaceId) : null;
  const ready = restored && restoredWorkspaceId === workspaceId;

  useEffect(() => { void restore(workspaceId); }, [restore, workspaceId]);

  // Flash the save indicator only for edits between restored states — the
  // restore swap itself (empty placeholder → saved layout) is not a save.
  useEffect(() => {
    let timeout: number | undefined;
    const unsubscribe = useCustomView.subscribe((state, prev) => {
      if (state.layout === prev.layout || !state.restored || !prev.restored) return;
      setSaveVisible(true);
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => setSaveVisible(false), 1600);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    const undoLayout = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== 'z') return;
      const target = document.activeElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) return;
      if (!canUndo) return;
      event.preventDefault();
      undo();
    };
    window.addEventListener('keydown', undoLayout);
    return () => window.removeEventListener('keydown', undoLayout);
  }, [canUndo, undo]);

  // Mod+[ / Mod+] walks the composed panes and leaves focus on the next
  // pane's module switcher so cycling stays fully keyboard-operable.
  useEffect(() => {
    const cyclePane = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey) return;
      const delta = event.key === '[' ? -1 : event.key === ']' ? 1 : 0;
      if (!delta) return;
      const cycle = customPanes(layout);
      const index = cycle.findIndex((pane) => pane.id === activePaneId);
      if (index < 0 || cycle.length === 0) return;
      const next = cycle[(index + delta + cycle.length) % cycle.length];
      event.preventDefault();
      activatePane(next.id);
      document.querySelector<HTMLButtonElement>(
        `[data-custom-pane-id="${CSS.escape(next.id)}"] .custom-feature-select`,
      )?.focus();
    };
    window.addEventListener('keydown', cyclePane);
    return () => window.removeEventListener('keydown', cyclePane);
  }, [activatePane, activePaneId, layout]);

  // F6 mirrors Work: leave a complex embedded surface and return to the
  // active pane's module switcher without requiring pointer precision.
  useEffect(() => {
    const focusPaneHeader = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'F6') return;
      const target = document.querySelector<HTMLButtonElement>(
        `[data-custom-pane-id="${CSS.escape(activePaneId)}"] .custom-feature-select`,
      );
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    window.addEventListener('keydown', focusPaneHeader);
    return () => window.removeEventListener('keydown', focusPaneHeader);
  }, [activePaneId]);

  const templateItems = useMemo<MenuItem[]>(() => TEMPLATES.map((template) => ({
    label: template.label,
    thumb: template.thumb,
    icon: template.icon,
    confirm: template.id === 'blank' && panes.some((pane) => pane.surface != null),
    onSelect: () => applyTemplate(template.id),
  })), [applyTemplate, panes]);

  return (
    <div className="custom-view">
      <header className="custom-builder-bar">
        <div className="custom-builder-title">
          <span className="custom-workspace-name" title={workspaceName}>
            <Icon name="workspace" size={11} />
            <span>{workspaceName}</span>
          </span>
          <Icon name="chev-right" size={10} />
          <strong>{t('custom.title')}</strong>
          <span className="custom-experimental">{t('custom.experimental')}</span>
          {saveVisible && (
            <span className="custom-save-state flash"><Icon name="check" size={10} /> {t('custom.autoSaved')}</span>
          )}
        </div>
        <div className="custom-builder-actions">
          <span className="custom-active-label">
            {activeSurface?.title ?? activeSurfaceId ?? t('custom.emptyPane')}
          </span>
          <button
            type="button"
            className="btn ghost custom-toolbar-btn"
            disabled={!ready}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setTemplateMenu({ x: rect.right - 220, y: rect.bottom + 4 });
            }}
            aria-haspopup="menu"
            aria-expanded={templateMenu != null}
          >
            <Icon name="workspace" size={12} /> {t('custom.templates')}
          </button>
          <button
            type="button"
            className="icon-btn"
            title={panes.length >= MAX_CUSTOM_PANES
              ? t('custom.paneCap', { count: MAX_CUSTOM_PANES })
              : t('custom.splitActiveRight')}
            aria-label={t('custom.splitActiveRight')}
            disabled={!ready || panes.length >= MAX_CUSTOM_PANES}
            onClick={() => splitPane(activePaneId, 'horizontal')}
          >
            <Icon name="split" size={13} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={panes.length >= MAX_CUSTOM_PANES
              ? t('custom.paneCap', { count: MAX_CUSTOM_PANES })
              : t('custom.splitActiveDown')}
            aria-label={t('custom.splitActiveDown')}
            disabled={!ready || panes.length >= MAX_CUSTOM_PANES}
            onClick={() => splitPane(activePaneId, 'vertical')}
          >
            <Icon name="unified" size={13} />
          </button>
        </div>
      </header>

      {!ready ? (
        <div className="custom-loading" role="status">
          <Icon name="refresh" size={16} className="spin" />
          {t('custom.restoring', { workspace: workspaceName })}
        </div>
      ) : (
        <CustomLayoutView
          key={workspaceId}
          node={layout}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          paneCount={panes.length}
          activePaneId={activePaneId}
          used={used}
          onActivate={activatePane}
          onSurface={setSurface}
          onSplit={splitPane}
          onClose={closePane}
          onTemplate={applyTemplate}
          renderSurface={renderSurface}
          onWorkFrame={onWorkFrame}
        />
      )}

      {templateMenu && (
        <ContextMenu
          x={templateMenu.x}
          y={templateMenu.y}
          items={templateItems}
          onClose={() => setTemplateMenu(null)}
        />
      )}
    </div>
  );
}

interface LayoutProps {
  workspaceId: string;
  workspaceName: string;
  paneCount: number;
  activePaneId: string;
  used: ReadonlyMap<CustomSurfaceId, string>;
  onActivate(paneId: string): void;
  onSurface(paneId: string, surfaceId: CustomSurfaceId | null): void;
  onSplit(paneId: string, direction: 'horizontal' | 'vertical'): void;
  onClose(paneId: string): void;
  onTemplate(template: CustomTemplateId): void;
  renderSurface(surface: CustomSurfaceRef, active: boolean): ReactNode;
  onWorkFrame(frame: CustomPaneFrame | null): void;
}

function CustomLayoutView({ node, ...props }: LayoutProps & { node: CustomLayout }) {
  if (node.kind === 'pane') return <CustomPaneView pane={node} {...props} />;
  const firstSurfaceId = customPanes(node.children[0])[0]?.surface?.surfaceId;
  const secondSurfaceId = customPanes(node.children[1])[0]?.surface?.surfaceId;
  const firstLabel = (firstSurfaceId && builtInSurfaceRegistry.get(firstSurfaceId)?.title)
    ?? firstSurfaceId
    ?? t('custom.empty');
  const secondLabel = (secondSurfaceId && builtInSurfaceRegistry.get(secondSurfaceId)?.title)
    ?? secondSurfaceId
    ?? t('custom.empty');
  return (
    <PanelGroup
      direction={node.direction}
      autoSaveId={`strand:custom:${props.workspaceId}:${node.id}`}
      className="custom-layout"
    >
      <Panel defaultSize={node.ratio} minSize={18}>
        <CustomLayoutView node={node.children[0]} {...props} />
      </Panel>
      <PanelResizeHandle
        className={`rs-handle ${node.direction === 'horizontal' ? 'vert' : 'horiz'}`}
        aria-label={t('custom.resizeBetween', { first: firstLabel, second: secondLabel })}
      />
      <Panel defaultSize={100 - node.ratio} minSize={18}>
        <CustomLayoutView node={node.children[1]} {...props} />
      </Panel>
    </PanelGroup>
  );
}

function CustomPaneView({
  pane,
  paneCount,
  activePaneId,
  used,
  onActivate,
  onSurface,
  onSplit,
  onClose,
  onTemplate,
  workspaceName,
  renderSurface,
  onWorkFrame,
}: LayoutProps & { pane: CustomPane }) {
  const active = pane.id === activePaneId;
  const surfaceId = pane.surface?.surfaceId ?? null;
  const surface = surfaceId ? builtInSurfaceRegistry.get(surfaceId) ?? null : null;
  const surfaceLabel = surface?.title ?? surfaceId;
  const paneRef = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [actionMenu, setActionMenu] = useState<{ x: number; y: number } | null>(null);
  const [compactActions, setCompactActions] = useState(false);

  useLayoutEffect(() => {
    const node = paneRef.current;
    if (!node) return;
    const measure = () => setCompactActions(node.getBoundingClientRect().width < 380);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!compactActions) setActionMenu(null);
  }, [compactActions]);

  const menuItems = useMemo<MenuItem[]>(() => [
    ...SURFACES.map((item) => {
      const owner = used.get(item.id);
      return {
        label: item.title + (owner && owner !== pane.id ? ` · ${t('custom.moveHere')}` : ''),
        icon: surfaceId === item.id ? 'check' as const : item.icon,
        onSelect: () => onSurface(pane.id, item.id),
      };
    }),
    {
      label: t('custom.emptyPane'),
      icon: 'x' as const,
      disabled: pane.surface == null,
      onSelect: () => onSurface(pane.id, null),
    },
  ], [onSurface, pane.id, pane.surface, surfaceId, used]);
  const actionMenuItems = useMemo<MenuItem[]>(() => [
    {
      label: t('custom.splitRight'),
      icon: 'split',
      disabled: paneCount >= MAX_CUSTOM_PANES,
      onSelect: () => onSplit(pane.id, 'horizontal'),
    },
    {
      label: t('custom.splitDown'),
      icon: 'unified',
      disabled: paneCount >= MAX_CUSTOM_PANES,
      onSelect: () => onSplit(pane.id, 'vertical'),
    },
    {
      label: paneCount === 1 ? t('custom.clearPane') : t('custom.closePane'),
      icon: 'x',
      disabled: paneCount === 1 && pane.surface == null,
      onSelect: () => onClose(pane.id),
    },
  ], [onClose, onSplit, pane.id, pane.surface, paneCount]);

  const openMenu = (button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom + 3 });
  };

  return (
    <section
      ref={paneRef}
      className={'custom-pane' + (active ? ' active' : '')}
      data-custom-pane-id={pane.id}
      aria-label={surfaceLabel ? t('custom.paneLabel', { feature: surfaceLabel }) : t('custom.emptyPaneLabel')}
      onPointerDownCapture={() => onActivate(pane.id)}
      onFocusCapture={() => onActivate(pane.id)}
    >
      <div className="custom-pane-header">
        <button
          type="button"
          className="custom-feature-select"
          aria-haspopup="menu"
          aria-expanded={menu != null}
          onClick={(event) => openMenu(event.currentTarget)}
          title={t('custom.chooseFeatureTitle')}
        >
          {surface ? <Icon name={surface.icon} size={13} /> : <span className="custom-empty-dot" />}
          <span>{surfaceLabel ?? t('custom.chooseFeature')}</span>
          <Icon name="chev-down" size={9} />
        </button>
        <div className="custom-pane-actions" style={{ marginLeft: 'auto' }}>
          {compactActions ? (
            <button
              type="button"
              className="icon-btn custom-pane-more"
              title={t('custom.moreActions')}
              aria-label={t('custom.moreActions')}
              aria-haspopup="menu"
              aria-expanded={actionMenu != null}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setActionMenu({ x: rect.right - 180, y: rect.bottom + 3 });
              }}
            >
              <Icon name="more" size={12} />
            </button>
          ) : (
            <>
              <button
                type="button"
                title={paneCount >= MAX_CUSTOM_PANES
                  ? t('custom.paneCap', { count: MAX_CUSTOM_PANES })
                  : t('custom.splitRight')}
                aria-label={t('custom.splitFeatureRight', { feature: surfaceLabel ?? t('custom.empty') })}
                disabled={paneCount >= MAX_CUSTOM_PANES}
                onClick={() => onSplit(pane.id, 'horizontal')}
              >
                <Icon name="split" size={12} />
              </button>
              <button
                type="button"
                title={paneCount >= MAX_CUSTOM_PANES
                  ? t('custom.paneCap', { count: MAX_CUSTOM_PANES })
                  : t('custom.splitDown')}
                aria-label={t('custom.splitFeatureDown', { feature: surfaceLabel ?? t('custom.empty') })}
                disabled={paneCount >= MAX_CUSTOM_PANES}
                onClick={() => onSplit(pane.id, 'vertical')}
              >
                <Icon name="unified" size={12} />
              </button>
              <button
                type="button"
                title={paneCount === 1 ? t('custom.clearPane') : t('custom.closePane')}
                aria-label={paneCount === 1
                  ? t('custom.clearPaneLabel')
                  : t('custom.closeFeaturePane', { feature: surfaceLabel ?? t('custom.empty') })}
                disabled={paneCount === 1 && surfaceId == null}
                onClick={() => onClose(pane.id)}
              >
                <Icon name="x" size={12} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="custom-pane-body">
        {surfaceId === BUILT_IN_SURFACE_IDS.work ? (
          <WorkFrameHost onFrame={onWorkFrame} />
        ) : pane.surface ? (
          renderSurface(pane.surface, active)
        ) : (
          <EmptyCustomPane
            paneId={pane.id}
            used={used}
            firstPane={paneCount === 1}
            workspaceName={workspaceName}
            onSurface={onSurface}
            onTemplate={onTemplate}
          />
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {actionMenu && (
        <ContextMenu
          x={actionMenu.x}
          y={actionMenu.y}
          items={actionMenuItems}
          onClose={() => setActionMenu(null)}
        />
      )}
    </section>
  );
}

function EmptyCustomPane({
  paneId,
  used,
  firstPane,
  workspaceName,
  onSurface,
  onTemplate,
}: {
  paneId: string;
  used: ReadonlyMap<CustomSurfaceId, string>;
  firstPane: boolean;
  workspaceName: string;
  onSurface(paneId: string, surfaceId: CustomSurfaceId): void;
  onTemplate(template: CustomTemplateId): void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const columns = gridRef.current && getComputedStyle(gridRef.current).gridTemplateColumns.split(' ').length > 1 ? 2 : 1;
    const delta = event.key === 'ArrowRight' ? 1
      : event.key === 'ArrowLeft' ? -1
      : event.key === 'ArrowDown' ? columns
      : event.key === 'ArrowUp' ? -columns
      : 0;
    if (!delta) return;
    event.preventDefault();
    buttons[(index + delta + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div className="custom-empty">
      <div className="custom-empty-copy">
        <span className="custom-empty-kicker">{t('custom.buildPane')}</span>
        <strong>{t('custom.chooseStrandFeature')}</strong>
        <span>{t('custom.followsRepository', { workspace: workspaceName })}</span>
      </div>
      <div ref={gridRef} className="custom-feature-grid" onKeyDown={onGridKeyDown}>
        {SURFACES.map((surface) => {
          const inUse = used.has(surface.id);
          return (
            <button
              key={surface.id}
              type="button"
              onClick={() => onSurface(paneId, surface.id)}
              title={inUse ? t('custom.featureAlreadyOpen', { feature: surface.title }) : undefined}
            >
              <span className="custom-feature-icon"><Icon name={surface.icon} size={15} /></span>
              <span className="custom-feature-copy">
                <strong>{surface.title}</strong>
                <small>{surface.description}</small>
              </span>
              {inUse && <span className="custom-feature-used">{t('custom.move')}</span>}
            </button>
          );
        })}
      </div>
      {firstPane && (
        <div className="custom-empty-templates">
          <span>{t('custom.orStartFrom')}</span>
          <button type="button" onClick={() => onTemplate('vscode')}>{t('custom.template.vscode')}</button>
          <button type="button" onClick={() => onTemplate('review')}>{t('custom.template.review')}</button>
        </div>
      )}
    </div>
  );
}

/** Measure the reserved Work pane against the stable workspace host. The real
 * Work component stays mounted once in App and is positioned over this slot,
 * preserving xterm renderers and scrollback while layouts/views change. */
function WorkFrameHost({ onFrame }: { onFrame: (frame: CustomPaneFrame | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const node = ref.current;
    const host = node?.closest<HTMLElement>('.workspace-host');
    if (!node || !host) return;
    const rect = node.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    onFrame({
      left: rect.left - hostRect.left,
      top: rect.top - hostRect.top,
      width: rect.width,
      height: rect.height,
    });
  }, [onFrame]);

  useLayoutEffect(() => {
    const node = ref.current;
    const host = node?.closest<HTMLElement>('.workspace-host');
    if (!node || !host) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(host);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      onFrame(null);
    };
  }, [measure, onFrame]);

  return <div ref={ref} className="custom-work-frame" aria-label={t('custom.workSurface')} />;
}
