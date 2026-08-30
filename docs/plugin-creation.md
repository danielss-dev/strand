# Plugin creation guide

This guide explains how to author a **declarative** Strand plugin that registers
a Workbench surface without executing third-party JavaScript inside Strand's
privileged webview. Read `docs/extensibility-architecture.md` first — it defines
the trust boundary this format implements.

## What ships today

- Bundled marketplace entries validated at install time
- Namespaced surface contributions merged into the Workbench `SurfaceRegistry`
- Permission-checked capability broker (`repository.read`, `ai.invoke`, `network.fetch`)
- Declarative surfaces rendered by Strand (`markdown`, `status`)
- One built-in dogfood plugin: **Heroi** (`daniels.heroi`) — Strand-hosted
  repository-scoped coding-agent chat with native, streaming Claude, Codex,
  and Cursor Agent sessions. Files, diffs, git changes, and other tooling stay
  in their own Workbench surfaces.

Community plugins cannot load arbitrary React, touch Zustand, call Tauri directly,
or access the DOM. Those capabilities require future isolated runtimes.

## Manifest shape

Save a JSON file with this structure:

```json
{
  "id": "example.quick-notes",
  "name": "Quick Notes",
  "version": "1.0.0",
  "apiVersion": "1",
  "description": "Pinned markdown notes inside the Workbench.",
  "author": "Your Name",
  "permissions": [],
  "contributes": {
    "surfaces": [
      {
        "id": "workspace",
        "title": "Quick Notes",
        "description": "Scratchpad rendered by Strand.",
        "icon": "edit",
        "scope": "workspace",
        "hosts": ["main", "panel", "sidebar", "bottom"],
        "instancePolicy": "singleton",
        "lifecycle": "keep-alive",
        "render": {
          "kind": "declarative",
          "view": {
            "type": "markdown",
            "content": "# Notes\n\nWrite markdown here."
          }
        }
      }
    ]
  }
}
```

### Required fields

| Field | Rule |
| --- | --- |
| `id` | Namespaced lowercase identifier (`publisher.plugin`). `strand.*` is reserved. |
| `apiVersion` | Must be `"1"`. |
| `permissions` | Explicit list; empty array when none are needed. |
| `contributes.surfaces` | At least one surface; max eight per manifest. |

Each surface `id` is a short segment. The full Workbench surface id becomes
`${manifest.id}.${surface.id}` — for example `example.quick-notes.workspace`.

### Permissions

| Permission | Grants |
| --- | --- |
| `repository.read` | Read-only snapshot of the active repository (path, branch, HEAD, dirty flag). |
| `ai.invoke` | Call Strand's existing provider CLI orchestration with an explicit request payload. |
| `network.fetch` | Reserved for future brokered network access (not enabled yet). |

Request only what the surface needs. The broker throws `PluginPermissionError`
when a capability is missing.

### Declarative view types

**Markdown**

```json
{
  "type": "markdown",
  "content": "# Title\n\nUp to 16 KiB of markdown."
}
```

**Status**

```json
{
  "type": "status",
  "title": "Repository",
  "items": [
    { "label": "Branch", "value": "main" },
    { "label": "HEAD", "value": "abc1234" }
  ]
}
```

Strand renders both view types with first-party components and theme tokens.

### Built-in renderers (Strand-maintained only)

Only Strand may ship `render.kind = "builtin"`. Today the allowed module is
`daniels.heroi.workspace` for the Heroi dogfood plugin. Third-party manifests
that declare `builtin` are rejected at validation time.

## Validation checklist

Before submitting a manifest, confirm:

1. `validatePluginManifest(manifest)` passes (see `ui/src/plugins/manifest.ts`).
2. Surface ids are unique after namespacing.
3. Icons use an existing `IconName` from `ui/src/components/Icon.tsx`.
4. `hosts` includes at least one of `main`, `panel`, `sidebar`, `bottom`.
5. `instancePolicy` matches how many live copies you expect:
   - `singleton` — one process-wide instance (default for stateful tools)
   - `per-context` — one instance per binding context
   - `multiple` — independent instances

## Adding to the bundled marketplace

Until remote distribution exists, new plugins ship by adding an entry to
`ui/src/plugins/marketplace.ts`:

```ts
{
  manifest: yourManifest,
  builtin: false,
  tags: ['declarative'],
}
```

Users install from **Settings → Plugins**. Installed plugin ids persist in SQLite
under `plugins.installed` (user-level, not workspace-scoped).

## Using a plugin in the Workbench

1. Install the plugin from Settings → Plugins.
2. Open Workbench (`Mod+1`).
3. Press `Mod+8` (Customize Workbench…).
4. Choose the plugin surface from the pane picker.
5. Done — layout persists per workspace without remounting Work's live editor/PTY.

The command palette exposes `Workbench: show <surface>` entries for every
registered surface, including installed plugins.

## AI agent workflow

When generating a plugin with an AI agent, provide this file plus:

- The target surface title and description
- Required permissions and why
- Declarative view content or status rows
- Desired `instancePolicy` and `scope`

Ask the agent to output **only** valid JSON matching the schema above, then run
the UI tests:

```bash
pnpm --filter ./ui exec tsc --noEmit
pnpm --filter ./ui test
```

## Related code

| Path | Purpose |
| --- | --- |
| `ui/src/plugins/manifest.ts` | Schema + validation |
| `ui/src/plugins/registry.ts` | Install/uninstall + surface registration |
| `ui/src/plugins/capabilities.ts` | Permission broker |
| `ui/src/plugins/marketplace.ts` | Bundled catalog |
| `ui/src/plugins/renderSurface.tsx` | Declarative + builtin render routing |
| `ui/src/plugins/builtins/heroi/` | Heroi dogfood plugin |
| `ui/src/workbench/SurfaceHost.tsx` | Host lifecycle contract |

## Non-goals (this phase)

- Remote marketplace downloads
- Arbitrary React components from third parties
- Direct Tauri invoke from plugin code
- Repository-scoped auto-install

See `docs/extensibility-architecture.md` for the full phased plan.
