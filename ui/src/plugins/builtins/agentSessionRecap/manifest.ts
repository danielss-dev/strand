import type { PluginManifest } from '../../manifest';

export const SESSION_RECAP_SURFACE_ID = 'daniels.session-recap.workspace' as const;

export const sessionRecapManifest: PluginManifest = {
  id: 'daniels.session-recap',
  name: 'Agent Session Recap',
  version: '0.1.0',
  apiVersion: '1',
  description: 'Summarize what an agent changed in the active worktree: files touched, risky paths, and TODOs left behind.',
  author: 'Daniels',
  permissions: ['repository.read'],
  contributes: {
    surfaces: [
      {
        id: 'workspace',
        title: 'Session Recap',
        description: 'Files, risky areas, and leftover TODOs for the active repository or worktree, next to Review.',
        icon: 'compare',
        scope: 'repository',
        hosts: ['main', 'panel', 'sidebar', 'bottom'],
        instancePolicy: 'singleton',
        lifecycle: 'unmount',
        render: { kind: 'builtin', module: 'daniels.session-recap.workspace' },
      },
    ],
  },
};
