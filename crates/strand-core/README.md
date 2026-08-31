# strand-core

Strand's git engine. UI-agnostic. Returns plain data that `strand-tauri` serializes.

## Status

Accepted. This is the contract for gix vs git2 vs the user's `git`. `Cargo.toml` and `AGENTS.md` still say "gix for reads, git2 for writes." That slogan is incomplete. This file wins.

## Context

Every Git feature and PRD §8 depends on which backend owns the work. Three backends are already in the crate:

- `gix` for most reads
- `git2` for index and commit writes, and for opening the same path as gix
- the user's `git` binary where git2 is the wrong tool

`Repo::log` shells out. git2's topological revwalk buffers the whole reachable DAG before the first row, so `limit` does not bound the work. On a 100k-commit repo that is a ~0.5s floor and it breaks the 2.0s open target near 1M commits. `git log --date-order -z -n` is incremental and commit-graph-backed. That is PR #5, not a style choice.

If the next module picks a backend by habit, Heroi, Review, Worktrees, and bulk stage will grow a fourth path. UI must not own git.

## Decision

### Reads

Use `gix` unless the hot path has a measured reason to shell out.

`Repo::log`, `Repo::log_head`, and `Repo::search_log` use `git log` through `git_command()` plus `GIT_SAFE_CONFIG`. Keep `--date-order` so the lane algorithm's topological invariant holds. Graph layout stays in `ui/src/lib/graph.ts`. Do not put a git2 revwalk back on this path.

Status, diff, blame, tree, ignore, and file listing stay on gix until a baseline says otherwise. Evidence lives in `docs/perf-baseline.md`.

### Writes

Use `git2` for index and commit when Strand can do the whole mutation itself.

Shell out when stability needs the user's git: interactive rebase, GPG/SSH signing, LFS, hooks, mergetool. Those are the cases named in `lib.rs`. A conflicted mutation returns `Ok` with a conflict flag, not `Err`. The sequencer is git's job.

### One shell-out policy

Every spawn starts at `git_command()`. On Windows that sets `CREATE_NO_WINDOW` so a GUI-subsystem build does not flash a console per call. Exception: mergetool keeps default flags because a console merge tool needs a window.

Every spawn prepends `GIT_SAFE_CONFIG`: empty `core.fsmonitor` and `core.pager=cat`. A repo-local fsmonitor is an RCE vector when opening an untrusted repo. Do not clear `core.sshCommand`, `credential.helper`, or `GIT_ASKPASS`. Those are how the user authenticates. See `network` module docs.

Do not add `Repo::run_git`. `network.rs`, `stash.rs`, and `history.rs` already have different helpers. `GIT_SAFE_CONFIG` is the shared constant so those helpers cannot drift on fsmonitor/pager. They can still differ on args, env, and timeout.

### Dual-open

`gix` and `git2` must open the same path. `init()` disables git2 owner validation once at process start, before any command thread. Otherwise Windows drive-root repos and uid-mismatched trees open in gix and fail in git2, and the tab loads half-empty. This does not widen the RCE surface. The dangerous exec is on shell-out, already killed by `GIT_SAFE_CONFIG`. git2 and gix do not honor fsmonitor exec.

git2 handles stay per-`Repo`. Do not add a process-wide `git2::Repository` cache. It is `!Sync`. Perf-baseline already rejected that, 2026-07-06.

### UI

The webview never talks to git. Bulk index work is one IPC such as `stage_paths`, not N. `strand-tauri` wraps `strand-core`. It does not grow a second engine.

## Rejected

**gix for every read.** `Repo::log` already proved git2 and gix lose to `git log` on the graph. Freeze the exception, do not pretend it is not there.

**git2 for every write.** Interactive rebase, signing, LFS, and hooks are git's product. Reimplementing them is how Strand becomes a worse git.

**A fourth backend in `strand-tauri` or Heroi.** Agent CLIs may spawn processes. They do not open repos.

**Community JS in the privileged webview talking to git.** Already rejected in `docs/extensibility-architecture.md`. This crate is the reason that rule holds.

**Process-wide git2 handle cache.** `!Sync`, already measured, already rejected.

## Consequences

`Cargo.toml` description and `AGENTS.md` "Project shape" are stale until a later PR. Implementers read this README.

New git operations pick a backend in the module that owns them and document why if they shell out. Silence means gix for reads and git2 for writes, except the log family.

Plugin isolation and Review vs Local Changes wait. They sit on this engine. They do not replace it.

## What to change

Honor this in:

- `crates/strand-core/src/lib.rs` — `GIT_SAFE_CONFIG`, `git_command`, `init`
- `crates/strand-core/src/log.rs` — `Repo::log` / `log_head` / `search_log`
- `crates/strand-core/src/repo.rs` — dual-open
- `crates/strand-core/src/stage.rs`, `commit.rs`, `apply.rs` — git2 writes
- `crates/strand-core/src/history.rs`, `network.rs`, `stash.rs` — per-module shell-out, shared `GIT_SAFE_CONFIG`
- `crates/strand-tauri/src/commands.rs` — one IPC per bulk git op
- `ui/src/stores/repo.ts` — cache of engine results, not a git implementation

Follow-up, not this PR: fix the `Cargo.toml` description and the `AGENTS.md` crate blurb so they mention shell-out. Then a process-model README for PTY + Heroi CLI children. Then DAN-53 Review vs Local Changes.
