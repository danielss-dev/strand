import { resolveTreeFileIcon, TREE_ICON_SPRITE_SHEETS } from '../lib/treeIcons';

/** Mount once beside a non-Pierre file list so its `<use>` icons can resolve
 * the same built-in and custom symbols Pierre injects into its shadow root. */
export function TreeIconSprite() {
  return (
    <span
      className="tree-icon-sprite"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: TREE_ICON_SPRITE_SHEETS }}
    />
  );
}

export function TreeFileIcon({ path, size = 16 }: { path: string; size?: number }) {
  const icon = resolveTreeFileIcon(path);
  const width = icon.width ?? size;
  const height = icon.height ?? size;
  return (
    <svg
      className="tree-file-icon"
      aria-hidden
      data-icon-name={icon.remappedFrom ?? icon.name}
      data-icon-token={icon.token}
      viewBox={icon.viewBox ?? `0 0 ${width} ${height}`}
      width={width}
      height={height}
    >
      <use href={`#${icon.name.replace(/^#/, '')}`} />
    </svg>
  );
}
