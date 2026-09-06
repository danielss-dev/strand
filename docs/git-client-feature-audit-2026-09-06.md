# Git-client feature audit — 2026-09-06

Audited source: `c3faa93` on PR #114, based on main `8e83c8c`.
The application manifests identify version **1.5.1**; this is a code audit,
not a claim about which release customers have installed.

Strand already covers most everyday local Git operations. The next priorities
are consistent hook execution, repository identity/signing controls, complete
large-PR data, and workflows for LFS and submodule repositories. There are
**19 missing or partial feature families** below. Priorities are recommendations
based on workflow impact, not usage analytics or promises for a release.

## Scope and method

Checked the native operations in `crates/strand-core/src`, Tauri command and
provider boundaries, typed frontend wrappers, stores, dialogs, context menus,
and command registration. Cross-checked PRD, TASKS, ROADMAP, and durable
learnings. A backend primitive or design document alone does not count as an
accessible feature; externally configured Git behavior is distinguished from
a Strand management UI. Absence findings combine source searches with the
relevant operation/menu inventory, rather than relying on old unchecked rows.

This supersedes the **current-status conclusions**, not the historical release
record, of [the July audit](./git-client-1.0-audit.md). This pass did not exercise
every workflow on every platform, benchmark competitors, or certify LFS/filter
compatibility. Official Git/GitHub references below establish the relevant
contracts, while the linked Strand code establishes the implementation gaps.

Priority in this document: **P1** = next parity/correctness work; **P2** = useful
workflow expansion; **P3** = specialized or substantial strategic work. These
are current recommendations, separate from PRD's historical release priorities.
LFS, submodules, and additional providers move up when their users are the
target audience. Existing performance follow-ups remain a parallel priority.

## Already implemented — do not add these as missing features

| Capability | Implementation evidence |
| --- | --- |
| Init/open/clone, remotes, explicit pull modes, upstream management, non-current branch push, force-with-lease, tag push/delete | [init.rs](../crates/strand-core/src/init.rs), [network.rs](../crates/strand-core/src/network.rs), [remote.rs](../crates/strand-core/src/remote.rs), [BranchNetworkDialog](../ui/src/views/BranchNetworkDialog.tsx) |
| File/hunk/line staging, unstage, discard with hunk undo, commit/amend, stash inspection and stash-to-branch | [stage.rs](../crates/strand-core/src/stage.rs), [apply.rs](../crates/strand-core/src/apply.rs), [stash.rs](../crates/strand-core/src/stash.rs), [LocalChanges](../ui/src/views/LocalChanges.tsx) |
| Interactive rebase with edit/merge preservation, multi-commit cherry-pick, merge-mainline actions, conflict resolver, ref comparison, reflog | [history.rs](../crates/strand-core/src/history.rs), [MergeResolver](../ui/src/views/MergeResolver.tsx), [CompareRefsDialog](../ui/src/views/CompareRefsDialog.tsx), [Reflog](../ui/src/views/Reflog.tsx) |
| Worktrees and workspace review, files/history/blame, lightweight UTF-8 editing, terminals and editor integration | [worktree.rs](../crates/strand-core/src/worktree.rs), [Work](../ui/src/views/Work.tsx), [WorkspaceReview](../ui/src/views/WorkspaceReview.tsx), [file.rs](../crates/strand-core/src/file.rs) |
| Configured commit signing, lazy signature verification, exact commit/series patch export | [commit.rs](../crates/strand-core/src/commit.rs) `signing_enabled`, [commit_metadata.rs](../crates/strand-core/src/commit_metadata.rs) `commit_signature` / `export_commit_patches` |
| GitHub.com and Azure Services/Server PRs: create, comments/replies, resolve threads, batched reviews, approve/request changes, local viewed/changed tracking, checks, lifecycle, merge, branch worktree | [pull_requests.rs](../crates/strand-tauri/src/pull_requests.rs), [PullRequests](../ui/src/views/PullRequests.tsx), [PullRequestMergeControl](../ui/src/views/PullRequestMergeControl.tsx) |
| Cancellable repository maintenance, activity output, configurable Workbench, bundled plugins, AI commit/PR writing | [maintenance.rs](../crates/strand-core/src/maintenance.rs), [workbench](../ui/src/workbench), [plugins](../ui/src/plugins), [ai](../crates/strand-tauri/src/ai) |

## P1 — close the compatibility and completeness gaps

| ID / feature | Current gap and code evidence | Completion criterion / current fallback |
| --- | --- | --- |
| **F01 — Git hooks on ordinary commits** | **Partial; correctness gap.** [commit.rs](../crates/strand-core/src/commit.rs) calls `commit_via_git` only when signing is enabled; unsigned commit/amend calls git2 directly. Its own comment records that only the subprocess path runs commit hooks. | Signed and unsigned commit/amend both honor applicable hooks, including `core.hooksPath`, propagate a rejecting hook, preserve the draft, and show useful output. Verify rejecting and message-rewriting fixtures and measure the no-hook path. Today: commit through system Git in the terminal. |
| **F02 — Repository identity controls** | **Missing UI.** [GitSection](../ui/src/views/Settings/GitSection.tsx) and [gitconfig.rs](../crates/strand-core/src/gitconfig.rs) expose only global name/email editing. Git's effective repository config is already used by commit creation. | Show the effective author/committer identity and its scope; set/remove a local override without overwriting global or conditional config. Verify two repositories and linked worktrees. Today: configure identity with Git. |
| **F03 — Signing controls and signed tags** | **Partial.** Configured commit signing and verification work. There is no key/format picker or per-operation signing control. [tag.rs](../crates/strand-core/src/tag.rs) creates lightweight/unsigned annotated tags via git2; [TagDialog](../ui/src/views/TagDialog.tsx) has only name/message. | Expose inherited signing state and scoped settings; delegate keys/passphrases to existing agents; create and verify signed tags; fail visibly when a requested signature fails. Verify GPG and SSH paths, including amend. Today: Git config for commits; `git tag -s` for tags. |
| **F04 — Git LFS support and management** | **Missing management UI; compatibility unverified.** No LFS command/model/surface appears in core, IPC, or UI. Network calls use system Git, but [stage.rs](../crates/strand-core/src/stage.rs) uses git2 index writes. That is insufficient evidence that the entire pointer/filter lifecycle works. | First validate real LFS pointer bytes through stage/checkout/commit/push/pull, including bulk staging and missing tooling. Then expose setup, tracked patterns, object/transfer status, locks and recoverable errors with bounded progress. Today: use Git LFS in the terminal; do not claim whole-app LFS support from network delegation alone. |
| **F05 — Complete submodule lifecycle** | **Partial.** [submodule.rs](../crates/strand-core/src/submodule.rs) implements list/status and update/init/recursive; [Sidebar](../ui/src/components/Sidebar.tsx) offers open, update and copy path. Add/remove/deinit/sync/URL changes and nested inspection are absent. | Add those explicit actions with dirty-state checks, progress/cancellation for network work, and tests for `.gitmodules`, index changes and nested modules. Today: open initialized modules as repo tabs; use Git for lifecycle changes. |
| **F06 — Complete large-PR data** | **Partial.** [pull_requests.rs](../crates/strand-tauri/src/pull_requests.rs) bounds GitHub inbox/results and queries review threads/comments/check contexts at 100; review queries have no cursor traversal. [PullRequests](../ui/src/views/PullRequests.tsx) filters the fetched inbox locally. | Cursor-based loading for inbox, reviews, threads/replies and check contexts, with explicit partial/error states; verify 101+ entries, deduplication and cancellation. Do not present partial review counts as complete. Keep initial reads shallow. Today: use the provider website for omitted items. |

F01 exposes a tension in the recorded policy: [learnings](./learnings.md)
says index/commit operations stay on git2, while PRD §10 and the same learnings
expect Git-equivalent hooks. This audit records that tension; it does not
silently change the engine policy. Git's contract allows pre-commit and
commit-msg hooks to reject a commit. [Git hook reference](https://git-scm.com/docs/githooks).

F04 must distinguish adding an LFS tracking pattern from converting existing
history; the latter is a separate, potentially rewriting operation and should
not be an implicit setup step. [Git LFS setup](https://git-lfs.com/).

F06 follows GitHub's documented cursor model: query page information and
request subsequent pages, instead of merely increasing the first-page limit.
[GitHub GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api).

## P2 — reduce routine trips to the terminal/provider website

| ID / feature | Current gap and code evidence | Completion criterion / current fallback |
| --- | --- | --- |
| **F07 — Patch import, mailbox and bundles** | **Partial.** Exact patch/series export exists in [commit_metadata.rs](../crates/strand-core/src/commit_metadata.rs). [apply.rs](../crates/strand-core/src/apply.rs) is wired to staging/discard, without a user import flow, mailbox operation state, or bundle operations. | Preview affected paths and target index/worktree; validate before apply; support mailbox continue/skip/abort with author metadata; verify/import/export bundles with prerequisite/ref summaries. Reject paths outside the repository. Today: `git apply`, `git am`, `git bundle`. |
| **F08 — Sparse checkout management** | **Missing surface.** No sparse-checkout command or settings boundary in [core modules](../crates/strand-core/src/lib.rs), [commands.rs](../crates/strand-tauri/src/commands.rs), or app actions. | Cone-mode directory selection, inspect/change/disable, clear distinction between excluded and deleted paths, dirty-tree preservation and sparse-index compatibility tests. Today: configure externally; Strand compatibility still needs explicit fixtures. |
| **F09 — Advanced clone options** | **Partial.** [CloneDialog](../ui/src/views/CloneDialog.tsx) passes URL/destination only; [network.rs](../crates/strand-core/src/network.rs) runs `clone --progress -- URL DEST`. | Add branch, depth/single-branch, partial-clone filter and recursive-submodule choices; support deepen/unshallow where applicable; explain history/network tradeoffs. Preserve safe argument separation, progress and cancellation. Today: clone with Git, then open the directory. |
| **F10 — Guided bisect** | **Missing.** [history.rs](../crates/strand-core/src/history.rs) and [repository operation state](../crates/strand-core/src/repo.rs) cover rebase/cherry-pick/revert/merge, without bisect actions or state. | Start with good/bad revisions; mark good/bad/skip; show remaining search and final culprit; resume an external bisect; reset to the original checkout safely. Automated test-command execution can be a later slice. Today: `git bisect`. |
| **F11 — More hosted providers and GitHub enterprise hosts** | **Missing adapters.** [pull_requests.rs](../crates/strand-tauri/src/pull_requests.rs) `parse_remote` recognizes GitHub.com/Azure; tests explicitly reject GitLab/Bitbucket. `HostRepo::GitHub` carries owner/repo but no host; custom GitHub hosts have no adapter. Azure Server profiles already exist. | Add GitLab and Bitbucket Cloud through the shared PR model; model host/API/auth scope for GitHub Enterprise or custom GitHub domains. Test permissions, pagination, review coordinates and stale-head protection per provider. Today: local Git works independently; use the hosting website for reviews. |
| **F12 — PR merge queue / auto-complete controls** | **Partial.** [PullRequestMergeControl](../ui/src/views/PullRequestMergeControl.tsx) offers immediate merge strategies; the provider model has no queue position or explicit auto-merge lifecycle. `merge_github` delegates to `gh pr merge`, whose provider behavior is not a Strand queue UI. | Capability-gated enable/cancel, queued versus merged states, policy blockers and refresh after head changes. Keep GitHub queue and Azure auto-complete semantics distinct. Today: provider website. |
| **F13 — Review evolution and actionable feedback export** | **Partial.** [PullRequests](../ui/src/views/PullRequests.tsx) tracks file patch hashes and “Changed since viewed”; it does not offer a diff between reviewed heads/iterations, suggestion application, or hosted unresolved-feedback export. Local Review notes/export already exist. | Compare an explicit reviewed boundary to current head, handle rebases/force-pushes, preview and validate suggestion application, export unresolved feedback with provider/file/line context. Today: provider comparisons or local ref comparison. |
| **F14 — Publish a new hosted repository** | **Missing.** [InitRepoDialog](../ui/src/views/InitRepoDialog.tsx) creates local repos and [remote.rs](../crates/strand-core/src/remote.rs) manages Git remote config; no provider repository-creation operation exists. PRD §6.1 already schedules hosted creation. | Choose provider/account/organization, name and visibility; show the concrete destination before creation; add the remote and explicitly choose initial push, with recovery from partial failure. Today: create on the provider, then add the remote in Strand. |
| **F15 — User-defined Git actions** | **Partial foundation.** [integrations.ts](../ui/src/lib/integrations.ts) supports editor/terminal templates; [Workbench commands](../ui/src/workbench/commands.ts) and bundled plugins are developer registries, not a user-defined repo/ref/file action editor. | Define scoped executable/argv templates, preview resolved arguments and working directory, expose context/palette entries, capture bounded output and cancel. Reuse exact selection context and avoid shell interpolation. Today: terminal or external scripts. |
| **F16 — CLI launcher and read-only companion** | **Design only.** [Cargo workspace](../Cargo.toml) contains core/Tauri/Azure helper crates, with no `strand-ops`/CLI companion; [strand-cli.md](./strand-cli.md) is explicitly a design. No desktop argument/deep-link repo-opening handler was found. | First deliver `strand PATH` with single-instance handoff and platform registration; then implement versioned read-only status/log/diff/review output. Keep mutating Git commands out of the planned companion scope. Today: app Open and the Git CLI. |

F08 and F09 address different costs: sparse checkout reduces the populated
working tree; clone depth/filter options affect acquired history or objects.
Opening either kind of externally created repository needs compatibility
fixtures, independently of adding its setup dialog.
[Sparse checkout](https://git-scm.com/docs/git-sparse-checkout),
[clone options](https://git-scm.com/docs/git-clone).

## P3 — deliberate later scope

| ID / feature | Current gap and code evidence | Completion criterion / current fallback |
| --- | --- | --- |
| **F17 — Work on repositories located on an SSH host** | **Design only.** [remote-ssh.md](./remote-ssh.md) records the daemon/transport design; [Repo::discover](../crates/strand-core/src/repo.rs) and [commands.rs](../crates/strand-tauri/src/commands.rs) open local filesystem paths. SSH Git remotes for fetch/push already work and are a different feature. | Remote repo identity, versioned daemon protocol, system-SSH authentication, bounded file/watch streaming, reconnect/cancellation and clear local/remote execution context. Today: SSH terminal, or a local clone. |
| **F18 — Advanced refs and tag editing** | **Missing/partial.** No Git notes/replace-ref management operations exist. [tag.rs](../crates/strand-core/src/tag.rs) has a force primitive, but [TagDialog](../ui/src/views/TagDialog.tsx) and the sidebar do not expose retarget/edit flows. Local review notes are not Git notes. | Explicit notes/replace-ref inspection and management; separate tag retarget/re-annotation with current/new target comparison and remote-aware confirmation. Signed tag creation belongs to F03. Today: Git CLI. |
| **F19 — Git-flow orchestration** | **Missing.** Normal branch/merge/rebase exist, but no git-flow configuration or start/finish feature/release/hotfix actions in [core modules](../crates/strand-core/src/lib.rs) or app commands. | Opt-in tool detection/configuration and inspectable start/finish operations with progress, conflicts and recovery. Prioritize only with demand from teams using Git-flow. Today: ordinary branches or external git-flow tools. |

## Adjacent gaps, tracked separately from Git feature parity

- **File metadata and session restoration:** [StatusBar](../ui/src/components/StatusBar.tsx)
  hardcodes `UTF-8 · LF`; [file.rs](../crates/strand-core/src/file.rs) preserves
  bytes/line endings for supported edits and rejects non-UTF-8 writes, but
  offers no encoding conversion UI. [work store](../ui/src/stores/work.ts)
  persists terminal descriptors; per-file mode/scroll/selection restoration
  remains in TASKS. Fix actual metadata first; a general editor is out of scope.
- **Community plugin execution:** bundled marketplace/manifest validation and
  capability declarations exist; remote installation, isolated execution and
  resource quotas remain in the extension backlog. The existing plugin UI
  should not be counted as a finished third-party execution platform.
- **Performance:** selected-file/near-viewport patch materialization and full
  production PRD certification remain in the
  [performance audit](./performance-audit-2026-09-06.md). These are quality and
  scaling work on existing features, not absent Git commands.
- **Platform validation:** macOS/GNOME/KDE candidate, terminal/integration,
  credential and updater evidence still belongs to the
  [release checklist](./release-checklist.md). Passing PR CI does not complete
  these runtime checks.

## Suggested implementation sequence

1. **Correctness and trustworthy state:** F01 hooks and F06 pagination; F02
   scoped identity and F03 signing next. Keep no-hook/status read costs measured.
2. **Repository compatibility:** F04 LFS and F05 submodules, followed by F08
   sparse checkout and F09 clone options. Test real fixtures before advertising
   support; defer expensive metadata until its surface is open.
3. **Interchange and review:** F07 patches, F10 bisect, then F11–F14 according
   to target-provider demand. Keep mutations explicit and recoverable.
4. **Extensibility and distribution of work:** F15/F16 first; F17–F19 after
   demand and protocol/engine prerequisites are clear.

Every new user action needs both a visible context entry and keyboard/palette
access, with a concrete completion test. This audit adds planning work only;
none of the unchecked features above is claimed implemented by PR #114.
