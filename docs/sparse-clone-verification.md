# Sparse checkout and clone controls — F08/F09

Verified on Windows / WebView2 on 2026-09-06.

- `cargo check -j 2 -p strand-core -p strand-tauri` passed.
- `cargo test -j 2 -p strand-core --lib --tests -- --test-threads=2`:
  175 tests passed, including 13 integration tests in `sparse_checkout.rs`,
  `clone_scope.rs` and `clone_recursive.rs`.
- `corepack pnpm --filter ./ui exec tsc --noEmit` passed.
- `corepack pnpm --filter ./ui exec vitest run --maxWorkers=2 --minWorkers=1`:
  76 files / 427 tests passed.

The repository's verify skill was run against an isolated native app instance.
The command palette and keyboard controls cloned a selected branch with depth
one, a single-branch refspec and `blob:none`; system Git confirmed each choice.
The history dialog deepened from one to three commits and downloaded all five.
A real stalled HTTP clone displayed progress and cancelled its transport.
History cancellation in an externally cloned shallow repository preserved the
index and restored keyboard focus.

Live sparse checks enabled a sparse index, changed to a nested directory with
spaces, refused changes after a real deletion without changing index bytes, and
restored every tracked file on disable. Files omitted excluded paths with a
Manage notice; a real included-file deletion produced exactly one deleted row.
Tab/Shift+Tab wrapping, Escape, initial/post-operation focus and the scrollable
880×650 layout were checked. The native debug instance was isolated from the
user's profile and app identifier; the checked-in Tauri config was unchanged.

Integration fixtures also cover external full/sparse indexes without rewriting
them on read, linked-worktree isolation, non-cone inspection/disable, staged and
unstaged edits, ignored/untracked-file refusal, sparse staging/hunks/commit/
checkout/discard, literal file paths, restored files with stale index timestamps,
real omitted historical blobs, shallow blame and recursive nested submodules.

Cone selection is limited to tracked directories in HEAD. External non-cone
patterns must be disabled before editing cone selections. Sparse changes refuse
dirty work rather than implicitly stashing it; they show busy state and Git's
warnings. Streamed progress and cancellation apply to clone/history downloads.
Partial content reads can require network access. Live execution and transport
cancellation validation was Windows only.

PR integration validation (2026-09-06): the combined LFS/sparse-index fixture
passes pointer staging, filtered discard, and partial-patch rejection without
expanding the on-disk sparse index. Rust checks and TypeScript pass.
