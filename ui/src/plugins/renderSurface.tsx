import type { ReactNode } from 'react';

import { t } from '../lib/i18n';
import type { SurfaceRenderRequest } from '../workbench/SurfaceHost';
import { PluginCapabilityBroker } from './capabilities';
import { T3CodeView } from './builtins/t3code/T3CodeView';
import { T3CODE_SURFACE_ID } from './builtins/t3code/manifest';
import type { DeclarativeView } from './manifest';
import { pluginRegistry } from './registry';

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
        <article className="plugin-markdown">{view.content.split('\n').map((line, index) => (
          line.startsWith('# ')
            ? <h1 key={index}>{line.slice(2)}</h1>
            : line.startsWith('## ')
              ? <h2 key={index}>{line.slice(3)}</h2>
              : line.length === 0
                ? <p key={index} className="plugin-markdown-gap" />
                : <p key={index}>{renderInlineMarkdown(line)}</p>
        ))}</article>
      </div>
    );
  }

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

function renderInlineMarkdown(line: string): ReactNode {
  const parts = line.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

export function renderPluginSurface(request: SurfaceRenderRequest): ReactNode {
  const binding = pluginRegistry.getSurfaceBinding(request.contribution.id);
  if (!binding) return null;
  const broker = pluginRegistry.createBroker(binding.manifest.id);
  const render = binding.surface.render;

  if (render.kind === 'builtin') {
    if (request.contribution.id === T3CODE_SURFACE_ID) {
      return (
        <T3CodeView
          request={request}
          broker={broker}
        />
      );
    }
    return (
      <div className="custom-empty" role="status">
        <div className="custom-empty-copy">
          <strong>{t('workbench.surfaceUnavailable')}</strong>
          <span>{request.contribution.id}</span>
        </div>
      </div>
    );
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
