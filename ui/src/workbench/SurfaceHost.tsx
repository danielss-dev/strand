import { createContext, useContext, type ReactNode } from 'react';

import { t } from '../lib/i18n';
import type {
  SurfaceContextBinding,
  SurfaceContribution,
  SurfaceHostKind,
  SurfaceId,
  SurfaceLifecycle,
  SurfaceRegistry,
} from './surfaces';

export interface SurfaceRenderRequest {
  contribution: SurfaceContribution;
  instanceId: string;
  binding: SurfaceContextBinding;
  host: SurfaceHostKind;
  lifecycle: SurfaceLifecycle;
}

export type SurfaceRenderer = (request: SurfaceRenderRequest) => ReactNode;

const SurfaceRuntimeContext = createContext<SurfaceRenderRequest | null>(null);

/** Lifecycle and context for the currently hosted surface instance. */
export function useSurfaceRuntime(): SurfaceRenderRequest {
  const runtime = useContext(SurfaceRuntimeContext);
  if (!runtime) throw new Error('useSurfaceRuntime must be used inside SurfaceHost');
  return runtime;
}

export function SurfaceHost({
  registry,
  surfaceId,
  instanceId,
  binding,
  host,
  lifecycle,
  render,
}: {
  registry: SurfaceRegistry;
  surfaceId: SurfaceId;
  instanceId: string;
  binding: SurfaceContextBinding;
  host: SurfaceHostKind;
  lifecycle: SurfaceLifecycle;
  render: SurfaceRenderer;
}) {
  const contribution = registry.get(surfaceId);
  if (!contribution) return <UnavailableSurface surfaceId={surfaceId} />;
  if (!contribution.hosts.includes(host)) {
    return <UnavailableSurface surfaceId={surfaceId} incompatible />;
  }
  const runtime = { contribution, instanceId, binding, host, lifecycle };
  return (
    <SurfaceRuntimeContext.Provider value={runtime}>
      {render(runtime)}
    </SurfaceRuntimeContext.Provider>
  );
}

function UnavailableSurface({ surfaceId, incompatible = false }: { surfaceId: string; incompatible?: boolean }) {
  return (
    <div className="custom-empty" role="status">
      <div className="custom-empty-copy">
        <strong>{t(incompatible ? 'workbench.surfaceIncompatible' : 'workbench.surfaceUnavailable')}</strong>
        <span>{surfaceId}</span>
        <small>{t(incompatible ? 'workbench.surfaceIncompatibleHint' : 'workbench.surfaceUnavailableHint')}</small>
      </div>
    </div>
  );
}
