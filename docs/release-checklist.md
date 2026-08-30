# Strand 1.0 release checklist

This is the fail-closed checklist for promoting a 1.0 release candidate. A row
is evidence, not ceremony: do not tag or publish while a required row is open.

## Automated gates

Run from the repository root on the exact candidate commit:

```text
pnpm install --frozen-lockfile
pnpm release:check-security
pnpm release:test-helper
pnpm store:check
pnpm --filter ./ui exec tsc --noEmit
pnpm --filter ./ui exec vitest run
cargo check -p strand-core -p strand-tauri
cargo test -p strand-core -p strand-tauri
cargo clippy -p strand-core -p strand-tauri -- -D warnings
pnpm build
```

Also require the GitHub Actions PR/CI checks to pass. The release workflow must
check out the requested tag, confirm that its version matches the tag, create
signed updater artifacts, and open a draft release; publishing remains a
deliberate maintainer action.

Helper releases use their own `strand-azdo-vX.Y.Z` tags. Require the helper
version check, binary-derived version/protocol metadata on all three targets,
the signed draft-then-published versioned helper prerelease, and promotion only
to the matching
`strand-azdo-protocol-N` channel. The post-promotion smoke job must download
through that channel and match the running Linux binary and archive to the
manifest. A normal Strand tag must not renumber or publish the helper.

## Publisher and update trust

- [x] macOS Developer ID signing and notarization are wired. The
  [public v0.13.0 universal release job](https://github.com/danielss-dev/strand/actions/runs/29613997996/job/87994909306)
  signed the app and DMG, received Apple notarization status `Accepted`, and
  stapled the app on 2026-07-17.
- [x] The embedded minisign public key and HTTPS stable endpoint are pinned by
  `scripts/check-release-security.mjs`; generated desktop/helper signatures
  hard-fail on another key through `scripts/check-updater-signatures.mjs`.
  Strand 1.0 intentionally exposes only this stable channel; selectable beta
  updates are post-1.0. All five published v0.13.0 desktop updater signatures
  plus its helper manifest from the
  [published release](https://github.com/danielss-dev/strand/releases/tag/v0.13.0)
  were independently decoded on 2026-07-18 and use embedded key
  `84FCBFD2A981CE5D`, proving the GitHub release secret is correct.
- [x] Linux AppImages receive a keyless Sigstore bundle in release CI. The same
  job immediately verifies the artifact against the exact Strand release
  workflow identity and GitHub Actions OIDC issuer before upload.
- [x] Use the Partner Center-signed Microsoft Store MSIX as the trusted Windows
  distribution (production identity `Danielss.strand`; owner-confirmed signing
  complete 2026-07-29). The standalone GitHub MSI remains `NotSigned` and is
  not the trusted Store channel. A separate Authenticode identity is required
  only if the unmanaged MSI/EXE fallback is promoted.
- [x] Build the exact candidate with updater key `84FCBFD2A981CE5D` and pass
  `pnpm release:check-updater-signatures`. Release run `29657871779` produced
  five desktop updater `.sig` artifacts for `v1.0.0`; a fresh download verified
  all five against embedded key `84FCBFD2A981CE5D`. The local machine-wide key
  remains mismatched at `5B0DEABB5904DD1F`, but it was not used by the hosted
  candidate and no key was rotated or disclosed.
- [ ] Run the updater end to end from the last public version to the 1.0 draft
  promoted through a disposable test endpoint, then confirm the normal stable
  endpoint only sees the published release.

## Microsoft Store distribution

- [x] Manual packaged-classic MSIX path builds a MakeAppx-validated x64 package,
  disables the direct updater in favor of Store-managed updates, and fails
  closed unless exact Partner Center identity values are supplied.
- [x] A temporary locally signed MSIX registered and launched from its real
  WindowsApps identity on Windows 11; the test app and certificates were then
  removed and all four stores audited clean (2026-07-25).
- [x] Manual **Microsoft Store MSIX candidate** workflow creates an unsigned
  `.msix` plus the recommended `.msixupload`; Partner Center supplies the
  production signature after certification.
- [x] GitHub release publication rebuilds the exact tag with Store identity
  `Danielss.strand` and submits its `.msixupload` to product `9N0JG96LRC4W`
  through Microsoft's official Store Developer CLI action; manual
  build-without-submit recovery remains available.
- [x] Store-only Tauri flavor builds an MSI with silent offline WebView2
  (`tauri.microsoftstore.conf.json`) while preserving the signed stable updater
  as a certificate-dependent fallback.
- [x] Manual Store workflow imports the external publisher certificate,
  verifies timestamped Authenticode on both the executable and MSI, verifies
  the updater key, and can publish an immutable versioned GitHub asset.
- [x] Partner Center copy, truthful live-generative-AI disclosure, in-product
  inappropriate-content reporting, license text, privacy notice, user-content
  guidelines, certification notes, and four sanitized screenshots are prepared in
  `docs/microsoft-store-submission.md` and `docs/store-assets/`.
- [ ] Deploy the privacy page and verify the Partner Center developer account.
- [x] Assign a dedicated Entra application the Partner Center Manager role and
  configure the four `microsoft-store-production` GitHub secrets
  (owner-confirmed 2026-07-28).
- [x] Obtain a green **Microsoft Store release** workflow for the exact
  submitted tag and confirm Partner Center accepted its `.msixupload`
  (`v1.2.1`, run `30382509727`, attempt 2; 2026-07-28).
- [x] Partner Center completed production signing of the accepted `v1.2.1`
  MSIX (owner-confirmed 2026-07-29).
- [ ] Run clean Windows 11 install/update/uninstall and Microsoft Defender
  scans, then submit initially as link-only discoverability.

The fresh development-identity MSIX built on 2026-07-25 is 17,656,211 bytes
(SHA-256
`6D13C5B4E8CD7A705148EBA7B97EE1DB2615FFD46E82B0CF3DD5F9FCA7947D7F`).
MakeAppx completed full semantic validation. A separately copied package was
signed with a temporary self-signed test certificate, registered as
`dev.danielss.strand.msix.test_1.1.1.0_x64__94yh9fqhspgzm`, and launched a
responsive `Strand` window from its protected WindowsApps location. The test
package and exact certificate thumbprint were removed afterward. This proves
the repository-owned package path; it is not a Store candidate because only
Partner Center can provide the real identity and production signature.

The unsigned local 1.1.1 MSI engineering build on 2026-07-25 produced a
221,757,440-byte offline MSI (SHA-256
`301EFA1539BA289A46F0454E96CE2730409CB00C0E8D979CECE2C3113EA7D359`).
WiX embeds `MicrosoftEdgeWebView2RuntimeInstallerX64.exe` and invokes it with
`/silent /install`. This proves the repository-owned offline/silent build
path, not the publisher gate: both the MSI and executable correctly report
`NotSigned` locally, and the workstation updater key remains the previously
recorded mismatch. Do not publish this engineering artifact.

## Brand and legal gate

- [ ] Obtain owner/counsel review of `docs/trademark-search.md`. The preliminary
  USPTO/EUIPO/WIPO pass found live identical `STRAND` class-9 registrations in
  the US and EU plus related software marks. Decide that coexistence is legally
  supportable or rename before tagging 1.0; this is not a clerical check.
- [ ] Select and approve contributor-assignment terms before enabling a CLA
  workflow for outside contributions. The AGPL/commercial dual-license model
  does not determine the agreement text or signing provider by itself.

## Platform release-candidate matrix

| Platform | Required evidence |
| --- | --- |
| Windows 11 | Clean Store install of the Partner Center-signed MSIX, launch/update/uninstall, native titlebar, editor and terminal presets |
| macOS Apple Silicon | Gatekeeper + stapler validation, install/launch/update, native menu, editor and terminal presets |
| macOS Intel | Universal binary launch/update smoke test |
| Ubuntu GNOME | AppImage plus `.deb` install/launch/update, system theme/chrome, editor and terminal presets |
| Fedora/KDE | `.rpm` plus AppImage install/launch/update, system theme/chrome, editor and terminal presets |

The Windows production-protocol workspace executable has current Computer Use
evidence for restored window state, persisted repositories, CSP/capabilities,
native window menu + keyboard traversal, command palette, Settings, clone
warning, status feedback, accessibility structure, and external integration
launches. The 2026-07-18 integration pass observed Strand launching VS Code
with `code.cmd -g <active-repository>` and a new Windows Terminal process from
the `wt -d <active-repository>` preset. This closes the Windows preset slice,
not the clean-install, updater, or uninstall rows. macOS
and Linux runtime rows still require their actual platforms; cross-compilation
is not equivalent evidence.

The exact optimized 1.0.0 executable was also launched by absolute path with
Computer Use on 2026-07-18. Restored repositories, Local Changes, Worktrees,
the command palette, all nine Settings sections, Privacy disclosure, and the
Updates page reporting `Strand 1.0.0` rendered and operated normally. The
candidate executable is 26,828,800 bytes with SHA-256
`159C61298A5B4C14F52909B9119556F3443CCB64016788ED8305C14C508F5B47`.
The MSI builds at 17,088,512 bytes with SHA-256
`F1FA01179037B12E3D607EF6A44135060D963AEBF0DDE99FB618B125AF061C37`.
Both local artifacts remain intentionally unpromoted: Authenticode reports
`NotSigned`, and the local MSI updater signature has the mismatched key
recorded above. The hosted `v1.0.0` draft supersedes the local updater artifact:
its MSI is also Authenticode `NotSigned`, but its updater signature uses the
correct embedded key.

The owner explicitly authorized pushing the annotated `v1.0.0` tag at commit
`698158b` on 2026-07-18 before the remaining gates closed. Release run
`29657871779` completed all jobs and populated an 18-asset draft. The universal
macOS candidate received notarization status `Accepted` (request
`588511bd-9b0c-4454-a988-ec6484dc0789`) and was stapled; Linux carries the
verified Sigstore bundle. The Git tag is not cryptographically signed because
no tag-signing identity was configured in this checkout. Re-signing it later
would require replacing the published tag; this override is evidence of the
push, not closure of the remaining legal or runtime rows. Windows trusted
distribution is handled separately by the Partner Center-signed Store MSIX.

The owner explicitly authorized the same override for the annotated `v1.0.1`
tag at commit `f173f8e3a5021fd5854c7d836fb7d8ec08af4be5` on 2026-07-20.
`git verify-tag v1.0.1` reports `no signature found`; no signing identity was
invented or configured. Release run `29706062468` completed all desktop and
helper jobs successfully and produced an 18-asset draft with updater signature
identity checks, macOS signing/notarization, and Linux Sigstore verification
green. This records the requested draft creation only; it does not close the
remaining publication gates above.

The owner authorized creating release 1.1.0 with the same annotated-but-
unsigned tag override at commit `1b015f51bb1f2e8d53169e3267db084c3a80493e` on
2026-07-20. `git verify-tag v1.1.0` reports `no signature found`; no signing
identity was invented or configured. Candidate CI run `29755733243` and release
run `29755981951` passed. The latter completed all eight desktop, helper,
assembly, and promotion jobs, and the 18-asset release was published as latest
stable at 16:04 UTC. An independent download audit found all five desktop
updater signatures and the helper manifest use embedded key
`84FCBFD2A981CE5D`; public `latest.json` reports 1.1.0 and targets only the
`v1.1.0` assets. Universal macOS notarization returned `Accepted` (request
`bcb128dd-36fc-4cd7-9beb-737b927be2ee`) and the app was stapled; Linux Sigstore
verification passed. `Get-AuthenticodeSignature` still reports `NotSigned` for
the 17,588,224-byte Windows MSI (SHA-256
`96B31FF0EB3990EEAB5378CFE9328E8F4E3E9EB6AB2298868A0AB8C181BB7463`).
That standalone MSI is not the trusted Store channel; Partner Center signing
of the production MSIX closes the Windows signed-distribution row. Legal,
updater-rehearsal, clean-machine, and real-platform rows remain open.

After the unavailable tag-signing setup was surfaced, the owner directed the
1.3.1 production Store deployment on 2026-08-11. The annotated `v1.3.1` tag
object is `91ae42f172bf859dabad954ebc138a174f46003a` and peels to the validated
candidate `64ad1d08d8dfb6d59e5b0b38aa8978c511e05c10`; `git verify-tag v1.3.1`
reports `no signature found`. Release run `31518879083` completed successfully
and published the desktop release. Microsoft Store production run
`31518896675` uploaded `Strand_1.3.1.0_x64.msixupload` and Partner Center
advanced the committed submission to Certification. This records the explicit
unsigned-tag override and successful submission, not completion of Partner
Center certification or the remaining platform-validation gates.

The owner directed the `v1.4.0` release on 2026-08-24 with the same explicit
annotated-but-unsigned tag override. Tag object
`21b8b954f2a8bd92042f0b626a6cb5f1c2ea0212` peels to merge commit
`6e2dc805156cb26faaa12df56d4c6e8f3888f51d`. Release run `32717124785`
completed successfully across Windows, Linux, and universal macOS, including
updater signature identity, Apple signing/notarization, and Linux Sigstore
verification, then the 13-asset release was published as latest stable. This
records the requested release override; the remaining external gates above
stay open. Microsoft Store run `32718774016` built the exact tag successfully;
publication attempts 1 and 2 each created a valid Partner Center submission
but failed at 1% during Azure blob upload, leaving Store promotion to retry
after the external upload path recovers.

The owner directed the `v1.5.0` release on 2026-08-30 with the established
annotated-but-unsigned tag override. Tag object
`af6296e5417351e7f07be7b2bc503ce3d3de8c7e` peels to validated candidate
`4058c97a78c63ce67610c84b5cdd7c1cafc2d9d6`. Release run `33323894309`
completed successfully across Windows, Linux, and universal macOS and
published 13 assets as the latest stable release. Microsoft Store production
run `33324693953` built the exact tag successfully, but attempts 1–3 each
created a valid Partner Center submission and failed at 1% during Azure blob
upload. Store promotion remains pending recovery of Microsoft's external
upload path.

Investigation identified Microsoft Store CLI v0.4.0–v0.4.1's omitted
`--uploadTimeout` regression rather than a package or service failure. Strand
now passes `--uploadTimeout 300` explicitly and enforces it in
`scripts/check-msix.mjs`. Replacement production run `33326040162` uploaded
the exact `v1.5.0` package, reached `CommitStarted`, and Partner Center reported
`Certification`, closing the Store submission retry on 2026-08-30.

## Desktop smoke pass

On every platform, use a disposable repository and cover:

1. Launch with no repository, open/clone a trusted fixture, restart, and confirm
   repository plus window-state restoration.
2. Navigate primary views and repository tabs from the keyboard; exercise the
   command palette, quick switcher, Settings, dialogs, focus traps, and Escape.
3. Stage/unstage/discard, commit, branch/tag/stash, fetch/pull/push against a
   disposable remote, and cancel one network operation.
4. Open commit/file history, blame, reflog, worktrees, submodules, interactive
   rebase, conflict resolution, patch export, and signature verification.
5. Load GitHub and Azure pull-request detail without writing; use a dedicated
   provider fixture for any comment/review/merge mutation.
6. Confirm contextual empty/error states, success/error/network toasts, truthful
   status-bar state, zoom, text scaling, and no clipped controls at minimum
   supported window size.
7. Inspect the crash-report preview and privacy disclosure without submitting.

## Promotion

1. Set all package/config/crate versions to `1.0.0`; run the automated gates
   again and commit the version change.
2. Create the signed `v1.0.0` tag locally and push it only with explicit
   publication approval.
3. Review the draft release assets, hashes, platform signatures, Sigstore
   bundle, updater `latest.json`, release notes, and website/download claims.
   The checked-in release-note source is
   `docs/changelog/2026-07-18-strand-1.0.0.md`.
4. Publish the GitHub release, then verify the stable updater and downloads
   from a clean machine. Redeploy `website/` if its release claims changed.
5. Announce only after the published artifacts pass the platform matrix.
