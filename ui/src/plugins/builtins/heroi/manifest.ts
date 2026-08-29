import type { PluginManifest } from '../../manifest';

export const HEROI_SURFACE_ID = 'daniels.heroi.workspace' as const;

export const heroiManifest: PluginManifest = {
  id: 'daniels.heroi',
  name: 'Heroi',
  version: '0.1.0',
  apiVersion: '1',
  description: 'Local AI agent orchestrator for the active repository — Claude Code, Codex, Gemini CLI, Aider, or a plain shell (Daniels\' Heroi, in Strand).',
  author: 'Daniels',
  permissions: ['repository.read', 'ai.invoke'],
  contributes: {
    surfaces: [
      {
        id: 'workspace',
        title: 'Heroi',
        description: 'Launch and track coding agents against the active repository or worktree.',
        icon: 'sparkle',
        scope: 'repository',
        hosts: ['main', 'panel', 'sidebar', 'bottom'],
        instancePolicy: 'singleton',
        lifecycle: 'keep-alive',
        render: { kind: 'builtin', module: 'daniels.heroi.workspace' },
      },
    ],
    commands: [
      { id: 'new-session', title: 'Heroi: New agent session', category: 'Heroi' },
    ],
  },
};
