# Icons

Generate the full Tauri icon set from a 1024×1024 source PNG:

```
pnpm --filter strand-ui exec tauri icon path/to/source.png
```

This will populate `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`,
and `icon.ico` in this directory. Until you do, `tauri build` will fail —
`tauri dev` works without them.
