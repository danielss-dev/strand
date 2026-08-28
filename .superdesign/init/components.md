# Shared UI components

Strand's public site is a dependency-free static page. It does not have a component library or separately exported UI primitives. The landing-page buttons, cards, status chips, keyboard keys, download cards, and product mock controls are authored directly in `website/index.html` and styled in `website/style.css`.

The canonical sources for all visible primitives are:

- `website/index.html` — complete markup and inline SVG symbol set.
- `website/style.css` — complete visual implementation.
- `website/script.js` — progressive enhancement and interactive demo behavior.

No component source is duplicated here because there are no component files to extract; pass the three canonical files as target context.
