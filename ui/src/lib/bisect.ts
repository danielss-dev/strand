export type BisectAction = 'good' | 'bad' | 'skip' | 'reset';
export interface BisectState {
  active: boolean; token: string; original: string; original_tip: string; current: string; subject: string;
  expected: string; good_term: string; bad_term: string; remaining: number;
  remaining_truncated: boolean; range_error: string; culprit: string | null; ambiguous: boolean;
  no_checkout: boolean; clean: boolean; log: string;
}
export interface BisectOutcome { success: boolean; output: string; state: BisectState }

export function bisectRatingBlock(state: BisectState): string | null {
  if (!state.active) return 'Start a bisect session first.';
  if (!state.clean) return 'Commit or stash test edits before changing the checkout.';
  if (state.culprit || state.ambiguous) return 'Review the result, then reset to your original checkout.';
  if (state.expected && state.current !== state.expected) return 'The checkout differs from Git’s selected test revision. Restore the expected revision before rating.';
  return null;
}
