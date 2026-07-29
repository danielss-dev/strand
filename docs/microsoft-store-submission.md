# Microsoft Store submission

This is the source of truth for Strand's Microsoft Store listing and candidate
package. The preferred route is an x64 MSIX packaged-classic desktop app.
Tauri 2 does not emit MSIX directly, so `scripts/build-msix.ps1` assembles the
release executable, manifest, and Store assets with Microsoft's MakeAppx tool.
The older MSI/EXE workflow remains available as a fallback, but it requires an
external CA-backed Windows code-signing certificate.

## Production identity

Strand is registered as Store product `9N0JG96LRC4W`. Its public manifest
identity, pinned by the Store workflow and MSIX policy check, is:

```text
Package/Identity/Name: Danielss.strand
Package/Identity/Publisher: CN=7BDB5F20-9C38-41B0-82F1-799F0AFDF699
Package/Properties/PublisherDisplayName: Danielss
```

The Store protocol link is
`ms-windows-store://pdp/?productid=9N0JG96LRC4W`. The Product identity page's
MSA app ID is not the Microsoft Entra application/client ID used by release
automation.

## Remaining submission prerequisites

- Complete owner/counsel review of the open Strand trademark gate and approve
  the factual privacy notice and user-content guidelines at
  `https://strandgit.com/docs/?page=privacy` and
  `https://strandgit.com/docs/?page=content-guidelines`.
- Do not obtain or upload a Windows publisher certificate for this route.
  Partner Center signs the accepted MSIX during certification.

## GitHub release automation

Publishing a GitHub draft release triggers the **Microsoft Store release**
workflow for that exact release tag. It:

1. checks out and version-checks the exact tag;
2. validates Strand's release and MSIX policies;
3. builds the app with the direct Tauri updater disabled in favor of
   Store-managed updates;
4. creates an x64 packaged-classic, medium-integrity, full-trust MSIX;
5. validates the manifest and payload with MakeAppx; and
6. uploads both `Strand_<version>.0_x64.msix` and the recommended
   `.msixupload` wrapper as a private workflow artifact;
7. authenticates to Partner Center with the official Microsoft Store
   Developer CLI GitHub Action; and
8. submits the `.msixupload` to Store product `9N0JG96LRC4W`.

The resulting package is intentionally unsigned. Partner Center signs it after
certification. Certification and publication are asynchronous Microsoft
operations; a successful GitHub job means Partner Center accepted the
submission, not that certification has completed. Do not attach the unsigned
Store artifact to a public GitHub release.

The first automated production submission was `v1.2.1`. Workflow run
`30382509727`, attempt 2, completed successfully on 2026-07-28 after the owner
canceled a conflicting portal-created draft. Partner Center accepted the
`.msixupload`, and the owner confirmed production Store signing complete on
2026-07-29. Clean-machine install/update/uninstall validation remains separate.

The workflow can also be run manually with an existing tag. Its `submit`
checkbox defaults to off, so a manual run builds a candidate without changing
Partner Center unless the maintainer deliberately enables submission.

### One-time GitHub and Partner Center setup

1. Associate a Microsoft Entra tenant with the Partner Center account.
2. Register a dedicated Entra application and add it under Partner Center
   **Account settings → User management → Microsoft Entra applications** with
   the **Manager** role.
3. Create these encrypted GitHub Actions secrets, preferably on the
   `microsoft-store-production` environment:

   | Secret | Value |
   | --- | --- |
   | `AZURE_AD_APPLICATION_CLIENT_ID` | Entra application (client) ID |
   | `AZURE_AD_APPLICATION_SECRET` | Entra client secret value |
   | `AZURE_AD_TENANT_ID` | Entra directory (tenant) ID |
   | `SELLER_ID` | Partner Center seller ID |

4. In GitHub, configure the `microsoft-store-production` environment with the
   desired deployment reviewers. Without reviewers, a published GitHub release
   proceeds directly to Store submission.

Never commit those four credential values. The Store product ID and package
identity are public metadata and intentionally live in the workflow.
Microsoft's GitHub Actions publication path currently supports free Store
products; Strand is configured as free.

## Build and package locally

For a local development build with a non-Store identity:

```powershell
pnpm run store:msix:check
pnpm run store:msix:build
```

The development artifact is written to `target/msix/dist/`. It is suitable for
manifest inspection and test-signing only. `-StoreSubmission` fails closed
unless explicit non-development identity and publisher values are supplied.

The older **Microsoft Store candidate** workflow is the MSI/EXE fallback. It:

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

That fallback still requires `WINDOWS_CERTIFICATE_BASE64`,
`WINDOWS_CERTIFICATE_PASSWORD`, and the Tauri updater signing secrets. Select
`publish_asset` only after its checks pass. It attaches the immutable Store MSI
to the matching GitHub release, producing this versioned HTTPS URL:

```text
https://github.com/danielss-dev/strand/releases/download/v<version>/Strand_<version>_x64_en-US_store.msi
```

Do not replace the bytes at a submitted URL. Publish a new versioned asset and
update the Partner Center submission.

Before an MSI/EXE fallback certification, install its workflow artifact on a
clean Windows 11 x64 machine through:

```powershell
msiexec.exe /i .\Strand_<version>_x64_en-US_store.msi /qn /norestart
```

Verify launch, repository open/clone, update, uninstall, and absence of a
WebView2 download during installation. Then run Microsoft Defender over the
MSI and installed directory. The Store supplies `/qn` for MSI packages. This
installer-specific step does not apply to the MSIX route.

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
  `https://strandgit.com/docs/?page=privacy`
- Website: `https://strandgit.com`
- Support: `https://github.com/danielss-dev/strand/issues`
- User-generated content guidelines:
  `https://strandgit.com/docs/?page=content-guidelines`
- Non-Microsoft drivers or NT services: **No**
- Tested to meet accessibility guidelines: **Do not claim this yet.** Strand
  is keyboard-operable, but no external conformance audit is recorded.
- Pen and ink: **No**
- Minimum system: Windows 11, x64; keyboard or pointing device.

Certification notes:

```text
Strand is a local-first Git client. The submitted x64 MSIX is a packaged-classic
desktop app for Windows 11 and uses the operating system's WebView2 runtime.
Strand installs no driver or NT service. It reads and writes
repositories only after the user opens or clones them. Network operations are
user initiated and delegated to system Git or the user's GitHub/Azure tooling.
Microsoft Store manages updates for this installation; Strand's direct
GitHub-Releases updater is disabled in the MSIX build. The app has no product
telemetry. Optional crash reporting opens a pre-filled GitHub issue that the
user reviews and submits. Optional live generative AI features use the user's
separately installed OpenAI Codex CLI or Claude Code CLI to draft commit
messages and pull-request text only after an explicit action. Every draft is
editable and is never committed or submitted automatically. Inappropriate
provider, user-generated, or generated content can be reported from Settings >
Privacy or the command palette. Reporting opens a pre-filled GitHub issue that
the user reviews and submits; nothing is sent automatically.
```

### Package

- Upload: submitted automatically by **Microsoft Store release**
- Architecture: **x64** (declared by the package)
- Minimum OS: **Windows 11, version 21H2 / build 22000**
- Language: **English (United States)**
- Runtime behavior: **packagedClassicApp**, **mediumIL**, `runFullTrust`
- Updates: **Microsoft Store managed**

The first submission is x64-only. Add a separately built arm64 package rather
than marking this package neutral.

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
- [x] **Strand** is created as MSIX/PWA Store product `9N0JG96LRC4W`.
- [x] Exact Product identity values are pinned in the MSIX workflow.
- [x] Entra release application is assigned Partner Center Manager access and
  the four GitHub environment secrets are configured (owner-confirmed
  2026-07-28).
- [ ] Owner/counsel closes or explicitly accepts the trademark gate.
- [ ] Owner approves the privacy and license listing text.
- [x] Partner Center accepted the `v1.2.1` `.msixupload` and completed
  production Store signing (owner-confirmed 2026-07-29).
- [ ] Store-signed package passes clean install/update/uninstall.
- [ ] Final screenshots and Store box art contain no private data.
- [ ] Age-rating questionnaire is completed accurately.
- [ ] First submission is certified through link-only discoverability.
