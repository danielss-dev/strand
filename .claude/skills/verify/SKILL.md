---
name: verify
description: Drive the running Strand app (Tauri 2 / WebView2 on Windows) over CDP to verify UI changes end-to-end — launch recipe, store-hook driving, screenshots, gotchas.
---

# Verifying Strand UI changes on the running app

Strand is a Tauri 2 app; on Windows the webview is WebView2, which exposes
Chrome DevTools Protocol when launched with `--remote-debugging-port`. The
app also ships a perf-gated test hook (`window.__strand`, see
`ui/src/main.tsx`) exposing the zustand stores, so a CDP client can open
repos, switch views, and select files without native dialogs. Full background
in `docs/perf-baseline.md` ("Reproducing the webview pass").

## Launch recipe (dev build, CDP enabled)

1. **Check for a running dev session first**: `Get-Process strand`;
   port 1420 busy means the user's `pnpm tauri dev` is up. Its vite serves
   your edited sources via HMR — you only need your *own* app instance for
   CDP, not another vite.
2. `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is **ignored** — wry passes
   `AdditionalBrowserArguments` through the WebView2 options API, which takes
   precedence over the env var. The only way in is
   `additionalBrowserArgs` in `crates/strand-tauri/tauri.conf.json`
   (⚠️ see gotchas before editing it):

   ```json
   "additionalBrowserArgs": "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9222"
   ```

   The config is embedded at compile time → rebuild:
   `cargo build --no-default-features` (dev-mode binary that loads
   http://localhost:1420; ~10s incremental).
3. Isolate the WebView2 profile or the new instance silently attaches to the
   user's existing browser process (fixed args, no CDP):
   `$env:WEBVIEW2_USER_DATA_FOLDER='<scratchpad>\wv2'` then run
   `target\debug\strand.exe`.
4. Poll `http://localhost:9222/json/list` for the page target.
5. When done: kill **only your own** strand.exe (note its PID at spawn —
   don't kill by name or start-time heuristics), revert `tauri.conf.json`,
   and `cargo build --no-default-features` again so the checked-in binary
   has no debug port.

## Driving the app

- Enable the store hook: `localStorage.setItem('strand:perf','1')` +
  `location.reload()` → `window.__strand.{repo,settings,workspaces,workspaceReview}`.
- A session-restore usually opens the user's tabs. Useful store calls
  (all via `Runtime.evaluate`, `awaitPromise: true`):
  - `repo.getState().setActiveTab('D:/GitSources/strand')` (await)
  - `repo.getState().refreshReviewDiffs()` (await), then
    `setView('review' | 'workspace-review' | 'local' | 'commits' | ...)`
  - `repo.getState().selectReviewFile('ui/src/...')` — repo-relative path;
    give `useSettled` ~1s before screenshotting
  - `settings.getState().set('diffMode', 'split' | 'stacked')` — key/value
    signature, not a partial object; revert when done
- Keyboard: `Input.dispatchKeyEvent` (`keyDown`+`keyUp`, e.g. `n`/`p`/`j`/`k`);
  mouse: `Input.dispatchMouseEvent` (`mousePressed`+`mouseReleased`).
- Screenshots: `Page.captureScreenshot`, with `clip` (+`scale: 2`) to zoom a
  region. Node ≥22 has a native `WebSocket` — a dependency-free driver script
  is ~40 lines; a reusable one from 2026-07-04 may exist in old session
  scratchpads (`drive.mjs`).

## Gotchas (paid for)

- ⚠️ **Editing `tauri.conf.json` (or any watched crate file) while the user's
  `pnpm tauri dev` is running restarts their app** — the Tauri CLI watches
  `crates/*` and rebuilds/relaunches; killing that relaunched instance also
  tears down their vite. If a user dev session is up, warn/ask first, and at
  minimum record your own PID and never kill by name or start-time.
- `pnpm tauri dev` must run from the **repo root** (config lives in
  `crates/strand-tauri`), and fails if vite's port 1420 is already busy.
- The SQLite session DB is shared across instances — your store calls
  (active tab, view) persist into the user's next launch. Keep mutations
  minimal and restore what you can.
- The `__strand` hook only exists while `localStorage['strand:perf']==='1'`;
  that flag lives in the (isolated) profile, so it never leaks to the user's.
