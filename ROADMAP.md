# Roadmap

Milestones map to PRD §11. Status as of 2026-05-25 (post Phase B step 1).

Legend: ☐ not started · ◐ in progress · ☑ done

---

## 0.0 — Scaffold ☑

Tauri 2 + Rust + React shell boots on macOS. IPC plumbed end-to-end with
4 read-only git commands (open / meta / status / log). Prototype design
system ported verbatim. No real feature surface yet.

---

## 0.1 — Internal alpha (≈ 6 weeks)

> PRD: "Repo management, basic ops (fetch/pull/push/commit/branch/checkout),
> diff & stage, commit graph, file tree, one platform — likely macOS."

- ◐ **Open / clone / add existing repo**
  - ☑ Dialog flow (native picker via ⌘O + topbar `+` dropdown, drag-and-drop folder onto window)
  - ☑ SQLite-backed recent-repo list with last-opened timestamp
  - ☑ Multi-repo tabs (open, switch, close)
  - ☐ Clone (HTTPS / SSH) with streaming progress
- ☐ **Local Changes — real staging UI**
  - List unstaged + staged with the actual status from `repo_status`
  - Line / hunk / file stage + unstage (likely requires `@pierre/diffs`)
  - Commit (subject + body + amend) via `git2`
- ☐ **Commit graph**
  - Table view from `repo_log` ☑ (placeholder, no lanes)
  - SVG lane/edge rendering with branch colors
  - Inline commit detail panel (changed files, message body)
- ☐ **Fetch / Pull / Push**
  - Rust commands streaming progress events to the frontend
  - Credential prompts via OS keychain
- ◐ **Branch ops**
  - ☐ List, checkout, create from HEAD or commit, delete
  - ☐ Sidebar wired to real data (currently placeholder)
  - ☑ Topbar branch dropdown shell (list + create-branch entry; both stubbed until reads/writes land)
- ☐ **File tree**
  - Working-tree view, status badges, click to file detail
  - Likely requires `@pierre/trees`
- ☐ **macOS packaging**
  - Real app icon (currently a placeholder "S")
  - Apple Developer ID signing + notarization
  - First DMG ships to a small alpha group

**Blockers cleared (2026-05-25):** PRD Q1 (Pierre libraries approved),
Q2 (license: AGPL-3.0 + dual-license commercial SKU), Q5 (pricing:
free + honor-system paid commercial license). Pierre diff & tree
integration is now unblocked.

---

## 0.5 — Public beta (≈ 12 weeks)

> PRD: "All P0 features. All three platforms. Auto-update. Light & dark
> themes. Performance targets met for medium repos."

- ☐ Stashes (create, apply, pop, drop)
- ☐ Tags (lightweight + annotated)
- ☐ Cherry-pick, revert, merge (ff / no-ff / squash), rebase
- ☐ Conflict resolution UI (three-way view)
- ☐ Discard changes (line / hunk / file) with single-undo
- ☐ Stacked + split diff layouts (persisted per-repo)
- ☐ **Theme management**
  - Light + dark themes with system-preference follow
  - Persisted per-user via settings store
  - Theme switcher in settings UI + command palette action
  - Live swap without reload (CSS variables already token-driven)
- ☐ Command palette: real action set (branches, files, commits, recents)
- ☐ Windows 11 build (chrome variant exists but is untested)
- ☐ Linux build (deb / rpm / AppImage)
- ☐ Tauri auto-update: real pubkey, real endpoint, signed manifests
- ☐ Performance pass to hit PRD §8 targets on medium repos
  (open <2s for 100k commits, status refresh <200ms on 10k files)

---

## 1.0 — Stable (≈ 20 weeks)

- ☐ Submodules (clone, update, status, recursive)
- ☐ Interactive rebase (custom sequence-editor protocol)
- ☐ Blame view (per-line author + commit jump)
- ☐ Reflog browser
- ☐ File history (log for a path)
- ☐ Commit search (`-G` / `-S`)
- ☐ Stashes shown inline on the graph
- ☐ Drag-and-drop renames in file tree
- ☐ Compact / default / relaxed density (settings UI; CSS already supports it)
- ☐ Crash reporting (opt-in, off by default)
- ☐ Telemetry (opt-in, clearly disclosed)
- ☐ Localization framework + English baseline
- ☐ Performance pass on 100k-commit repos
- ☐ Signed installers on all three platforms

---

## 1.1+ — Post-1.0

- Git-flow (start/finish feature/release/hotfix; shells out to `git-flow`)
- Git LFS (status badges + progress)
- GPG / SSH commit signing UI
- CLI companion binary (`strand`) over a local daemon
- Plugin / extension surface
- AI features (commit message suggestions, conflict hints) — PRD Q3
- Built-in PR review surface for GitHub / GitLab — PRD Q4

---

## Cross-cutting tracks (run in parallel with all milestones)

- **Security & signing.** EV cert for Windows. macOS notarization pipeline
  must be live by 0.1 alpha.
- **Open questions.** PRD §12 lists 5 open Qs.
  1. ☑ Pierre licensing — approved 2026-05-25.
  2. ☑ OSS vs source-available — AGPL-3.0 + dual-license commercial.
  3. ☐ AI features extension point — design before 1.0.
  4. ☐ PR review surface — 1.1 candidate.
  5. ☑ Pricing — free for all, honor-system paid commercial license.
- **Naming & trademark.** USPTO/EUIPO/WIPO search before 0.5 public launch.
