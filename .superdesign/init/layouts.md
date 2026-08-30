# Shared layouts

The site has one monolithic page rather than shared layout components.

## Landing shell

- Source: `website/index.html`
- Description: fixed site navigation, one-page main content, download surface, footer, and command-palette dialog.
- Render branch: the full document renders on every viewport; responsive presentation is handled only by the media queries at the end of `website/style.css`.

The complete source is kept in `website/index.html` and should be passed directly as context. There are no shared layout files to reproduce separately.
