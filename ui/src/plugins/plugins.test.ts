import { describe, expect, it, vi } from 'vitest';

import { PluginCapabilityBroker, PluginPermissionError } from './capabilities';
import { validatePluginManifest, PLUGIN_API_VERSION } from './manifest';
import { MARKETPLACE_CATALOG } from './marketplace';
import { PluginRegistry } from './registry';
import { sessionRecapManifest } from './builtins/agentSessionRecap/manifest';
import { heroiManifest } from './builtins/heroi/manifest';
import { quickNotesManifest } from './builtins/quickNotes/manifest';

describe('validatePluginManifest', () => {
  it('accepts a valid declarative plugin manifest', () => {
    const manifest = validatePluginManifest({
      id: 'example.demo',
      name: 'Demo',
      version: '1.0.0',
      apiVersion: PLUGIN_API_VERSION,
      description: 'Demo plugin',
      author: 'Strand',
      permissions: [],
      contributes: {
        surfaces: [{
          id: 'panel',
          title: 'Demo',
          description: 'Demo surface',
          icon: 'workspace',
          scope: 'app',
          hosts: ['panel'],
          instancePolicy: 'singleton',
          lifecycle: 'unmount',
          render: {
            kind: 'declarative',
            view: { type: 'markdown', content: '# Hello' },
          },
        }],
      },
    });
    expect(manifest.id).toBe('example.demo');
  });

  it('rejects reserved strand namespace', () => {
    expect(() => validatePluginManifest({
      id: 'strand.custom',
      name: 'Bad',
      version: '1.0.0',
      apiVersion: PLUGIN_API_VERSION,
      description: 'Bad',
      author: 'Bad',
      permissions: [],
      contributes: { surfaces: [] },
    })).toThrow('strand.* namespace is reserved');
  });

  it('reserves the Session Recap builtin module', () => {
    expect(() => validatePluginManifest({
      ...sessionRecapManifest,
      id: 'example.not-recap',
    })).toThrow('Session Recap builtin module is reserved');
  });
});

describe('MARKETPLACE_CATALOG', () => {
  it('ships Heroi as the dogfood builtin and never lists T3Code', () => {
    const ids = MARKETPLACE_CATALOG.map((entry) => entry.manifest.id);
    expect(ids).toContain('daniels.heroi');
    expect(ids).not.toContain('daniels.t3code');
    const heroi = MARKETPLACE_CATALOG.find((entry) => entry.manifest.id === 'daniels.heroi');
    expect(heroi?.builtin).toBe(true);
    expect(heroi?.manifest.name).toBe('Heroi');
    expect(heroi?.manifest.description).toMatch(/Claude/);
    expect(heroi?.manifest.description).toMatch(/Codex/);
    expect(heroi?.manifest.description).toMatch(/Cursor/);
    expect(heroi?.manifest.description).not.toMatch(/Gemini/);
    expect(heroi?.manifest.description).not.toMatch(/Aider/);
    expect(heroiManifest.contributes.commands?.[0]?.id).toBe('new-conversation');
    expect(ids).toContain('example.quick-notes');
    expect(ids).toContain('daniels.session-recap');
    expect(ids).not.toContain('example.repo-status');
    expect(MARKETPLACE_CATALOG.find((entry) => entry.manifest.id === 'example.quick-notes')?.builtin).toBe(true);
    expect(quickNotesManifest.contributes.surfaces[0]?.scope).toBe('repository');
    const recap = MARKETPLACE_CATALOG.find((entry) => entry.manifest.id === 'daniels.session-recap');
    expect(recap?.builtin).toBe(true);
    expect(recap?.manifest.permissions).toEqual(['repository.read']);
    expect(sessionRecapManifest.contributes.surfaces[0]?.render).toEqual({
      kind: 'builtin',
      module: 'daniels.session-recap.workspace',
    });
    expect(validatePluginManifest(sessionRecapManifest).id).toBe('daniels.session-recap');
  });
});

describe('PluginRegistry', () => {
  it('registers plugin surfaces into the combined workbench registry', () => {
    const registry = new PluginRegistry();
    registry.install(heroiManifest);
    expect(registry.getSurfaceRegistry().get('daniels.heroi.workspace')?.title).toBe('Heroi');
    registry.uninstall('daniels.heroi');
    expect(registry.getSurfaceRegistry().get('daniels.heroi.workspace')).toBeUndefined();
  });

  it('registers Agent Session Recap as a workbench surface', () => {
    const registry = new PluginRegistry();
    registry.install(sessionRecapManifest);
    expect(registry.getSurfaceRegistry().get('daniels.session-recap.workspace')?.title).toBe('Session Recap');
    expect(registry.createBroker('daniels.session-recap').has('repository.read')).toBe(true);
    expect(registry.createBroker('daniels.session-recap').has('ai.invoke')).toBe(false);
  });
});

describe('PluginCapabilityBroker', () => {
  it('blocks capabilities that are not granted', async () => {
    const broker = new PluginCapabilityBroker(new Set(['repository.read']));
    await expect(broker.readRepository('/tmp/repo', 'main', 'abc', false)).resolves.toMatchObject({
      name: 'repo',
    });
    await expect(broker.invokeAi(
      '/tmp/repo',
      'openai',
      'gpt-5.6-luna',
      { opId: '1', sensitiveDecision: { mode: 'scan' }, styleInstruction: null },
      null,
      null,
    )).rejects.toBeInstanceOf(PluginPermissionError);
  });

  it('invokes AI when ai.invoke is granted', async () => {
    const { tauri } = await import('../lib/tauri');
    vi.spyOn(tauri, 'repoSuggestCommitMessage').mockResolvedValue({
      status: 'generated',
      suggestion: { subject: 'Plan', body: 'Do the thing' },
      coverage: {
        scope: 'unstaged',
        totalFiles: 0,
        manifestFiles: 0,
        patchFiles: 0,
        omittedPatchFiles: 0,
        truncatedPatchFiles: 0,
        sensitiveExcludedFiles: 0,
      },
      provider: 'openai',
    });
    const broker = new PluginCapabilityBroker(new Set(['ai.invoke']));
    const result = await broker.invokeAi(
      '/tmp/repo',
      'openai',
      'gpt-5.6-luna',
      { opId: '1', sensitiveDecision: { mode: 'scan' }, styleInstruction: 'Plan work' },
      null,
      null,
    );
    expect(result.subject).toBe('Plan');
  });
});
