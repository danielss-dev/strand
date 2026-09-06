import { create } from 'zustand';

import { settings } from '../lib/db';
import { marketplaceManifestFor } from '../plugins/marketplace';
import { pluginRegistry } from '../plugins/registry';
import { BufferedWrites } from '../lib/bufferedWrites';

const stateWrites = new BufferedWrites((key, value) => settings.set(key, value));

const INSTALLED_PLUGINS_KEY = 'plugins.installed';
const PLUGIN_STATE_PREFIX = 'plugin-state:';

export function pluginStateKey(pluginId: string, instanceId: string): string {
  return `${PLUGIN_STATE_PREFIX}${pluginId}:${instanceId}`;
}

interface PluginStoreState {
  ready: boolean;
  version: number;
  installedIds: readonly string[];
  restore(): Promise<void>;
  install(pluginId: string): Promise<void>;
  uninstall(pluginId: string): Promise<void>;
  loadState<T>(key: string): Promise<T | null>;
  saveState<T>(key: string, value: T): Promise<void>;
  scheduleState<T>(key: string, value: T): void;
  flushState(key: string): Promise<void>;
}

async function persistInstalled(ids: readonly string[]): Promise<void> {
  await settings.set(INSTALLED_PLUGINS_KEY, ids);
}

export const usePlugins = create<PluginStoreState>((set, get) => ({
  ready: false,
  version: 0,
  installedIds: [],

  async restore() {
    const stored = await settings.get<string[]>(INSTALLED_PLUGINS_KEY);
    const manifests = (stored ?? [])
      .map((pluginId) => marketplaceManifestFor(pluginId))
      .filter((manifest): manifest is NonNullable<typeof manifest> => manifest != null);
    pluginRegistry.restoreInstalled(manifests);
    set({
      ready: true,
      installedIds: pluginRegistry.listInstalled().map(({ manifest }) => manifest.id),
      version: get().version + 1,
    });
  },

  async install(pluginId) {
    const manifest = marketplaceManifestFor(pluginId);
    if (!manifest) throw new Error(`Unknown marketplace plugin: ${pluginId}`);
    if (pluginRegistry.isInstalled(pluginId)) return;
    pluginRegistry.install(manifest);
    const installedIds = [...get().installedIds, pluginId];
    await persistInstalled(installedIds);
    set({ installedIds, version: get().version + 1 });
  },

  async uninstall(pluginId) {
    if (!pluginRegistry.uninstall(pluginId)) return;
    const installedIds = get().installedIds.filter((id) => id !== pluginId);
    await persistInstalled(installedIds);
    set({ installedIds, version: get().version + 1 });
  },

  async loadState<T>(key: string): Promise<T | null> {
    await stateWrites.flush(key);
    return settings.get<T>(key);
  },

  async saveState<T>(key: string, value: T): Promise<void> {
    stateWrites.schedule(key, value);
    await stateWrites.flush(key);
  },
  scheduleState: (key, value) => stateWrites.schedule(key, value),
  flushState: (key) => stateWrites.flush(key),
}));
