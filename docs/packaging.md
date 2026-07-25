# Packaging & signing runbook

Status (2026-07-18): release CI builds all three platforms, signs and notarizes
the universal macOS app, produces minisign-verified updater artifacts, and
keyless-signs Linux AppImages with Sigstore. The remaining 1.0 distribution
gates are the Windows publisher certificate and release-candidate validation
on Windows, macOS, GNOME, and KDE. The 1.0 updater is stable-only; a selectable
beta channel is explicitly post-1.0.

---

## Done so far (2026-06-01)

- **Real icon.** The placeholder "S" is gone; `crates/strand-tauri/icons/`
  now carries the real icon set (squircle on the Apple grid, commit
  `aefc189`).
- **Signed bundle.** On an Apple-Silicon Mac with Xcode + the "Developer ID
  Application: Daniel Schwarz Campos (57CBXS5P39)" cert in the Keychain:
  ```sh
  APPLE_SIGNING_IDENTITY="Developer ID Application: Daniel Schwarz Campos (57CBXS5P39)" \
    pnpm tauri build --target aarch64-apple-darwin
  ```
  produces `target/aarch64-apple-darwin/release/bundle/dmg/Strand_<version>_aarch64.dmg`
  (~10 MB). The DMG and the embedded `Strand.app` are both signed (chain to
  Apple Root CA); the app is `valid on disk` and `satisfies its Designated
  Requirement`. Tauri deletes the staged `.app` after bundling — the signed
  copy lives inside the DMG.

## Local-build caveats

Releases go through CI (§ "Release CI" below), which signs, notarizes, and
builds universal — validated end-to-end on v0.5.0 (2026-06-12). Building
locally instead:

- **No notarization credentials in the local env.** `spctl` reports
  "Unnotarized Developer ID" until the DMG is notarized + stapled. CI gets
  `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` from repo secrets — see §3.
- **Apple-Silicon-only.** Only `aarch64-apple-darwin` is installed; the
  universal target needs `rustup target add x86_64-apple-darwin` — see §3.

---

## 1. Real app icon

1. Produce a 1024×1024 `app-icon.png` (square, no rounded corners — macOS
   rounds them itself).
2. Generate the full icon set:
   ```sh
   pnpm tauri icon path/to/app-icon.png
   ```
   This writes `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`,
   `icon.ico`, and the Windows/Store variants into
   `crates/strand-tauri/icons/`, matching the paths already listed in
   `tauri.conf.json`.

## 2. Apple Developer ID signing

1. Enroll in the Apple Developer Program; create a **Developer ID
   Application** certificate and install it in the login Keychain.
2. Point Tauri at it (either env vars in CI or `tauri.conf.json` →
   `bundle.macOS.signingIdentity`):
   ```sh
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
   ```
3. Strand sets `app.macOSPrivateApi = true` (transparency/vibrancy); that's
   fine for Developer-ID distribution (it only blocks Mac App Store review,
   which isn't the alpha channel).

## 3. Notarization

1. Create an app-specific password (appleid.apple.com) **or** an App Store
   Connect API key.
2. Provide credentials to Tauri's bundler via env:
   ```sh
   export APPLE_ID="you@example.com"
   export APPLE_PASSWORD="app-specific-password"
   export APPLE_TEAM_ID="TEAMID"
   ```
   (Or `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH` for the
   API-key path.)
3. Build + sign + notarize + staple in one shot:
   ```sh
   pnpm tauri build --target universal-apple-darwin
   ```
   Tauri runs `notarytool submit --wait` and `stapler staple` when the Apple
   env vars are present.

## 4. First DMG to the alpha group

1. Verify Gatekeeper acceptance on a clean Mac:
   ```sh
   spctl -a -vvv -t install "Strand.app"
   xcrun stapler validate "Strand.app"
   ```
2. Ship the stapled `.dmg`. (Auto-update is fully wired: the updater pubkey is
   real, `bundle.createUpdaterArtifacts` is on, and the `endpoints` point at the
   GitHub Releases manifest — `releases/latest/download/latest.json`, which
   `tauri-action` publishes per release. The old `strand.danielss.dev/updates`
   host was dropped in 0.6.1 (`ce1ffd0`). Note: the release workflow opens a
   **draft**, and `releases/latest/download/` only resolves once you publish it.)

---

## Cross-platform note

Windows (`.msi`) and Linux (`.deb`/`.rpm`/`.appimage`) targets are already in
`bundle.targets` and build without an Apple account. Release CI gives each
AppImage a keyless Sigstore bundle; the Windows publisher identity remains an
external 1.0 gate.

### Microsoft Store MSI flavor

The Microsoft Store uses a separate MSI flavor so the normal GitHub installer
stays small. `crates/strand-tauri/tauri.microsoftstore.conf.json` builds only
MSI, sets the non-product publisher name, and embeds the silent offline WebView2
installer required by Microsoft's Win32 Store route. Run:

```text
pnpm store:check
pnpm store:build
```

The manual **Microsoft Store candidate** workflow is the publishable path. It
checks out an exact tag, imports the external Authenticode identity, injects
only its thumbprint into a generated config, builds the offline MSI, verifies
valid timestamped signatures on both `strand.exe` and the MSI, and reuses the
existing updater-key identity gate. The optional `publish_asset` input attaches
the verified package to the exact GitHub release under an immutable,
version-bearing `_store.msi` name. Partner Center then links to that HTTPS asset.
Listing copy, privacy/legal notes, screenshots, and remaining external gates
live in `docs/microsoft-store-submission.md`.

---

## Release CI

`.github/workflows/release.yml` builds, signs, and publishes all three
platforms via [`tauri-apps/tauri-action`]. It runs on a `v*` tag push (or
manual dispatch) and opens a **draft** GitHub Release with the installers
attached — macOS universal `.dmg`, Windows `.msi`, Linux `.deb`/`.rpm`/
`.AppImage`. Review and publish the draft by hand.

Manual dispatch checks out the requested tag before building; it never labels
the current branch snapshot as that tag. On Linux, the release job requests a
short-lived GitHub Actions OIDC identity, signs every AppImage with Cosign,
immediately verifies the artifact and bundle against
`https://github.com/${GITHUB_WORKFLOW_REF}` plus the GitHub Actions issuer, and
uploads `<AppImage>.sigstore.json` beside the installer. No long-lived Linux
signing secret exists. To verify a downloaded tagged release, substitute the
real artifact and tag:

```sh
cosign verify-blob Strand_1.0.0_amd64.AppImage \
  --bundle Strand_1.0.0_amd64.AppImage.sigstore.json \
  --certificate-identity \
    https://github.com/danielss-dev/strand/.github/workflows/release.yml@refs/tags/v1.0.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The same workflow also builds the optional `strand-azdo` helper for universal
macOS, Windows x86_64, and Linux x86_64. It publishes versioned `.zip`/
`.tar.gz` archives plus `strand-azdo-manifest.json` and its minisign signature
under the exact app tag and the rolling `strand-azdo-latest` prerelease. The
published `.minisig` is the raw Minisign text expected by the desktop verifier;
the workflow decodes the base64 envelope emitted by Tauri's signer before upload.
The manifest records helper/protocol/target agreement,
archive and extracted-binary SHA-256 values, size, and asset name. The helper
uses the existing updater signing key and embedded public key; `latest` is never
part of the install path; the app downloads the rolling release and rejects a
different protocol version. After the exact-tag upload succeeds, the same signed
workflow artifacts are promoted to the rolling release without a post-upload
smoke-test matrix.

If a published release predates or missed the helper jobs, run **Release**
manually with that exact tag and **helpers_only** enabled. This rebuilds, signs,
uploads, and promotes only the `strand-azdo` assets; it does not rebuild or
replace the desktop installers already attached to the release. A maintainer
with Git push access can use the equivalent `strand-azdo-vX.Y.Z` tag trigger;
the workflow targets the existing `vX.Y.Z` release and skips every desktop job.

The macOS helper binary is Developer-ID signed before archiving and its archive
is submitted to Apple notarization. Windows publisher signing remains coupled
to the planned Windows certificate work; the signed manifest is mandatory on
all platforms. Installation extracts only the expected regular file, refuses
links/traversal, and keeps the previous helper until the replacement verifies.

### Release security policy gate

Run `pnpm release:check-security` before packaging. PR CI and every release job
run the same fail-closed check. It pins the reviewed production CSP, the exact
local desktop capability allowlist, `createUpdaterArtifacts: true`, the single
HTTPS stable endpoint, minisign public-key ID `84FCBFD2A981CE5D`, exact-tag
checkout, and Linux Sigstore identity flow. Any capability, channel, or signing
change must be reviewed and updated in the checker in the same commit; a silent
broadening or signing removal fails CI.

After packaging, run `pnpm release:check-updater-signatures` (or pass exact
`.sig` paths to `scripts/check-updater-signatures.mjs`). It reads every Tauri
updater signature envelope and requires its minisign key ID to match the public
key embedded in the app. The release workflow runs this after every desktop
build and before helper promotion, including the helpers-only path. Tauri can
finish a bundle while only warning about a private/public key mismatch; that
warning is a failed release, never an artifact to promote.

**Before tagging:** bump `version` in `tauri.conf.json`, the workspace
`Cargo.toml`, and `package.json` to match the tag. Tauri names the artifacts
from the config version, not the tag.

### Secrets to add (Settings → Secrets and variables → Actions)

`GITHUB_TOKEN` is provided automatically — don't add it. Everything below is a
repo (or org) Actions **secret**.

| Secret | Required for | What it is |
| --- | --- | --- |
| `APPLE_CERTIFICATE` | macOS signing | Base64 of the exported **Developer ID Application** `.p12` (see below) |
| `APPLE_CERTIFICATE_PASSWORD` | macOS signing | The password set when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | macOS signing | `Developer ID Application: Daniel Schwarz Campos (57CBXS5P39)` |
| `APPLE_ID` | macOS notarization | Apple Account email |
| `APPLE_PASSWORD` | macOS notarization | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | macOS notarization | `57CBXS5P39` |
| `TAURI_SIGNING_PRIVATE_KEY` | **Every build** | Tauri updater private key (see below) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | **Every build** | Password for that key |
| `WINDOWS_CERTIFICATE_BASE64` | Microsoft Store candidate | Base64 PKCS#12/PFX publisher certificate with private key |
| `WINDOWS_CERTIFICATE_PASSWORD` | Microsoft Store candidate | Password for the publisher PKCS#12/PFX |

The `APPLE_*` secrets are mandatory for the release workflow because both the
app and the universal helper must be signed/notarized. The
`TAURI_SIGNING_*` pair is also **mandatory**: it signs updater artifacts and
the helper manifest, and `bundle.createUpdaterArtifacts` is `true`. Any bundle
build (CI or local) fails without the private key. Windows publisher signing is
wired for the separate Microsoft Store candidate once those two external
certificate secrets exist; the normal release remains unsigned until the owner
deliberately applies the same identity there. Linux AppImage publisher identity
is keyless and needs no repository secret.

> **Local builds** now need the key too. Point Tauri at the generated file:
> ```sh
> export TAURI_SIGNING_PRIVATE_KEY="$HOME/.strand/updater.key"   # path or content
> export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<password>"
> ```

The macOS updater artifact (`Strand.app.tar.gz` + `.sig`) comes from the
**`app`** bundle target, not `dmg` — so `bundle.targets` must keep `"app"`
alongside `"dmg"`, or the Mac build only warns ("no updater-enabled targets
were built") and ships no update. Windows (`msi`) and Linux (`appimage`) are
updater-enabled on their own. Verified 2026-06-01: the release key's generated
`.sig` key ID matches the configured pubkey (`84FCBFD2A981CE5D`). A 2026-07-18
local candidate exposed a different machine-wide key (`5B0DEABB5904DD1F`); the
artifact gate rejected it without changing or disclosing that external secret.
This is workstation-only: all published v0.13.0 desktop `.sig` files and the
helper manifest use `84FCBFD2A981CE5D`, so the hosted Actions secret matches
the embedded release key.

### Producing the macOS cert secret

Export the Developer ID Application identity (the one already in the login
Keychain) to a `.p12`, then base64 it:

```sh
# Keychain Access → right-click the "Developer ID Application" identity →
# Export… → .p12 (set a password = APPLE_CERTIFICATE_PASSWORD)
base64 -i DeveloperID.p12 | pbcopy   # paste as APPLE_CERTIFICATE
```

The current secrets were rebuilt 2026-06-12 (the originals failed PKCS12 MAC
verification on `security import`): `security export -t identities -f pkcs12`,
then filtered to the Developer-ID identity only and repackaged with
`openssl pkcs12 -export -legacy` (legacy ciphers — macOS `security import`
rejects OpenSSL 3 defaults). Verify a candidate p12 locally before setting the
secret: import it into a throwaway keychain
(`security create-keychain` → `security import` → `security find-identity`).

### Updater key (already generated)

The keypair was generated on 2026-06-01 and lives **outside the repo** at
`~/.strand/` (perms `700`; never commit it). The public key is already in
`tauri.conf.json` → `plugins.updater.pubkey` (minisign key ID
`84FCBFD2A981CE5D`). To populate the GitHub secrets:

```sh
cat ~/.strand/updater.key       | pbcopy   # → TAURI_SIGNING_PRIVATE_KEY
cat ~/.strand/updater.password  | pbcopy   # → TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

To regenerate from scratch (rotates the key — every prior release's updater
signatures become unverifiable, so the pubkey in config must be updated too):

```sh
pnpm tauri signer generate -p '<password>' -w ~/.strand/updater.key -f
# → ~/.strand/updater.key.pub contents → tauri.conf.json plugins.updater.pubkey
```

[`tauri-apps/tauri-action`]: https://github.com/tauri-apps/tauri-action
