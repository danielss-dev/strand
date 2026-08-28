# Page dependency trees

## `/` — Strand landing page

Entry: `website/index.html`

Dependencies:

- `website/index.html`
  - `website/style.css`
    - `website/fonts/geist-400-latin.woff2`
    - `website/fonts/geist-500-latin.woff2`
    - `website/fonts/geist-600-latin.woff2`
    - `website/fonts/jetbrains-mono-400-latin.woff2`
    - `website/fonts/jetbrains-mono-500-latin.woff2`
    - `website/fonts/jetbrains-mono-600-latin.woff2`
  - `website/script.js`
  - `website/favicon.svg`
  - `website/favicon.png`
  - `website/og-image.png`

The real desktop render is the same HTML branch as mobile. CSS media queries at lines 1179–1225 change navigation visibility, product-demo panes, grids, and footer layout.

## `/docs/` — User guide

Entry: `website/docs/index.md`

Dependencies:

- `website/build.mjs`
  - `website/docs/manifest.json`
  - `website/docs/docs.css`
  - `website/docs/marked.min.js`
  - `website/docs/*.md`

The documentation surface is outside the requested redesign target.
