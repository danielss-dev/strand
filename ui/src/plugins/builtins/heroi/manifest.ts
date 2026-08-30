import type { PluginManifest } from '../../manifest';

export const HEROI_SURFACE_ID = 'daniels.heroi.workspace' as const;

export const heroiManifest: PluginManifest = {
  id: 'daniels.heroi',
  name: 'Heroi',
  version: '0.1.0',
  apiVersion: '1',
  description: 'Agentic IDE chrome from heroi_aide — workspaces, chats, Claude/Codex/Cursor composer, kanban, and diffs hosted as a Strand Workbench surface.',
  author: 'Daniels',
  permissions: ['repository.read'],
  contributes: {
    surfaces: [
      {
        id: 'workspace',
        title: 'Heroi',
        description: 'heroi_aide layout: project sidebar, conversations, and a diff panel for the active Strand repository.',
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
