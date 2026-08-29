export {
  BUILT_IN_SURFACE_IDS,
  BUILT_IN_SURFACES,
  LEGACY_CUSTOM_FEATURE_IDS,
  builtInSurfaceRegistry,
  legacyFeatureIdForSurface,
  surfaceIdForLegacyFeature,
  type BuiltInSurfaceContribution,
  type LegacyCustomFeatureId,
} from './builtInSurfaces';
export {
  DuplicateWorkbenchCommandError,
  UnavailableWorkbenchCommandError,
  UnknownWorkbenchCommandError,
  WorkbenchCommandRegistry,
  type WorkbenchCommandContext,
  type WorkbenchCommandDefinition,
  type WorkbenchCommandId,
} from './commands';
export {
  SurfaceRegistry,
  type SurfaceContextBinding,
  type SurfaceContribution,
  type SurfaceHostKind,
  type SurfaceId,
  type SurfaceInstancePolicy,
  type SurfaceLifecycle,
  type SurfaceLifecyclePolicy,
  type SurfaceScope,
  type SurfaceSizeConstraints,
} from './surfaces';
export {
  SurfaceHost,
  useSurfaceRuntime,
  type SurfaceRenderer,
  type SurfaceRenderRequest,
} from './SurfaceHost';
export { pluginRegistry } from '../plugins/registry';
