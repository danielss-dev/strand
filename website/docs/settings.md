# Settings

Open the Settings dialog with `Mod+,`, the gear button in the status bar, or the command palette ("Settings…"). The dialog has nine sections — Appearance, Diff, Keyboard, Git, Hosting, Integrations, AI, Updates, and Privacy. Most changes apply live; git identity and Azure DevOps Server profiles have explicit save actions.

The sidebar is a keyboard-navigable list: `↑`/`↓` move between sections, `Home`/`End` jump to the first or last, and `Escape` closes the dialog.

## Appearance

- **Theme** — System ("Match the OS appearance"), Light ("Warm cream"), or Dark ("Warm charcoal"), shown as cards with live swatches. The default is System. `Mod+Shift+T` toggles between light and dark from anywhere (it skips System), and the palette has "Theme: Light / Dark / System" entries.
- **Accent** — eight color dots: Amber (default), Rose, Magenta, Violet, Blue, Cyan, Teal, and Green. The accent recolors the whole app live and works in both themes.
- **Start in** — choose which repository space opens after launch: Work (default), Local Changes, Review, Pull Requests, or All Commits.
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

Rebindable defaults include the command palette (`Mod+K`), views `Mod+1`–`Mod+7`, push/pull/fetch/sync, the theme toggle, the repo switcher (`Mod+E`), and the AI commit-message suggestion (`Mod+Shift+M`). The full table lives in [Keyboard and palette](keyboard-and-palette.md).

Below the rebindable list, a **Context shortcuts** card documents the fixed, surface-local keys — things like `F6` to focus Work tabs, `Mod+Enter` to commit from the message box, `Mod+F` to search within the current file or diff, `/` to search commits, and `j`/`k` to step files in the Review queue and Local Changes. These are not rebindable; the card is a reference so you can look them up without leaving Settings.

## Git

- **Global identity** — Name and Email inputs written to your global git config (`~/.gitconfig`) with an explicit **Save identity** button. This is the author identity for new commits everywhere, not just in Strand.
- **Default clone & open folder** — a path with **Choose…** and **Clear** buttons. This is where the clone dialog and the open-repository picker start.

Everything else about git — credentials, SSH keys, commit signing — is inherited from your existing git setup: network operations (push, pull, fetch, clone) go through your system `git`, and when `commit.gpgSign` is on, commits do too — picking up your signing config and running your `pre-commit` / `commit-msg` hooks, just like plain `git commit`. Unsigned commits (the default) are written in-process and do not run commit hooks. There is nothing to configure in Strand for those.

## Hosting

Hosting is organized into GitHub, Azure DevOps, and Azure DevOps Server
accordions. Each summary keeps its connection state visible while the details
are collapsed. GitHub shows the account returned by `gh`; Azure DevOps shows
the account returned by `az` and also requires the `azure-devops` extension.
Refresh reruns these bounded CLI checks. Strand does not read or store either
CLI's token.

Azure DevOps Server 2020+ support is optional. Turn on **On-premises pull
requests** to download the latest signed `strand-azdo` helper whose protocol is
compatible with this Strand version.
While the helper is being fetched and verified, the status row, install button,
and progress bar show that the download is still running.
The status row shows the installed helper and protocol versions; **Retry
installation** replaces it only after signature and SHA-256 verification.
Disabling keeps profiles and credentials. **Remove helper and credentials** is
confirmed separately and removes the binary, profiles, imported certificates,
and vault entries.

Each server profile has a display name and an HTTPS collection URL such as
`https://server/tfs/DefaultCollection`. For a standard on-prem HTTPS clone URL,
the collection field is optional: leave it blank and Strand derives and saves
the collection boundary from the active repository's preferred Git remote. If
no standard Server remote can be identified, Strand asks for the URL. It later
derives the project and repository from each repository's Git remote. No
per-repository project setting is required. Additional HTTPS/SSH prefixes are
optional for server aliases; the longest match wins and
ambiguous matches are rejected.
Cloud `dev.azure.com` and `visualstudio.com` addresses are not accepted here;
Azure DevOps Services continues to use `az`.

Choose **Personal access token** on macOS, Windows, or Linux. The PAT needs at
least Azure **Code: Read & write** scope and is stored only in Keychain,
Windows Credential Manager, or Linux Secret Service. It is never written to
Strand settings. A PEM CA certificate can be imported for a private PKI; Strand
copies and validates it rather than retaining the external path. If PAT login
fails, check its scope and expiry and make sure IIS Basic Authentication is
disabled, because enabling it prevents Azure DevOps Server PAT authentication.
On Windows, **Windows identity (Negotiate / NTLM)** uses the current login and
the Windows trusted-root store instead of a PAT or profile CA. Use **Test** on a
saved profile before opening its pull requests. The Server accordion is green
when the verified helper is installed and at least one profile has a stored PAT
or selects Windows authentication; this is configuration readiness, while
**Test** performs the actual server connection.

## Terminal

Configure Work's embedded terminals separately from external applications.

- **Default shell** — a global System default, platform preset, installed WSL
  distribution on Windows, or custom executable and arguments. The active
  repository can use **Use global** or save an override shared by its linked
  worktrees. **Check availability** resolves the executable without starting it.
- **Font / Font size** — choose the embedded terminal face and a size from
  10–32px. The preview updates immediately, as do open terminal renderers.
- The arrow beside Work's main New Terminal button creates one tab with a
  different native or WSL shell without changing either saved default.

## Integrations

- **External editor / Terminal** — configure the applications that Strand's
  "Open in editor" (`Mod+Shift+E`) and "Open in terminal" (`Mod+Shift+C`)
  actions launch, along with the matching topbar buttons and palette entries.
  Single-file context menus in Files, Local Changes, Review, and Workspace
  Review also use the editor setting and pass the right-clicked file directly.

- **External editor** — a dropdown of per-platform presets, None, or "Custom command…". Custom commands are templates with `{file}`, `{line}`, and `{dir}` placeholders, and a **Test** button lets you verify the command before relying on it.
- **Terminal** — the same style of picker; the template takes a `{dir}` placeholder and opens the repository folder.

## AI

Strand can suggest a commit message from staged changes, or all unstaged changes
when nothing is staged, and draft pull-request text from committed branch
changes. It has no API key of its own — suggestions run through a CLI you
already have, on your own subscription. Auth and billing stay entirely in the
vendor's CLI; Strand only orchestrates it.

- **Provider** — choose OpenAI (default) or Anthropic. The account card below
  shows only the selected provider's CLI path, sign-in, sign-out, and status
  controls.
- **Model** — choose the selected provider's writing model. Strand remembers
  one choice per provider and uses it for both commit-message suggestions and
  pull-request drafts. The performance-first defaults remain `gpt-5.6-luna`
  and `claude-sonnet-5`.
- **Provider account** — optionally override the selected provider's CLI path
  (leave empty to use `codex` or `claude` on PATH), sign in or out, and check
  whether the CLI is missing, signed out, signed in, or unable to run. Strand
  remembers the last checked connection indicator, so returning to Settings
  still shows **Connected**. Credentials remain stored only by the vendor CLI;
  **Refresh status** checks that external session again.
- **Repository writing profile** — up to 1,000 characters of optional style,
  terminology, or audience guidance for the active repository family. Linked
  worktrees share the profile through their canonical `common_dir`; an empty
  profile uses recent commit subjects only.

In a packaged desktop build, PATH is recovered from the interactive login shell
on macOS/Linux and from the persisted user and machine environment on Windows,
then merged with the environment inherited at launch. This finds Homebrew,
local-bin, npm, WinGet, and version-manager installs and also supplies runtime
commands such as `node` to npm-installed CLIs. Restart Strand after changing
shell startup files or installing a CLI; use the custom path only when you need
to override automatic resolution.

To get a commit suggestion, stage some changes and press the sparkle button next
to the commit subject field in Local Changes, use `Mod+Shift+M`, or run "Suggest
commit message" from the palette. To draft a PR, use **Fill with Codex/Claude
Code** in the Create PR dialog. If the CLI isn't installed or you aren't signed
in, the action stays clickable and the hint appears inline. Sign-in starts the
provider's browser or CLI flow, and once you complete it you run the action
again. If a CLI launcher is present but its packaged executable is broken,
Strand keeps that distinct from “signed out” and shows a repair hint beside the
form rather than claiming that sign-in opened. Generation failures use concise
hints for recognized provider limits, model problems, timeouts, and connection
errors. Strand never displays a raw vendor CLI session transcript because it
can contain the prompt, repository paths, and patch content.

Strand never runs an automatic provider-status subprocess from Local Changes.
Provider checks remain explicit here. Writing generation is user-initiated,
uses bounded local context, and does not add Strand telemetry or persist prompts,
outputs, or sensitive classifications.

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
