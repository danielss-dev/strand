# Strand landing — Paper-inspired design direction

## Product and page job

Strand is a fast, local-first, keyboard-first Git client for professional developers who review both human- and agent-written code. The landing page has one job: let a developer understand the product's point of view in seconds, then prove it with the working app replica and lead them to the correct platform download.

The product remains Strand. Paper is a visual reference, not a content source or brand to imitate literally.

## Direction: the living release map

Borrow Paper's disciplined spatial system: a near-black canvas, oversized ultra-light sans headlines, thin blueprint rules, large editorial frames, quiet secondary copy, and small monospace state labels. Translate it into Strand's world of commit lanes, refs, diffs, and shipped milestones.

The signature is a continuous Git lane that behaves like a blueprint datum line. It begins in the hero, frames the interactive app demo, and becomes the spine of an honest product roadmap. Milestone nodes and rectangular crop marks should feel like real Git graph geometry—not decorative circles or a generic startup timeline.

## Preserve from Strand

- Keep the exact Strand mark and wordmark in every logo position.
- Keep the interactive app replica intact and legible; it is the primary proof surface.
- Keep the warm charcoal/amber product identity and the user-selectable accent hue.
- Keep all real claims, performance numbers, platform downloads, pricing terms, GitHub links, SEO metadata, keyboard behavior, and reduced-motion behavior.
- Maintain the static, dependency-free implementation and performance-first posture.

## Color tokens

- Canvas / black: `#0b0b0a` — dominant page background.
- Framed surface: `#141412` — large product and roadmap frames.
- Primary ink: `#f2f0e9` — headlines and decisive controls.
- Secondary ink: `#96958f` — supporting headlines and body copy.
- Blueprint rule: `#292925` — 1px structural grid, borders, and crop marks.
- Strand amber: `#e8a83a` / existing OKLCH accent token — active lane, focus, current milestone, primary CTA.
- Semantic green/red and optional branch hues remain limited to the product demo and true status meanings.

Do not introduce purple gradients, glassmorphism, bright multi-color backgrounds, or decorative blobs. Ambient accent glow may remain only around the app proof surface, at lower intensity than the current site.

## Typography

- Display and section headlines: self-hosted Geist, weight 400 where available, letter-spacing about `-0.03em`, line-height `0.96–1.02`. Use `clamp()` aggressively: hero thesis 64–104px desktop; section title 48–72px.
- Body: Geist 400, 17–19px, 1.5–1.6 line height, max line length 38–44rem.
- Utility, status, measurements, keyboard labels: JetBrains Mono 400/500, 11–13px.
- Do not use JetBrains Mono for every headline. Its role is data, state, and Git vernacular; Geist carries the editorial voice.
- Avoid italics as the main accent treatment. Use scale, weight, position, and tone.

## Layout and structure

- Maximum content width: roughly 1200px with responsive 24–40px gutters.
- Build on a visible 12-column blueprint. Thin horizontal and vertical rules encode alignment and section frames.
- Hero: left-aligned, two-tone thesis. First line is bright and concrete; following line(s) are muted, like Paper's hero hierarchy. Copy and CTAs sit below at a narrower measure. The interactive product window spans most of the grid and visually locks into the same rails.
- Sections: avoid repeated centered eyebrow/headline/paragraph/card-grid blocks. Alternate editorial frames: large title left + explanation right; artifact left + milestone copy right; narrow utility rows for facts.
- Feature content should become fewer, larger narrative clusters. Preserve all important capabilities, but group them by real jobs rather than presenting ten equal cards.
- Roadmap: add a dedicated `#roadmap` section and nav link. Use verified project states rather than aspirational dates:
  - `SHIPPED` — Stable foundation / current 1.3.1 release: complete Git client, cross-platform signed distribution, worktrees, review, PR workspace.
  - `IN PROGRESS` — Hosted review expansion: GitLab/Bitbucket adapters, deeper pagination, merge queue/auto-complete, review evolution.
  - `DESIGNED` — Remote repositories over SSH via `strandd`, JSON-RPC/stdio, system SSH.
  - `NEXT` — Read-only `strand` CLI companion exposing typed diff/log/status/review data to agents.
  Link the section to the repository's full `ROADMAP.md`.
- Pricing and download remain separate late-page decisions, but use flat framed regions rather than floating card chrome.

## Components

- Navigation: 60–64px fixed bar, black opaque background, compact wordmark left, lowercase links, understated text CTA. Add `Roadmap`; keep Docs and GitHub.
- Buttons: square-ish 2–6px radius, 40–44px height, direct labels. Primary is warm white or Strand amber depending on contrast; secondary is text-only with an arrow.
- Status badge: JetBrains Mono, 13px, 1px rectangular outline, 2–4px radius, one 6px status dot, lowercase or uppercase consistently.
- Roadmap frame: strong grid placement, hairline borders, no elevated shadow. Each milestone gets a large negative-space field and one concise description.
- Product demo: retain existing app chrome, interactions, syntax colors, and dark native-window shadow. Do not redraw or simplify the mock content.
- Cards: use only when the information is truly independent. Prefer bordered rows or split frames; no generic icon-in-rounded-square feature grid.

## Motion

- One orchestrated entry: hero lines reveal in sequence, blueprint lane draws, app frame rises by 12–18px.
- Section reveal remains subtle and scroll-triggered.
- Roadmap status dots may pulse only for `IN PROGRESS`; static for every other status.
- Hover states should expose rules/labels or shift a lane by 1px—not lift every box.
- Respect `prefers-reduced-motion: reduce`; no essential content depends on animation.

## Responsive behavior

- Desktop grid collapses from 12 columns to 6 around 1000px and one content column around 720px.
- Keep the hero app replica usable at narrow widths with the existing selective pane hiding.
- Roadmap frames stack title, artifact, description, and state badge without horizontal overflow.
- Navigation retains a visible primary download action; secondary links may collapse.
- Preserve visible focus rings and semantic headings/landmarks.

## Hard constraints

- Use ONLY the fonts, colors, spacing, and component styles defined here and in the supplied Strand CSS tokens.
- Do not copy Paper's logo, brand name, marketing copy, screenshots, or proprietary assets.
- Do not introduce external runtime dependencies, remote fonts, autoplay media, or heavy canvas/WebGL effects.
- Keep the page fast, keyboard-operable, accessible, responsive, and truthful to shipped source behavior.
