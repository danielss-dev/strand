# Extensible workbench architecture

**Status:** Accepted; internal foundation implemented, public runtime pending

**Scope:** Built-in composition first; community plugin runtime later

**Decision owner:** Strand maintainers

## Context

The experimental Custom view proves that Strand features can be composed into
nested, resizable, workspace-persisted layouts. It also exposes the coupling
that prevents composition from scaling:

- `CUSTOM_FEATURE_IDS`, `CustomView` metadata, `App.tsx` labels and
  `renderCustomFeature`, palette actions, and the `View` union are separate
  closed lists.
- Some surfaces still load or handle navigation according to a global route,
  so embedding requires flags such as `active` or `embedded` and callbacks
  owned by `App.tsx`.
- Layout v1 caps panes at the number of built-ins, rejects duplicate features,
  and rejects an unknown feature ID by discarding the whole stored layout.
- Most feature state implicitly follows the active repository, which prevents
  a surface instance from being pinned to a repository or worktree.

These are acceptable prototype constraints, not a plugin contract. No
community plugin loader, sandbox, or public extension API exists today.

The branch also establishes three durable rules that this architecture must
preserve:

1. A stateful live surface has one owner until it explicitly supports multiple
   instances. Reassigning it moves the owner; it does not mount a hidden copy.
2. Expensive persistent renderers, especially Work's xterm/editor layer, stay
   at a stable React position. Composition places a reserved frame around the
   renderer instead of remounting it.
3. Workspace persistence includes every channel: cached models, in-flight
   restores, write queues, and resizable-panel identities. Stale restores may
   never cross workspace boundaries.

## Decision

Strand will become a **workbench** whose UI is assembled from registered
contributions. A feature declares surfaces, commands, and typed extension
slots without choosing their screen location. Hosts resolve those declarations
at runtime and supply explicit context, lifecycle, and app services.

Built-ins will adopt this contract before it is exposed to community plugins.
The public plugin boundary will be a narrow, versioned capability API rather
than Strand's React components, Zustand stores, DOM, or Tauri command surface.

### Implementation status (2026-08-28)

The first internal slice is implemented:

- `SurfaceRegistry` is the ordered source of truth for the ten namespaced
  built-in surface contributions, including host compatibility, scope,
  instance policy, lifecycle policy, size metadata, and legacy-ID migration.
- `SurfaceHost` resolves both dedicated and Custom placements, supplies the
  surface runtime contract, rejects incompatible hosts, and renders a stable
  placeholder when a contribution is unavailable.
- `WorkbenchCommandRegistry` provides ordered, namespaced, context-aware
  command registration and execution; Custom's generated layout commands use
  it before entering the existing global palette.
- Custom layout v2 separates `surfaceId` from `instanceId` and context binding,
  enforces bounded topology and known singleton policies, migrates v1, and
  preserves structurally valid unknown contribution IDs.
- Existing built-ins resolve through one renderer map. Work intentionally
  remains behind its stable external frame so live editors and PTYs are not
  remounted.

This does **not** make third-party plugins executable. Most built-ins still
read active repository state from existing stores, and typed services,
resource leases, extension slots, permission brokering, and isolation remain
future phases.

```text
built-in modules              community plugins (later)
       |                               |
       +-------- contribution registry+
                       |
            workbench shell and hosts
       layout | context | focus | lifecycle
                       |
       commands | dialogs | navigation | resources
                       |
          permission-checked capabilities
                       |
             Rust Git engine and providers
```

## Terminology

| Term | Meaning |
| --- | --- |
| **Feature** | A user capability such as Local Changes, Files, Commits, or Review. A feature is not a layout location. |
| **Module** | A namespaced registration unit. It contributes one or more surfaces, commands, menus, or slot items. Built-ins and plugins use the same contribution model, but not necessarily the same execution model. |
| **Surface** | A registered presentation of a capability, such as `strand.changes.workspace` or `strand.changes.explorer`. A feature may expose several surfaces for different jobs. |
| **Instance** | One identity-bearing placement of a surface with its own context binding and permitted local state. Surface identity and instance identity are separate. |
| **Host** | A workbench-owned location that can mount compatible surfaces: main area, sidebar, bottom panel, tab group, or split pane. |
| **Slot** | A typed extension point inside a Strand-owned surface, such as header actions, tree decorations, context-menu items, detail panels, or status items. It is not arbitrary DOM injection. |
| **Context** | The explicit app, workspace, repository, worktree, selection, and invocation identity available to a contribution. Context is data, not a global route. |

## Contribution registry

The registry is the single source of truth for discovery, rendering, placement,
instance limits, and command-palette exposure. Built-ins register statically at
startup and may lazy-load their implementation. Registration fails on duplicate
IDs or incompatible API versions.

An initial internal descriptor should be small and data-oriented:

```ts
interface SurfaceContribution {
  id: string; // namespaced, for example "strand.changes.explorer"
  title: string;
  icon: IconName;
  scope: 'app' | 'workspace' | 'repository' | 'worktree';
  allowedHosts: readonly HostKind[];
  instancePolicy: 'singleton' | 'per-context' | 'multiple';
  lifecycle: 'unmount' | 'keep-alive' | 'external-persistent';
  minSize?: { width?: number; height?: number };
  load: () => Promise<SurfaceFactory>;
}
```

The registry must provide indexed lookup and filtered enumeration. Feature
pickers, labels, layout validation, navigation, and command generation consume
the registry; they must not introduce parallel switches or ID arrays.

`instancePolicy` has precise semantics:

- `singleton`: at most one live instance in the process; assigning it elsewhere
  moves the existing instance.
- `per-context`: at most one live instance for each canonical context identity.
- `multiple`: independent instances are supported and all state, focus, DOM
  queries, and resource subscriptions are instance-scoped.

Existing stateful built-ins start as `singleton`. They move to a broader policy
only after tests prove that their stores, listeners, renderer state, and DOM
queries are isolated.

## Surface host

Every dedicated or composed placement resolves through `SurfaceHost`:

```tsx
<SurfaceHost
  surfaceId="strand.changes.workspace"
  instanceId="surface-instance-123"
  binding={{ kind: 'follow-active-repository' }}
/>
```

The host owns:

- descriptor lookup, lazy loading, loading/error boundaries, and an unavailable
  contribution placeholder;
- a surface-local root element for all focus and DOM queries;
- resolved context and lifecycle state;
- command, dialog, navigation, notification, and resource services;
- host kind and measured size; and
- enforcement of compatibility and instance policy.

`SurfaceHost` must not become a feature switch. Special renderers use explicit
host adapters. Work, for example, remains `external-persistent`: its stable
renderer layer is process-owned while the host publishes the active reserved
frame and lifecycle state.

Dedicated views become named workbench presets over the same hosts over time.
They may retain route aliases for navigation and backward compatibility, but
must not maintain a second render path.

## Lifecycle and resource leases

Every host reports three independent states:

- **mounted**: the instance and its state owner exist;
- **visible**: the user can currently see the surface and it may perform visible
  rendering or refresh work; and
- **focused**: the instance owns surface-level keyboard interaction.

Mounted does not imply visible, and visible does not imply focused. Only the
focused surface may own surface-level window shortcuts. Host-level navigation
shortcuts remain workbench-owned.

Data acquisition follows resource demand, never route names:

```ts
const lease = resources.acquire({
  context: repositoryContext.id,
  resource: 'working-tree-status',
  consumer: instanceId,
  active: lifecycle.visible,
});
```

The resource coordinator keys work by canonical context plus resource
parameters, reference-counts consumers, deduplicates IPC, shares bounded
caches, and cancels or ignores stale results. Expensive polling, diff
rendering, provider calls, and file loading stop when no visible consumer needs
them unless the resource explicitly requires background continuity. Hidden
keep-alive surfaces retain cheap UI state without becoming background work.

## Context binding and repository sessions

An instance stores a binding, not a captured global repository path:

```ts
type ContextBinding =
  | { kind: 'follow-active-workspace' }
  | { kind: 'follow-active-repository' }
  | { kind: 'pinned-repository'; repositoryId: string }
  | { kind: 'pinned-worktree'; worktreeId: string };
```

Bindings resolve to immutable context snapshots containing canonical IDs and
the capabilities permitted for that scope. Commands and resources receive that
snapshot explicitly. They must not infer the target from `view`, DOM position,
or a mutable `activePath` during asynchronous work.

Repository data will move incrementally toward sessions keyed by canonical
repository identity. The first migration does not rewrite the repository store;
it introduces a context adapter for current active-repository behavior, then
moves one resource family at a time. This supports future side-by-side
repositories and worktrees without placing that risk on the first registry
change.

## Workbench services

Placement-specific callback props and direct `setView(...)` calls will be
replaced with context-aware services.

### Commands

Commands are namespaced registrations such as `strand.changes.stage` or
`strand.worktree.create`. One command definition feeds the command palette,
keyboard binding, native and context menus, and toolbars. Invocation includes
the source instance and resolved context. Command enablement is derived from
context capabilities and selection, not the current route.

### Dialogs

Surfaces request typed dialogs through a workbench service. The shell owns
modal rendering, focus restoration, destructive confirmation, and result
typing. Features do not receive shell state setters.

### Navigation

Navigation reveals a surface rather than choosing a hard-coded page:

```ts
navigation.revealSurface('strand.review.workspace', {
  context,
  target: 'reuse-or-current-host',
});
```

The workbench may focus an existing compatible instance, place one in the
current host, or open its default preset. The caller does not know the final
location. Navigation to a selection or document is expressed as typed reveal
data, not a DOM query.

## Layout schema v2

Version 2 persists topology separately from surface-owned state. Its leaf is a
surface reference rather than a closed built-in feature union:

```ts
interface SurfaceRef {
  kind: 'surface';
  instanceId: string;
  surfaceId: string;
  binding: ContextBinding;
  stateRef?: string;
}

type LayoutNode =
  | SurfaceRef
  | { kind: 'empty'; id: string }
  | { kind: 'split'; id: string; direction: 'horizontal' | 'vertical'; ratio: number; children: [LayoutNode, LayoutNode] }
  | { kind: 'group'; id: string; activeInstanceId: string | null; children: SurfaceRef[] };
```

Required behavior:

- Pane count is a defensive storage limit, not the number of known built-ins.
- Duplicate acceptance is determined by the registered instance policy.
- Unknown or disabled `surfaceId` values are preserved and render a stable
  “contribution unavailable” placeholder with remove/retry actions.
- One missing plugin never invalidates or resets the rest of a layout.
- Plugin/surface state uses separately versioned, namespaced, quota-bounded
  storage. Layout topology carries only a `stateRef`.
- Split IDs and group IDs remain stable so resize persistence survives renders.
- Layout cache, restore, undo, write queue, and panel auto-save IDs are all
  workspace-scoped. A restore result is applied only if its workspace is still
  active.
- The v1 migrator maps built-in feature IDs to namespaced surface IDs and keeps
  the legacy value until v2 has been written successfully.

Validation is structural and bounded before registry resolution. This is what
allows an otherwise valid layout to survive an unavailable contribution.

## Extension slots

“Every view is extendable” means stable typed slots, not access to internal
component trees. A surface documents the slots it supports and the data schema
accepted by each slot. Initial slot categories should be limited to needs
already exercised by built-ins:

- header and toolbar actions;
- context-menu entries;
- tree row badges and decorations;
- detail/sidebar panels; and
- footer or status items.

Strand owns ordering, overflow, keyboard behavior, focus, accessible names,
themes, and rendering. Contributions declare content and commands. Slot IDs and
schemas are versioned; consumers must tolerate a contribution being missing or
disabled.

## Community plugin model

Community plugins eventually use a manifest with namespaced, versioned
contributions. This is a target shape, not an implemented format:

```json
{
  "id": "example.review-tools",
  "name": "Review Tools",
  "version": "1.0.0",
  "apiVersion": "1",
  "permissions": {
    "repository": ["read"],
    "network": ["api.example.com"]
  },
  "contributes": {
    "commands": [],
    "surfaces": [],
    "menus": [],
    "slots": []
  }
}
```

Plugin installation is user-level. Opening a repository must never install or
execute repository-provided code. IDs, contribution counts, manifest size,
stored state, payload size, and execution time are bounded. Missing, disabled,
or crashed plugins degrade to placeholders without damaging the layout.

### Trust boundary

Third-party JavaScript or React code will not execute inside Strand's
privileged main webview. That webview can reach a broad Tauri command surface,
and its current CSP deliberately disallows frames; making arbitrary code a
component would bypass a meaningful security boundary.

Plugin support therefore advances in tiers:

1. **Declarative contributions first.** Strand renders commands, menus,
   badges, trees, Markdown, forms, settings, and constrained surfaces from
   validated data.
2. **Isolated custom UI later.** If required, custom UI runs in a separate,
   unprivileged webview or equivalent sandbox. It communicates through a
   schema-validated, permission-checked RPC broker and cannot access the main
   DOM or Tauri invoke directly.
3. **Isolated backend later.** Computation runs in a capability-limited WASI
   runtime or an out-of-process helper. Strand does not load community Rust
   dynamic libraries into its process.

Plugins never receive raw Zustand stores, credentials, filesystem access,
provider tokens, shell execution, or unrestricted network access. Each
capability is explicit in the manifest, granted by the user, scoped to the
invocation context, and enforced by the broker. Revocation takes effect without
requiring the plugin to cooperate.

## Invariants

### Performance

- Registry lookups and contribution filtering are indexed; no plugin scan is
  added to Git hot paths or render loops.
- Surface implementations and isolated runtimes load lazily.
- Hidden surfaces do not fetch, poll, tokenize, or mount expensive renderers
  merely because they remain alive.
- Shared resources deduplicate IPC and bound cache memory. Plugin storage,
  payloads, execution, and event rates have hard quotas.
- Persistent renderers keep stable ownership and DOM placement contracts.
- Changes must continue to meet the PRD startup, large-repository open, and
  working-tree refresh targets. Extensibility is not permission to trade
  responsiveness for convenience.

### Accessibility and input

- Every host has a predictable entry target and pane/group keyboard navigation.
- Only the focused surface owns surface-level shortcuts; all queries begin at
  its root. Global commands remain workbench-owned.
- Every contributed action is reachable through the command system, including
  actions shown in pointer menus or toolbars.
- Strand-rendered declarative contributions use Strand components and retain
  their native semantics, focus order, accessible names, contrast, and
  platform-correct shortcut labels.
- Any future isolated custom UI must meet the same keyboard and accessibility
  contract before that contribution type becomes public.

## Migration plan

Each phase must preserve current behavior and land with focused tests. Do not
start community execution before built-ins prove the contract.

1. **Internal foundation — complete.** Register built-in surface and Custom
   command contributions, introduce `SurfaceHost`, share the existing renderer
   map across dedicated and Custom placements, and migrate persisted layouts
   to bounded v2 surface references with a fail-safe v1 reader.
2. **Services vertical slice.** Add typed command, dialog, and navigation
   services at the runtime boundary. Migrate Files and both Local Changes
   presentations end to end, removing route-gated loading while preserving
   their keyboard and focus contracts.
3. **Resources and context.** Add resource leases and active-repository context
   adapters. Migrate status/diff loading first, then provider and history
   resources. Add pinned repository/worktree bindings only after operations
   accept explicit canonical context.
4. **Remaining built-ins.** Move Commits, Review, Pull Requests, Reflog,
   Worktrees, Workspace Review, and Work to hosts. Keep Work behind its stable
   persistent-renderer adapter. Convert dedicated routes into named presets
   incrementally.
5. **Layout v2 completion.** Add tab groups, separately versioned surface state,
   retry/remove actions for missing contributions, and downgrade handling.
   Extend corrupt, oversized, stale-workspace, and missing-plugin coverage as
   those capabilities land.
6. **Declarative plugin API.** Version the manifest, capability broker, quotas,
   permissions UI, contribution diagnostics, and install/disable/remove
   lifecycle. Dogfood it with an optional built-in module before publishing an
   SDK.
7. **Isolated execution, if justified.** Design custom UI and backend sandboxes
   as separate security projects with threat models and cross-platform failure
   containment. They are not prerequisites for declarative plugins.

## Non-goals

- Shipping a community plugin runtime as part of the initial registry work.
- Allowing arbitrary React components, DOM/CSS injection, Tauri invocation, or
  direct store access from plugins.
- Making every existing surface multi-instance immediately.
- Rewriting the complete repository store before one vertical slice works.
- Removing every dedicated route in one change.
- Treating layout JSON as executable plugin configuration.
- Building a marketplace, remote layout sync, signing ecosystem, or plugin
  monetization before the local permission and isolation model is proven.

## Consequences

New built-in capabilities require one registration rather than edits across
the shell, picker, palette, and render switches. Surfaces can follow or pin a
context and can move between compatible hosts without knowing where they are.
Layouts survive unavailable plugins, while resource leases and stable renderer
ownership keep composition from becoming background work.

The cost is a deliberate internal platform layer: IDs and schemas require
governance, implicit global state must migrate gradually, and custom plugin UI
cannot be treated as an ordinary React component. Those costs buy a boundary
that remains stable, fast, accessible, and safe enough to expose later.
