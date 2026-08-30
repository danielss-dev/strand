# Extractable components

The public landing page is a single static document and has no reusable source components suitable for safe DraftComponent extraction. Navigation, footer, cards, and the interactive app replica are tightly coupled to the page's inline SVG symbol registry and global CSS.

For this target, keep these structures in the page draft and pass the canonical HTML/CSS directly. Do not extract basic primitives or fabricate a component layer that the codebase does not have.
