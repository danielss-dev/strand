# Strand landing page

Static site for `strandgit.com`. A zero-dependency Node build pre-renders the
Markdown user guide into crawlable HTML and writes the deployable site to
`dist/`.

**Deployed on Railway**: project `landings` → service `strand`
(GitHub `danielss-dev/strand` @ `main`). The service root is the repo
(not this folder): Railway installs Node/pnpm (not the root Rust crate), then
`pnpm install --frozen-lockfile && pnpm --filter strand-ui build:demo &&
pnpm --filter strand-website build`,
and starts with `npx --yes serve website/dist -l ${PORT:-4321}` (the
Railpack Rust runtime has no pnpm on PATH). Watch paths are
`/website/**` and `/ui/**` so chrome changes rebuild the live demo. Test URL:
<https://strand-landing-production.up.railway.app>. The custom domain
`strandgit.com` is live through the Railway service.

The live demo at `/demo/` is the real app bundle built into
`website/demo/` (gitignored). `website/build.mjs` copies it into `dist/`;
on Railway/CI a missing bundle fails the build so the hero cannot ship a
404. Locally, `pnpm site:build` from the repo root (or `pnpm demo:build`
then `npm run build` here) produces the same output. Preview locally with
`pnpm site` from the repo root (builds and serves on
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
- The hero window (`#demo`) is the actual Strand UI. Railway (and
  `pnpm site:build`) runs `pnpm demo:build`, which puts
  `ui/` through Vite in `--mode demo` (`ui/.env.demo` sets `VITE_DEMO=1`),
  which swaps the Tauri IPC layer for the in-browser backend in
  `ui/src/demo/` — an in-memory git model (commits, branches, worktrees,
  index/workdir, stash, blame, unified patches), fixture history for a sample
  `acme-api` repository, scripted pull requests, a scripted terminal, and
  stubs for the desktop-only plugins — and emits a static SPA to
  `website/demo/`, served at `/demo/` with `noindex`. The landing page embeds
  it in an iframe behind `demo-poster.webp`; desktop visitors get an automatic
  Review-first mount, "Restart" remounts it (state lives in the iframe, so
  this resets the sample repo), and "Full screen" opens `/demo/` in a tab. Deep links from
  page sections post `{ type: 'strand-demo:view', view }` to the iframe (or
  pass `?view=` on first mount); below 720px the embed hands off to a new
  tab because the app shell is a desktop layout. Because it is the real UI,
  chrome changes in `ui/src` flow through automatically — only the fixtures
  and IPC handlers in `ui/src/demo/` need care when a command's shape
  changes.
- `demo-poster.webp` (1440×900) is a screenshot of `/demo/?view=review` with
  `src/auth/retry.ts` selected. Regenerate it after visible chrome changes:
  serve `dist/`, capture the demo at 1440×900, `cwebp -q 82`.
- The version pill, download cards, and release date read
  `repos/danielss-dev/strand/releases/latest` at load; the markup carries the
  last-known tag as a static fallback — bump it when cutting a release so the
  no-JS / rate-limited path stays honest.
- ⌘K (or the nav pill) opens a page-level clone of the app's command palette
  (same grouped / fuzzy / highlighted UI): it scrolls to page sections,
  switches the demo's view, sets the accent, and opens GitHub / X. Items live
  in `ITEMS` in `script.js` — add new destinations there. Inside the iframe,
  ⌘K opens the app's own palette; key events don't cross the frame boundary.
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
- [x] Verify the apex domain in Google Search Console (DNS verification completed
      2026-07-31).
- [ ] Import the verified property into Bing Webmaster Tools and submit
      `https://strandgit.com/sitemap.xml` after this SEO build is deployed.
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
- [x] The performance figures in §06 match `docs/perf-baseline.md` (re-checked
      during the 2026-09-02 refresh).
