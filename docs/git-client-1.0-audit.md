# Git-client 1.0 parity audit

Last reviewed: 2026-07-18

## Goal and bar

Strand 1.0 should replace Fork, GitKraken, Tower, or the Git CLI for a
professional developer's everyday repository work while keeping Strand's
advantages: fast local reads, strong keyboard access, first-class worktrees,
and review of AI-authored changes.

“Parity” does not mean copying every cloud feature or every obscure Git flag.
It means that common local and hosted workflows have a clear UI path, advanced
variants are discoverable at the point of use, destructive actions have a
safety boundary, and the command palette reaches the same actions.

This audit compares Strand's implemented surfaces and `TASKS.md` against the
current official product material for:

- [Fork features](https://git-fork.com/) and [Fork release notes](https://git-fork.com/releasenotes)
- [GitKraken push, pull, and fetch](https://help.gitkraken.com/gitkraken-desktop/pushing-and-pulling/)
- [GitKraken branching and merging](https://help.gitkraken.com/gitkraken-desktop/branching-and-merging/)
- [GitKraken command palette](https://help.gitkraken.com/gitkraken-desktop/command-palette/)
- [Tower feature overview](https://www.git-tower.com/features/all-features)

## Priority definitions

- **Release blocker** — required by Strand's PRD for 1.0 or necessary for a
  trustworthy stable release.
- **Daily-driver** — common enough that users otherwise fall back to the CLI.
- **Power feature** — important parity, but safe to schedule after the release
  blockers if 1.0 needs scope control.
- **Later** — valuable specialization that should not delay a stable 1.0.

## Shipped in the 2026-07-16 parity slice

- Explicit pull strategies: honor Git configuration, merge with fast-forward
  when possible, rebase, and fast-forward only.
- Explicit push strategies: normal push, push reachable annotated tags, push
  all tags, and guarded force push via `--force-with-lease`.
- A keyboard-operable network options menu beside Fetch / Pull / Push, with
  matching command-palette actions.
- A dedicated force-push confirmation naming the local and remote branches and
  explaining the lease protection. Plain `--force` remains unavailable.
- Current-branch Pull / Push submenus in the branch context menu.
- Copy branch name, full ref, and commit SHA for local branches; equivalent
  copy actions for remote branches, tags, and stashes.
- Create a branch or worktree from a tag directly from its context menu.
- Set, change, or unset the upstream of any local branch.
- Push any local branch to a chosen remote branch without checking it out,
  optionally setting that destination as its upstream.
- Fetch a selected remote branch or pull it into the current branch with any
  typed pull strategy.
- A per-repository default pull strategy used by the primary Pull action and a
  corrected Sync flow that actually runs fetch, pull, then push.
- A single-file **Open in editor** command in the Files, Local Changes, Review,
  and Workspace Review context menus, routed to the configured integration with
  the clicked path rather than ambient selection.

## 1.0 gap matrix

### Release blockers

| Gap | Current state | 1.0 acceptance bar |
| --- | --- | --- |
| Hosted review completion | GitHub/Azure list, detail, threads, comments, readiness, follow, create, merge, close/reopen, and terminal read-only gating exist | Submit approve/request-changes reviews; viewed-file and unresolved-thread progress; update/check out branch; preserve drafts on provider failure |
| Localization | Complete 2026-07-18: typed English catalog, interpolation/plurals, locale-aware formatters, and migrated global/release-critical surfaces | Keep new Strand-owned copy in the catalog; preserve raw Git/provider diagnostics inside translated context; add a locale picker only with another complete catalog |
| Signed platform distribution | macOS signed/notarized; Windows EV and Linux signing open | Trusted installer/update path on macOS, Windows, and Linux; stable and beta update channels |
| Security hardening | Complete 2026-07-18: production CSP, exact local desktop capability allowlist, signed stable-updater policy gate, and pre-URL clone-hook warning | Keep `pnpm release:check-security` green in PR and release CI; repeat the production-protocol smoke test for release candidates |
| Platform validation | Windows runtime pass exists; Linux and several integration presets remain unverified | GNOME + KDE pass, Windows/Linux editor-terminal presets, credential prompts, file dialogs, shortcuts, and updater smoke-tested |
| Release quality | Core and UI tests exist; some open empty-state/a11y work remains | Full keyboard audit, release checklist, crash recovery, no misleading no-op controls, and every destructive action documented |

### Daily-driver Git gaps

| Area | Missing or incomplete functionality | Priority |
| --- | --- | --- |
| Repository setup | Initialize a new repository, choose an initial branch, and optionally create `.gitignore` / first commit shipped 2026-07-18 | Complete for 1.0 daily use |
| Branch tracking | Upstream management, explicit non-current branch push, destination naming, and selected-branch fetch/pull shipped 2026-07-16 | Complete for 1.0 daily use |
| Network preferences | Per-repo pull strategy, pull autostash, and fetch-prune defaults; explicit one-operation overrides; separate fetch/push URLs shipped 2026-07-18 | Complete for 1.0 daily use |
| Fine-grained staging | Individual-line stage, unstage, recoverable discard, pointer range selection, and keyboard line picker shipped 2026-07-18 | Complete for 1.0 daily use |
| Stashes | Branch from stash plus non-mutating sidebar inspect/reveal shipped 2026-07-18 | Complete for 1.0 daily use |
| Multi-commit actions | Ordered multi-commit cherry-pick, two-commit comparison, and merge-mainline cherry-pick/revert shipped 2026-07-18 | Complete for 1.0 daily use |
| Rebase | `edit` / pause-to-amend and topology-safe `--rebase-merges` preservation shipped 2026-07-18 | Complete for 1.0 daily use |
| Branch comparison | First-class local/remote/tag changed-file and full diff comparison shipped 2026-07-18 | Complete for 1.0 daily use |
| Remote management | Scoped prune, native default-remote selection, fetch/push refspec inspection, and separate fetch/push URL editing shipped 2026-07-18 | Complete for 1.0 daily use |
| Repository maintenance | Cancellable `git maintenance run`, guarded `git gc`, `git fsck --full`, and a bounded per-repository activity log with exact commands/captured output shipped 2026-07-18 | Complete for 1.0 daily use |
| File actions | Create file/folder, exact folder targeting, external editor/reveal, relative/absolute path copy, direct history/blame, rename, and confirmed deletion shipped 2026-07-18 | Complete for 1.0 daily use |
| Commit metadata | Lazy GPG/SSH/X.509 verification, subject/body copy, exact patch export, and ordered multi-selection copy/export actions shipped 2026-07-18 | Complete for 1.0 daily use |

### Power-feature parity

The 1.0 scope is closed: Strand keeps the already-shipped lazy GPG/SSH/X.509
verification and exact commit/series patch export. Every unshipped power surface
below moves to 1.1 so signing key mutation, repository-shape changes, external
tool contracts, and user-defined command execution do not enter the stable
release after the daily-driver and hosted-review gates have closed.

| Feature | Notes | Priority |
| --- | --- | --- |
| Git bisect | Fork exposes visual bisect; Strand has no guided good/bad workflow | 1.1 |
| Git LFS UI | Filters work through system Git, but locks, tracked patterns, status, and transfer progress are invisible | 1.1 |
| Signing UI | Existing config is honored and verification ships; key selection and per-commit signing controls remain | 1.1 |
| Git-flow | Fork/Tower expose start/finish feature, release, and hotfix workflows | 1.1 |
| Sparse checkout | Useful for monorepos; needs cone-mode-first UX and clear destructive boundaries | 1.1 |
| Patch workflows | Exact commit/series export ships; apply/mailbox/bundle flows remain | 1.1 |
| Submodule completeness | Add/remove/deinit, sync a selected submodule, change URL, and inspect nested status | 1.1 |
| Advanced history | Notes, replace refs, signed tags, tag move/force with confirmation | Later |
| Custom actions | User-defined commands scoped to repository/ref/file with safe argv templates | 1.1 |

### Hosted-provider parity after the current PR workspace

- GitHub batched review submission, pending inline drafts, Approve / Request
  changes, viewed-file state, unresolved-thread navigation, commits/checks
  tabs, and attention-oriented inbox filters.
- Azure inline comments with iteration coordinates and review-policy parity.
- Update branch, check out PR into a worktree, close/reopen, and “since my last
  review” comparison.
- GitLab merge-request and Bitbucket Cloud adapters through the same
  provider-neutral model.

## Context-menu coverage target

Every row menu remains context-sensitive: unavailable actions are hidden or
disabled with a reason, and the primary action stays first.

| Surface | 1.0 menu target |
| --- | --- |
| Local branch | Reveal, checkout/open worktree, pull/push variants when current, set upstream, create branch/worktree, compare/review, merge, rebase/interactive rebase, rename, copy name/ref/SHA, delete |
| Remote branch | Fetch, reveal, checkout/track, create branch/worktree, compare, set as upstream, copy name/ref/SHA, delete remotely |
| Tag | Reveal/checkout, create branch/worktree, compare, push/delete remote, copy name/SHA, move/edit annotated tag, delete |
| Stash | Inspect, apply, pop, branch from, copy name/SHA/patch, drop |
| Commit selection | Open detail, compare, branch/tag/worktree, cherry-pick/revert, reset/rebase, copy SHA/message, export patch |
| Changed file | Open, stage/unstage/discard, stash, ignore, copy paths/diff, history/blame, editor/terminal/reveal |
| Repository file | Open/preview, rename/move, delete, history/blame, compare, copy paths, editor/reveal |
| Remote | Fetch/prune, edit URLs/refspecs, rename, copy URL, set default, remove |

## Recommended implementation waves

1. **Network and ref ergonomics** — branch tracking/ref operations, network
   preferences, and remote-management close-out are shipped.
2. **Daily local Git close-out** — shipped: initialize repository, line staging,
   stash-to-branch, multi-commit operations, branch comparison, and rebase
   `edit` / merge preservation.
3. **Hosted review close-out** — viewed/thread ledger, batched reviews,
   lifecycle actions, and safe PR worktrees.
4. **Stable-release hardening** — localization, CSP/capabilities, signed
   installers and update channels, Linux validation, full keyboard/a11y pass.
5. **Power parity** — scope closed for 1.0: shipped verification and patch
   export stay; every unshipped power surface is explicitly scheduled for 1.1.

The active milestone remains **1.0 Stable**. Network/ref ergonomics, repository
initialization, stash-to-branch and inspection, line-level staging,
multi-commit actions, branch/ref comparison, rebase close-out, repository
maintenance, and working-tree file actions are now shipped foundations. The
daily local Git and hosted-review close-outs are complete. Stable-release
hardening is the remaining implementation wave.
