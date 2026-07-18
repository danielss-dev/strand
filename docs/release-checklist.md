# Strand 1.0 release checklist

This is the fail-closed checklist for promoting a 1.0 release candidate. A row
is evidence, not ceremony: do not tag or publish while a required row is open.

## Automated gates

Run from the repository root on the exact candidate commit:

```text
pnpm install --frozen-lockfile
pnpm release:check-security
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
- [ ] Import/configure the Windows publisher certificate or approved cloud-
  signing profile, then verify both the app executable and MSI with
  `Get-AuthenticodeSignature`. This requires a purchased external identity and
  cannot be manufactured from repository code. The published v0.13.0 MSI was
  also inspected on 2026-07-18 and reports `NotSigned` with no signer.
- [x] Build the exact candidate with updater key `84FCBFD2A981CE5D` and pass
  `pnpm release:check-updater-signatures`. Release run `29657871779` produced
  five desktop updater `.sig` artifacts for `v1.0.0`; a fresh download verified
  all five against embedded key `84FCBFD2A981CE5D`. The local machine-wide key
  remains mismatched at `5B0DEABB5904DD1F`, but it was not used by the hosted
  candidate and no key was rotated or disclosed.
- [ ] Run the updater end to end from the last public version to the 1.0 draft
  promoted through a disposable test endpoint, then confirm the normal stable
  endpoint only sees the published release.

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
| Windows 11 | Clean install, valid publisher signature, launch/update/uninstall, native titlebar, editor and terminal presets |
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
not the clean-install, publisher-signature, updater, or uninstall rows. macOS
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
push, not closure of the remaining publisher, legal, or runtime rows.

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
