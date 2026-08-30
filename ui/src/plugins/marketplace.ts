import type { PluginManifest } from './manifest';
import { heroiManifest } from './builtins/heroi/manifest';
import { quickNotesManifest } from './builtins/quickNotes/manifest';

export interface MarketplaceEntry {
  manifest: PluginManifest;
  /** True when Strand ships the renderer; third-party plugins stay declarative. */
  builtin: boolean;
  tags: readonly string[];
}

/** Bundled catalog — no remote fetch until signing and isolation are proven. */
export const MARKETPLACE_CATALOG: readonly MarketplaceEntry[] = [
  {
    manifest: heroiManifest,
    builtin: true,
    tags: ['agents', 'orchestrator', 'experimental'],
  },
  {
    manifest: quickNotesManifest,
    builtin: true,
    tags: ['notes', 'repository'],
  },
];

export function marketplaceEntryFor(pluginId: string): MarketplaceEntry | undefined {
  return MARKETPLACE_CATALOG.find((entry) => entry.manifest.id === pluginId);
}

export function marketplaceManifestFor(pluginId: string): PluginManifest | undefined {
  return marketplaceEntryFor(pluginId)?.manifest;
}
