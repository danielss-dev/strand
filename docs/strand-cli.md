# `strand` CLI — feature design

Status (2026-06-12): **design only, scheduled post-1.0** (ROADMAP §1.1+,
where "CLI companion binary" has been a bullet since the start — this doc
fleshes it out). Shares its foundation with
[`remote-ssh.md`](./remote-ssh.md): both consume the transport-agnostic
`strand-ops` crate, and the CLI and the remote daemon are proposed as
**one binary**. Read that doc first.

## Why

Two audiences, one binary:

1. **Humans in a terminal.** `strand .` opens the repo in the app the way
   `code .` opens VS Code. `strand diff` renders a readable diff,
   `strand log` the history, without leaving the shell.
2. **AI agents.** Agents currently scrape `git diff` / `git log` — text
   formats designed for humans in 1970s terminals: 3-line context
   fragments, locale-sensitive, rename detection that lies, conflict
   state spread across plumbing calls. Strand's engine already produces
   *typed, structured* answers to all of these questions (the serde types
   crossing the Tauri IPC boundary). `strand --json` hands agents that
   same data: full-file-context diffs, structured conflicts, batched
   snapshots. Better input → better agent output, and it pairs with the
   AI-change-review use case: the agent works against `strand` CLI data,
   the human reviews the result in the Strand app.

## Decision

One headless static binary, **`strand`**, linking `strand-ops` directly —
no app, no daemon, no socket required for data commands. Three modes in
one artifact:

- **`strand <path>`** — open/focus that repo in the Strand app (the only
  mode that talks to the GUI).
- **`strand <subcommand>`** — run an engine op in-process and print the
  result (terminal-rendered by default, `--json` for machines).
- **`strand --stdio`** — the JSON-RPC daemon mode that
  [`remote-ssh.md`](./remote-ssh.md) calls `strandd`. Same binary, same
  builds (linux x86_64/aarch64 musl + darwin), same SHA-256 manifest.
  One distribution artifact instead of two.

Data commands deliberately do **not** route through the running app: an
agent on a headless box (exactly where agents live) must work with no GUI
installed. The cost is no shared cache between CLI and app — acceptable;
the engine is fast and the index/odb are the real source of truth.

## Command surface (v1)

Each subcommand maps onto an existing `strand-ops` op — the CLI invents
no new engine behavior. Repo resolution: `-C <path>` or cwd discovery,
same as git.

| Command | Backing op(s) | Notes |
| --- | --- | --- |
| `strand <path>` | — | open/focus in app (see below) |
| `strand status` | `repo_status` / `repo_snapshot` | `--snapshot` batches status+refs+meta+log in one call |
| `strand diff` | `repo_diff_unstaged` (`--staged`, `--commit <sha>`, `--between <a> <b>`, `--since <ref>`) | terminal rendering with syntax-aware colors |
| `strand diff --full-context` | `repo_diff_unstaged_full` / `repo_diff_since_full` | whole-file-context diffs — the review-pool ops, the headline for agents |
| `strand log` | `repo_log`, `repo_file_history` | `-n`, `--file <path>` |
| `strand blame <file>` | `repo_blame` | |
| `strand review` | `repo_diff_since_full` + `repo_log` + `repo_status` | one payload: everything an agent (or reviewer) needs to review changes since a base ref |
| `strand conflicts` | `repo_read_conflict_file` ×N | structured ours/theirs/base per conflict — no plumbing archaeology |
| `strand schema` | — | dump the JSON schema of all output types, versioned |

Explicitly **not** in v1: mutation of any kind — no push/pull/fetch, no
stage/commit/branch/stash/rebase (decided 2026-06-12; push/pull were in
an earlier draft and cut). The app is the write surface; the CLI is
**open + read, full stop**. That's also a safety property: an agent
driving `strand --json` cannot change the repo or the remotes through
it. Expand later only with demonstrated demand — every write op added
to the CLI is a write op agents will script against, and that contract
then has to be maintained forever.

## Machine output (the AI contract)

- **`--json` everywhere.** Output is the *same serde types* the IPC layer
  already ships to the webview (`FileDiff`, `Commit`, `FileStatus`,
  `Snapshot`, …). One set of types, three consumers (webview, remote
  daemon, CLI) — the contract can't drift from the app's behavior.
- **Versioned.** Top-level envelope carries a `schemaVersion`; additive
  changes only within a major. `strand schema` emits the full JSON
  schema so agents/tooling can introspect instead of guessing.
- **Streaming (reserved).** No v1 command is long-running, but the
  envelope reserves NDJSON progress events (final result = last line)
  for any future op that streams `Progress`.
- **Errors are data.** Non-zero exit + a single JSON error object on
  stderr (`{ code, message }` — the existing `CmdError` shape). Stable
  exit codes per error class.
- **No pager, no locale, no terminal detection surprises.** `--json`
  output is byte-identical whether piped or not.

Why this beats `git diff` for an agent, concretely:

- `--full-context` returns the **whole file** with hunk offsets, not
  3-line fragments — the agent sees the code it's editing in context
  (same data Strand's review view uses).
- One `strand status --snapshot` call replaces 4–5 git invocations
  (status + branch + ahead/behind + recent log) — fewer subprocess round
  trips, one coherent point-in-time view.
- Conflicts arrive as structured ours/theirs/base blobs per file instead
  of `ls-files -u` stage-number archaeology.
- Renames, binaries, and submodules are typed fields, not text
  conventions to regex.

## `strand <path>` — opening the app

The one GUI-coupled mode:

- App running → forward the path to the existing instance and focus it.
  Requires **`tauri-plugin-single-instance`** (not currently wired into
  `strand-tauri` — prerequisite task) so a second launch hands its args
  to the first and exits.
- App not running → launch it with the path as argv (macOS:
  `open -a Strand --args <path>`; Linux/Windows: exec the app binary).
- `strand <path> --review [--since <ref>]` may later deep-link straight
  into the review view; v1 just opens the repo.

## Distribution

- The binary ships **inside the app bundle**; a Settings action installs
  a symlink/shim on `PATH` (the VS Code `code`-command pattern). The app
  and its CLI version together — no skew.
- The same artifact is what the remote-SSH bootstrap uploads as
  `strandd`. One build matrix, one signing/notarization story, one hash
  manifest (see [`remote-ssh.md`](./remote-ssh.md) §Bootstrap).
- Standalone download also published per release for headless boxes
  (agents need the CLI where the GUI will never be installed).

## Performance

- Data commands link `strand-ops` in-process: no daemon spawn, no socket
  handshake. Cold-start budget ≈ binary exec + repo open; gix mmaps the
  odb, so `strand status` on a warm repo should land well under 100 ms —
  measure against PRD §8 and `docs/perf-baseline.md` when work starts.
- `--snapshot` exists precisely so agent loops don't pay N process
  spawns for one logical question.

## What 1.0 must not break

Same guardrail as the remote-SSH design, plus one:

- Everything flows through the op layer that becomes `strand-ops`
  (`commands.rs` stays thin, `strand-core` stays UI-agnostic).
- **Treat the IPC serde types as a public contract in waiting.** Renames
  and shape changes are free today; after the CLI ships they're breaking
  changes for every script and agent harness built on `--json`. Prefer
  additive evolution already.

## Open questions (resolve when work starts)

- Crate layout: `strand-cli` as a thin clap front-end over `strand-ops`,
  or a `bin` target inside the daemon crate? (Likely: one
  `strand-headless` crate with `cli` + `stdio` entry modes.)
- ~~Terminal diff rendering~~ **Resolved (2026-06-12): Rust-native.**
  OpenTUI / `@pierre/diffs` were considered and rejected for in-process
  use: both are TS (embedding a JS runtime breaks the single static
  binary and puts a runtime on the daemon's remote attack surface), and
  Pierre renders to the DOM, not terminal cells — no reuse without a
  rewrite. Instead: `syntect` highlighting + truecolor ANSI streamed
  through a pager (the `delta` model), themed by porting `tokens.css`
  to a terminal palette so CLI diffs visually match the app. Pierre
  stays webview-only. An interactive TUI mode, if ever wanted, is
  `ratatui` — or an *external* OpenTUI tool consuming
  `strand diff --json --full-context`; the JSON contract exists so rich
  frontends can be built without touching the binary.
- Windows shim details (`strand.cmd` vs symlink; PATH installer UX).
