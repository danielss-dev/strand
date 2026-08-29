export {
  PLUGIN_API_VERSION,
  PluginManifestError,
  surfaceIdForPlugin,
  toSurfaceContribution,
  validatePluginManifest,
  type DeclarativeView,
  type PluginCommandManifest,
  type PluginManifest,
  type PluginPermission,
  type PluginSurfaceManifest,
  type ValidatedPlugin,
} from './manifest';
export {
  PluginCapabilityBroker,
  PluginPermissionError,
  type RepositorySnapshot,
} from './capabilities';
export {
  MARKETPLACE_CATALOG,
  marketplaceEntryFor,
  marketplaceManifestFor,
  type MarketplaceEntry,
} from './marketplace';
export {
  PluginRegistry,
  pluginRegistry,
  type InstalledPluginRecord,
} from './registry';
export { renderPluginSurface, isPluginSurface } from './renderSurface';
export { T3CODE_SURFACE_ID, t3codeManifest } from './builtins/t3code/manifest';
