import type { PluginManifest } from './manifest';
import { t3codeManifest } from './builtins/t3code/manifest';

export interface MarketplaceEntry {
  manifest: PluginManifest;
  /** True when Strand ships the renderer; third-party plugins stay declarative. */
  builtin: boolean;
  tags: readonly string[];
}

/** Bundled catalog — no remote fetch until signing and isolation are proven. */
export const MARKETPLACE_CATALOG: readonly MarketplaceEntry[] = [
  {
    manifest: t3codeManifest,
    builtin: true,
    tags: ['agents', 'ai', 'experimental'],
  },
  {
    manifest: {
      id: 'example.quick-notes',
      name: 'Quick Notes',
      version: '1.0.0',
      apiVersion: '1',
      description: 'A declarative scratchpad rendered entirely by Strand.',
      author: 'Strand',
      permissions: [],
      contributes: {
        surfaces: [
          {
            id: 'workspace',
            title: 'Quick Notes',
            description: 'Pinned markdown notes inside the Workbench.',
            icon: 'edit',
            scope: 'workspace',
            hosts: ['main', 'panel', 'sidebar', 'bottom'],
            instancePolicy: 'singleton',
            lifecycle: 'keep-alive',
            render: {
              kind: 'declarative',
              view: {
                type: 'markdown',
                content: [
                  '# Quick Notes',
                  '',
                  'This pane is a **declarative plugin surface**. Strand renders the',
                  'markdown from the manifest — no third-party JavaScript executes',
                  'inside the privileged webview.',
                  '',
                  'Install plugins from Settings → Plugins, then add them to a',
                  'Workbench pane while customizing the layout.',
                ].join('\n'),
              },
            },
          },
        ],
      },
    },
    builtin: false,
    tags: ['declarative', 'sample'],
  },
  {
    manifest: {
      id: 'example.repo-status',
      name: 'Repository Status',
      version: '1.0.0',
      apiVersion: '1',
      description: 'Read-only repository snapshot via the permission broker.',
      author: 'Strand',
      permissions: ['repository.read'],
      contributes: {
        surfaces: [
          {
            id: 'panel',
            title: 'Repo Status',
            description: 'Shows the active repository branch and HEAD.',
            icon: 'branch',
            scope: 'repository',
            hosts: ['panel', 'sidebar', 'bottom'],
            instancePolicy: 'singleton',
            lifecycle: 'unmount',
            render: {
              kind: 'declarative',
              view: {
                type: 'status',
                title: 'Active repository',
                items: [
                  { label: 'Branch', value: 'Follows active repository' },
                  { label: 'HEAD', value: 'Granted via repository.read' },
                ],
              },
            },
          },
        ],
      },
    },
    builtin: false,
    tags: ['declarative', 'repository'],
  },
];

export function marketplaceEntryFor(pluginId: string): MarketplaceEntry | undefined {
  return MARKETPLACE_CATALOG.find((entry) => entry.manifest.id === pluginId);
}

export function marketplaceManifestFor(pluginId: string): PluginManifest | undefined {
  return marketplaceEntryFor(pluginId)?.manifest;
}
