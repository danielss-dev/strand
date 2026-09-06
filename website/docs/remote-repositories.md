# Repositories over SSH

Use **Open repository on SSH host…** in the command palette or the **SSH** topbar button
to inspect a repository on another machine. This first version is read only:
Git and file reads run on that host, and the inspector shows its address and
connection state throughout. Your local repository stays open behind it.

## Prepare the host

Configure a host alias in your normal OpenSSH config. Use your terminal to
verify its host key and authenticate first. Strand uses system OpenSSH with
strict host-key checking and noninteractive authentication, including your SSH
agent and configured jump hosts. It does not ask for or save private keys or
passwords. Unknown or changed host keys and interactive login requirements
appear as connection errors; resolve them in your terminal.

Install a compatible Strand companion on the host as `~/.strand/bin/strand`.
Automatic installation and standalone host downloads are still planned. For
now, build the companion from the same Strand source on a supported POSIX host:

```sh
cargo build --release -p strand-headless
mkdir -p ~/.strand/bin
install -m 755 target/release/strand-cli ~/.strand/bin/strand
```

The host also needs Git on its PATH. The companion uses `--stdio` for its
connection to Strand; protocol compatibility is checked before any repository
read. Windows SSH hosts are not supported by this first connection flow.

## Connect and inspect

Enter an address such as `ssh://devbox/home/me/project` and select **Connect**.
Put the user, port and jump-host configuration in the host alias, rather than
in the address. Successful addresses appear as suggestions on later visits.

Choose a view:

- **Status** shows working-tree and index changes separately for the selected file.
- **Changes since HEAD** displays a full-context diff against the checked-out commit.
- **Recent history** shows the latest 50 commits reachable from HEAD.
- **Review since…** compares against your chosen revision, resolved to a fixed
  commit for that read. Refresh if HEAD changes during the review.
- **Files** previews working-tree files in 64 KiB chunks, up to 1 MiB. Use
  **Reload file** for a fresh snapshot; appending fails if the file changed.

Filter the file list to narrow large repositories. Tab moves between controls,
arrow keys select files and views, and Escape closes the inspector. The divider
resizes the list and inspection pane. Remote inspection has no stage, commit,
push, editor or terminal actions. Local repository shortcuts are suspended
while the inspector is open.

## Connection changes

File watching refreshes repository status and the active diff/history view.
The **Refresh** button requests a new read. An interrupted connection retries
reads twice with a short delay; a final failure remains visible. Use
**Reconnect now** after fixing authentication, a missing/incompatible companion,
or an unavailable host. No failed operation is saved for later execution.

**Disconnect**, **Cancel connection**, or closing the inspector stops the SSH
connection and all of its reads. If a snapshot remains visible, it is marked
disconnected. Local repositories continue to work during an SSH failure.
