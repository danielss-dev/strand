# Strand landing page

Static site for `strand.danielss.dev`. No build step.

**Deployed on Railway**: project `landings` → service `strand-landing`
(`railway up` from this folder redeploys; `npm start` is what Railway runs —
`serve . -l $PORT`; `npm run build` is a no-op that exists only because the
Railway image build wants a build command). Test URL:
<https://strand-landing-production.up.railway.app>. The custom domain
`strand.danielss.dev` is live through the Railway service.

Preview locally with `pnpm site` from the repo root (serves on
<http://localhost:4321> via [`serve`](https://github.com/vercel/serve)).

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
- `docs/` — the user guide, served at `/docs/`. Content is plain markdown
  (`*.md`, one file per page) rendered client-side by `docs/index.html` +
  `docs/docs.js` using the vendored `docs/marked.min.js` (still no build
  step). **To update a page, edit its `.md` and redeploy. To add a page,
  drop the `.md` in `docs/` and add a row to `docs/manifest.json`** (order
  there drives the sidebar and prev/next pager). Cross-page links are plain
  relative `foo.md` links — the viewer rewrites them (and they render on
  GitHub too). Keep the guide in sync with app releases: every claim in it
  was fact-checked against `ui/src` on 2026-07-18 for the 1.0 release candidate.

## Before launch

- [x] Custom-domain DNS and TLS are live at `strand.danielss.dev`.
- [x] Download CTAs resolve the latest platform assets through the GitHub
      Releases API, with the release page as the failure fallback.
- [ ] Point "Get a commercial license" at `COMMERCIAL.md` / a purchase flow
      once that exists (currently links to the repo).
- [x] Open Graph and Twitter previews use `og-image.png` (1200×630), rendered
      from the checked-in `og-image.svg` source.
- [x] Tauri updater manifest (`latest.json`) is served from GitHub Releases
      (`releases/latest/download/latest.json`), which `tauri-action` publishes
      automatically — `tauri.conf.json` points the updater there. No custom
      `/updates` route on `strand.danielss.dev` is needed.
- [x] The performance figures in §02 match `docs/perf-baseline.md` as of the
      2026-07-18 1.0 content pass.
