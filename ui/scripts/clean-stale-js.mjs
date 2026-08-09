// Remove stale generated frontend artifacts before Vite starts:
// - compiled `.js` / `.js.map` files beside `.ts` / `.tsx` source;
// - optimizer metadata that points at a dependency pnpm has removed.
//
// Why this exists: Vite resolves `.js` before `.tsx`, so a leftover compiled
// `.js` (emitted by an older `tsc` run, before tsconfig set `noEmit`) shadows
// the real source and silently runs an OLD version of the UI. `tsconfig.json`
// has `noEmit: true` so these should not regenerate — this is a safety net that
// runs before `dev`/`build`, and can be invoked directly via `pnpm clean:js`.
//
// Source cleanup only removes files with a matching `.ts`/`.tsx` sibling, so
// genuinely hand-authored `.js` is untouched. Optimizer recovery removes only
// Vite's generated `ui/node_modules/.vite` cache.

import { readdirSync, statSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(uiDir, 'src');
const viteCacheDir = join(uiDir, 'node_modules', '.vite');
const viteDepsDir = join(viteCacheDir, 'deps');
const viteMetadata = join(viteDepsDir, '_metadata.json');

/** Does a `.ts`/`.tsx` source exist for this emitted `.js`/`.js.map` artifact? */
function hasSource(fullPath) {
  const base = fullPath.endsWith('.js.map')
    ? fullPath.slice(0, -'.js.map'.length)
    : fullPath.endsWith('.js')
      ? fullPath.slice(0, -'.js'.length)
      : null;
  if (base === null) return false;
  return existsSync(base + '.ts') || existsSync(base + '.tsx');
}

let removed = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
    } else if ((name.endsWith('.js') || name.endsWith('.js.map')) && hasSource(full)) {
      rmSync(full);
      removed += 1;
      console.log(`  removed ${relative(srcDir, full)}`);
    }
  }
}

if (existsSync(srcDir)) walk(srcDir);

// A dependency upgrade can leave Vite's optimizer metadata pointing at a
// removed pnpm package directory. Vite then fails before it can invalidate the
// cache itself (ENOENT while reading the old dependency entry). Remove only
// the generated optimizer cache when one of its recorded source files is gone.
let removedViteCache = false;
if (existsSync(viteMetadata)) {
  try {
    const metadata = JSON.parse(readFileSync(viteMetadata, 'utf8'));
    const dependencies = [
      ...Object.values(metadata.optimized ?? {}),
      ...Object.values(metadata.discovered ?? {}),
    ];
    const stale = dependencies.some((dependency) =>
      typeof dependency?.src === 'string'
      && !existsSync(resolve(viteDepsDir, dependency.src)));
    if (stale) {
      rmSync(viteCacheDir, { recursive: true, force: true });
      removedViteCache = true;
    }
  } catch (error) {
    console.warn(`clean-stale-js: could not inspect Vite cache: ${error.message}`);
  }
}

console.log(
  removed > 0
    ? `clean-stale-js: removed ${removed} stale compiled file(s) from ui/src`
    : 'clean-stale-js: nothing to clean',
);
if (removedViteCache) {
  console.log('clean-stale-js: removed stale Vite dependency cache');
}
