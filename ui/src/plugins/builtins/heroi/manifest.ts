import type { PluginManifest } from '../../manifest';

export const HEROI_SURFACE_ID = 'daniels.heroi.workspace' as const;

export const heroiManifest: PluginManifest = {
  id: 'daniels.heroi',
  name: 'Heroi',
  version: '0.1.0',
  apiVersion: '1',
  description: 'Local AI agent orchestrator UI (Daniels\' Heroi) — repo sidebar, agent tabs, and git inspector for Claude Code, Codex, Gemini CLI, Aider, or Shell.',
  author: 'Daniels',
  permissions: ['repository.read'],
  contributes: {
    surfaces: [
      {
        id: 'workspace',
        title: 'Heroi',
        description: 'Heroi-style agent launcher for the active Strand repository or worktree.',
        icon: 'sparkle',
        scope: 'repository',
        hosts: ['main', 'panel', 'sidebar', 'bottom'],
        instancePolicy: 'singleton',
        lifecycle: 'keep-alive',
        render: { kind: 'builtin', module: 'daniels.heroi.workspace' },
      },
    ],
    commands: [
      { id: 'new-tab', title: 'Heroi: New agent tab', category: 'Heroi' },
    ],
  },
};
