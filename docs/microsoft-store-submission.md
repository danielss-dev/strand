# Microsoft Store submission

This is the source of truth for Strand's Microsoft Store listing and candidate
package. It follows Microsoft's MSI/EXE submission route because Tauri 2
produces MSI/EXE installers, not a native MSIX package.

## Before opening the submission

- Reserve **Strand** as an **EXE or MSI app** in Partner Center. The repository
  identifier `dev.danielss.strand` does not reserve a Store identity.
- Confirm the Partner Center publisher name and the Authenticode certificate
  subject with the owner. The Store build currently uses
  **Daniel Schwarz Campos** as the MSI publisher; change it before certification
  if the verified Partner Center identity differs.
- Complete owner/counsel review of the open Strand trademark gate and approve
  the factual privacy notice and user-content guidelines at
  `https://strand.danielss.dev/docs/?page=privacy` and
  `https://strand.danielss.dev/docs/?page=content-guidelines`.
- Add `WINDOWS_CERTIFICATE_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD` as GitHub
  Actions secrets. The certificate must include its private key and chain to a
  CA in the Microsoft Trusted Root Program. The existing
  `TAURI_SIGNING_PRIVATE_KEY` secrets remain required for Strand's updater.

## Build and package

Run the **Microsoft Store candidate** workflow with an existing version tag.
The workflow:

1. checks out and version-checks the exact tag;
2. validates Strand's release and Store policies;
3. imports the publisher certificate;
4. builds an x64 MSI with the silent offline WebView2 installer;
5. requires valid, timestamped Authenticode signatures on both `strand.exe`
   and the MSI;
6. verifies the Tauri updater signature against embedded key
   `84FCBFD2A981CE5D`; and
7. uploads a workflow artifact named
   `Strand_<version>_x64_en-US_store.msi`.

Select `publish_asset` only after those checks pass. It attaches the immutable
Store MSI to the matching GitHub release, producing this versioned HTTPS URL:

```text
https://github.com/danielss-dev/strand/releases/download/v<version>/Strand_<version>_x64_en-US_store.msi
```

Do not replace the bytes at a submitted URL. Publish a new versioned asset and
update the Partner Center submission.

Before certification, install the workflow artifact on a clean Windows 11 x64
machine through:

```powershell
msiexec.exe /i .\Strand_<version>_x64_en-US_store.msi /qn /norestart
```

Verify launch, repository open/clone, update, uninstall, and absence of a
WebView2 download during installation. Then run Microsoft Defender over the
MSI and installed directory. The Store supplies `/qn` for MSI packages.

## Partner Center fields

### Availability

- Markets: choose only after trademark/legal approval. Do not silently default
  to every market while that gate is open.
- Discoverability: **Available through link** for the first certification
  flight; switch to **Available in Microsoft Store** only after the clean
  install/update/uninstall pass.
- Pricing: **Free**. Strand has no feature gates or license-key purchase in the
  app. Organizations remain responsible for complying with AGPL-3.0 or
  obtaining the separately offered commercial license.
- Free trial: not applicable.

### Properties

- Category: **Developer tools**
- Product accesses personal information: **Yes**. Strand can display local
  repository content and connected Git-host data, and an optional
  user-reviewed crash report can contain repository paths.
- Privacy policy:
  `https://strand.danielss.dev/docs/?page=privacy`
- Website: `https://strand.danielss.dev`
- Support: `https://github.com/danielss-dev/strand/issues`
- User-generated content guidelines:
  `https://strand.danielss.dev/docs/?page=content-guidelines`
- Non-Microsoft drivers or NT services: **No**
- Tested to meet accessibility guidelines: **Do not claim this yet.** Strand
  is keyboard-operable, but no external conformance audit is recorded.
- Pen and ink: **No**
- Minimum system: Windows 11, x64; keyboard or pointing device.

Certification notes:

```text
Strand is a local-first Git client. The x64 MSI is a standalone installer and
bundles Microsoft's offline WebView2 runtime; Partner Center may use the normal
/qn MSI switch. Strand installs no driver or NT service. It reads and writes
repositories only after the user opens or clones them. Network operations are
user initiated and delegated to system Git or the user's GitHub/Azure tooling.
The built-in updater checks the signed stable GitHub Releases channel. The app
has no product telemetry. Optional crash reporting opens a pre-filled GitHub
issue that the user reviews and submits. Optional live generative AI features
use the user's separately installed OpenAI Codex CLI or Claude Code CLI to
draft commit messages and pull-request text only after an explicit action.
Every draft is editable and is never committed or submitted automatically.
Inappropriate provider, user-generated, or generated content can be reported
from Settings > Privacy or the command palette. Reporting opens a pre-filled
GitHub issue that the user reviews and submits; nothing is sent automatically.
```

### Package

- URL:
  `https://github.com/danielss-dev/strand/releases/download/v<version>/Strand_<version>_x64_en-US_store.msi`
- Architecture: **x64**
- Language: **English (United States)**
- App type: **MSI**
- Silent install: Partner Center default **`/qn`**

The first submission is x64-only. Add a separately built and certified arm64
package rather than marking this MSI neutral.

### Age ratings

Answer the questionnaire in Partner Center. Strand itself contains no mature
content, advertising, gambling, or commerce. It can display user-controlled
repository files, commit messages, and pull-request content from connected
services; disclose that user-generated content capability rather than treating
the bundled UI as the only possible content.

## English (United States) listing

Product name:

```text
Strand
```

Short description:

```text
A fast, keyboard-first Git client for reviewing changes, shaping commits, and
working across repositories without losing context.
```

Description:

```text
Strand is a fast, friendly desktop Git client built for the way developers work
now: local changes, AI-assisted edits, pull requests, terminals, and repository
history in one focused workspace.

Review changes with whole-file context and syntax-aware diffs. Shape clean
commits with precise staging, history, blame, reflog, rebase, conflict, stash,
branch, tag, submodule, and worktree tools. Open GitHub and Azure DevOps pull
requests without leaving the app. Keep files and repository-scoped terminals
beside the diff you are reviewing.

Strand is local-first and performance-first. It has no product telemetry, no
account of its own, no feature gates, and no license-key prompts. Git
credentials, SSH agents, commit signing, hooks, and supported provider CLIs
remain under your existing system configuration.

Optional live generative AI can draft a commit message or pull-request text
through your separately installed OpenAI Codex CLI or Claude Code CLI. It runs
only when you ask, uses your provider account, produces an editable draft, and
never commits or submits the result automatically. Report inappropriate output
from **Settings → Privacy → Report inappropriate content…** or the command
palette. Strand opens a pre-filled GitHub issue that the user reviews and
submits; nothing is sent automatically.

Keyboard navigation and the command palette make the common path fast, while
every major action remains available to pointer users. Light, dark, density,
font, diff, integration, terminal, and AI-provider settings adapt the workspace
without turning it into a full IDE.

Strand is open source under AGPL-3.0 and free for individuals. Organizations
can comply with the AGPL or obtain the separately offered commercial license.
```

App features:

- Fast local repository status, history, and diff browsing
- Whole-file review queue for AI-assisted changes
- Precise stage, unstage, discard, and commit workflows
- GitHub and Azure DevOps pull-request review
- File editing and repository-scoped terminal tabs
- Branches, tags, stashes, reflog, worktrees, and submodules
- Interactive rebase and conflict-resolution surfaces
- Command palette and keyboard-first navigation
- Optional user-initiated AI drafts through Codex or Claude Code
- Light and dark themes with density and font controls
- No product telemetry or Strand account

Keywords:

```text
git
developer tools
code review
diff
repository
version control
pull requests
```

Applicable license terms:

```text
Strand is offered under the GNU Affero General Public License version 3.0.
The complete license text is available at
https://github.com/danielss-dev/strand/blob/main/LICENSE. Organizations that
do not wish to use Strand under AGPL-3.0 may obtain a separate commercial
license under the terms published at
https://github.com/danielss-dev/strand/blob/main/COMMERCIAL.md.
```

Copyright and trademark:

```text
Copyright © 2026 Daniel Schwarz. Strand name and marks are subject to the
owner's rights and the repository's pending trademark review.
```

Store logos:

- 1:1 box art source: `strand.png` (1254×1254)
- Windows package logo: `crates/strand-tauri/icons/StoreLogo.png` (50×50)

Fresh sanitized 2160×1380 candidate captures are checked in at:

1. `docs/store-assets/01-review.png`
2. `docs/store-assets/02-history.png`
3. `docs/store-assets/03-settings.png`
4. `docs/store-assets/04-work.png`

Recheck every image before submission for real credentials, private repository
names, tokens, email addresses, or terminal history.

## Final external gates

- [ ] Partner Center developer account is verified.
- [ ] **Strand** name is reserved as an MSI/EXE app.
- [ ] Publisher/certificate identity is approved and Actions secrets are set.
- [ ] Owner/counsel closes or explicitly accepts the trademark gate.
- [ ] Owner approves the privacy and license listing text.
- [ ] Signed Store workflow artifact passes clean install/update/uninstall.
- [ ] Final screenshots and Store box art contain no private data.
- [ ] Age-rating questionnaire is completed accurately.
- [ ] First submission is certified through link-only discoverability.
