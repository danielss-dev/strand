# F16 / F17 foundation verification — 2026-09-06

Scope: a bundled launcher, versioned read-only CLI and shared SSH inspection
foundation. No remote mutation APIs or generic command execution were added.

## Implementation stages

1. `1a35103`: bundled `strand-cli`, user `strand` installation, desktop locator
   and bounded single-instance repository handoff after session restoration.
2. `207a1f4`: `strand-ops`, schema-v1 status/log/diff/review commands, stable
   machine errors, bounded encoding and shared desktop read types.
3. SSH foundation: the same binary's `--stdio` protocol, native system-SSH
   manager and isolated read-only inspector. See [remote-ssh.md](./remote-ssh.md)
   for limits and [the user guide](../website/docs/remote-repositories.md) for
   the current manual setup.

## Automated regression coverage

- CLI integration tests exercise status/snapshot, history, diff sources and
  review; binary and half-staged files; unborn repositories and linked
  worktrees; deterministic errors; and byte-for-byte repository preservation.
- Protocol tests reject unknown read fields, incomplete/oversized frames and
  invalid remote identities. A regression preserves successful JSON-RPC
  `result: null` while rejecting a null error object.
- Daemon process tests cover handshake mismatch, disallowed methods, multiplexed
  IDs, chunks and changed-file tokens, traversal rejection, watcher bursts,
  cancellation, duplicate IDs and EOF teardown.
- Desktop transport tests launch a dependency-free compiled peer. They cover
  concurrent requests, null results, malformed/oversized/truncated frames,
  unknown response IDs, excessive diagnostics, EOF, timeout, cancellation and
  liveness changes during request registration. Pending reads drain and child
  processes exit; dropping the owner does not retain the session in a cycle.
- Six UI store tests cover subscribing before the first snapshot, canonical
  identity and recents, watch-burst coalescing, stale response rejection after
  close/host switch, bounded idle reconnection and recovery from a bad revision.

The TypeScript check and full frontend suite passed: **76 files / 431 tests**.
`cargo check -p strand-core -p strand-tauri` and clippy with warnings denied
passed. The full native run passed **162 core, 121 desktop and 11 companion/ops
tests**. The frontend production build and normal desktop build (without the
verification CDP override) also passed. Vite retained its existing large-chunk
and mixed-import warnings.

## Windows desktop and system-SSH verification

The repository's `verify` workflow drove an isolated WebView2 profile and app
identifier through CDP. The tracked Tauri configuration was not edited. Tests
used temporary repositories and only this task's processes.

Launcher checks covered a cold startup request, delivery to an already-running
instance, a path containing spaces, the Settings/palette install flow and the
installed command. The temporary command and Windows PATH change were restored.

For SSH, Windows system OpenSSH connected to an isolated localhost SSH server
using generated test keys, a pinned known-host entry and a temporary SSH alias.
The server launched the native Windows companion. A test-only bridge translated
the fixture's POSIX identity to its Windows disk path and back. This validates
the actual desktop/SSH/daemon channel, but is **not native Linux/macOS host
evidence**. The temporary SSH configuration was removed and its original bytes
verified afterward.

The app pass verified:

- Connection and canonical repository identity, with remote execution context.
- A full-context diff rendered by the shared Pierre component.
- Two 64 KiB file reads, rejection of a stale append, and explicit reload.
- Recent history and review with a pinned base OID.
- A burst of writes updating the final content of an already-modified file.
- Automatic reconnect and watcher restoration after an idle connection loss.
- Visible failure for malformed peer output, while local status still worked
  (8.3 ms in this small debug fixture; not a PRD performance benchmark).
- Cancellation of a hung handshake, changed-host-key rejection before remote
  execution, and recovery after restoring the expected host key.
- Suppressed local view shortcuts inside the inspector, Escape closing and
  disconnecting, and local navigation afterward.
- Byte-for-byte preservation of every fixture `.git` file across inspection.

## Remaining acceptance work

- Native macOS/Linux launcher installation and native POSIX SSH host passes.
- Standalone/static host builds, signed hash manifest, SFTP bootstrap and repair.
- Host-alias discovery, remote directory browsing and ordinary remote tabs.
- Expanded CLI blame/conflict commands and syntax-colored pager output.
- Large-repository/long-WAN performance measurement. This change keeps local
  reads in process and bounds transport/UI work, but does not certify PRD §8.

These remain open in TASKS and ROADMAP; the wider June design is not declared
complete by this foundation.
