import { useEffect } from 'react';

/**
 * Close a popover when the user clicks outside any of `refs` or presses Escape.
 * No-op while `active` is false. Mirrors the helper Topbar uses for its menus.
 */
export function useOutsideClose(
  refs: React.RefObject<HTMLElement>[],
  active: boolean,
  close: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (refs.some((r) => r.current?.contains(target))) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [refs, active, close]);
}
