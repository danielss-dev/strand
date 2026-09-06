# Strand performance audit — 2026-09-06

Audited `main` at `8e83c8c` after a clean fast-forward from `1727570`.
The best next improvement is to reduce repeated patch generation and refresh
work. The basic status/snapshot and incremental commit-log paths are already
fast on the PRD fixtures. The original audit and its before measurements are
retained below; the implementation results follow at the end.

## Measurements

Windows, AMD Ryzen 7 7700X, Git 2.45.1.windows.1, Node 22.14.0. Release Rust
build, one excluded warmup per operation, sorted min/median/max samples.
Builds and benchmarks ran separately. These are warm filesystem measurements,
not cold-disk or end-to-end UI timings.

Reused the existing fixtures at `D:/GitSources/.strand-perf-fixtures/` and
verified their shapes: `bigtree` has 10,001 tracked files and 501 changed paths;
`bighist` has 100,000 commits. The extended harness adds full-context Review
diffs, worktree statistics, and serialized diff payload sizes.

| Operation | 10k-file fixture, median | Samples |
| --- | ---: | ---: |
| Discover repository | 1.06 ms | 30 |
| Open git2 handle | 0.73 ms | 30 |
| Status, reused handle | 14.76 ms | 30 |
| Snapshot, reused handle | 19.38 ms | 20 |
| Discover + snapshot, matching command lifecycle | 36.50 ms | 20 |
| Work tree without ignored paths | 17.13 ms | 30 |
| Work tree with ignored boundaries | 466.01 ms | 30 |
| Unstaged patches | 547.68 ms | 20 |
| Staged patches, empty index diff | 1.65 ms | 20 |
| Discover + full-context diff against HEAD | 539.56 ms | 5 |
| Discover + worktree statistics | 242.74 ms | 5 |

A preceding independent run gave snapshot **36.13 ms**, ignored boundaries
**442.99 ms**, and unstaged patches **535.47 ms**. The ordering is repeatable.
The ordinary unstaged operations above use the harness's reused handle; they
are not full IPC measurements. The full-context row deliberately opens a fresh
handle, as the actual command does.

The 501-file unstaged result contains 229,771 patch bytes / 295,880 JSON bytes;
the full-context result contains 246,406 patch bytes / 313,519 JSON bytes.
This fixture exposes many-file computation cost. Its small files do **not**
model the payload amplification of hundreds of long, mostly unchanged files.

On the 100k-commit fixture, discover + log(5,000) is **76.47 ms** and the entire
log(100,000) is **568.56 ms**. The UI normally requests only 500 commits.
On Strand's own checkout, discover + snapshot is **34.16 ms**, unstaged patches
**5.77 ms**, ignored boundaries **43.85 ms**, and worktree statistics **64.47 ms**.
That local run had only the benchmark file edited; it is a small-changeset
control, not a simulation of heavy agent activity.

The production Vite build emits an initial entry of **about 2.13 MB**
(607.46 kB gzip), plus CSS and independently loaded workers/assets. This is
the initial JavaScript chunk, not the sum of lazy language/diagram chunks.
Gzip size is informational for the website; local desktop parse/evaluate cost
depends on the uncompressed code and execution. Startup time was not measured.

## Prioritized changes

These findings describe the pre-change code at `8e83c8c`. Original line
numbers refer to that revision.

### 1. Coalesce refreshes and reject superseded results — high priority

`stores/repo.ts:1113–1197` launches new snapshot, diff, and log requests on
every call. `handleExternalChange` requests snapshot + unstaged + staged + log
even for an ordinary source-file write. A pinned baseline adds another
full-context diff. The async setters check the active path, but have no
same-repository request generation or in-flight deduplication. Slow earlier
responses can therefore overwrite newer results for the same path.

`App.tsx:1283–1316` adds watcher and focus triggers, while writes such as
`stage()` await their own refresh. The backend's 400 ms quiet-period debounce
does not combine those frontend triggers. `Review.tsx:113–123` also refreshes
on mount and, when embedded without a baseline, on replacement of the
unstaged array. Workspace Review independently fetches the active repository
again (`stores/workspaceReview.ts:175–220, 318–335`).

Implement one in-flight request per canonical repository and resource, with
a dirty flag for one necessary trailing refresh. Publish only results from
the current activation/generation. Preserve freshness after a write that
arrives during a read: simply dropping overlapping requests is insufficient.
Give HEAD/ref changes a log invalidation signal; ordinary file writes should
not reload unchanged history.

Verify with overlapping watcher/focus/stage triggers and deliberately reordered
responses. Assert bounded request counts, newest-state publication, safe A→B→A
tab switching, and eventual refresh after writes during an in-flight request.
This removes redundant work; it does not make an individual 548 ms diff cheap.

### 2. Generate patches only when needed; retain unchanged objects — high priority

`refreshLocalChanges` always runs both patch commands, and a saved baseline
keeps full-context Review live even when Work or another destination is open
(`stores/repo.ts:1149–1158, 1261–1289`). Open/tab-switch paths request all of
this data up front. Stage/unstage also await the whole refresh. A 36 ms
snapshot therefore does not imply a responsive large-changeset action.

First separate cheap status/navigation freshness from patch demand. Track
actual mounted consumers, including composed Workbench panes, and refresh
their dirty resources on activation. Pinned review marks and bulk actions
must still operate on fresh data. Next benchmark a changed-file summary plus
path-scoped patch retrieval for the selected/nearby files; keep multi-file
search, export, AI review, rename handling, and staging semantics intact.

Preserve existing `FileDiff` objects when path, patch, and metadata match,
and preserve unchanged log arrays. Snapshot slices already use `stable`, but
diff/log setters replace every object. That invalidates Review's verdict and
navigation memos and the object-keyed parse/hash caches
(`components/Diff.tsx:94`, `lib/patch.ts:24`, `views/Review.tsx:131`).
Keep content-derived Pierre keys; changing a real patch must still remount
its virtualized renderer. Equal status entries do not prove equal file content.

Verify that idle/no-op refreshes reuse objects; edit the same already-modified
file twice and check its patch updates. Measure stage/hunk feedback and visible
file load on the 501-file fixture. Virtualization alone only bounds rendering,
not the backend patch generation measured here.

### 3. Avoid repeated Files boundary enumeration — high priority

`tree.rs:215–266` traverses every non-ignored directory and calls
`status_should_ignore` for each child after the normal status/index walk.
It correctly stops at ignored directories, yet costs **443–466 ms** on 10k
tracked files. `RepositoryFiles.tsx:159–193` invokes it again whenever `active`
becomes true, despite retaining the prior local tree cache.

Reuse the loaded boundary inventory within a repository, with explicit
invalidation for file/path mutations and ignore-rule changes. Benchmark batch
ignore discovery or eliminating redundant per-entry checks before changing
the backend. Preserve nested repositories, symlink/long-path guards, ignored
folder identity, lazy one-level expansion, and the existing first-load state.
Do not move ignored enumeration into snapshots or substitute snapshot paths
for the authoritative Files inventory (see `docs/learnings.md`).

Verify Files→Git→Files without mutation avoids another full walk; creation,
deletion, moves, and nested `.gitignore` edits must invalidate correctly.

### 4. Bound worktree and workspace fan-out — medium priority

`Worktrees.tsx:61–110` starts up to four commands per checkout simultaneously:
status, HEAD log, branch health, and filesystem/shortstat statistics. Every
fresh worktree array retriggers the batch; the store publishes a new array
even when membership is unchanged (`stores/repo.ts:1469`). Cancellation only
suppresses the UI result; it does not stop queued native work. Workspace
Review similarly loads all members through one unrestricted `Promise.all`.

The advisory statistics call costs **243 ms per checkout** on the fixture.
It already skips common generated directories such as `node_modules` and
`target` (`worktree.rs:674`); do not attribute this cost to those directories.
Disk bytes are computed but not displayed in the current Worktrees rows.

Use a small measured concurrency limit, prioritize visible/selected checkouts,
reuse unchanged membership arrays, and cache advisory statistics separately
from authoritative status. Load cleanup-specific health when needed, while
revalidating dirty/locked/merged state before destructive actions. Measure a
10–20 checkout workspace and active-editor responsiveness under background load.

### 5. Defer optional feature code at startup — medium priority

`App.tsx:52–100` statically imports most views and dialogs, including Settings,
pull requests, conflict/rebase flows, and Work. `Work.tsx:13–14` statically
imports xterm. The resulting **2.13 MB** entry deserves a startup trace.
Mermaid and the Pierre editor already use dynamic imports; do not count their
separate chunks as initial script or propose lazy-loading them again.

Start with lazy optional dialogs and provider/plugin surfaces. Keep shell
navigation immediate and preserve the persistent Work/editor/terminal host's
React identity. Validate first invocation, keyboard focus, and returning to a
live terminal. Compare production navigation→paint and launch→interactive;
a smaller bundle by itself does not establish a startup improvement.

### 6. Batch Heroi transcript persistence — medium priority

Every committed conversation change triggers saving the complete conversation
collection (`HeroiView.tsx:290–293`). Text/activity events update that collection
(`:440–486`); `stores/plugins.ts:68` passes it directly to SQLite settings,
where `lib/db.ts:88` serializes the entire value. No debounce or per-key write
queue is present on this path. React may batch some events, so this is not a
claim of one write per token.

Coalesce streaming saves and serialize writes per state key. Flush final,
stopped, and failed turns and handle scope changes without saving one repo's
state into another. Memoize stable completed turns; profile long transcripts
before choosing incremental Markdown parsing or transcript virtualization.
Measure writes/second, bytes serialized, long tasks, and final-state restore
with multiple conversations running. Latency impact is unmeasured here.

### 7. Move Blame tokenization off the UI thread — medium priority

Blame rows are already virtualized (`FileView.tsx:997–1098`), but
`lib/highlight.ts:54` calls synchronous `codeToTokens` on the full file after
async grammar loading. The 12,000-line limit does not bound bytes or line
length. The surrounding async function does not move tokenization to a worker.

Use a worker-backed tokenization path with bounded input and plain-text
fallback, retaining cross-line grammar state. Verify theme changes, very long
lines, and 5k/12k-line code while typing or scrolling another pane. This is a
source-confirmed main-thread risk; its duration has not been profiled here.

## Measurement gates and implementation order

Implement refresh coordination, then demand-driven patches/object reuse, then
Files enumeration. Each should be a separate change with before/after numbers.
Worktree scheduling, lazy startup, Heroi, and Blame follow their live profiles.

Add a repeatable production WebView2 pass for: 100k-commit open, the 501-file
dirty tree, whole-file 5k-line Review/Local Changes, repeated hunk staging,
worktree switching, streaming Heroi, and multiple persistent terminals.
Record IPC counts/bytes, queue wait, engine time, JS long tasks, paint latency,
and process-tree private memory. Report distributions, not only one warm run.

`lib/perf.ts:42` calls the first snapshot a cold-start approximation; it does
not wait for the visible graph/diff to paint. The June/July timings in
`docs/perf-baseline.md` remain historical evidence, not certification of this
September build. This audit did not remeasure live UI paint, perceived staging,
idle memory, cold launch, or installer size, so it does not reopen/close their
historical milestone checkboxes based on engine timings alone.

Retain what is already effective: batched snapshots and index writes,
`spawn_blocking` read commands, incremental Git log, row/file virtualization,
the shared two-worker highlight pool, and persistent Work renderers. A global
mutex-protected repository cache remains a poor first target: opening a handle
costs about 1–2 ms, and serialization could compromise concurrent reads.

## Reproduction and checks

```powershell
cargo build --release -p strand-core --example perfcheck
.\target\release\examples\perfcheck.exe D:\GitSources\.strand-perf-fixtures\bigtree 5000
.\target\release\examples\perfcheck.exe D:\GitSources\.strand-perf-fixtures\bighist 100000
pnpm --filter ./ui exec tsc --noEmit
pnpm --filter ./ui exec vite build --manifest
cargo check -p strand-core -p strand-tauri
git diff --check
```

For new fixtures, use `scripts/gen_perf_fixtures.py` in a dedicated disposable
directory; the generator replaces its `bigtree` and `bighist` children. The
extended full-context benchmark assumes the fixture has a HEAD commit.

The release benchmark build, `cargo check -p strand-core -p strand-tauri`,
TypeScript, production Vite build, and `git diff --check` passed. Vite reports
large-chunk warnings and shared modules that cannot be split by their existing
dynamic imports. Those warnings are recorded as leads, not test failures.

## Implemented improvements

The follow-up implements all seven areas above:

1. `RefreshQueue` coalesces reads per canonical repository/resource, keeps a
   trailing refresh for changes during an outstanding read, and suppresses
   superseded responses. Active-repository generations cover A→B→A switches.
   Snapshots reload history when HEAD/refs change, rather than on every file
   write. The native watcher uses a bounded wakeup channel and a two-second
   maximum debounce wait, including linked-worktree index/HEAD watching.
2. Mounted diff consumers request patches, including composed panes and Work's
   Changes document. Hidden panes leave snapshot/status active. Clipboard and
   reviewed-file actions explicitly refresh their inputs. Stash, fixup, and
   navigation controls use status. `diff_unstaged_paths` supplies rename-aware
   staging targets without patch bodies. `stableRows` retains unchanged diffs
   and log entries while comparing actual content.
3. Files retains its local inventory across sidebar switches. Per-repository
   versions and `repo://files-changed` invalidate it on structural and ignore
   changes. The native boundary walk skips per-file ignore checks for entries
   Git's status/index walk already classified. Ignored children remain lazy.
4. Worktrees and Workspace Review share a two-job background read limit.
   Current-checkout rows load first; canceled queued work skips native reads.
   Advisory worktree statistics have a bounded 30-second cache; cleanup
   revalidates native membership, dirty state, locks, branch, and merge health.
5. Optional dialogs, pull requests, and Heroi load in separate chunks. Work's
   persistent host remains stable across navigation.
6. `BufferedWrites` coalesces Heroi progress in 500 ms windows and serializes
   writes per key. Completion, stop, failure, scope exit, and reload flush
   pending state. Completed message rows and Markdown are memoized.
7. Blame resolves Pierre registrations before sending them to a worker-owned
   Shiki core. Tokenization preserves whole-file grammar state, supersedes old
   replies, and falls back to text above byte/line/line-length limits. The
   worker is disposed with the view.

### After measurements

Same release engine harness, hardware, fixture, and warmup policy as above;
builds and engine benchmarks ran separately.

| Operation | Before median | After median | Interpretation |
| --- | ---: | ---: | --- |
| Files including ignored boundaries | 466.01 ms | 34.30 ms | 13.6× faster; 30 samples |
| Discover + snapshot | 36.50 ms | 35.30 ms | Similar engine cost; 20 samples |
| Unstaged path-only targets | unavailable | 12.61 ms | 20 samples; replaces full patches for hidden bulk staging |
| All unstaged patches | 547.68 ms | 513.32 ms | Still expensive; 20 samples |
| Full-context HEAD Review | 539.56 ms | 499.56 ms | Still expensive; 5 samples |
| Advisory worktree statistics | 242.74 ms | 237.48 ms | Per-scan cost remains; scans are bounded/cached |
| Initial JavaScript chunk | 2,130.76 kB | 1,956.72 kB | 8.2% smaller; gzip 607.46 → 558.00 kB |

Patch contents and serialized sizes on the 501-file fixture stayed identical.
The boundary-walk and path-only-read gains are structural; the small changes
in unchanged native operations should be treated as run variation.

### Live app verification

Used isolated WebView2 and SQLite state under a temporary app identifier,
without changing the checked-in Tauri config. The first pass used a release
engine with production Vite assets. Subsequent lifecycle checks, including the
corrected Blame worker, used production assets in a debug shell; those timings
are not used as release engine benchmarks.

- Hidden Work refresh on the 10k-file fixture: seven release samples from
  48.8–53.6 ms, median 50.4 ms, measured through two animation frames after
  the store update. This is a warm status refresh, not cold launch.
- A fresh lifecycle instrument at the fetch/IPC transport confirmed one
  snapshot and zero patch/log reads for a hidden refresh; 20 simultaneous
  requests also produced one snapshot. The test suite separately verifies
  the trailing read for a write during an outstanding request.
- Files→Git→Files issued no tree IPC. Creating/deleting an actual file updated
  its shadow-DOM tree row; nested ignore edits emitted inventory invalidation.
- Hidden Stage all issued one path-only read, one index write, one snapshot,
  and no patch requests. Both sides of a rename reached the index.
- Work's Changes document loaded with empty patch stores; the Stash checklist
  listed current changes without loading patches. An embedded Review in the
  Workbench updated after an already-modified file changed again, retaining
  an unchanged neighboring diff object's identity.
- Eleven actual checkouts loaded progressively with bounded reads. Reopening
  Worktrees repeated status/log reads but issued zero advisory-stat scans.
- A live terminal kept the same runtime ID across Work→Review→Work. First
  opening the lazy Settings dialog placed keyboard focus inside the dialog.
- A synthetic 100-event Heroi stream in a 200-message transcript made seven
  transcript saves (225,172 bytes of SQL IPC arguments). Reloading saved state
  returned all 100 updates and a completed turn. Provider calls were intercepted
  locally; no vendor agent was launched.
- A 5,000-line Blame file rendered 70 rows and real colored tokens in both
  light and dark themes. A regression test also checks multiline comment
  state using real Pierre registrations and Shiki tokenization.

The first release Local Changes opening took 3.40 seconds and Review 696 ms
on the 501-file fixture; a 500-row initial graph from the 100k-commit fixture
took 324 ms. These are single first-use observations, not distributions or
new PRD passes. Eliminating hidden/redundant work does not make a full 501-file
patch generation cheap. A selected-file/near-viewport patch protocol and a
repeatable cold-launch/first-use profile remain separate follow-ups.

The populated debug-shell process tree (three repositories, terminal state,
and the transcript exercise) used approximately 452 MiB private memory.
This is not the PRD's idle-memory scenario. Long-task observers produced no
entries in this WebView2 pass, so the absence of entries is not used as proof
of a frame-time target. Installer size, cold disk launch, and sustained
multi-agent workloads were not re-certified.

Validation: 425 frontend tests across 75 files, 162 core Rust tests, TypeScript,
native checks, Clippy with warnings denied for core/Tauri, production Vite
builds, and release app compilation. Temporary
CDP binaries/profiles are verification artifacts, not release configuration.

PR CI exposed a test-environment difference: Node 20 has no built-in
`navigator`, unlike the local Node 22 runtime. The Blame integration test now
stubs it before importing Pierre and restores all globals afterward. All 425
frontend tests also pass locally with `--no-experimental-global-navigator`;
the real grammar/color assertions remain enabled.
