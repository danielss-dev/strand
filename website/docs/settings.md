# Settings

Open the Settings dialog with `Mod+,`, the gear button in the status bar, or the command palette ("Settings…"). The dialog has eight sections — Appearance, Diff, Keyboard, Git, Integrations, AI, Updates, and Privacy — and every change applies live; there is no Save button (the one exception is the git identity, which has an explicit save).

The sidebar is a keyboard-navigable list: `↑`/`↓` move between sections, `Home`/`End` jump to the first or last, and `Escape` closes the dialog.

## Appearance

- **Theme** — System ("Match the OS appearance"), Light ("Warm cream"), or Dark ("Warm charcoal"), shown as cards with live swatches. The default is System. `Mod+Shift+T` toggles between light and dark from anywhere (it skips System), and the palette has "Theme: Light / Dark / System" entries.
- **Accent** — eight color dots: Amber (default), Rose, Magenta, Violet, Blue, Cyan, Teal, and Green. The accent recolors the whole app live and works in both themes.
- **Open repositories** — Sidebar or Tabs: show open repositories as a vertical icon rail or as a horizontal tab strip in the toolbar. The default is Tabs. See [Repositories and workspaces](repositories-and-workspaces.md).
- **Density** — Compact, Default, or Relaxed spacing.
- **UI font** — Geist (default), Inter, IBM Plex Sans, or System.
- **Mono font** — JetBrains Mono (default), Geist Mono, IBM Plex Mono, Commit Mono, or SF Mono / system.
- **Open files on** — Preview or Source: which tab the file view opens on for renderable files (SVG, Markdown). The default is Preview.

## Diff

Diff options come with a live preview — a sample diff at the bottom of the section re-renders as you change settings.

- **Default layout** — Stacked or Split. This is the default for repositories that haven't picked their own layout; each repository can override it with the toggle in the diff-pane header, and that per-repo choice is remembered.
- **Diff font** — "Same as mono font" (default) or any of the mono fonts.
- **Change indicators** — `+ / −` classic markers, Bars (default), or None.
- **Line numbers** — checkbox, on by default.
- **Highlight changed words** — checkbox, on by default. Emphasizes the changed part of a line, not just the line.

## Keyboard

Every global shortcut in Strand is rebindable here. Shortcuts are grouped by category — General, Navigation, Git, Repository, Appearance — and each row shows the command label with its current binding.

- **Rebind** — click the binding chip; it switches to "Press keys…" and records the next combination you press. `Escape` cancels the recording.
- **Unassign** — the × button removes a binding entirely.
- **Reset** — each row has a reset-to-default button, and a **Restore defaults** button at the top resets everything.
- **Conflicts** — if two commands end up on the same combination, both are flagged "Shared with another command" so you can resolve it.

Rebindable defaults include the command palette (`Mod+K`), views `Mod+1`–`Mod+6`, push/pull/fetch/sync, the theme toggle, the repo switcher (`Mod+E`), and the AI commit-message suggestion (`Mod+Shift+M`). The full table lives in [Keyboard and palette](keyboard-and-palette.md).

Below the rebindable list, a **Context shortcuts** card documents the fixed, surface-local keys — things like `Mod+Enter` to commit from the message box, `Mod+F` to search within the current file or diff, `/` to search commits, and `j`/`k` to step files in the Review queue and Local Changes. These are not rebindable; the card is a reference so you can look them up without leaving Settings.

## Git

- **Global identity** — Name and Email inputs written to your global git config (`~/.gitconfig`) with an explicit **Save identity** button. This is the author identity for new commits everywhere, not just in Strand.
- **Default clone & open folder** — a path with **Choose…** and **Clear** buttons. This is where the clone dialog and the open-repository picker start.

Everything else about git — credentials, SSH keys, commit signing — is inherited from your existing git setup: network operations (push, pull, fetch, clone) go through your system `git`, and when `commit.gpgSign` is on, commits do too — picking up your signing config and running your `pre-commit` / `commit-msg` hooks, just like plain `git commit`. Unsigned commits (the default) are written in-process and do not run commit hooks. There is nothing to configure in Strand for those.

## Integrations

Configure the external editor and terminal that Strand's "Open in editor" (`Mod+Shift+E`) and "Open in terminal" (`Mod+Shift+C`) actions use, along with the matching topbar buttons and palette entries.

- **External editor** — a dropdown of per-platform presets, None, or "Custom command…". Custom commands are templates with `{file}`, `{line}`, and `{dir}` placeholders, and a **Test** button lets you verify the command before relying on it.
- **Terminal** — the same style of picker; the template takes a `{dir}` placeholder and opens the repository folder.

## AI

Strand can suggest a commit message from staged changes, or all unstaged changes
when nothing is staged, and draft pull-request text from committed branch
changes. It has no API key of its own — suggestions run through a CLI you
already have, on your own subscription. Auth and billing stay entirely in the
vendor's CLI; Strand only orchestrates it.

- **AI writing provider** — "OpenAI (ChatGPT subscription)" (default), which uses your ChatGPT subscription via the Codex CLI (`gpt-5.6-luna`), or "Anthropic (Claude Code CLI)", which uses the Claude Code CLI (`claude-sonnet-5`). These fixed, focused models keep short commit-message and PR-draft requests responsive rather than inheriting your coding CLI's default model.
- **Codex CLI** — an optional custom path (leave empty to use `codex` on PATH), a status line, and **Sign in with ChatGPT** / **Sign out** buttons.
- **Claude Code CLI** — an optional custom path (leave empty to use `claude` on PATH), a status line, and **Sign in to Claude Code** / **Sign out** buttons.
- **Check CLI status** — checks both CLIs and reports whether each is missing,
  signed out, signed in, or installed but unable to run.

To get a commit suggestion, stage some changes and press the sparkle button next
to the commit subject field in Local Changes, use `Mod+Shift+M`, or run "Suggest
commit message" from the palette. To draft a PR, use **Fill with Codex/Claude
Code** in the Create PR dialog. If the CLI isn't installed or you aren't signed
in, the action stays clickable and the hint appears inline. Sign-in starts the
provider's browser or CLI flow, and once you complete it you run the action
again. If a CLI launcher is present but its packaged executable is broken,
Strand keeps that distinct from “signed out” and shows a repair hint beside the
form rather than claiming that sign-in opened.

## Updates

- **Version** — shows the current version with a state-dependent action: **Check for updates**, **Download & install** (with a progress bar), or **Restart now**. Release notes are shown when available.
- **Automatic updates** — "Check for updates on launch" (on by default) and "Download and install automatically" (off by default). Updates always apply on the next restart; Strand never restarts itself.

The in-app updater covers the macOS app, the Windows MSI install, and the Linux AppImage; `.deb` and `.rpm` installs are not covered — update them by downloading the new release from GitHub Releases.

## Privacy

Strand has no telemetry. The only reporting mechanism is crash reports, and those are opt-in and user-mediated:

- **Offer to report crashes on launch** — off by default. When enabled and Strand crashed last time, a toast offers to report it; reporting opens a pre-filled GitHub issue in your browser, which you review and submit yourself. Nothing is ever uploaded automatically.
- **Report last crash…** — manually start that flow for the most recent crash (disabled when the crash log is empty).

Crashes are always logged locally regardless of the toggle; the section shows the crash-log path and notes that logs can include repository paths, so you can review before sharing.

---

All settings persist across launches, along with the rest of your session — open tabs, pane sizes, per-repo diff layouts, and workspaces. For the full shortcut reference, see [Keyboard and palette](keyboard-and-palette.md).
