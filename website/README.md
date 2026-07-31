# Strand landing page

Static site for `strandgit.com`. A zero-dependency Node build pre-renders the
Markdown user guide into crawlable HTML and writes the deployable site to
`dist/`.

**Deployed on Railway**: project `landings` → service `strand-landing`
(`railway up` from this folder redeploys; Railway runs `npm run build` and then
`npm start`, which serves `dist/` on `$PORT`). Test URL:
<https://strand-landing-production.up.railway.app>. The custom domain
`strandgit.com` is live through the Railway service.

Preview locally with `pnpm site` from the repo root (builds and serves on
<http://localhost:4321> via [`serve`](https://github.com/vercel/serve)). Run
`npm test` from this folder to build and validate titles, descriptions,
canonicals, JSON-LD, the sitemap, robots policy, and internal links.

- `index.html` / `style.css` / `script.js` — the whole site. Design tokens are
  lifted from the app (`ui/src/styles/tokens.css`): same warm-charcoal OKLCH
  palette, same single-hue accent system (the hero dots rotate `--accent-h`
  exactly like the app's `[data-accent]`). The download section uses
  self-contained Apple, Windows, and Linux vector marks, highlights the
  visitor's detected platform as a convenience, and keeps all three platform
  choices visible.
- `fonts/` — Geist + JetBrains Mono woff2, copied from `ui/public/fonts`
  (self-hosted, latin subsets only).
- The hero window is a replica of the actual app shell (workspace/repo tabs,
  network and stash controls, sidebar, Work tabs, Review toolbar and queue,
  pull requests, commit graph, diff, and statusbar), built to the real metrics
  in `ui/src/styles/chrome.css` and `features.css`, with syntax colors taken
  from the app's `pierre-dark` Shiki theme (`@pierre/theme`). It's a working
  demo: all five primary sidebar destinations switch in place; file/terminal
  tabs, Git/Files, repository/workspace Review scope, PR selection, file
  actions, review notes, baselines, tree folders, keyboard navigation, commit
  form, and both pane resizers respond like their app counterparts. If the
  app's chrome changes materially, re-sync the mock against fresh screenshots.
- ⌘K opens a page-level clone of the app's command palette (same grouped /
  fuzzy / highlighted UI): it scrolls to page sections, switches the demo
  views, sets the accent, and opens GitHub / X. Items live in `ITEMS` in
  `script.js` — add new destinations there.
- `docs/` — the user-guide source, served as pre-rendered pages at `/docs/`
  and `/docs/<slug>/`. Content is plain markdown (`*.md`, one file per page),
  converted at build time by `build.mjs` with the vendored
  `docs/marked.min.js`. **To update a page, edit its `.md` and redeploy. To add
  a page, drop the `.md` in `docs/` and add a title + unique description row
  to `docs/manifest.json`** (order drives the sidebar, sitemap, and prev/next
  pager). Cross-page links stay as relative `foo.md` links in source so they
  render on GitHub; the build rewrites them to canonical clean URLs. Keep the
  guide in sync with app releases: every claim in it
  was fact-checked against `ui/src` on 2026-07-18 for the 1.0 release candidate.
  The public privacy policy used by distribution listings is
  `/docs/privacy/`, and Store UGC guidance is `/docs/content-guidelines/`.
  Legacy `?page=` URLs redirect to their clean equivalents; deploy website
  changes before submitting either Store URL.

## Before launch

- [x] Custom-domain DNS and TLS are live at `strandgit.com`.
- [ ] Redirect `www.strandgit.com` permanently to `https://strandgit.com/`
      in the Railway/DNS control plane (the stale `www` record currently lands
      on an unrelated 404 host).
- [ ] Verify the apex domain in Google Search Console, import it into Bing
      Webmaster Tools, and submit `https://strandgit.com/sitemap.xml` after
      this SEO build is deployed.
- [x] Download CTAs resolve the latest platform assets through the GitHub
      Releases API, with the release page as the failure fallback.
- [ ] Point "Get a commercial license" at `COMMERCIAL.md` / a purchase flow
      once that exists (currently links to the repo).
- [x] Open Graph and Twitter previews use `og-image.png` (1200×630), rendered
      from the checked-in `og-image.svg` source.
- [x] Tauri updater manifest (`latest.json`) is served from GitHub Releases
      (`releases/latest/download/latest.json`), which `tauri-action` publishes
      automatically — `tauri.conf.json` points the updater there. No custom
      `/updates` route on `strandgit.com` is needed.
- [x] The performance figures in §02 match `docs/perf-baseline.md` as of the
      2026-07-18 1.0 content pass.
