# Main audit — 2026-09-29

Audited `f5ed9a875adbbb70cbef98987e24b298b85ce2f1` (1.7.2), after a clean
fast-forward of local `main` from `df612d8`. No application fixes, commits or
pushes were made during the audit. The implementation follow-up is recorded
below. This is a targeted correctness, safety, performance and
backlog audit, not exhaustive certification of every feature.

Environment: macOS Apple Silicon, Rust 1.92.0, Apple Git 2.54.0, Node 25.9.0,
pnpm 9.0.0. Git LFS is absent. Frontend dependencies were synchronized with
`pnpm install --frozen-lockfile`; no manifest or lockfile changed.

## Prioritized findings

P1 means fix before the next release; P2 means a concrete follow-up. Six
findings were reproduced against the actual engine or existing tests. A05 is
confirmed by source inspection, without an out-of-memory stress test.

### A01 / P1 — File discard and unstage expand literal filenames as patterns

Evidence: `crates/strand-core/src/stage.rs:137–141`, `:88`, `:170`.
`CheckoutBuilder::path` and `reset_default` receive selected filenames as
pathspecs without disabling wildcard matching. The UI calls these paths from
`useRepo.discardMany` / `unstageMany`; bulk discard does not create a safety
stash (`ui/src/stores/repo.ts:1764`).

Reproduction: commit `[id].tsx` and `i.tsx`, modify both, then call
`Repo::discard_path("[id].tsx")`. Both files revert, including the unrelated
`i.tsx`. Stage new changes to both and call `unstage_path("[id].tsx")`:
`git diff --cached --name-only` becomes empty. This affects valid cross-platform
filenames, including bracketed route filenames; it is not limited to Unix `*`.

Fix criterion: single and bulk actions affect exactly the selected paths,
including `[]`, `*`, `?` and pathspec-like prefixes. Disable checkout pathspec
matching and use an exact-path index reset strategy. Preserve the existing
batched in-process hot path and narrow Windows fallback.

### A02 / P1 — Hard reset overwrites colliding untracked content without recovery

Evidence: `crates/strand-core/src/reset.rs:60–93` and
`ui/src/views/ResetDialog.tsx:108`.
The dirty check explicitly excludes untracked/ignored files and snapshots with
`include_untracked=false`. Its premise that hard reset never touches untracked
files is false when the target tree needs their paths. The dialog promises a
safety snapshot.

Reproduction: commit `collision.txt`, delete and commit it, recreate it with
unique untracked bytes, then call `reset("HEAD~1", ResetMode::Hard)`. The bytes
become the old committed content and `snapshot_oid` is `None`.

Fix criterion: preflight collisions against the target tree and either refuse
or preserve the threatened content before resetting. Include file/directory
collisions and ignored data in regression coverage, with native, sparse and
LFS dispatch coverage. Do not claim a recovery snapshot unless it covers the
data actually overwritten; avoid an unconditional stash round trip.

### A03 / P1 — Add to .gitignore follows symlinks outside the checkout

Evidence: `crates/strand-core/src/ignore.rs:20–37`.
The quick action joins `.gitignore` directly to the repository path and reads
and rewrites it without the working-tree guard or a no-symlink check.

Reproduction: point `.gitignore` at a text file in a separate temporary
directory, then call `gitignore_add("/build")`. The operation succeeds and the
external file gains `/build\n`. Only disposable files were used in this probe.

Fix criterion: reject symlinked/nonregular ignore files and escaped resolved
destinations before reading/writing; test both existing and dangling symlinks.
An ordinary Ignore action must never mutate a repository-controlled external
target. This is a file-boundary bug; no code-execution exploit was attempted.

### A04 / P2 — Staging a dangling symlink silently stages nothing

Evidence: `crates/strand-core/src/stage.rs:16–23` and `:50–57`.
`Path::exists` follows the link, so a present link with an absent referent is
classified as a deleted file. Git tracks the link itself.

Reproduction on macOS: create `link -> missing-target`, call
`stage_path("link")`; it returns `Ok(())`, but `git ls-files --stage link` is
empty. The bulk path repeats the same existence check. For an already tracked
link, this branch can remove its index entry instead of staging the link.

Fix criterion: inspect directory-entry existence with `symlink_metadata`,
distinguish NotFound from other I/O errors, and test new/modified dangling links
through single and bulk staging. Preserve mode `120000` and the link text.

### A05 / P2 — The 2 MB content limit does not bound the disk read

Evidence: `crates/strand-core/src/file.rs:110–115`, `:259–260`.
`file_content` calls `std::fs::read` for the entire working-tree file before
`build_content` truncates the result to 2,000,000 bytes. Selecting a very large
log or generated asset therefore allocates its complete size in the backend,
even though the UI displays only a prefix or a binary notice.

Fix criterion: open a regular file and perform a bounded prefix read, retaining
correct truncated/binary/editable flags and UTF-8 boundaries. Ensure changing
file size cannot defeat the bound. Measure memory and bytes read on a large
fixture; frontend virtualization does not protect native allocations. Audit
revision/blob reads separately rather than claiming they are already bounded.

### A06 / P2 — Rename/move allows destinations inside .git

Evidence: `crates/strand-core/src/rename.rs:30–31`, `:51–61` and
`ui/src/views/RenameFileDialog.tsx:55–63`.
The rename dialog accepts a full relative destination. The native checks
enforce checkout containment but omit the administrative-path rejection used
by file create/delete.

Reproduction: `move_path("scratch.txt", ".git/audit-moved")` succeeds for an
untracked file. It disappears from the working tree and appears inside Git
metadata. Existing destination files are still protected against overwrite;
this finding does not claim otherwise.

Fix criterion: reject administrative source/destination components before
creating directories or moving data, including aliases into the Git directory.
Cover untracked files, directories and linked worktrees. Apply the guard at
the native mutation boundary, not only in the dialog.

### A07 / P2 — Missing-worktree removal fails through a macOS path alias

Evidence: `crates/strand-core/src/worktree.rs:225–229`.
Registration lookup compares literal paths or canonicalizes the entire target.
Once the target is absent, canonicalization fails; `/var/...` no longer matches
Git's stored `/private/var/...` spelling.

Reproduction: existing test
`worktree::tests::removal_only_skips_archive_when_the_registered_directory_is_missing`
fails independently on this Mac at line 1411 with `not a registered worktree`
after removing the directory. It also fails with system/global Git config
isolated. The analogous existing-directory identity guard remains important.

Fix criterion: reconcile missing target identities through their existing
ancestors or authoritative registered identity without weakening
archive-before-remove or different-repository checks. Retest macOS aliases,
ordinary paths and the existing archive-failure cases.

## Baseline verification and limitations (before fixes)

| Check | Result |
| --- | --- |
| `pnpm --filter ./ui exec tsc --noEmit` | Pass |
| `pnpm --filter ./ui test` | 99 files, 568 tests pass |
| `pnpm build` | Pass; entry chunk 2,013.31 kB / 573.63 kB gzip; Vite large-chunk warning |
| `cargo check -p strand-core -p strand-tauri` | Pass |
| `pnpm release:check-security` | Pass |
| `pnpm release:test-helper` | 9 tests pass |
| `pnpm release:check-helper` | Live protocol-7 manifest, signature asset and three platform archives available; not a fresh cryptographic verification |
| `cargo test -p strand-core -p strand-tauri` | Core stopped the command: 203 pass, 16 fail, 6 ignored |
| Isolated core run below | 210 pass, 2 fail, 6 ignored, 7 LFS tests filtered |
| Separate `cargo test -p strand-tauri` | 162 pass, 3 fail |
| Serial cancellation subset below | 5 pass, 1 fail |

Core failure breakdown: seven missing-Git-LFS prerequisites; seven fixtures
inherited personal signing settings and failed through the signing agent; one
conditional-identity expectation; one missing-worktree removal (A07).
No personal Git configuration was changed. This isolated rerun removes the
signing-environment failures, but does not certify LFS:

```sh
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
  cargo test -p strand-core -- --skip lfs
cargo test -p strand-tauri cancel -- --test-threads=1
```

The conditional-identity test still expects `Conditional` and receives `Base`
(`gitconfig.rs:206`). Its includeIf pattern uses a noncanonical temporary path;
diagnose fixture path semantics against system Git before labeling it a
production identity regression.

Two Tauri cancellation deadline failures pass in the serial rerun. The user
action descendant test still fails at `user_actions.rs:337`, expecting
`spawned child` in stdout after a fixed 700 ms delay. Investigate child readiness
and macOS capture/startup behavior; the failure alone does not prove a process
escaped cancellation. These are open validation issues, not a green suite.

The disposable engine probe exercised A01–A04 and A06 directly, with the
following output (A01 used `[id].tsx` and `i.tsx`):

```text
DISCARD wildcard: selected="old literal", unrelated="old neighbour"
UNSTAGE wildcard: staged files=""
RESET collision: content="old committed", snapshot=None
STAGE dangling symlink: result=Ok(()), index=""
IGNORE symlink: result=Ok(()), external content="outside original\n/build\n"
MOVE into git metadata: result=Ok(()), exists=true
```

No native UI walkthrough, packaged installer/updater cycle, live provider write,
full dependency vulnerability scan, or current PRD performance certification
was performed. Passing builds and tests do not establish those claims.

## What Strand needs next

1. **Protect local data first.** Fix A01–A03 with real-repository regressions,
   then A04–A07. Keep each logical fix separate and preserve batched hot paths.
2. **Make macOS verification trustworthy.** Isolate test Git config, state
   prerequisites for Git LFS, resolve the identity/cancellation tests, and add
   a macOS Rust test job. CI currently has Linux Rust and Windows-specific
   jobs, but no macOS test job. Complete native terminal process-tree,
   workspace persistence and Workbench continuity checks on macOS/Linux.
3. **Certify current performance.** Existing TASKS already tracks first-use
   grammar/paint, cold launch, idle memory and sustained-edit gaps. Measure the
   exact production candidate against PRD §8, separating native reads, IPC,
   highlighting and visible paint. The entry bundle is a lead to profile, not
   proof of a responsiveness regression.
4. **Close delivery evidence.** Run current macOS/GNOME/KDE install/update
   checks and live Azure iteration/suggestion validation. Reconcile helper and
   historical release rows: protocol 7 is available now, while protocol-6
   backfill and old Store/SEO tasks require current external evidence. Do not
   assume every unchecked historical row is still missing.
5. **Then prioritize product expansion.** Plugin isolation/quotas and remote
   install, typed Workbench context/services, SSH artifact/bootstrap and remote
   directory browsing, CLI terminal rendering/distribution, and the proposed
   per-run review checkpoints remain explicit incomplete families. Small UX
   follow-ups include repository-tab reordering, truthful encoding/EOL status
   and per-file persistence. Select these by user need after hardening.

Planning cleanup is also warranted: PRD still contains historical unresolved
licensing/pricing questions already answered in TASKS; ROADMAP's cross-cutting
questions still label PR review as a candidate despite its implementation.
Keep historical audit evidence, but provide one concise current release gate
and distinguish shipped features from pending validation.


## Implementation follow-up — 2026-09-29

A01–A07 are implemented with regression tests. Historical findings and
failed baseline runs above are retained as
reproduction evidence, not the current implementation status.

- **A01:** `needs_literal_pathspec` routes special-name batches through one
  NUL-delimited Git command. Reset uses `--literal-pathspecs`; checkout-index
  takes exact filenames. Ordinary batches retain their libgit2 fast path.
  Regressions cover bracketed routes, wildcard/negation/comment characters,
  spaces, Unix backslashes, single/bulk operations and unborn HEAD.
- **A02:** `guard_reset_tree` checks target collisions before snapshots or any
  reset dispatch. Directory replacement inspects threatened descendants,
  including ignored files, without scanning unrelated dependency directories.
  It refuses collisions; it does not attempt an implicit untracked stash.
  Normal, sparse-index, LFS and file/directory fixtures retain bytes and Git
  state on refusal. The dialog and guide now describe the actual coverage.
- **A03:** Ignore checks containment and regular-file metadata, opens without
  following symlinks, and reads/writes one handle. Missing files use create-new.
  Existing, dangling and in-tree symlinks and directory targets are tested.
- **A04:** `entry_exists` uses symlink metadata and propagates non-NotFound
  errors. New and modified dangling links retain mode 120000 and target text
  through single and bulk staging.
- **A05:** Working-tree content reads at most 2,000,001 bytes; valid UTF-8 is
  not split at the preview boundary. The 1 GiB sparse-file regression ran in
  0.10 seconds with 18,628,608 bytes maximum RSS for the test process on this
  Mac (`/usr/bin/time -l`), not a packaged-app memory claim. Historical blob
  materialization remains a separate path and is not certified by this test.
- **A06:** `guard_move_metadata` rejects administrative components and resolved
  aliases into per-worktree/common Git metadata before creating directories.
  Tests include linked worktrees, aliases and working-tree root moves.
- **A07:** `resolve_missing_path` canonicalizes the existing ancestor while
  retaining the missing suffix. Existing-directory identity and recovery-archive
  guards remain intact and their regressions pass.

Validation repairs also isolate the affected test fixtures from personal
signing/LFS settings, canonicalize Unix includeIf paths, switch accepted LFS
mock-server sockets to blocking mode on macOS, and replace fixed cancellation
sleeps with child-readiness checkpoints. Git LFS 3.8.0 was installed locally
for verification, without changing global Git configuration. The Rust CI
matrix now includes macOS as well as Linux; its hosted run is still pending.

Stronger cancellation checks exposed two additional production gaps. Unix Git
cancellation now signals the owned group even after the leader exits. Hosted
provider commands now use Unix process groups / Windows Job Objects and stop
helpers before joining pipes on cancellation, timeout, error and natural
completion. The active-child and exited-parent regressions pass. Provider
output reads remain unbounded; TASKS records that separate follow-up.

Verification after fixes:

- Core: 232 unit tests and 13 integration tests pass; six existing optional
  signing/Git-flow/measurement tests remain ignored.
- Tauri: 166 tests pass, including provider helper cleanup and readiness-based
  cancellation tests.
- Frontend: all 568 tests pass; TypeScript passes.
- `cargo check -p strand-core -p strand-tauri` and clippy with `-D warnings` pass.
- `git diff --check` passes. The audit's earlier production frontend build and
  release-policy results remain baseline evidence; no packaged app was rebuilt
  or released in this repair pass.

The repository planning corrections are limited to evidence already available:
PRD licensing/pricing decisions and ROADMAP's implemented PR-review surface.
Native macOS/Linux packaged-app validation, Windows execution of the new native
branches, production PRD performance certification, and external Store/SEO/
older-helper publication reconciliation remain open. Product-expansion items
in the original audit remain separate future work, not implied fixes in this
hardening change.
