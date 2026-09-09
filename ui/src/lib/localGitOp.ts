/** Overlap copy when a second local write is requested while one is in flight. */
export const LOCAL_GIT_OP_BUSY = 'A local Git operation is already running.';

export function checkoutProgress(name: string): string {
  return `Checking out \`${name}\`…`;
}

export function checkoutCommitProgress(): string {
  return 'Checking out commit…';
}

export function stashApplyProgress(): string {
  return 'Applying stash…';
}

export function stashPopProgress(): string {
  return 'Popping stash…';
}

export function stashDropProgress(): string {
  return 'Dropping stash…';
}

export function deleteRefProgress(name: string): string {
  return `Deleting \`${name}\`…`;
}

export type ProgressUpdate = string | null | ((current: string | null) => string | null);

/** App `runLocalProgress` — sets ToastViewport `networkMessage` without Cancel. */
export type LocalGitOp = (message: string, work: () => Promise<void>) => Promise<boolean>;

export interface LocalGitOpRunnerOptions {
  /** Same setter as App `setNetProgress` — local writes omit `netOpId`. */
  setProgress: (update: ProgressUpdate) => void;
  onBusy: () => void;
  waitForPaint: () => Promise<void>;
  /** Network fetch/pull/push already owns the pill — don't steal it. */
  isBlocked?: () => boolean;
}

/**
 * Mirrors App network ops: `setNetProgress(label)` → `waitForPaint()` →
 * await work → `finally` clear. Does not set `netOpId` (no Cancel).
 * Returns whether work ran; overlap toasts via `onBusy` instead of throwing.
 */
export function createLocalGitOpRunner(
  options: LocalGitOpRunnerOptions,
): LocalGitOp {
  let busy = false;
  return async (message, work) => {
    if (busy || options.isBlocked?.()) {
      options.onBusy();
      return false;
    }
    busy = true;
    options.setProgress(message);
    try {
      await options.waitForPaint();
      await work();
      return true;
    } finally {
      options.setProgress((current) => (current === message ? null : current));
      busy = false;
    }
  };
}
