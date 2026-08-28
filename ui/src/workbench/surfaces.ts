import type { IconName } from '../components/Icon';

/** Public surface IDs are namespaced so built-ins and plugins cannot collide. */
export type SurfaceId = `${string}.${string}`;

export type SurfaceHostKind = 'main' | 'panel' | 'sidebar' | 'bottom';
export type SurfaceScope = 'app' | 'workspace' | 'repository' | 'worktree';
export type SurfaceInstancePolicy = 'singleton' | 'per-context' | 'multiple';
export type SurfaceLifecyclePolicy = 'unmount' | 'keep-alive';

export interface SurfaceSizeConstraints {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

export interface SurfaceContribution {
  id: SurfaceId;
  title: string;
  description: string;
  icon: IconName;
  scope: SurfaceScope;
  hosts: readonly SurfaceHostKind[];
  instancePolicy: SurfaceInstancePolicy;
  lifecycle: SurfaceLifecyclePolicy;
  size?: Readonly<SurfaceSizeConstraints>;
}

/** Runtime state supplied by a host to a mounted surface. */
export interface SurfaceLifecycle {
  mounted: boolean;
  visible: boolean;
  focused: boolean;
}

export type SurfaceContextBinding =
  | { kind: 'follow-active' }
  | { kind: 'pinned-repository'; repositoryId: string }
  | { kind: 'pinned-worktree'; worktreeId: string }
  | { kind: 'pinned-workspace'; workspaceId: string };

/**
 * Ordered metadata registry. Rendering remains the workbench host's concern so
 * the contribution contract can also describe isolated plugin surfaces later.
 */
export class SurfaceRegistry {
  private readonly contributions = new Map<SurfaceId, SurfaceContribution>();

  constructor(contributions: Iterable<SurfaceContribution> = []) {
    for (const contribution of contributions) this.register(contribution);
  }

  register(contribution: SurfaceContribution): void {
    if (!isNamespacedSurfaceId(contribution.id)) {
      throw new TypeError(`Surface contribution id "${contribution.id}" must be namespaced.`);
    }
    if (this.contributions.has(contribution.id)) {
      throw new Error(`Surface contribution already registered: ${contribution.id}`);
    }
    this.contributions.set(contribution.id, contribution);
  }

  unregister(id: SurfaceId): boolean {
    return this.contributions.delete(id);
  }

  get(id: SurfaceId): SurfaceContribution | undefined {
    return this.contributions.get(id);
  }

  list(): readonly SurfaceContribution[] {
    return [...this.contributions.values()];
  }

  listForHost(host: SurfaceHostKind): readonly SurfaceContribution[] {
    return this.list().filter((contribution) => contribution.hosts.includes(host));
  }
}

function isNamespacedSurfaceId(value: string): value is SurfaceId {
  return /^[^.\s]+(?:\.[^.\s]+)+$/.test(value);
}
