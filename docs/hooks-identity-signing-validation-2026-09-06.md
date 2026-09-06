# F01–F03 validation — 2026-09-06

Base: `263ebe6` (PR #114). Windows, system Git, isolated worktree and fixtures.

## F01 — commit hooks

Commit and amend always use system Git. This explicitly supersedes the old
unsigned git2 path documented in learnings; index operations remain on git2.
Git owns hook lookup, `core.hooksPath`, rejection, message rewrites, signing,
merge parents and amend attribution. The command runs on the blocking pool.
Stdout and stderr are drained concurrently, keeping each stream’s first/last
8 KiB with an explicit truncation marker. Drafts are checkout-keyed and survive
failed operations and view/repository changes during the session.

Evidence:
- Core fixtures: custom hooksPath, rejecting pre-commit and commit-msg,
  prepare-commit-msg/commit-msg rewriting, post-commit output, amend post-rewrite
  old/new OIDs, preserved index/HEAD on rejection, bounded verbose output,
  attribution on amend and missing SSH signing key failure.
- Store/shortcut tests: 12 passed, including rejected-hook index refresh,
  completed commit with failed refresh, and repository-switch response handling.
- Frontend TypeScript: passed.
- Isolated native WebView2: Ctrl+Enter rejection kept subject/body; switching
  to Commits and back retained the draft; retry ran message rewriting and
  exposed successful hook output. Verified the resulting commit message with
  Git. Screenshots retained under `target/verify-f010203/f01-*.png` (local only).
- Manual 25-iteration debug measurement, while other tasks were compiling:
  system Git median **529.01 ms**, p95 **797.32 ms**; former git2 algorithm median
  **24.50 ms**, p95 **97.98 ms**. This is an explicit correctness cost on commit,
  not a status/staging hot-path change or an idle performance certification.
  Reproduce with `cargo test -p strand-core measure_no_hook_commit_path --
  --ignored --nocapture`. Both measurements exclude staging.

Git contracts: [hooks](https://git-scm.com/docs/githooks),
[commit](https://git-scm.com/docs/git-commit).
