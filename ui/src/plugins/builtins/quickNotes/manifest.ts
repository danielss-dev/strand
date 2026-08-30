import type { PluginManifest } from '../../manifest';

export const QUICK_NOTES_SURFACE_ID = 'example.quick-notes.workspace' as const;

export const quickNotesManifest: PluginManifest = {
  id: 'example.quick-notes',
  name: 'Quick Notes',
  version: '1.1.0',
  apiVersion: '1',
  description: 'A repository-scoped scratchpad saved in Strand.',
  author: 'Strand',
  permissions: ['repository.read'],
  contributes: {
    surfaces: [
      {
        id: 'workspace',
        title: 'Quick Notes',
        description: 'Notes for the active repository, stored by Strand.',
        icon: 'edit',
        scope: 'repository',
        hosts: ['main', 'panel', 'sidebar', 'bottom'],
        instancePolicy: 'singleton',
        lifecycle: 'keep-alive',
        render: { kind: 'builtin', module: 'strand-tools.quick-notes.workspace' },
      },
    ],
  },
};
