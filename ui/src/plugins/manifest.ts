import type { IconName } from '../components/Icon';
import type {
  SurfaceHostKind,
  SurfaceId,
  SurfaceInstancePolicy,
  SurfaceLifecyclePolicy,
  SurfaceScope,
} from '../workbench/surfaces';

/** Versioned public plugin API boundary. Bump only with a migration story. */
export const PLUGIN_API_VERSION = '1' as const;

export type PluginApiVersion = typeof PLUGIN_API_VERSION;

/** Explicit capabilities a manifest may request; enforced by the broker. */
export type PluginPermission =
  | 'repository.read'
  | 'ai.invoke'
  | 'network.fetch';

export type DeclarativeView =
  | { type: 'markdown'; content: string }
  | {
      type: 'status';
      title: string;
      items: readonly { label: string; value: string }[];
    };

export interface PluginSurfaceManifest {
  /** Short segment combined with the plugin id, e.g. "workspace". */
  id: string;
  title: string;
  description: string;
  icon: IconName;
  scope: SurfaceScope;
  hosts: readonly SurfaceHostKind[];
  instancePolicy: SurfaceInstancePolicy;
  lifecycle: SurfaceLifecyclePolicy;
  render:
    | { kind: 'declarative'; view: DeclarativeView }
    | { kind: 'builtin'; module: 'daniels.t3code.workspace' };
}

export interface PluginCommandManifest {
  id: string;
  title: string;
  category?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: PluginApiVersion;
  description: string;
  author: string;
  permissions: readonly PluginPermission[];
  contributes: {
    surfaces: readonly PluginSurfaceManifest[];
    commands?: readonly PluginCommandManifest[];
  };
}

export interface ValidatedPlugin {
  manifest: PluginManifest;
  surfaceIds: readonly SurfaceId[];
}

const NAMESPACED_ID = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const SEGMENT_ID = /^[a-z0-9][a-z0-9-]*$/;

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginManifestError';
  }
}

export function surfaceIdForPlugin(manifest: PluginManifest, surface: PluginSurfaceManifest): SurfaceId {
  return `${manifest.id}.${surface.id}` as SurfaceId;
}

export function validatePluginManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== 'object') throw new PluginManifestError('Manifest must be an object.');
  const manifest = raw as Partial<PluginManifest>;

  if (typeof manifest.id !== 'string' || !NAMESPACED_ID.test(manifest.id)) {
    throw new PluginManifestError('Manifest id must be a namespaced identifier (example.review-tools).');
  }
  if (manifest.id.startsWith('strand.')) {
    throw new PluginManifestError('The strand.* namespace is reserved for built-in surfaces.');
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
    throw new PluginManifestError('Manifest name is required.');
  }
  if (typeof manifest.version !== 'string' || manifest.version.trim().length === 0) {
    throw new PluginManifestError('Manifest version is required.');
  }
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new PluginManifestError(`Unsupported apiVersion "${String(manifest.apiVersion)}".`);
  }
  if (typeof manifest.description !== 'string') {
    throw new PluginManifestError('Manifest description is required.');
  }
  if (typeof manifest.author !== 'string') {
    throw new PluginManifestError('Manifest author is required.');
  }
  if (!Array.isArray(manifest.permissions)) {
    throw new PluginManifestError('Manifest permissions must be an array.');
  }
  for (const permission of manifest.permissions) {
    if (permission !== 'repository.read' && permission !== 'ai.invoke' && permission !== 'network.fetch') {
      throw new PluginManifestError(`Unknown permission "${String(permission)}".`);
    }
  }
  if (!manifest.contributes || typeof manifest.contributes !== 'object') {
    throw new PluginManifestError('Manifest contributes block is required.');
  }
  if (!Array.isArray(manifest.contributes.surfaces) || manifest.contributes.surfaces.length === 0) {
    throw new PluginManifestError('At least one surface contribution is required.');
  }
  if (manifest.contributes.surfaces.length > 8) {
    throw new PluginManifestError('Manifest exceeds the surface contribution limit (8).');
  }

  const validated = manifest as PluginManifest;
  const surfaceIds = new Set<string>();
  const surfaces = validated.contributes.surfaces as readonly PluginSurfaceManifest[];
  for (const surface of surfaces) {
    validateSurfaceManifest(validated, surface);
    const fullId = surfaceIdForPlugin(validated, surface);
    if (surfaceIds.has(fullId)) throw new PluginManifestError(`Duplicate surface id "${fullId}".`);
    surfaceIds.add(fullId);
  }

  return validated;
}

function validateSurfaceManifest(manifest: PluginManifest, surface: PluginSurfaceManifest): void {
  if (typeof surface.id !== 'string' || !SEGMENT_ID.test(surface.id)) {
    throw new PluginManifestError(`Surface id "${String(surface.id)}" must be a lowercase segment.`);
  }
  if (typeof surface.title !== 'string' || surface.title.trim().length === 0) {
    throw new PluginManifestError(`Surface "${surface.id}" requires a title.`);
  }
  if (typeof surface.description !== 'string') {
    throw new PluginManifestError(`Surface "${surface.id}" requires a description.`);
  }
  if (typeof surface.icon !== 'string') {
    throw new PluginManifestError(`Surface "${surface.id}" requires an icon.`);
  }
  if (!Array.isArray(surface.hosts) || surface.hosts.length === 0) {
    throw new PluginManifestError(`Surface "${surface.id}" must declare compatible hosts.`);
  }
  if (surface.render.kind === 'declarative') {
    validateDeclarativeView(surface.render.view);
  } else if (surface.render.kind === 'builtin') {
    if (surface.render.module !== 'daniels.t3code.workspace') {
      throw new PluginManifestError(`Unknown builtin module "${String(surface.render.module)}".`);
    }
    if (manifest.id !== 'daniels.t3code') {
      throw new PluginManifestError('The T3Code builtin module is reserved for daniels.t3code.');
    }
  } else {
    throw new PluginManifestError(`Surface "${surface.id}" has an invalid render kind.`);
  }
}

function validateDeclarativeView(view: DeclarativeView): void {
  if (view.type === 'markdown') {
    if (typeof view.content !== 'string' || view.content.length > 16_384) {
      throw new PluginManifestError('Markdown view content must be a string up to 16 KiB.');
    }
    return;
  }
  if (view.type === 'status') {
    if (typeof view.title !== 'string' || view.title.length === 0) {
      throw new PluginManifestError('Status view title is required.');
    }
    if (!Array.isArray(view.items) || view.items.length === 0 || view.items.length > 32) {
      throw new PluginManifestError('Status view requires 1–32 items.');
    }
    for (const item of view.items) {
      if (typeof item.label !== 'string' || typeof item.value !== 'string') {
        throw new PluginManifestError('Status view items require label and value strings.');
      }
    }
    return;
  }
  throw new PluginManifestError('Unknown declarative view type.');
}

export function toSurfaceContribution(
  manifest: PluginManifest,
  surface: PluginSurfaceManifest,
) {
  return {
    id: surfaceIdForPlugin(manifest, surface),
    title: surface.title,
    description: surface.description,
    icon: surface.icon,
    scope: surface.scope,
    hosts: surface.hosts,
    instancePolicy: surface.instancePolicy,
    lifecycle: surface.lifecycle,
  };
}
