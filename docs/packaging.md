# Packaging & signing runbook

Status: the **macOS alpha packaging** item in `ROADMAP.md` §0.1 is the one
remaining 0.1 task that can't be completed from a dev checkout — it needs a
Mac, an Apple Developer account, and signing certificates that don't live in
the repo. This file is the runbook for whoever has those credentials.

Everything else in 0.1 (clone, streaming progress, detached checkout, file
tree, recent messages, multi-select) is code-complete and verified.

---

## Why it's blocked here

- **No macOS host.** Strand is currently developed on Windows; the `.dmg`
  target, `codesign`, and `notarytool` only run on macOS.
- **No Apple Developer ID.** Signing needs a "Developer ID Application"
  certificate ($99/yr Apple Developer Program) installed in the host
  Keychain. Notarization needs an app-specific password or an App Store
  Connect API key.
- **Placeholder icon.** `crates/strand-tauri/icons/` ships a generated
  placeholder "S". A real 1024×1024 source PNG must be designed first, then
  expanded to the icon set.

None of these are code; they're assets and credentials. The Tauri config is
already wired for the bundle (`tauri.conf.json` → `bundle.targets` includes
`"dmg"`, `bundle.icon` lists the icon set).

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
2. Ship the stapled `.dmg`. (Auto-update is separate — see the 0.5
   "real updater pubkey + endpoint" task; `tauri.conf.json` still has the
   `TODO_REPLACE_WITH_TAURI_UPDATER_PUBKEY` placeholder.)

---

## Cross-platform note

Windows (`.msi`) and Linux (`.deb`/`.rpm`/`.appimage`) targets are already in
`bundle.targets` and build without an Apple account; Windows EV signing and
Linux sigstore signing are tracked under §0.5 "platform / packaging", not
0.1.
