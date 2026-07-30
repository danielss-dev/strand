# Icons

The root `strand.png` is the canonical rounded white-tile source for the
desktop and Store icon set. Regenerate every platform size from the repository
root with:

```
.\node_modules\.bin\tauri.cmd icon strand.png
```

On macOS/Linux, run the equivalent local binary without the `.cmd` suffix.
This populates the PNG, ICO, ICNS, Microsoft Store, Android, and iOS variants
in this directory.

Then regenerate the MSIX app-list variants on Windows:

```
.\scripts\generate-msix-icons.ps1
```

These exact-size dark- and light-shell resources prevent Windows from scaling
the plated fallback behind the Store app icon.
