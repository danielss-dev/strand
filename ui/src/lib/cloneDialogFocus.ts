type FocusTarget = { focus: () => void };

/**
 * Defer the dialog's initial focus until a closing command palette has restored
 * its opener. The returned cleanup restores whichever control was behind the
 * modal rather than the auto-focused URL input.
 */
export function startCloneDialogFocusLifecycle(
  initialOpener: FocusTarget | null,
  getActive: () => FocusTarget | null,
  getInput: () => FocusTarget | null,
  requestFrame: (callback: () => void) => number,
  cancelFrame: (id: number) => void,
): () => void {
  let opener = initialOpener;
  const frame = requestFrame(() => {
    const input = getInput();
    const active = getActive();
    if (active && active !== input) opener = active;
    input?.focus();
  });
  return () => {
    cancelFrame(frame);
    opener?.focus();
  };
}
