# Theme

## Compact token summary

- Palette: warm near-black `--bg-os: oklch(0.14 0.006 60)`, base `0.185`, panel `0.215`, elevated `0.255`, hover `0.295`; warm white `--text: oklch(0.96 0.005 80)`, secondary `0.82`, muted `0.65`, dim `0.50`.
- Accent: one user-selectable hue in `--accent-h` (amber default `55`), with `--accent: oklch(0.74 0.165 var(--accent-h))`, `--accent-2: oklch(0.84 0.13 var(--accent-h))`, and a dark foreground.
- Semantic diff colors: green add, red delete, ochre modified. Seven branch-lane colors provide restrained secondary accents.
- Type: self-hosted Geist 400/500/600 for body and JetBrains Mono 400/500/600 for headings, labels, controls, and code.
- Radius: `6px`, `10px`, `14px`; buttons typically `8px`; pills use `999px`.
- Shadows: deep black native-window shadows (`0 24px 64px`) and compact panel shadows (`0 12px 32px`).
- Layout: centered `1120px` wrap with `24px` gutters; content sections use generous vertical spacing; breakpoints at `1000px` and `720px`.
- Motion: one IntersectionObserver-driven upward reveal; hover lift on primary cards; all motion is disabled or flattened under `prefers-reduced-motion`.
- Dark-only public landing page today. Design tokens are intentionally related to `ui/src/styles/tokens.css`.

## Raw source locations

The full source dumps remain canonical in the repository:

- `website/style.css` — all landing tokens, styles, breakpoints, and motion (1,225 lines).
- `website/index.html` — all page markup and inline SVG symbols.
- `ui/src/styles/tokens.css` — product theme source that the landing tokens derive from.

For generation, pass `website/style.css:1:180` for tokens/base/hero and the relevant section ranges rather than the entire file, per the payload budget rule.
