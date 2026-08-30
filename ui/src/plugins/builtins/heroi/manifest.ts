import type { PluginManifest } from '../../manifest';

export const HEROI_SURFACE_ID = 'daniels.heroi.workspace' as const;

export const heroiManifest: PluginManifest = {
  id: 'daniels.heroi',
  name: 'Heroi',
  version: '0.1.0',
  apiVersion: '1',
  description: 'Repository-scoped coding-agent chat for Claude, Codex, and Cursor Agent inside the Strand Workbench.',
  author: 'Daniels',
  permissions: ['repository.read', 'ai.invoke'],
  contributes: {
    surfaces: [
      {
        id: 'workspace',
        title: 'Heroi',
        description: 'Chats scoped to the active repository with background Claude, Codex, and Cursor Agent sessions.',
        icon: 'sparkle',
        scope: 'repository',
        hosts: ['main', 'panel', 'sidebar', 'bottom'],
        instancePolicy: 'singleton',
        lifecycle: 'keep-alive',
        render: { kind: 'builtin', module: 'daniels.heroi.workspace' },
      },
    ],
    commands: [
      { id: 'new-conversation', title: 'Heroi: New conversation', category: 'Heroi' },
    ],
  },
};
