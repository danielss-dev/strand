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
- Manual 25-iteration debug measurement after concurrent builds settled:
  system Git median **81.01 ms**, p95 **87.72 ms**; former git2 algorithm median
  **7.59 ms**, p95 **8.47 ms**. Under earlier concurrent compilation these were
  529.01/797.32 ms and 24.50/97.98 ms respectively (median/p95).
  This is an explicit correctness cost on commit,
  not a status/staging hot-path change or an idle performance certification.
  Reproduce with `cargo test -p strand-core measure_no_hook_commit_path --
  --ignored --nocapture`. Both measurements exclude staging.

Git contracts: [hooks](https://git-scm.com/docs/githooks),
[commit](https://git-scm.com/docs/git-commit).

## F02 — repository identity

- Core: three gitconfig tests passed, including conditional include contents
  left byte-for-byte intact; separate repository values unaffected; common
  local config shared across linked worktrees; explicit worktree identity
  retained after removal of common local name.
- Native WebView2: Settings → Git displayed effective author/committer and
  field provenance; Save name changed the effective identity; Remove name
  override restored inheritance; opening a second repository displayed that
  repository’s own identity. Local screenshots: `f02-local-identity.png` and
  `f02-separate-repository.png` under `target/verify-f010203/`.
- The Git settings entry is available in the command palette; all fields and
  actions use native inputs/buttons within the existing Settings tab model.
- Frontend TypeScript and `cargo check -p strand-core -p strand-tauri` passed.

Git contracts: [config scope and includes](https://git-scm.com/docs/git-config).

## F03 — signing controls and signed tags

Commit/amend and tag creation accept inherit/sign/unsigned without writing a
configuration override. Inheritance is resolved by system Git; explicit
unsigned annotated tags suppress both `tag.gpgSign` and `tag.forceSignAnnotated`.
Settings show effective values/provenance and save/remove only direct local or
explicitly enabled worktree keys. Signing uses Git's existing agents, signing
program and key references. Verification resolves an immutable tag object and
returns unsigned/verified/failed plus bounded Git output; validity does not
silently imply signer trust. No graph-wide verification was added.

Evidence:
- Full core suite passed at 167 tests before the final boolean-parser fixture.
  The final run had **167 passed, one failed, three ignored**: unchanged
  `watch::tests::debounce_collapses_a_burst_into_one_callback` observed two
  callbacks instead of one, and failed again in isolation. The watcher source,
  core dependency manifest and lockfile are unchanged from the task base.
  This is recorded as a follow-up; the final full core suite is not green.
  All hook/identity/signing/tag tests passed, including the added boolean case.
  Full frontend suite: 75 files, 430 tests passed,
  including refresh failure after successful signing and switching
  repositories while a signer runs.
- Explicit real GPG and SSH fixtures both passed. Each covers new signed
  commit, inherited signed amend, per-operation unsigned amend without config
  mutation, hooks rewriting/rejecting signed commits, explicit/inherited/
  force-annotated signed tags, unsigned annotated/lightweight overrides,
  tampered-signature failure, and missing-key commit/tag failure with unchanged
  HEAD and no failed tag ref. SSH also covers a missing allowed signers file.
- Each real-signature fixture exercises a linked worktree, inherited signing,
  then a worktree-only unsigned default while common local defaults and the
  main checkout's HEAD remain intact. A separate scope test rejects worktree
  writes when the extension is disabled and confirms removal restores inherited
  values without affecting another repository.
- Config parsing distinguishes Git's valueless boolean (`true`) from an
  explicitly empty boolean (`false`), with a fixture for both and the `yes` alias.
- Native WebView2: Settings → Git saved SSH format, key reference, allowed
  signers path and commit/tag defaults. Ctrl+Enter created a verified signed
  commit; amend also verified. The palette opened signed-tag creation and
  verification. A missing-key amend preserved HEAD, draft and signing choice.
  The final native pass used Enter in the palette, confirmed a failed signed
  tag kept name/message/choice and created no ref, retried it unsigned against
  both signing defaults, and verified an inherited force-annotated signature.
  Worktree-scoped save/remove restored inheritance while main config stayed
  unchanged.
  Screenshots are local under `target/verify-f010203/f03-*.png`.
- `cargo check -p strand-core -p strand-tauri` and frontend TypeScript passed.

The fixtures caught two Git tag details: verbatim messages need a final LF
before the appended signature, and explicit `--annotate` suppresses
`tag.forceSignAnnotated`. Inherited tag creation uses `--file` without that
override. See Git's [tag implementation](https://github.com/git/git/blob/v2.45.1/builtin/tag.c)
and [tag configuration](https://git-scm.com/docs/git-config#Documentation/git-config.txt-tagforceSignAnnotated).

Reproduce the real-key fixtures with `cargo test -p strand-core signing::tests
-- --ignored --nocapture`. They use generated, disposable keys and isolated
GPG homes; they do not change the user's global Git configuration or keyring.
Validation host: Windows, Git 2.45.1.windows.1. macOS/Linux runtime behavior,
X.509, hardware-backed keys and interactive pinentry were not exercised.
