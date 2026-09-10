# Strand agent-review audit — 2026-09-10

Audited `main` at `96c64d92e703b5e3ccfadbc51c79ce873de1211e` (1.6.0).
The working tree was clean at the start. The original audit changed documentation and
planning only. The dated implementation follow-up at the end records subsequent
work; findings and original source locations below remain historical.

Strand already provides most of the tools needed to review agent changes:
whole-file diffs, committed/staged/unstaged comparisons, pinned baselines,
content-sensitive reviewed marks, feedback notes, optional AI review, worktree
comparisons, hosted PRs, and a read-only CLI. The highest-value next work is
making the review and recovery guarantees reliable while agents keep writing.
After that, connect agent runs, review feedback, and verification results.

Priorities below concern this use case; they do not redefine historical release
milestones. P1 means fix before expanding the workflow; P2 means follow next.
Source locations refer to the audited revision.

## Correctness findings

### R01 / P1 — Worktree removal proceeds after its recovery archive fails

`ui/src/stores/repo.ts:1565` catches any `repoWorktreeArchive` error, logs it,
and calls `repoWorktreeRemove` anyway at line 1570. With force enabled, Git's
dirty-worktree protection is bypassed. An archive failure caused by identity,
filters, or temporary storage can therefore leave removed work unrecoverable
through Strand's archive UI. The surrounding comment and
`website/docs/worktrees.md:63` promise a recoverable removal.

**Change:** require a successful recovery archive before removing an existing
dirty worktree. Handle an already-missing/prunable directory separately.
**Verify:** inject archive failure and assert no removal command is dispatched;
retain the worktree, its files, and an actionable error. Source-confirmed;
destructive failure was not exercised against a real user worktree.

### R02 / P1 — Archives do not preserve content that exists only in the index

`crates/strand-core/src/worktree.rs:508` runs `add -A` against a copied index
before writing the archive tree. This replaces staged contents with disk
contents. Restore at line 628 resets the index to HEAD. If a file has three
different versions in HEAD, the index, and the worktree, the middle version is
not retained by the archive. This loses bytes, not just staged/unstaged flags.

**Evidence:** a disposable Git repository executing the same archive/restore
command sequence started with index `staged-only-version` and worktree
`workdir-version`. Restore produced index `base` and worktree `workdir-version`;
the staged-only blob was not reachable from the archive. This reproduces the
Git sequence, not an end-to-end native UI run. The existing archive test at
`worktree.rs:1166` does not cover this case.

**Change:** retain the original index tree independently, for example with a
stash-style archive structure, and restore both layers. Preserve compatibility
with existing archives. **Verify:** partially staged modifications, staged
additions subsequently deleted from disk, renames, and untracked files survive
archive/remove/restore with their original contents and staging state.

### R03 / P1 — A read error deletes the pinned review baseline

`ui/src/stores/repo.ts:1327` catches every full-context diff error and calls
`clearBaseline`. That clears the comparison and persists `null` at line 1294.
A transient read failure can silently remove already-committed agent work from
the review scope. An unavailable commit should also remain an explicit failed
boundary, rather than become an apparently different successful comparison.

**Change:** preserve the baseline and last successful comparison, show its
staleness/error, and offer Retry. Baseline reset should be an explicit action.
**Verify:** transient errors and unavailable commits never alter the persisted
baseline or notes scope. Source-confirmed.

### R04 / P1 — Workspace Review omits staged changes in inbox mode

`ui/src/stores/workspaceReview.ts:215` uses `repoDiffUnstagedFull`, which compares
the index with the working tree (`crates/strand-core/src/diff.rs:180`). Single
repository Review instead compares against HEAD (`stores/repo.ts:1323`).
Consequently, staging a file can remove it from Workspace Review; a partially
staged file shows only its remaining unstaged part.

**Change:** use the same combined inbox semantics in both review surfaces.
Fetch current unstaged mutation targets separately and retain the restrictions
on hunk actions for combined staged/unstaged patches. **Verify:** fully staged,
partially staged, and unstaged files remain in the queue across `git add`, with
the same review content in both views. Source-confirmed.

### R05 / P1 — Stage reviewed can stage bytes the user did not review

`ui/src/stores/repo.ts:1432` checks a refreshed patch hash, then sends filenames
to `repoStageMany`. Its IPC contract (`commands.rs:1074`) carries no expected
content. `crates/strand-core/src/stage.rs:55` reads the current disk contents
when adding each path to the index. An agent can write between the check and
that read, so the operation can stage a newer, unreviewed version.

**Change:** bind staging to the reviewed content and expected index/repository
state at the native mutation boundary. Stage captured reviewed blobs or reject
changed content without a second unchecked disk read. Preserve Git filter/LFS
and sparse-index behavior. **Verify:** deterministically write after review
refresh and before index mutation; the newer version must never be staged as
reviewed. Source-confirmed missing guard; no timed race was reproduced.

### R06 / P2 — Stage reviewed bypasses rename handling

`ui/src/stores/repo.ts:1433` supplies only each diff's destination path.
Ordinary `stageMany` explicitly expands `old_path` at line 1661, because staging
only the destination leaves the source deletion unstaged. Stage reviewed can
therefore stage an addition instead of the complete recognized rename.

**Change:** use current index-to-workdir rename targets for reviewed-file
staging, including both paths. **Verify:** a reviewed rename stages its add and
delete together; a pinned historical baseline must not supply the mutation
paths. Source-confirmed, not exercised through the native UI.

### R07 / P2 — Feedback notes can quote different code after another edit

`ui/src/lib/types.ts:145` stores a note's line/side/text but no original excerpt
or content identity. `reviewExport.ts:143` resolves that number against the
current patch. Inserting lines before the noted code can make exported feedback
quote an unrelated location. Accepted AI findings inherit the same behavior.

**Evidence:** executing the actual export function in memory with a stored
line-10 note for `authorizeAndDelete()` and its target now at line 25 exported
unrelated lines 6–14 beside the authorization feedback.

**Change:** retain original source context and a content fingerprint; safely
reanchor or label notes outdated after edits. **Verify:** inserted/deleted lines,
renames, and removed files never produce a misleading current-code excerpt.

### R08 / P2 — Review looks empty before the first commit

Inbox passes literal `HEAD` at `ui/src/stores/repo.ts:1323`.
`crates/strand-core/src/diff.rs:188` unconditionally resolves it to a commit,
which fails in a newly initialized repository. The error is logged while
`Review.tsx:737` can display “No uncommitted changes” despite new files.

**Change:** compare against the empty tree for an unborn HEAD, including staged
and untracked additions. Expose read failures separately from successful empty
results. **Verify:** an agent scaffolding a repository is reviewable before its
first commit, after staging, and after committing. Source-confirmed.

## Scale and verification gaps

### R09 / P1 — Large reviews need bounded per-file retrieval

Desktop Review still materializes the whole full-context patch collection
(`ui/src/stores/repo.ts:1323`). The September 6 audit's *after* measurements
report approximately 500 ms native full-context generation and 513 ms unstaged
generation for 501 changed files; its single first-use Local Changes observation
was 3.40 seconds (`docs/performance-audit-2026-09-06.md:291` and `:335`). These
are historical observations, not measurements repeated in this audit.

The CLI has the same problem plus a hard limit: `strand-ops/src/lib.rs:313`
rejects output above 8 MiB and instructs the caller to narrow the request, but
Diff/Review have no path filter or pagination (`strand-headless/src/cli.rs:44`).
Reducing the log count cannot reduce the full patch payload.

**Change:** cheap file summaries followed by bounded selected-file/nearby-file
patch requests, with explicit progressive search/export/AI-review traversal.
Expose a usable narrowing mechanism in the CLI and keep its output cap. The
desktop protocol is already tracked under Performance in TASKS.
**Verify:** large multi-file and long-file agent edits can be inspected and
fully exported progressively without generating every patch for first paint.

### R10 / P1 — The agent review loop needs an integration regression gate

PR CI has Linux Rust tests and frontend TypeScript/Vitest; its Windows job tests
the Azure helper (`.github/workflows/ci.yml:18`, `:69`, `:115`). It has no
browser/native agent-review flow. Existing unit coverage and manual native
checks are useful, but the findings above cross the store/IPC/Git boundaries.

**Change:** automate a disposable-repository scenario: agent edits → review →
stage/commit → feedback → further edits → re-review, including tab switches,
restart persistence, partially staged files, and archive failure. Add a native
Windows smoke pass and retain real macOS/Linux release validation.
**Verify:** run the scenario repeatedly with controlled edit/read interleavings.
Tie current performance certification to visible paint and sustained edits.
Cold launch, current idle memory/installer targets, and sustained multi-agent
work remain un-certified in the September performance follow-up.

## Product opportunities after the correctness fixes

These are proposals, not features claimed by the current implementation.

| Opportunity | What is missing today | Small useful first delivery |
| --- | --- | --- |
| O1 — Review this agent run | Heroi records conversations and launches runs (`HeroiView.tsx:551`), but Open review only navigates (`:914`, `App.tsx:693`). No per-run before-state is captured. An agent that commits can leave an empty inbox unless the reviewer pinned a baseline manually. | Capture a named before-run boundary, including pre-existing dirty/index state, and offer Review this run / Changes since last review. Use a separate worktree for reliable attribution when runs overlap. A starting HEAD alone cannot distinguish pre-existing edits or concurrent agents. |
| O2 — Feedback and re-review | Clipboard feedback exists, but notes have no open/resolved/reopened lifecycle or originating agent-run association (`ReviewNote`, `reviewExport.ts`). | Prepare feedback in the originating conversation for explicit send, retain the review boundary, and let the reviewer resolve/reopen notes after inspecting the next delta. Keep Git review in Strand's existing Review surface. |
| O3 — Verification attached to the reviewed revision | Terminals and user actions can run checks, but the local review model has no structured test/build result tied to the reviewed content. | Run a user-selected check through existing command infrastructure; record command, exit result, time, and content identity beside review progress. Mark results stale on relevant edits. A reviewed checkmark must not imply tests passed. |

Existing secondary gaps include standalone companion distribution and SSH
bootstrap, structured CLI blame/conflict reads, and provider-specific hosted
actions. GitLab request-changes and several Bitbucket operations still use the
provider site. Bitbucket merge is intentionally unavailable without an atomic
expected-head guard; weakening that guard is not a parity fix. See the existing
CLI, Remote SSH, Hosted pull requests, and platform validation rows in TASKS.

## Recommended order

1. Repair recovery and review correctness (R01–R08), with regression cases.
2. Deliver bounded desktop/CLI patch retrieval (R09) and the repeatable review
   integration scenario (R10).
3. Add per-run boundaries (O1), then connect feedback and verification (O2/O3).

The first implementation should be the recovery pair R01/R02: both are bounded
changes with direct data-preservation acceptance criteria. R03/R04/R06/R08 are
also focused fixes. R05 and R09 need deliberate native protocol work.

## Validation performed

- `pnpm --filter ./ui exec tsc --noEmit` passed.
- `cargo check -p strand-core -p strand-tauri` passed.
- Full frontend rerun: **498 tests across 89 files passed**. The initial run,
  concurrent with the Rust check, had one 5-second timeout in
  `highlight.worker.test.ts`; it passed alone in 716 ms and the full rerun
  passed in 5.12 seconds. Record this as a timing sensitivity, not a proven
  product defect.
- Reproduced the archive's staged-content loss with its Git command sequence
  in a disposable repository, and stale feedback excerpts with the actual
  export function.
- No app implementation changes, commits, pushes, hosted writes, live provider
  checks, full Rust test suite, or native UI run were performed for this audit.

## Implementation follow-up — 2026-09-11

The user selected correctness, performance, and integration tests. R01–R10
are implemented and passed the integrated checks below. O1–O3 remain
proposals; this work does not add new agent-run, handoff, or check-result flows.

- Recovery now fails closed in native `remove_worktree`, stores the original
  index as a separate archive parent, restores both layers, and accepts legacy
  archives. Archive refs also use a unique suffix and create-only writes so
  snapshots created in the same second cannot overwrite one another.
- Review and Workspace Review retain failed comparisons with an explicit
  Retry state, include staged and unstaged inbox changes, and handle unborn
  HEAD. Combined/historical patches cannot dispatch unstaged hunk writes.
- `reviewed_stage.rs` reconstructs inspected text against its immutable base,
  captures worktree input, runs clean filters on that input, and publishes the
  resulting blob IDs under HEAD/index locks after validating the expected Git
  state. Current rename sources are included; a historical baseline's rename
  source does not authorize deleting a current unrelated path.
- `ReviewNote.anchor` retains the original excerpt and fingerprint. The editor
  captures its displayed source before later agent edits; old or changed anchors
  export as outdated. File notes remain available while a patch is loading.
- `diff_page.rs` adds summaries, selected patches, and revision-bound byte
  chunks. Desktop Review loads selected/nearby patches and Local Changes loads
  patches near its viewport. Search, copying, feedback and AI actions explicitly
  request complete data and report failures. Native pages allow at most 32 paths
  and 4 MiB of patch text; an oversized single file has an explicit error/open
  file path. CLI `--summary`, `--path`, `--compact`, and `diff-chunk` provide
  narrowing and progressive export while retaining the 8 MiB envelope limit.
- `scripts/test-review-native.mjs` and the `windows-review` CI job exercise
  real React stores, Tauri IPC, Git, rendered diffs, and native restart with
  isolated profiles/repositories and retained screenshots, feedback and logs.

### Native performance measurement

Windows release `perfcheck` on the existing `bigtree` fixture (10,000 tracked
files, 501 changed files), with one warmup excluded and no concurrent agent
build/test workload. These are engine timings, not desktop first-paint timings.

| Read | Median | Samples |
|---|---:|---:|
| Review file summary | 133.52 ms | 20 |
| Three selected whole-file patches | 20.40 ms | 20 |
| Existing full Review read | 689.61 ms | 5 |
| Existing unstaged full collection | 539.60 ms | 20 |
| Discover + snapshot | 35.10 ms | 20 |

The two demand-driven medians total 153.92 ms, about 78% below the complete
Review read in the same run. This arithmetic is not an end-to-end IPC/paint
measurement. The summary was 92,674 JSON bytes; three selected files were
143,320 patch bytes / 149,521 JSON bytes. The complete review was 246,406 patch
bytes / 313,519 JSON bytes. The selected files include a relatively large file,
so this fixture's initial payload reduction is smaller than its CPU reduction.
Raw local output: `target/review-native-performance.txt`. Reproduce with
`cargo run --release -p strand-core --example perfcheck -- <fixture>`.

### Implementation validation

- Frontend: **528 tests across 95 files passed**; TypeScript `--noEmit` and
  the normal production build passed. Vite still reports nonfatal chunk-size,
  mixed static/dynamic import and duplicate sourcemap warnings.
- Rust: `cargo check -p strand-core -p strand-tauri` passed. Full core suite:
  **219 unit tests plus 13 integration tests passed; six existing tests ignored**.
  CLI/ops coverage passed (five CLI, three daemon, four operations, one launcher).
  Core/ops/headless Clippy passed with warnings denied.
- The full core run exposed an existing Windows test-daemon cleanup leak
  after assertions passed. Its test now uses the shared process-tree cleanup
  helper; the focused submodule test passed and left no daemon running.
- Native Windows: **16 assertions passed across two complete rounds** of
  `node scripts/test-review-native.mjs --repeat 2`. Tests use the development
  app with real Tauri IPC/Git and inspect actual rendered code. They verify
  staged and partially staged files, edits after review, anchored feedback,
  repository switching, automatic restart restoration, invalid baselines,
  unborn repositories and recovery failure retaining index/disk data.
- The 70-file native scenario initially loaded only **4/70 and 5/70** patches
  in the two runs. Scrolling rendered the last file; search showed explicit
  loading progress, reached **70/70**, and navigated to previously unloaded
  text. This verifies demand-driven behavior, not a production paint deadline.
- Native evidence: `target/review-native-20260911-final/result.json`,
  `local-paging-{1,2}.json`, screenshots and feedback in the same directory.
  Test profiles/processes were cleaned up and the normal app build restored.
  The new GitHub-hosted Windows CI job has not run remotely yet.

Implementation validation used local repositories and made no hosted writes
or live AI-provider requests. The implementation is published separately for
pull-request review.

### Limits retained

Archives exclude ignored files and do not freeze external writers. Stop the
agent before removing its worktree. Native reviewed staging supports textual
files; binary files/submodules require ordinary Stage. Chunk output is bounded,
but libgit2 still computes an individual file's diff internally, and continued
chunks recompute that patch and verify its revision. Desktop single-file patches
over the cap require opening the file or using CLI chunks; complete exports
must not silently omit them. Cold start, idle memory, sustained multi-agent
editing and macOS/Linux release certification remain separate backlog work.
