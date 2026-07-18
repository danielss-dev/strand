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
pnpm build
```

Also require the GitHub Actions PR/CI checks to pass. The release workflow must
check out the requested tag, confirm that its version matches the tag, create
signed updater artifacts, and open a draft release; publishing remains a
deliberate maintainer action.

## Publisher and update trust

- [x] macOS Developer ID signing and notarization are wired and previously
  validated on the universal build.
- [x] Tauri updater artifacts and manifests are authenticated by the embedded
  minisign public key; the stable updater endpoint is HTTPS and pinned by
  `scripts/check-release-security.mjs`. Strand 1.0 intentionally exposes only
  this stable channel; selectable beta updates are post-1.0.
- [x] Linux AppImages receive a keyless Sigstore bundle in release CI. The same
  job immediately verifies the artifact against the exact Strand release
  workflow identity and GitHub Actions OIDC issuer before upload.
- [ ] Import/configure the Windows publisher certificate or approved cloud-
  signing profile, then verify both the app executable and MSI with
  `Get-AuthenticodeSignature`. This requires a purchased external identity and
  cannot be manufactured from repository code.
- [ ] Run the updater end to end from the last public version to the 1.0 draft
  promoted through a disposable test endpoint, then confirm the normal stable
  endpoint only sees the published release.

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
warning, status feedback, and accessibility structure. macOS and Linux runtime
rows still require their actual platforms;
cross-compilation is not equivalent evidence.

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
4. Publish the GitHub release, then verify the stable updater and downloads
   from a clean machine. Redeploy `website/` if its release claims changed.
5. Announce only after the published artifacts pass the platform matrix.
