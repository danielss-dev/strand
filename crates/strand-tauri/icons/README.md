# Icons

`app-icon.svg` is the canonical squircle source for the desktop and Store icon
set. Regenerate every platform size from the repository root with:

```
.\node_modules\.bin\tauri.cmd icon crates\strand-tauri\icons\app-icon.svg
```

On macOS/Linux, run the equivalent local binary without the `.cmd` suffix.
This populates the PNG, ICO, ICNS, Microsoft Store, Android, and iOS variants
in this directory.
