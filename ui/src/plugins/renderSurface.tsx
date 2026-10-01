import { lazy, Suspense } from 'react';
import { AgentSessionRecapView } from './builtins/agentSessionRecap/AgentSessionRecapView';
import { QuickNotesView } from './builtins/quickNotes/QuickNotesView';
import type { DeclarativeView } from './manifest';
import { pluginRegistry } from './registry';
import type { PluginCapabilityBroker } from './capabilities';
import type { SurfaceRenderRequest } from '../workbench/SurfaceHost';
import { renderMarkdown } from '../lib/markdown';
import { t } from '../lib/i18n';
import type { ReactNode } from 'react';

const HeroiView = lazy(() => import('./builtins/heroi/HeroiView').then((m) => ({ default: m.HeroiView })));

function DeclarativePluginView({
  view,
  broker,
  request,
}: {
  view: DeclarativeView;
  broker: PluginCapabilityBroker;
  request: SurfaceRenderRequest;
}) {
  if (view.type === 'markdown') {
    return (
      <div className="plugin-surface plugin-surface-markdown" data-surface-id={request.contribution.id}>
        <article className="plugin-markdown markdown">
          {renderMarkdown(view.content)}
        </article>
      </div>
    );
  }

  if (view.type === 'status') {
    return (
      <div className="plugin-surface plugin-surface-status" data-surface-id={request.contribution.id}>
        <header className="plugin-status-head">
          <strong>{view.title}</strong>
          {broker.has('repository.read') && request.binding.kind === 'follow-active' && (
            <span className="plugin-status-badge">{t('plugins.repoContext')}</span>
          )}
        </header>
        <dl className="plugin-status-list">
          {view.items.map((item) => (
            <div key={item.label} className="plugin-status-row">
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  const exhaustive: never = view;
  return exhaustive;
}

export function renderPluginSurface(request: SurfaceRenderRequest): ReactNode {
  const binding = pluginRegistry.getSurfaceBinding(request.contribution.id);
  if (!binding) return null;
  const broker = pluginRegistry.createBroker(binding.manifest.id);
  const render = binding.surface.render;

  if (render.kind === 'builtin') {
    switch (render.module) {
      case 'daniels.heroi.workspace':
        return <Suspense fallback={<div className="custom-empty" role="status">Loading…</div>}>
          <HeroiView request={request} broker={broker} />
        </Suspense>;
      case 'strand-tools.quick-notes.workspace':
        return <QuickNotesView />;
      case 'daniels.session-recap.workspace':
        return <AgentSessionRecapView request={request} broker={broker} />;
      default: {
        const exhaustive: never = render.module;
        return (
          <div className="custom-empty" role="status">
            <div className="custom-empty-copy">
              <strong>{t('workbench.surfaceUnavailable')}</strong>
              <span>{exhaustive}</span>
            </div>
          </div>
        );
      }
    }
  }

  return (
    <DeclarativePluginView
      view={render.view}
      broker={broker}
      request={request}
    />
  );
}

export function isPluginSurface(surfaceId: string): boolean {
  return pluginRegistry.isPluginSurface(surfaceId as import('../workbench/surfaces').SurfaceId);
}
