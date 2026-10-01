# Plugin marketplace backlog

**Status:** Design note for DAN-77. Grounded in `docs/plugin-creation.md` and
`docs/extensibility-architecture.md`. Does not ship new permissions, view
types, or a remote catalog.

**Today's model.** Community and bundled plugins are data-only. Strand
validates a manifest (`apiVersion: "1"`), registers namespaced Workbench
surfaces, and renders them itself. Third-party JavaScript does not run in the
privileged webview. The capability broker exposes three named permissions:

| Permission | Ships today |
| --- | --- |
| `repository.read` | Read-only snapshot: path, name, branch, HEAD, dirty flag. |
| `ai.invoke` | Existing provider CLI orchestration (`repoSuggestCommitMessage`). |
| `network.fetch` | Reserved; the broker does not enable it. |

Declarative view types are `markdown` and `status`. `render.kind = "builtin"`
is reserved for Strand-maintained modules (Heroi, Quick Notes, Agent Session
Recap). Remote downloads, arbitrary React, and direct Tauri invoke remain
non-goals until isolation is proven.

Static `markdown` / `status` content cannot follow the active worktree, review
baseline, or loaded diffs. Anything that must read that context is a
Strand-hosted builtin that still requests only real permissions and degrades
to an empty state when context is missing.

## Suggested marketplace order (deferred)

Do not start a remote catalog in this phase. Architecture already lists
marketplace, signed indexes, and monetization as non-goals before local
permission and isolation hold. When that work is justified, suggested order:

1. **JSON Schema + "load unpacked"** — author against the existing manifest
   schema; install from a local folder for dogfood.
2. **Registry CI** — validate manifests in Strand's repo (what the bundled
   catalog already does at install time).
3. **Signed index** — hashed, signed catalog; no unsigned remote execute.
4. **Re-consent / revocation** — changing permissions re-prompts; revoke
   without plugin cooperation (broker already fails closed).
5. **Site / deep links** — install URLs after signing and consent exist.
6. **Non-verified publishers** — last, and only behind isolation plus
   explicit user consent.

Until an isolated runtime exists, Settings → Plugins stays a bundled
in-app list (`ui/src/plugins/marketplace.ts`).

## Tier 1 — fits today's primitives

Ideas that can ship with `markdown` / `status` and `repository.read` /
`ai.invoke`, or as a Strand-maintained builtin that uses those same
permissions and existing repo/review state.

| Idea | Today's model | Notes |
| --- | --- | --- |
| **Agent Session Recap** | Builtin (`daniels.session-recap`) | First dogfood for this note. Summarizes files touched, risky paths, and TODOs in loaded patches. `repository.read` only. Sits next to Review; does not grow a diff viewer. |
| Quick Notes | Builtin (`example.quick-notes`) | Already shipped. Scratchpad keyed by repository path. |
| Heroi | Builtin (`daniels.heroi`) | Already shipped. Chat only; Files/Review stay separate panes. |
| Static markdown checklists | Declarative `markdown` | No permissions. Fine for pinned runbooks. |
| Repo snapshot card | Declarative `status` | Branch/HEAD/dirty labels. The old Repo Status sample was removed; do not revive it unless it earns a pane. |
| AI one-liner of uncommitted work | `ai.invoke` | Already first-party via commit-message suggestion. Not a plugin. |

**Claude's other Tier-1 pick, Risk Radar,** is not shippable on today's
views. A useful radar wants a `list` / `badge` contribution (or tree-row
slots). That is a new surface type. Out of scope here.

## Tier 2 — needs slots or new view types

Typed Workbench slots (header actions, tree badges, context menus, detail
panels, status items) are designed in the architecture doc and are not
implemented. Do not pretend they shipped.

| Idea | Gap |
| --- | --- |
| Risk Radar | New declarative `list` / `badge` view, or tree-row badges. |
| Ownership / CODEOWNERS badges | Tree-row slot + a read of CODEOWNERS (new capability or first-party). |
| Review-queue decorations | Slot inside `strand.review.workspace`, not a third-party React tree. |
| Header actions on Files / Review | Header/toolbar slot. |

## Tier 3 — needs `network.fetch` and/or isolated UI

`network.fetch` is named in the manifest and thrown as missing by the
broker. Enabling it is a separate trust-boundary project.

| Idea | Gap |
| --- | --- |
| CI status panels | Brokered network to GitHub/Azure/etc.; likely a `status`/`list` surface plus host auth that plugins must never see raw. |
| Extra hosted-PR widgets | Same network + slots inside Pull Requests. |
| Secret sniffer (remote rules) | Local heuristics can live in Recap's risky-path list; remote rule packs need fetch + quotas. |

## Tier 4 — needs isolation (webview or WASI)

Custom UI in the main webview is rejected. Isolated custom UI and backend
are architecture phases 7, not this ticket.

| Idea | Gap |
| --- | --- |
| Arbitrary React dashboards | Unprivileged webview + schema-validated RPC. |
| Community git helpers / WASM tools | Capability-limited WASI; no `dlopen` into Strand. |
| Remote marketplace client | Signing, consent, revocation, then isolation. |

## Follow-ups (not this PR)

- Risk Radar after a `list`/`badge` primitive exists.
- Enable `network.fetch` only with host allowlists and quotas.
- Remote marketplace only after isolation is proven, in the order above.
