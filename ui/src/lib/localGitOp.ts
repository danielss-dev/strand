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

/** Network pills keep cancel/status-bar ownership; local copy fills the same slot when idle. */
export function toastProgressMessage(
  networkMessage: string | null,
  localMessage: string | null,
): string | null {
  return networkMessage ?? localMessage;
}

export interface LocalGitOpRunnerOptions {
  setProgress: (message: string | null) => void;
  onBusy: () => void;
  waitForPaint: () => Promise<void>;
}

/**
 * Serializes silent local Git writes (checkout, track, stash, …) so the
 * ToastViewport progress pill can paint before the store await, and so a
 * second click does not throw.
 */
export function createLocalGitOpRunner(
  options: LocalGitOpRunnerOptions,
): (message: string, work: () => Promise<void>) => Promise<void> {
  let busy = false;
  return async (message, work) => {
    if (busy) {
      options.onBusy();
      return;
    }
    busy = true;
    options.setProgress(message);
    try {
      await options.waitForPaint();
      await work();
    } finally {
      options.setProgress(null);
      busy = false;
    }
  };
}
