# Remote repos over SSH — feature design

Status (2026-09-06): **F17 read-only foundation implemented locally**.
`strand-cli --stdio` serves the versioned `strand-ops` allowlist. The desktop's
**SSH repositories** inspector connects through system OpenSSH and displays
status, history, full-context changes/reviews, and bounded file previews. Local
repository commands stay in process; remote identities are rejected by local
`Repo::discover`. Remote inspection has separate state and no mutation controls.

The host must currently have a compatible companion installed at
`~/.strand/bin/strand`. Automatic SFTP installation, signed host-artifact
manifests, the Linux/macOS release matrix, host discovery/directory browsing,
ordinary remote tabs and remote writes remain open. The sections below record
the broader target design; they are not claims about the current inspector.
See [the user guide](../website/docs/remote-repositories.md) for today's setup.

## Implemented protocol and limits

- `ssh://HOST-ALIAS/absolute/path` identifies the repository; configure user,
  port and jump hosts in OpenSSH config. Paths travel in JSON on stdin, never
  in a shell command. Only the fixed `exec "$HOME/.strand/bin/strand" --stdio`
  command executes remotely. `BatchMode=yes` and `StrictHostKeyChecking=yes`
  keep authentication and host-key enrollment in the terminal.
- JSON-RPC 2.0 uses increasing integer IDs, newline-delimited UTF-8 frames and
  an 8 MiB frame limit. Protocol 1 negotiates schema 1 and read/watch/file-chunk
  capabilities. Unknown methods/fields, malformed frames and unknown response
  IDs fail closed. `hello`, `read`, `watch`, `unwatch` and `cancel` are the only
  methods; read operations share the CLI's typed schema.
- The daemon permits four concurrent reads, sixteen repository watches and
  eight queued output frames. Watch events debounce at 400 ms and coalesce on
  a 200 ms notifier; a full queue preserves a trailing notification. File reads
  are at most 64 KiB with an offset and metadata version token. A changed token
  rejects appending to an old preview; these are not atomic disk snapshots.
- The desktop permits sixteen hosts, sixteen pending requests per connection
  and thirty-two IPC reads overall. Reads retry connection failures twice
  (250 ms, then 1 s). Handshake/read/diff deadlines are 15/30/60 seconds;
  timeout or cancellation kills the SSH process tree and fails every pending
  read on that host. Cancellation does not interrupt another host or a local
  operation. No write queue or write replay exists.
- EOF ends the daemon and its watchers. Daemon-side cancellation retains the
  worker slot until the native read returns; desktop cancellation tears down
  the connection for prompt interruption. Diagnostics retain at most 16 KiB;
  a peer emitting more than 64 KiB of stderr is stopped.
- The inspector keeps a single diff mounted, shows at most 500 matching file
  names (filter to narrow), and caps file previews at 1 MiB. Watch refreshes
  coalesce with a trailing read and reject stale generations. Closing the
  inspector cancels reads and disconnects; successful remote addresses alone
  are saved as recents. Disconnect leaves a visibly stale snapshot.

## Why

A growing share of Strand's target users run coding agents on a remote
machine (devbox, VPS, cloud sandbox) and connect over SSH. Their repos —
and the worktrees their agents churn through — live on that machine. Today
they either sync files locally or fall back to terminal git. Strand should
open a repo *on the remote machine* and feel local: same views, same
keyboard model, same review flow, with the git engine executing where the
repo actually lives.

This pairs directly with the AI-change-review primary use case: the agent
works remotely, the human reviews from their own machine.

## Decision

**Remote headless engine** (the VS Code Remote-SSH model): ship a small
headless binary — working name **`strandd`** — that wraps `strand-core`
behind a JSON-RPC-over-stdio server. Strand connects by spawning
`ssh <host> ~/.strand/bin/strandd --stdio` and multiplexes all engine
calls for that host over the one long-lived channel. Git operations run at
native speed against the remote disk (gix/git2 unchanged); only serialized
results cross the wire — one network round trip per operation.

### Rejected alternatives

- **Shelling out to `git` over SSH** (`ssh host git -C /repo status
  --porcelain=v2`): forks the engine — a parallel plumbing-parsing layer
  next to gix/git2 — loses file watching entirely, and pays an SSH exec
  per operation. Permanent maintenance tax for a worse result.
- **SSHFS / network mount**: zero code, but gix does many small reads; a
  status over a network filesystem takes seconds, not milliseconds.
  Violates the prime directive. Document it as a "works today" workaround,
  nothing more.

## Architecture

### The seam already exists

Every engine op crosses a serialization boundary today: the UI calls a
typed wrapper in `ui/src/lib/tauri.ts`, which invokes a
`#[tauri::command]` in `crates/strand-tauri/src/commands.rs` (~81
commands, serde types both directions), keyed by an opaque
`path: string`. The plan exploits that:

- **Addressing.** A remote repo is addressed as
  `ssh://<host-alias>/abs/path/to/repo` flowing through the *existing*
  `path` parameter. The frontend, Zustand stores, tabs, and recents
  already treat the path as an opaque key, so they barely change.
- **Routing.** A transport layer in `strand-tauri` inspects the path:
  plain paths dispatch in-process exactly as today (zero overhead on the
  local hot path — no extra serialization, no indirection cost); `ssh://`
  paths serialize the same serde types as JSON-RPC frames over the host's
  stdio channel.
- **Shared op surface.** Extract the command handlers from `strand-tauri`
  into a transport-agnostic crate (working name `strand-ops`) consumed by
  both the Tauri shell and `strandd`. One implementation, two transports.

### Streaming and watching

- **Progress.** Network commands already stream `Progress` over a Tauri
  `Channel`; remotely these become notification frames on the same stdio
  stream, re-emitted locally as channel messages. Frontend unchanged.
- **File watching.** `strand-core/src/watch.rs` (notify) runs *inside
  `strandd`* on the remote machine; change events stream back as
  notifications and a thin adapter re-emits them as Tauri events. The
  frontend's refresh logic is untouched. Debounce on the remote side so
  agent-driven write storms don't flood the link.

### Connection lifecycle

1. **Connect.** Spawn the system `ssh` binary (see Security) with
   keepalives; probe for `~/.strand/bin/strandd` and its version.
2. **Bootstrap.** If missing or version-mismatched, upload the right
   binary (static musl for Linux x86_64/aarch64, darwin builds) over SFTP
   to `~/.strand/bin/`, verify its SHA-256 against the manifest baked into
   the app, `chmod +x`, exec. Never run a binary whose hash doesn't match.
3. **Handshake.** Versioned hello (protocol version, strandd version,
   capabilities). Mismatch → re-bootstrap or fail loudly; never limp along
   on a mismatched protocol.
4. **Multiplex.** All repos on that host share the one connection.
   Requests carry ids; responses and notifications interleave.
5. **Reconnect.** On drop: automatic reconnect with exponential backoff,
   connection state surfaced in the UI (topbar indicator + toast). Reads
   retry transparently after reconnect. **Writes never auto-retry** — if
   the link died mid-write, re-query state first and let the user confirm;
   an op that may have landed must not be replayed blind.

## Security model

Hard rules, in priority order:

1. **Strand never handles credentials.** Authentication is delegated
   entirely to the system `ssh` binary, which inherits `~/.ssh/config`,
   `known_hosts`, ssh-agent, hardware keys, 2FA prompts, and `ProxyJump`.
   No passwords, passphrases, or keys are ever read, stored, or proxied by
   Strand. This is also why we shell out instead of embedding a Rust SSH
   library: OpenSSH's auth surface and config semantics are battle-tested
   and already trusted by the user.
2. **Host verification is OpenSSH's.** Unknown or changed host keys
   surface OpenSSH's own prompt/error verbatim in the connect UI. Strand
   never passes `StrictHostKeyChecking=no` or auto-accepts a key.
3. **`strandd` listens on nothing.** Stdio only — no TCP port, no unix
   socket, no remote attack surface beyond the SSH session itself. It runs
   as the SSH user with that user's permissions, nothing more.
4. **Binary provenance.** Uploaded `strandd` binaries are
   checksum-verified before first exec (hash manifest ships inside the
   signed Strand app bundle). The remote side is treated as
   untrusted-until-verified in both directions: malformed or oversized
   frames from the daemon are dropped and the connection is torn down.
5. **Protocol hygiene.** Versioned handshake, per-frame size limits,
   strict serde (`deny_unknown_fields` on the wire types), no dynamic
   code paths driven by remote input.

## Stability model

- One long-lived SSH process per host, `ServerAliveInterval`-style
  keepalives, exponential-backoff reconnect (see lifecycle above).
- Request timeouts per op class (status vs clone differ by orders of
  magnitude); a hung daemon is killed and re-spawned rather than wedging
  the UI.
- The UI must stay responsive with a dead link: remote tabs show a
  disconnected state and queue nothing; local repos are completely
  unaffected (separate transport, no shared locks).
- Connection health is observable: indicator in the topbar, last-error
  detail in a tooltip/palette entry, manual "reconnect now" action.

## What doesn't translate

Some ops are meaningless or different against a remote path. The handshake
advertises **capability flags** and the UI hides or remaps accordingly:

- `external.rs` (open in editor, reveal in Finder, open terminal): hidden
  for remote repos in v1 of the feature. Possible later: "open in
  terminal" → spawn `ssh -t <host>` in the user's terminal.
- File pickers (clone destination, repo open): need a remote
  directory-listing op and a minimal remote dir browser; the native OS
  dialog can't browse the remote filesystem.
- Drag-and-drop of files from the OS: local-only by nature.

## Performance

PRD §8 targets assume local disk; over SSH every op costs +1 RTT. LAN is
invisible; WAN needs care:

- Lean on the existing snapshot pattern — batch round trips, don't chat.
- Watcher-driven refreshes coalesce remote-side before crossing the wire.
- Diff/blame payloads are already serialized for IPC; same shapes, just
  bigger latency. Consider gzip on frames above a size threshold.
- The local hot path must not regress at all: routing dispatches
  in-process for plain paths with no added serialization.

## What 1.0 must not break

Pre-1.0 discipline that keeps this feature cheap later (this is the
actionable part today):

- Keep **every** engine call flowing through `tauri.ts` → `commands.rs`.
  No side-channel filesystem access from the frontend.
- Treat the repo path as an **opaque key** in the frontend — never parse,
  join, or assume local-filesystem semantics on it in UI code.
- Keep `strand-core` UI-agnostic and `commands.rs` thin, so the
  `strand-ops` extraction stays mechanical.
- New ops that touch the local OS (dialogs, shell-outs, reveal-in-Finder)
  stay in clearly separated modules (`external.rs` pattern) so capability
  flags can fence them later.

## Open questions (resolve when work starts)

- Host management UX: reuse `~/.ssh/config` aliases as the host list, or
  keep a Strand-side host registry (likely: read aliases, no registry)?
- Windows local side: spawn `ssh.exe` (ships with Windows 10+) — verify
  config/agent parity. Windows as the *remote* side: out of scope v1.
- `strandd` release channel: same updater manifest as the app, or pinned
  per app version (likely: pinned, app carries its matching daemon)?
- Auth edge: interactive prompts (2FA, passphrase) need a PTY — decide
  between `ssh` in a hidden PTY with prompt forwarding vs requiring
  agent-based auth in v1 (likely: agent-based only in v1, fail with a
  clear message).
