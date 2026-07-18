# Localization contract

Strand 1.0 ships an English source catalog in `ui/src/lib/i18n.ts`. The same
module is the single seam for later translated catalogs; 1.0 deliberately does
not expose a locale picker while English is the only complete UI language.

## Adding user-visible copy

1. Add a namespaced English key to `en`.
2. Render it with `t(key, values)`. Interpolation fails loudly when a required
   value is missing, and TypeScript rejects unknown keys.
3. Use `plural` for count-sensitive copy and `formatNumber`, `formatPercent`, or
   `formatDateTime` for user-locale formatting. Do not concatenate a fixed
   date/number representation into translated text.
4. Keep raw Git/provider output and error detail verbatim. Translate the Strand-
   owned context around it, then include the original detail so diagnostics are
   never hidden or lossy.

The initial catalog covers the app-wide navigation and settings shell plus the
release-critical clone and update flows. Existing locale-aware date rendering
continues to use the browser/OS locale. New surfaces must enter through the
catalog; broader migration happens alongside the first additional language so
translation work is driven by a real catalog rather than speculative keys.

Run `pnpm --filter ./ui test -- src/lib/i18n.test.ts` and the normal TypeScript
gate after changing the catalog or formatter behavior.
