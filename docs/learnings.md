# Learnings

Things we've learned while building Strand that aren't otherwise obvious from
the PRD / ROADMAP / TASKS files. Append here when you discover something
that future work (yours or another agent's) needs to respect.

---

## UI must be responsive and resizable

**Rule.** The app needs to feel responsive at any window size, and every
multi-pane layout in the app **must have resizable panes**.

**Why.** Strand is a desktop client people leave running for hours next to
their editor and terminal. Hard-coded pane widths force users to fight the
layout — they shrink the window or pop a long path into a tiny column and
lose work to ellipses. The PRD §8 performance bar and PRD §9 "good-looking
out of the box" goal both depend on the layout actually fitting the user's
screen, whatever that screen is.

**How to apply.**

- Every horizontal or vertical split between content panes uses
  `react-resizable-panels` (`<PanelGroup>`, `<Panel>`, `<PanelResizeHandle>`).
  Don't introduce fixed-width sidebars or `grid-template-columns: 200px 1fr`
  layouts for primary content regions.
- Give each `<PanelGroup>` a stable `autoSaveId` so the user's chosen sizes
  survive relaunch. Existing IDs: `strand:body`, `strand:lc-main`,
  `strand:lc-files`.
- Pick sensible `defaultSize` / `minSize` / `maxSize` so a panel can't be
  resized into uselessness. Sidebars: roughly 12–40%. Diff pane: never
  below 30% (Pierre needs room to render).
- Use the shared `.rs-handle.vert` / `.rs-handle.horiz` classes for resize
  handles so the hover/drag affordance is consistent everywhere.
- When adding a new pane: also check that its content reflows. Long file
  paths truncate (`text-overflow: ellipsis`), code lines wrap or scroll —
  never push the layout wider.
- Mobile / narrow widths are out of scope (PRD §2: no mobile), but the
  layout should still degrade gracefully on a laptop screen — nothing
  should require a 1600px viewport to be usable.

**Out of scope here.** This is about content panes. Native window chrome
(traffic lights, titlebar) and the topbar stay where they are.

---

## `tauri-plugin-sql` `:default` doesn't include writes

`sql:default` only grants `allow-close`, `allow-load`, `allow-select`.
**`INSERT`/`UPDATE`/`DELETE` (and any `Database.execute` call) are blocked
unless you also list `sql:allow-execute`** in
`crates/strand-tauri/capabilities/default.json`.

The failure mode is brutal: reads work, schema migrations run, the DB
file is created — but every write throws from the frontend. We caught
those errors with `console.warn`, so the only visible symptom was
"recents and session tabs are always empty across launches."

**How to apply.** Every Tauri plugin uses the same `:default` pattern. If
you wire a new plugin and writes seem to no-op, the first thing to check
is whether the corresponding `allow-execute` (or equivalent write
permission) is in the capabilities list. Plugin default permissions live
in `~/.cargo/registry/src/index.crates.io-*/tauri-plugin-<name>-<version>/permissions/default.toml`
— read them when you grant `<plugin>:default` and confirm the verbs you
need are covered.

### Gotcha: `react-resizable-panels` height plumbing

Two related traps. Both end in "the panel collapses, the pinned bottom bar
floats in the middle of the screen." Verify visually after touching any
PanelGroup site.

**1. Wrap `<PanelGroup>` in a flex-item div.** `<PanelGroup>` writes its
own inline `width: 100%; height: 100%; display: flex; overflow: hidden`.
Putting `className="flex-1-thing"` directly on the group doesn't work —
the inline `height: 100%` competes with `flex-basis`, the group computes
to content height, and siblings collapse.

```tsx
<div className="lc-main">           {/* flex: 1; min-height: 0 — owns layout */}
  <PanelGroup direction="horizontal" autoSaveId="…">
    …
  </PanelGroup>
</div>
```

**2. Panel children need `height: 100%`, not just `flex: 1`.** The library's
`<Panel>` is `display: block` for its content slot — flex rules from the
ancestor don't propagate through it. A child like `.main` that says
`flex: 1` only ends up `flex: 1` *within its own children*, not within
the Panel. Always pair `flex: 1` with `height: 100%` on content that
lives inside a Panel:

```css
.main {
  flex: 1;       /* works when used directly in a flex parent */
  height: 100%;  /* works when used inside a Panel — required */
}
```

Existing sites: `.body`, `.lc-main`, `.lc-files`, `.main`, `.sidebar`.
Copy the pattern when adding a new resizable region.
