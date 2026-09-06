# Git LFS and submodule validation — 2026-09-06

F04 and F05 are implemented through core operations, typed IPC, sidebar entries
and keyboard-operable dialogs. Verification used Windows, Git 2.45.1 and Git
LFS 3.5.1, with disposable repositories and local Git/HTTP endpoints.

## Regressions reproduced and fixed

- **LFS index bytes:** git2 `index.add_path` stored the asset instead of the
  canonical pointer produced by `git hash-object --path`. Single-file and bulk
  staging now run Git's required LFS clean filter. Fixtures compare the actual
  index/commit bytes, then check checkout, discard, hard reset, push and pull.
  A missing filter executable fails without changing the index to raw assets.
- **Submodule ignored files:** non-forced `git submodule deinit` removed an
  ignored local file. Removal/deinit now check ignored files and recorded
  commits in every initialized descendant. The fixture covers both direct
  and nested ignored files, dirty/untracked files, and unrecorded commits.
- **Native dialog integration:** corrected shared-select styling and routed
  module opening through the workspace store, so workspace reconciliation
  retains the new active repository.

## Automated checks

Run from the repository root:

```text
cargo check -p strand-core -p strand-tauri -j 2
cargo clippy -p strand-core -p strand-tauri -j 2 -- -D warnings
cargo test -p strand-core --lib -j 2 -- --test-threads=2
pnpm --filter ./ui exec tsc --noEmit
pnpm --filter ./ui test
```

All checks passed: 169 core tests and 425 frontend tests across 75 files.

Core coverage lives in `lfs.rs`, `submodule.rs` and
`network::bounded_process_tests`. Fixtures also verify local setup/tracking
without history changes, server lock/list/unlock, safe argument handling,
submodule transport, `.gitmodules` and gitlink staging, URL/index preservation,
deinit/reinit, lazy nested metadata, bounded output and cancellation of helpers
that keep progress pipes open. Linux CI installs Git LFS for these real fixtures.

## Native verification

Followed `.agents/skills/verify/SKILL.md` with an isolated application identifier,
WebView2 profile, Vite port and disposable repositories. The checked-in Tauri
configuration was never edited. The verification instance was stopped by its
recorded PID and the normal dev binary rebuilt without the CDP override.

- LFS: sidebar setup and tracking, Stage all/commit with canonical pointer
  bytes, object listing from the command palette, initial focus, styled fields,
  no network on opening, cancellation and subsequent successful environment read.
- Submodules: real add/clone, status, lazy nested navigation, opening the module
  as a repository, URL changes/sync, confirmation by keyboard, dirty-file refusal,
  deinit/reinit/removal and retained module history. A stalled add cancelled
  without changing the index. The rebuilt app also refused deinit when an
  ignored local file was present, preserving its exact contents and the index.
- Cancellation of stalled local HTTP requests completed in approximately
  0.44 seconds for LFS and 0.48 seconds for submodule add. These are fixture
  observations, not general performance certification.

## Boundaries

Lock listing is capped at 100 with an exact-path filter; object transcripts
retain a bounded tail. Submodule metadata is paged at 100 per level; dirty
inspection is explicit and destructive preflight may walk descendants. LFS
history migration and partial-pointer patches are intentionally absent.

Hosted authentication/locking services and macOS/Linux runtime behavior were
not exercised here. The LFS network fixture clones without checkout and then
uses Strand checkout because this Git/LFS combination rejects a hook installed
during normal clone checkout. Advanced clone compatibility remains tracked
under F09; no system safety override was added.
