// Remove stale compiled `.js` / `.js.map` files that sit next to their
// `.ts` / `.tsx` source under `ui/src`.
//
// Why this exists: Vite resolves `.js` before `.tsx`, so a leftover compiled
// `.js` (emitted by an older `tsc` run, before tsconfig set `noEmit`) shadows
// the real source and silently runs an OLD version of the UI. `tsconfig.json`
// has `noEmit: true` so these should not regenerate — this is a safety net that
// runs before `dev`/`build`, and can be invoked directly via `pnpm clean:js`.
//
// Only files with a matching `.ts`/`.tsx` sibling are removed, so any
// genuinely hand-authored `.js` is left untouched.

import { readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

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
console.log(
  removed > 0
    ? `clean-stale-js: removed ${removed} stale compiled file(s) from ui/src`
    : 'clean-stale-js: nothing to clean',
);
