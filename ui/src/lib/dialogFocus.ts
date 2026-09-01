/** Focusable controls a modal must keep Tab inside. */
export const DIALOG_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Cycle Tab / Shift+Tab inside `root`. Returns true when the event was
 * handled so the caller can preventDefault.
 */
export function trapTabKey(root: HTMLElement, key: string, shiftKey: boolean): boolean {
  if (key !== 'Tab') return false;
  const focusables = Array.from(root.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE));
  if (focusables.length === 0) return false;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (shiftKey && document.activeElement === first) {
    last.focus();
    return true;
  }
  if (!shiftKey && document.activeElement === last) {
    first.focus();
    return true;
  }
  return false;
}
