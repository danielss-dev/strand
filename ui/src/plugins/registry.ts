import { BUILT_IN_SURFACES } from '../workbench/builtInSurfaces';
import { SurfaceRegistry, type SurfaceContribution, type SurfaceId } from '../workbench/surfaces';
import { PluginCapabilityBroker } from './capabilities';
import {
  type PluginManifest,
  type PluginSurfaceManifest,
  type ValidatedPlugin,
  surfaceIdForPlugin,
  toSurfaceContribution,
  validatePluginManifest,
} from './manifest';

export interface InstalledPluginRecord extends ValidatedPlugin {
  enabled: boolean;
}

interface PluginSurfaceBinding {
  manifest: PluginManifest;
  surface: PluginSurfaceManifest;
}

/** User-level plugin lifecycle layered on the workbench surface registry. */
export class PluginRegistry {
  private readonly installed = new Map<string, InstalledPluginRecord>();
  private readonly surfaceBindings = new Map<SurfaceId, PluginSurfaceBinding>();
  private combinedRegistry = new SurfaceRegistry(BUILT_IN_SURFACES);

  listInstalled(): readonly InstalledPluginRecord[] {
    return [...this.installed.values()];
  }

  isInstalled(pluginId: string): boolean {
    return this.installed.has(pluginId);
  }

  getInstalled(pluginId: string): InstalledPluginRecord | undefined {
    return this.installed.get(pluginId);
  }

  getSurfaceRegistry(): SurfaceRegistry {
    return this.combinedRegistry;
  }

  getSurfaceBinding(surfaceId: SurfaceId): PluginSurfaceBinding | undefined {
    return this.surfaceBindings.get(surfaceId);
  }

  isPluginSurface(surfaceId: SurfaceId): boolean {
    return this.surfaceBindings.has(surfaceId);
  }

  install(raw: unknown): InstalledPluginRecord {
    const manifest = validatePluginManifest(raw);
    if (this.installed.has(manifest.id)) {
      throw new Error(`Plugin already installed: ${manifest.id}`);
    }
    const surfaceIds = manifest.contributes.surfaces.map((surface) => (
      surfaceIdForPlugin(manifest, surface)
    ));
    const record: InstalledPluginRecord = { manifest, surfaceIds, enabled: true };
    this.installed.set(manifest.id, record);
    this.registerSurfaces(manifest);
    return record;
  }

  uninstall(pluginId: string): boolean {
    const record = this.installed.get(pluginId);
    if (!record) return false;
    for (const surfaceId of record.surfaceIds) {
      this.combinedRegistry.unregister(surfaceId);
      this.surfaceBindings.delete(surfaceId);
    }
    this.installed.delete(pluginId);
    return true;
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    const record = this.installed.get(pluginId);
    if (!record || record.enabled === enabled) return;
    record.enabled = enabled;
    if (enabled) this.registerSurfaces(record.manifest);
    else this.unregisterSurfaces(record.manifest);
  }

  createBroker(pluginId: string): PluginCapabilityBroker {
    const record = this.installed.get(pluginId);
    if (!record?.enabled) return new PluginCapabilityBroker(new Set());
    return new PluginCapabilityBroker(new Set(record.manifest.permissions));
  }

  restoreInstalled(manifests: readonly unknown[]): InstalledPluginRecord[] {
    this.installed.clear();
    this.surfaceBindings.clear();
    this.combinedRegistry = new SurfaceRegistry(BUILT_IN_SURFACES);
    const records: InstalledPluginRecord[] = [];
    for (const raw of manifests) {
      try {
        records.push(this.install(raw));
      } catch (error) {
        console.warn('Skipping invalid installed plugin manifest', error);
      }
    }
    return records;
  }

  private registerSurfaces(manifest: PluginManifest): void {
    for (const surface of manifest.contributes.surfaces) {
      const contribution = toSurfaceContribution(manifest, surface);
      this.registerSurfaceContribution(contribution, manifest, surface);
    }
  }

  private unregisterSurfaces(manifest: PluginManifest): void {
    for (const surface of manifest.contributes.surfaces) {
      const surfaceId = surfaceIdForPlugin(manifest, surface);
      this.combinedRegistry.unregister(surfaceId);
      this.surfaceBindings.delete(surfaceId);
    }
  }

  private registerSurfaceContribution(
    contribution: SurfaceContribution,
    manifest: PluginManifest,
    surface: PluginSurfaceManifest,
  ): void {
    if (this.combinedRegistry.get(contribution.id)) {
      throw new Error(`Surface id already registered: ${contribution.id}`);
    }
    this.combinedRegistry.register(contribution);
    this.surfaceBindings.set(contribution.id, { manifest, surface });
  }
}

export const pluginRegistry = new PluginRegistry();
