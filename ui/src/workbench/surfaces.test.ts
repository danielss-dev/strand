import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_SURFACES,
  LEGACY_CUSTOM_FEATURE_IDS,
  builtInSurfaceRegistry,
  legacyFeatureIdForSurface,
  surfaceIdForLegacyFeature,
} from './builtInSurfaces';
import { SurfaceRegistry, type SurfaceContribution } from './surfaces';

function contribution(
  id: SurfaceContribution['id'],
  hosts: SurfaceContribution['hosts'],
): SurfaceContribution {
  return {
    id,
    title: id,
    description: `${id} description`,
    icon: 'workspace',
    scope: 'repository',
    hosts,
    instancePolicy: 'singleton',
    lifecycle: 'unmount',
  };
}

describe('SurfaceRegistry', () => {
  it('lists contributions in stable registration order', () => {
    const registry = new SurfaceRegistry([
      contribution('test.first', ['main']),
      contribution('test.second', ['panel']),
    ]);
    registry.register(contribution('test.third', ['sidebar']));

    expect(registry.list().map(({ id }) => id)).toEqual([
      'test.first',
      'test.second',
      'test.third',
    ]);
  });

  it('filters contributions by compatible host without changing order', () => {
    const registry = new SurfaceRegistry([
      contribution('test.first', ['main', 'sidebar']),
      contribution('test.second', ['bottom']),
      contribution('test.third', ['sidebar', 'bottom']),
    ]);

    expect(registry.listForHost('sidebar').map(({ id }) => id)).toEqual([
      'test.first',
      'test.third',
    ]);
    expect(registry.listForHost('panel')).toEqual([]);
  });

  it('rejects duplicate surface IDs without replacing the first contribution', () => {
    const first = contribution('test.duplicate', ['main']);
    const registry = new SurfaceRegistry([first]);

    expect(() => registry.register(contribution('test.duplicate', ['bottom']))).toThrow(
      'Surface contribution already registered: test.duplicate',
    );
    expect(registry.get('test.duplicate')).toBe(first);
  });

  it('rejects surface IDs that are not namespaced', () => {
    const registry = new SurfaceRegistry();

    expect(() => registry.register(contribution('invalid' as SurfaceContribution['id'], ['main'])))
      .toThrow('Surface contribution id "invalid" must be namespaced.');
  });

  it('can unregister a contribution without disturbing registration order', () => {
    const registry = new SurfaceRegistry([
      contribution('test.first', ['main']),
      contribution('test.second', ['main']),
    ]);

    expect(registry.unregister('test.first')).toBe(true);
    expect(registry.unregister('test.first')).toBe(false);
    expect(registry.list().map(({ id }) => id)).toEqual(['test.second']);
  });
});

describe('built-in surface contributions', () => {
  it('maps every legacy Custom v1 feature exactly once to a unique namespaced ID', () => {
    const legacyIds = BUILT_IN_SURFACES.map(({ legacyId }) => legacyId);
    const surfaceIds = BUILT_IN_SURFACES.map(({ id }) => id);

    expect(legacyIds).toHaveLength(LEGACY_CUSTOM_FEATURE_IDS.length);
    expect(new Set(legacyIds).size).toBe(legacyIds.length);
    expect(new Set(legacyIds)).toEqual(new Set(LEGACY_CUSTOM_FEATURE_IDS));
    expect(new Set(surfaceIds).size).toBe(surfaceIds.length);
    expect(surfaceIds.every((id) => id.startsWith('strand.'))).toBe(true);

    for (const surface of BUILT_IN_SURFACES) {
      expect(surfaceIdForLegacyFeature(surface.legacyId)).toBe(surface.id);
      expect(legacyFeatureIdForSurface(surface.id)).toBe(surface.legacyId);
      expect(builtInSurfaceRegistry.get(surface.id)).toBe(surface);
    }
    expect(legacyFeatureIdForSurface('plugin.unknown')).toBeUndefined();
  });
});
