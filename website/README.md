# Strand landing page

Static site for `strand.danielss.dev`. No build step — deploy the folder as-is
(GitHub Pages, Cloudflare Pages, any static host).

Preview locally with `pnpm site` from the repo root (serves on
<http://localhost:4321> via [`serve`](https://github.com/vercel/serve); the
`package.json` here exists only for that script — it isn't part of the deploy).

- `index.html` / `style.css` / `script.js` — the whole site. Design tokens are
  lifted from the app (`ui/src/styles/tokens.css`): same warm-charcoal OKLCH
  palette, same single-hue accent system (the hero dots rotate `--accent-h`
  exactly like the app's `[data-accent]`).
- `fonts/` — Geist + JetBrains Mono woff2, copied from `ui/public/fonts`
  (self-hosted, latin subsets only).
- The hero window is a replica of the actual app shell (topbar / sidebar /
  Review toolbar / queue tree / diff / statusbar), built to the real metrics
  in `ui/src/styles/chrome.css` and `features.css`, with syntax colors taken
  from the app's `pierre-dark` Shiki theme (`@pierre/theme`). It's a working
  demo: the sidebar switches Local Changes / Review / All Commits views, tree
  folders collapse, `j`/`k`/`space` drive the queue (and the commit graph),
  and the commit bar "commits". If the app's chrome changes materially,
  re-sync the mock against fresh screenshots.
- ⌘K opens a page-level clone of the app's command palette (same grouped /
  fuzzy / highlighted UI): it scrolls to page sections, switches the demo
  views, sets the accent, and opens GitHub / X. Items live in `ITEMS` in
  `script.js` — add new destinations there.

## Before launch

- [ ] Point the download CTAs at real release assets (currently
      `github.com/danielss-dev/strand/releases`).
- [ ] Point "Get a commercial license" at `COMMERCIAL.md` / a purchase flow
      once that exists (currently links to the repo).
- [ ] Add an `og:image` (1200×630) for link unfurls.
- [ ] Host the Tauri updater manifest (`latest.json`) on the same domain —
      `tauri.conf.json` expects `strand.danielss.dev`.
- [ ] Keep the perf numbers in §02 in sync with `docs/perf-baseline.md`.
