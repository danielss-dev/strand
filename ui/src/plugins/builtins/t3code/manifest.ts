import type { PluginManifest } from '../../manifest';

export const T3CODE_SURFACE_ID = 'daniels.t3code.workspace' as const;

export const t3codeManifest: PluginManifest = {
  id: 'daniels.t3code',
  name: 'T3Code',
  version: '0.1.0',
  apiVersion: '1',
  description: 'Agent harness control surface for Codex and Claude Code inside Strand.',
  author: 'Daniels',
  permissions: ['repository.read', 'ai.invoke'],
  contributes: {
    surfaces: [
      {
        id: 'workspace',
        title: 'T3Code',
        description: 'Threads, providers, and agent status for the active repository.',
        icon: 'sparkle',
        scope: 'repository',
        hosts: ['main', 'panel', 'sidebar', 'bottom'],
        instancePolicy: 'singleton',
        lifecycle: 'keep-alive',
        render: { kind: 'builtin', module: 'daniels.t3code.workspace' },
      },
    ],
    commands: [
      { id: 'new-thread', title: 'T3Code: New thread', category: 'T3Code' },
    ],
  },
};
